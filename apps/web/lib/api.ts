import { z } from "zod";
import { randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { getDb, audit, activeMembership, type Verification, type User, type Enrollment } from "@class-comfyui/database";
import { getEnv, appUrl } from "@class-comfyui/config";
import {
  hashToken,
  newVerificationToken,
  checkAdminCode,
  signWorkspaceToken,
  parseRosterCsv,
  reconcileRoster,
} from "@class-comfyui/auth";
import { EmailSchema, ClassCreateSchema, WorkerCreateSchema, canonicalEmail } from "@class-comfyui/shared";
import { currentUser } from "./auth-helpers";
import { requireOrigin } from "./origin";
import { checkRateLimit, clientIp } from "./rate-limit";
import { createSession, sessionCookieValue, destroySessionByCookie, clearSessionCookie } from "./session";
import { sendMail, verificationEmail, buildVerifyLink, signupInviteEmail } from "./mailer";
import { generateSignupUrl, validateSignupToken, setSignupEnabled } from "./signup";
class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
function fail(status: number, message: string): never {
  throw new ApiError(status, message);
}
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
function limit(action: string, id: string, n = 10, ms = 60000) {
  if (!checkRateLimit(action, id, n, ms)) fail(429, "Too many requests. Try again later.");
}
async function body(req: Request) {
  if (Number(req.headers.get("content-length") || 0) > 6_000_000) fail(413, "Request too large");
  const reader = req.body?.getReader();
  if (!reader) return {};
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 6_000_000) {
      await reader.cancel();
      fail(413, "Request too large");
    }
    chunks.push(value);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, any>;
  } catch {
    fail(400, "Invalid JSON");
  }
}
function workerUrl(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    ["169.254.169.254", "metadata.google.internal"].includes(u.hostname)
  )
    fail(400, "Worker URL must be a plain HTTP lab origin");
  return u.origin;
}
const authBody = z.object({
  email: EmailSchema,
  classSlug: z.string().max(100).optional(),
  signupToken: z.string().max(200).optional(),
  isAdmin: z.boolean().default(false),
  adminCode: z.string().max(1000).default(""),
  firstName: z.string().max(100).default(""),
  lastName: z.string().max(100).default(""),
});
async function requestVerification(req: Request, b: Record<string, any>, signupOnly: boolean) {
  const input = authBody.parse(b),
    db = getDb(),
    env = getEnv(),
    ip = clientIp(req.headers);
  limit("auth-ip", ip, 120);
  limit("auth-email", input.email, 5, 300000);
  if (input.isAdmin) limit("admin-register", ip, 5, 300000);
  const raw = newVerificationToken();
  const challenge = db.transaction(() => {
    const user = db.userByEmail(input.email);
    if (user?.status === "DISABLED") fail(403, "Account unavailable");
    const row: Verification = {
      id: hashToken(raw),
      email: input.email,
      purpose: "LOGIN",
      classId: null,
      enrollmentIds: [],
      signupVersion: null,
      firstName: input.firstName,
      lastName: input.lastName,
      expiresAt: Date.now() + env.VERIFICATION_TTL_MINUTES * 60000,
      consumedAt: null,
    };
    if (input.isAdmin) {
      if (!checkAdminCode(input.adminCode, env.ADMIN_REGISTRATION_CODE)) fail(403, "Incorrect admin registration code");
      row.purpose = "ADMIN";
    } else if (signupOnly || input.classSlug || input.signupToken) {
      if (!input.classSlug || !input.signupToken) fail(403, "A valid class signup link is required");
      const valid = validateSignupToken(input.classSlug, input.signupToken);
      if (!valid.ok) fail(403, "Invalid or disabled signup link");
      const enrollment = db
        .list("enrollments", "class_id=? AND email=?", [valid.classId!, input.email])
        .find((e) => e.status !== "ARCHIVED");
      if (!enrollment) fail(403, "This email is not eligible for this class");
      row.purpose = "SIGNUP";
      row.classId = valid.classId!;
      row.signupVersion = valid.version!;
      row.enrollmentIds = [enrollment.id];
    } else if (!user) {
      fail(403, "Use your class signup link to register");
    }
    db.put("verifications", row);
    return row;
  });
  try {
    await sendMail(verificationEmail(input.email, buildVerifyLink(raw, input.email)));
  } catch {
    db.delete("verifications", challenge.id);
    fail(502, "Email delivery failed. Please retry or contact the administrator.");
  }
  return json({ ok: true, message: "Check your email for a sign-in link." });
}
function verify(req: Request, b: Record<string, any>) {
  const input = z.object({ email: EmailSchema, token: z.string().min(20).max(200) }).parse(b);
  limit("verification", clientIp(req.headers), 120);
  return getDb().transaction(() => {
    const db = getDb(),
      row = db.get("verifications", hashToken(input.token));
    if (!row || row.email !== input.email || row.consumedAt || row.expiresAt <= Date.now())
      fail(400, "Invalid, used or expired verification link");
    let u = db.userByEmail(input.email);
    if (u?.status === "DISABLED") fail(403, "Account disabled");
    // Re-check current eligibility before creating a user or consuming the challenge.
    const memberships: Enrollment[] = [];
    if (row.purpose === "SIGNUP") {
      const c = row.classId ? db.get("classes", row.classId) : undefined;
      if (!c?.active || !c.signupEnabled || c.signupTokenVersion !== row.signupVersion)
        fail(403, "Signup is no longer available; request a new link");
      for (const id of row.enrollmentIds) {
        const e = db.get("enrollments", id);
        if (!e || e.classId !== row.classId || e.rosterEmail !== input.email || e.status === "ARCHIVED")
          fail(403, "Enrollment no longer eligible");
        memberships.push(e);
      }
      if (!memberships.length) fail(403, "Enrollment required");
    }
    if (row.purpose === "LOGIN" && !u) fail(403, "Account unavailable");
    const now = new Date().toISOString();
    const becameAdmin = row.purpose === "ADMIN" && u?.globalRole !== "ADMIN";
    if (!u)
      u = {
        id: randomUUID(),
        email: input.email,
        firstName: row.firstName || memberships[0]?.firstName || "",
        lastName: row.lastName || memberships[0]?.lastName || "",
        emailVerifiedAt: now,
        status: "ACTIVE",
        globalRole: row.purpose === "ADMIN" ? "ADMIN" : "STUDENT",
        lastLoginAt: now,
        createdAt: now,
      };
    if (row.purpose === "ADMIN") u.globalRole = "ADMIN";
    u.lastLoginAt = now;
    u.emailVerifiedAt = now;
    db.put("users", u);
    for (const e of memberships) {
      e.userId = u.id;
      e.status = "ACTIVE";
      db.put("enrollments", e);
    }
    row.consumedAt = Date.now();
    db.put("verifications", row);
    if (becameAdmin) audit("ADMIN_REGISTERED", { actorId: u.id, targetId: u.id });
    const session = createSession(u.id);
    const res = json({ ok: true, role: u.globalRole, userId: u.id });
    res.headers.set("Set-Cookie", sessionCookieValue(session.raw, session.expiresAt));
    return res;
  });
}
function shapedJobs(user: User, url: URL) {
  const db = getDb();
  let jobs = db.list(
    "jobs",
    user.globalRole === "ADMIN" ? "1" : "user_id=?",
    user.globalRole === "ADMIN" ? [] : [user.id]
  );
  for (const [key, field] of [
    ["classId", "classId"],
    ["userId", "userId"],
    ["status", "status"],
    ["workerId", "workerId"],
  ] as const) {
    const v = url.searchParams.get(key);
    if (v) jobs = jobs.filter((j) => j[field] === v);
  }
  const jobId = url.searchParams.get("jobId");
  if (jobId) jobs = jobs.filter((j) => j.id === jobId);
  const q = (url.searchParams.get("q") || "").toLowerCase(),
    from = url.searchParams.get("from"),
    to = url.searchParams.get("to"),
    type = url.searchParams.get("outputType");
  return jobs
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
    .filter((j) => !from || j.submittedAt >= from)
    .filter((j) => !to || j.submittedAt <= to + "T23:59:59.999Z")
    .map((j) => ({
      ...j,
      leaseOwner: undefined,
      extraData: undefined,
      history: undefined,
      workerName: j.workerId ? db.get("workers", j.workerId)?.name : null,
      email: db.get("users", j.userId)?.email,
      outputs: db
        .list("outputs", "job_id=?", [j.id])
        .map((o) => ({ ...o, storagePath: undefined, url: `/api/outputs/${o.id}` })),
    }))
    .filter((j) => !q || `${j.id} ${j.orgDefinedId} ${j.email}`.toLowerCase().includes(q))
    .filter((j) => !type || j.outputs.some((o) => o.mimeType.startsWith(type)))
    .slice(0, 500);
}
function rosterPreview(user: User, b: Record<string, any>) {
  const input = z.object({ classId: z.string(), csv: z.string().min(1).max(5_000_000) }).parse(b),
    db = getDb();
  if (!db.get("classes", input.classId)) fail(404, "Class not found");
  const { rows, errors } = parseRosterCsv(input.csv);
  if (errors.length) fail(400, errors.join("; "));
  const existing = db.list("enrollments", "class_id=?", [input.classId]);
  const preview = reconcileRoster(rows, existing);
  const id = randomUUID();
  const summary = {
    totalRows: preview.totalRows,
    newCount: preview.newCount,
    unchangedCount: preview.unchangedCount,
    updatedCount: preview.updatedCount,
    invalidCount: preview.invalidCount,
    duplicateCount: preview.duplicateCount,
    missingCount: preview.missingCount,
  };
  db.put("roster_imports", {
    id,
    classId: input.classId,
    actorId: user.id,
    createdAt: new Date().toISOString(),
    status: "PREVIEW",
    rows,
    csvHash: hashToken(input.csv),
    missingIds: existing
      .filter((e) => !rows.some((r) => r.email === canonicalEmail(e.rosterEmail) || r.orgDefinedId === e.orgDefinedId))
      .map((e) => e.id),
    summary,
  });
  for (const row of preview.rows)
    db.put("roster_import_rows", { id: randomUUID(), importId: id, line: row.line, state: row.state, row: { ...row } });
  return json({
    importId: id,
    preview: {
      ...summary,
      rows: preview.rows,
      missing: existing.filter(
        (e) => !rows.some((r) => r.email === canonicalEmail(e.rosterEmail) || r.orgDefinedId === e.orgDefinedId)
      ),
    },
  });
}
function rosterCommit(user: User, b: Record<string, any>) {
  return getDb().transaction(() => {
    const input = z.object({ importId: z.string(), archiveIds: z.array(z.string()).default([]) }).parse(b),
      db = getDb(),
      batch = db.get("roster_imports", input.importId);
    if (
      !batch ||
      batch.actorId !== user.id ||
      batch.status !== "PREVIEW" ||
      Date.parse(batch.createdAt) < Date.now() - 3600000
    )
      fail(409, "Preview expired or already imported. Preview again.");
    if (batch.summary.invalidCount || batch.summary.duplicateCount)
      fail(400, "Fix invalid and duplicate rows before importing");
    const c = db.get("classes", batch.classId);
    if (!c) fail(404, "Class not found");
    let created = 0,
      updated = 0;
    for (const r of batch.rows) {
      const matches = db.list("enrollments", "class_id=? AND (email=? OR org_id=?)", [c.id, r.email, r.orgDefinedId]);
      if (matches.length > 1)
        fail(409, "Email and student ID conflict with different existing enrollments. Nothing imported.");
      let e = matches[0];
      if (!e) {
        e = {
          id: randomUUID(),
          classId: c.id,
          userId: null,
          rosterEmail: r.email,
          orgDefinedId: r.orgDefinedId,
          firstName: r.firstName,
          lastName: r.lastName,
          role: "STUDENT",
          status: "INVITED",
        };
        created++;
      } else {
        const changed =
          e.rosterEmail !== r.email ||
          e.orgDefinedId !== r.orgDefinedId ||
          e.firstName !== r.firstName ||
          e.lastName !== r.lastName;
        if (changed) updated++;
        if (e.rosterEmail !== r.email) {
          e.userId = null;
          e.status = "INVITED";
        }
        Object.assign(e, {
          rosterEmail: r.email,
          orgDefinedId: r.orgDefinedId,
          firstName: r.firstName,
          lastName: r.lastName,
        });
      }
      db.put("enrollments", e);
    }
    for (const id of input.archiveIds) {
      if (!batch.missingIds.includes(id)) fail(400, "Only reviewed missing enrollments can be archived");
      const e = db.get("enrollments", id);
      if (!e || e.classId !== c.id) fail(409, "Roster changed; preview again");
      e.status = "ARCHIVED";
      db.put("enrollments", e);
      audit("ENROLLMENT_ARCHIVED", { actorId: user.id, classId: c.id, targetId: id });
    }
    batch.status = "COMMITTED";
    db.put("roster_imports", batch);
    audit("ROSTER_IMPORTED", {
      actorId: user.id,
      classId: c.id,
      targetId: batch.id,
      metadata: { created, updated, archived: input.archiveIds.length },
    });
    return json({ ok: true, created, updated, archived: input.archiveIds.length, total: batch.rows.length });
  });
}
export async function handleApi(req: Request): Promise<Response> {
  try {
    const blocked = requireOrigin(req);
    if (blocked) return blocked;
    const url = new URL(req.url),
      p = url.pathname.replace(/\/$/, ""),
      method = req.method,
      db = getDb();
    if (p === "/api/health") {
      db.sql.prepare("SELECT 1").get();
      return json({ ok: true, service: "web", database: "sqlite-wal" });
    }
    const b = ["GET", "HEAD"].includes(method) ? {} : await body(req);
    if (p === "/api/signup/info" && method === "GET") {
      const valid = validateSignupToken(url.searchParams.get("slug") || "", url.searchParams.get("token") || "");
      if (!valid.ok) fail(404, "Invalid or disabled signup link");
      const c = db.get("classes", valid.classId!)!;
      return json({ name: c.name, courseCode: c.courseCode, term: c.term });
    }
    if (method === "POST" && (p === "/api/auth/request-code" || p === "/api/signup/request"))
      return await requestVerification(req, b, p === "/api/signup/request");
    if (method === "POST" && p === "/api/auth/verify") return verify(req, b);
    if (method === "POST" && p === "/api/auth/logout") {
      destroySessionByCookie(req.headers.get("cookie"));
      const res = json({ ok: true });
      res.headers.set("Set-Cookie", clearSessionCookie());
      return res;
    }
    const user = currentUser(req);
    if (p === "/api/auth/session") {
      const enrollments = user
        ? db.list("enrollments", "user_id=?", [user.id]).map((e) => {
            const c = db.get("classes", e.classId);
            return {
              ...e,
              classSlug: c?.slug,
              className: c?.name,
              courseCode: c?.courseCode,
              term: c?.term,
              classActive: c?.active,
            };
          })
        : [];
      return json({ user: user ?? null, enrollments });
    }
    if (!user) fail(401, "Authentication required");
    if (p === "/api/workspace/session" && method === "POST")
      return db.transaction(() => {
        const input = z.object({ classId: z.string() }).parse(b);
        limit("workspace", user.id, 20);
        const e = activeMembership(db, user.id, input.classId);
        if (!e) fail(403, "No active class enrollment");
        const env = getEnv(),
          jti = randomUUID();
        db.put("workspace_tickets", {
          id: jti,
          userId: user.id,
          classId: e.classId,
          enrollmentId: e.id,
          expiresAt: Date.now() + env.WORKSPACE_TOKEN_TTL_SECONDS * 1000,
          consumedAt: null,
        });
        const token = signWorkspaceToken(
          { sub: user.id, classId: e.classId, enrollmentId: e.id, jti, ttlSeconds: env.WORKSPACE_TOKEN_TTL_SECONDS },
          env.WORKSPACE_JWT_SECRET
        );
        return json({ url: appUrl(env.COMFY_PUBLIC_URL, `/auth/exchange?token=${encodeURIComponent(token)}`) });
      });
    if (p === "/api/jobs" && method === "GET") return json({ jobs: shapedJobs(user, url) });
    const retryMatch = p.match(/^\/api\/jobs\/([^/]+)\/archive$/);
    if (retryMatch && method === "POST")
      return db.transaction(() => {
        const j = db.get("jobs", retryMatch[1]);
        if (!j || (user.globalRole !== "ADMIN" && j.userId !== user.id)) fail(404, "Job not found");
        if (j.status !== "COMPLETED" || j.archiveStatus !== "FAILED") fail(409, "Only failed archives can be retried");
        limit("archive-retry", user.id, 5, 300000);
        j.archiveStatus = "ARCHIVING";
        db.put("jobs", j);
        return json({ ok: true });
      });
    const jobMatch = p.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch) {
      const j = db.get("jobs", jobMatch[1]);
      if (!j || (user.globalRole !== "ADMIN" && j.userId !== user.id)) fail(404, "Job not found");
      if (method === "GET")
        return json({
          job: shapedJobs(user, new URL("/api/jobs?jobId=" + j.id, getEnv().PUBLIC_URL)).find((v) => v.id === j.id),
        });
      if (method === "DELETE")
        return db.transaction(() => {
          const current = db.get("jobs", j.id)!;
          if (current.status === "QUEUED") {
            current.status = "CANCELLED";
            current.completedAt = new Date().toISOString();
          } else if (["RUNNING", "DISPATCHING"].includes(current.status)) current.cancelRequested = true;
          db.put("jobs", current);
          return json({ ok: true });
        });
    }
    const outputMatch = p.match(/^\/api\/outputs\/([^/]+)$/);
    if (outputMatch && method === "GET") {
      const o = db.get("outputs", outputMatch[1]),
        j = o ? db.get("jobs", o.jobId) : undefined;
      if (!o || !j || (user.globalRole !== "ADMIN" && j.userId !== user.id)) fail(404, "Output not found");
      if (j.archiveStatus === "EXPIRED") fail(410, "Output expired under retention policy");
      const base = path.resolve(getEnv().AUDIT_DATA_DIR),
        file = path.resolve(o.storagePath);
      if (!file.startsWith(base + path.sep)) fail(404, "Output not found");
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        fail(404, "Archived file unavailable");
      }
      return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
        headers: {
          "Content-Type": o.mimeType,
          "Content-Length": String(size),
          "Content-Disposition": `attachment; filename="${o.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (p === "/api/audit" && method === "GET") {
      let events = db.list("audits");
      if (user.globalRole !== "ADMIN") events = events.filter((e) => e.actorId === user.id);
      for (const key of ["classId", "type"] as const) {
        const val = url.searchParams.get(key);
        if (val) events = events.filter((e) => e[key] === val);
      }
      const q = (url.searchParams.get("q") || "").toLowerCase();
      return json({
        events: events
          .filter((e) => !q || JSON.stringify(e).toLowerCase().includes(q))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 500),
      });
    }
    if (user.globalRole !== "ADMIN") fail(403, "Administrator required");
    if (p === "/api/admin/metrics" && method === "GET") {
      const jobs = db.list("jobs"),
        today = new Date().toISOString().slice(0, 10);
      return json({
        activeClasses: db.list("classes").filter((c) => c.active).length,
        students: db.list("users").filter((u) => u.globalRole === "STUDENT").length,
        pending: db.list("enrollments").filter((e) => !e.userId && e.status === "INVITED").length,
        queued: jobs.filter((j) => j.status === "QUEUED").length,
        active: jobs.filter((j) => ["RUNNING", "DISPATCHING"].includes(j.status)).length,
        workers: db.list("workers").length,
        gpus: db.list("workers").filter((w) => w.enabled && ["ONLINE", "BUSY"].includes(w.healthStatus)).length,
        jobsToday: jobs.filter((j) => j.submittedAt.startsWith(today)).length,
        failures: jobs.filter((j) => ["FAILED", "LOST"].includes(j.status)).length,
        outputsToday: db.list("outputs").filter((o) => db.get("jobs", o.jobId)?.completedAt?.startsWith(today)).length,
      });
    }
    if (p === "/api/roster/preview" && method === "POST") return db.transaction(() => rosterPreview(user, b));
    if (p === "/api/roster/import" && method === "POST") return rosterCommit(user, b);
    if (p === "/api/smtp/test") {
      if (method === "GET") return json({ configured: true, hostRedacted: getEnv().SMTP_HOST.slice(0, 2) + "***" });
      if (method === "POST") {
        limit("smtp-test", user.id, 3, 300000);
        const input = z.object({ to: EmailSchema }).parse(b);
        try {
          await sendMail({ to: input.to, subject: "ComfyUI Lab SMTP test", text: "SMTP delivery is working." });
        } catch {
          fail(502, "SMTP delivery failed");
        }
        audit("SMTP_TEST_SENT", { actorId: user.id, metadata: { to: input.to } });
        return json({ ok: true, message: "Test email sent" });
      }
    }
    const inviteMatch = p.match(/^\/api\/admin\/classes\/([^/]+)\/email-signup$/);
    if (inviteMatch && method === "POST") {
      limit("invitations", user.id, 2, 300000);
      const c = db.get("classes", inviteMatch[1]);
      if (!c?.active || !c.signupEnabled) fail(403, "Class signup unavailable");
      const input = z.object({ signupUrl: z.string().url().max(1000) }).parse(b),
        supplied = new URL(input.signupUrl),
        parts = supplied.pathname.split("/"),
        raw = parts.at(-1)!;
      const valid = validateSignupToken(c.slug, raw);
      if (!valid.ok || valid.classId !== c.id) fail(400, "Invalid or revoked signup URL");
      const canonical = appUrl(getEnv().PUBLIC_URL, `/signup/${c.slug}/${raw}`);
      if (input.signupUrl !== canonical) fail(400, "Signup URL must match the canonical application URL");
      const recipients = db
        .list("enrollments", "class_id=?", [c.id])
        .filter((e) => !e.userId && e.status !== "ARCHIVED");
      let sent = 0,
        failed = 0;
      for (const e of recipients) {
        if (!validateSignupToken(c.slug, raw).ok) break;
        let success = true;
        try {
          await sendMail(signupInviteEmail(e.rosterEmail, `${c.courseCode} — ${c.term}`, canonical));
          sent++;
        } catch {
          failed++;
          success = false;
        }
        db.put("invitations", {
          id: randomUUID(),
          classId: c.id,
          email: e.rosterEmail,
          actorId: user.id,
          createdAt: new Date().toISOString(),
          status: success ? "SENT" : "FAILED",
          error: success ? null : "SMTP delivery failed",
        });
      }
      audit("INVITATIONS_SENT", { actorId: user.id, classId: c.id, targetId: c.id, metadata: { sent, failed } });
      return json({ ok: failed === 0, sent, failed });
    }
    // Every administrative read/modify/write runs under one short writer transaction.
    return db.transaction(() => adminRoute(user, p, method, b, url));
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    if (e instanceof z.ZodError)
      return json(
        { error: "Invalid request", details: e.issues.map((v) => `${v.path.join(".")}: ${v.message}`).join("; ") },
        400
      );
    if (e instanceof Error && /UNIQUE constraint/.test(e.message))
      return json({ error: "A conflicting record already exists" }, 409);
    if (e instanceof Error && /database is locked/.test(e.message))
      return json({ error: "Database busy; retry shortly" }, 503);
    console.error("[api] request failed", e instanceof Error ? e.name : "Error");
    return json({ error: "Request failed" }, 500);
  }
}
function adminRoute(user: User, p: string, method: string, b: Record<string, any>, url: URL) {
  const db = getDb();
  const actor = db.get("users", user.id);
  if (actor?.globalRole !== "ADMIN" || actor.status !== "ACTIVE") fail(403, "Administrator required");
  if (p === "/api/admin/classes") {
    if (method === "GET")
      return json({
        classes: db.list("classes").map((c) => {
          const e = db.list("enrollments", "class_id=?", [c.id]);
          return { ...c, enrolled: e.length, registered: e.filter((v) => v.userId && v.status === "ACTIVE").length };
        }),
      });
    if (method === "POST") {
      const input = ClassCreateSchema.parse(b),
        now = new Date().toISOString(),
        c = db.put("classes", {
          ...input,
          id: randomUUID(),
          active: true,
          signupEnabled: false,
          signupTokenVersion: 0,
          createdAt: now,
          updatedAt: now,
        });
      audit("CLASS_CREATED", { actorId: user.id, classId: c.id, targetId: c.id });
      return json({ class: c }, 201);
    }
  }
  const clsMatch = p.match(/^\/api\/admin\/classes\/([^/]+)(?:\/(signup|enrollments))?$/);
  if (clsMatch) {
    const c = db.get("classes", clsMatch[1]);
    if (!c) fail(404, "Class not found");
    if (clsMatch[2] === "signup") {
      if (method === "POST")
        return json({ ...generateSignupUrl(c.id, user.id), raw: undefined, signupEnabled: true }, 201);
      if (method === "PATCH") {
        const input = z.object({ enabled: z.boolean() }).parse(b);
        return json({ signupEnabled: setSignupEnabled(c.id, input.enabled, user.id).signupEnabled });
      }
      const token = db.list("signup_tokens", "class_id=?", [c.id])[0],
        e = db.list("enrollments", "class_id=?", [c.id]);
      return json({
        signupEnabled: c.signupEnabled,
        hasActiveToken: !!token,
        version: c.signupTokenVersion,
        registered: e.filter((v) => v.userId).length,
        remaining: e.filter((v) => !v.userId && v.status !== "ARCHIVED").length,
        tokenCreatedAt: token?.createdAt,
      });
    }
    if (clsMatch[2] === "enrollments" && method === "PATCH") {
      const input = z.object({ id: z.string(), status: z.enum(["ARCHIVED", "INVITED"]) }).parse(b),
        e = db.get("enrollments", input.id);
      if (!e || e.classId !== c.id) fail(404, "Enrollment not found");
      e.status = input.status;
      db.put("enrollments", e);
      audit(input.status === "ARCHIVED" ? "ENROLLMENT_ARCHIVED" : "ENROLLMENT_REACTIVATED", {
        actorId: user.id,
        classId: c.id,
        targetId: e.id,
      });
      return json({ enrollment: e });
    }
    if (method === "GET")
      return json({
        class: c,
        enrollments: db.list("enrollments", "class_id=?", [c.id]).map((e) => ({
          ...e,
          lastLogin: e.userId ? db.get("users", e.userId)?.lastLoginAt : null,
          accountStatus: e.userId ? db.get("users", e.userId)?.status : "PENDING",
          jobs: db.list("jobs", "enrollment_id=?", [e.id]).length,
          outputs: db
            .list("jobs", "enrollment_id=?", [e.id])
            .reduce((n, j) => n + db.list("outputs", "job_id=?", [j.id]).length, 0),
        })),
      });
    if (method === "PATCH" || method === "DELETE") {
      const input =
        method === "DELETE"
          ? { active: false }
          : z
              .object({
                name: z.string().min(1).max(200).optional(),
                courseCode: z.string().min(1).max(50).optional(),
                term: z.string().min(1).max(50).optional(),
                description: z.string().max(2000).optional(),
                active: z.boolean().optional(),
              })
              .parse(b);
      Object.assign(c, input, { updatedAt: new Date().toISOString() });
      db.put("classes", c);
      audit(c.active ? "CLASS_UPDATED" : "CLASS_ARCHIVED", { actorId: user.id, classId: c.id, targetId: c.id });
      return json({ ok: true, class: c });
    }
  }
  if (p === "/api/admin/users") {
    if (method === "GET") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      return json({
        users: db
          .list("users")
          .filter((u) => !q || `${u.email} ${u.firstName} ${u.lastName}`.toLowerCase().includes(q)),
      });
    }
    if (method === "PATCH") {
      const input = z
          .object({
            status: z.enum(["ACTIVE", "DISABLED"]),
            globalRole: z.enum(["ADMIN", "STUDENT", "INSTRUCTOR", "TA"]).optional(),
          })
          .parse(b),
        u = db.get("users", url.searchParams.get("id") || "");
      if (!u) fail(404, "User not found");
      const losingAdmin =
        u.status === "ACTIVE" &&
        u.globalRole === "ADMIN" &&
        (input.status === "DISABLED" || (input.globalRole && input.globalRole !== "ADMIN"));
      if (losingAdmin && db.list("users").filter((v) => v.status === "ACTIVE" && v.globalRole === "ADMIN").length === 1)
        fail(409, "Cannot disable or demote the final active administrator");
      Object.assign(u, input);
      db.put("users", u);
      audit(u.status === "DISABLED" ? "USER_DISABLED" : "USER_ENABLED", { actorId: user.id, targetId: u.id });
      return json({ user: u });
    }
  }
  if (p === "/api/workers") {
    if (method === "GET") return json({ workers: db.list("workers") });
    if (method === "POST") {
      const input = WorkerCreateSchema.parse(b),
        w = db.put("workers", {
          ...input,
          baseUrl: workerUrl(input.baseUrl),
          id: randomUUID(),
          lastHealthCheck: null,
          healthStatus: "OFFLINE",
          lastAssignedAt: 0,
          externalBusy: false,
        });
      audit("WORKER_CREATED", { actorId: user.id, targetId: w.id, metadata: { name: w.name } });
      return json({ worker: w }, 201);
    }
  }
  const wMatch = p.match(/^\/api\/workers\/([^/]+)$/);
  if (wMatch && (method === "PATCH" || method === "DELETE")) {
    const w = db.get("workers", wMatch[1]);
    if (!w) fail(404, "Worker not found");
    const input = method === "DELETE" ? { enabled: false } : WorkerCreateSchema.partial().parse(b);
    if ("baseUrl" in input && input.baseUrl) input.baseUrl = workerUrl(input.baseUrl);
    if (db.list("jobs", "worker_id=? AND status IN ('RUNNING','DISPATCHING')", [w.id]).length && "baseUrl" in input)
      fail(409, "Wait for active jobs before changing worker URL");
    Object.assign(w, input);
    if (!w.enabled) w.healthStatus = "DISABLED";
    db.put("workers", w);
    audit(w.enabled ? "WORKER_UPDATED" : "WORKER_DISABLED", {
      actorId: user.id,
      targetId: w.id,
      metadata: { name: w.name },
    });
    return json({ ok: true, worker: w });
  }
  fail(404, "Route not found");
}
