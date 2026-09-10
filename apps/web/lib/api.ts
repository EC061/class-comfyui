import { z } from "zod";
import { randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import {
  getDb,
  audit,
  activeMembership,
  type Verification,
  type User,
  type Enrollment,
  type Role,
} from "@class-comfyui/database";
import { getEnv, appUrl } from "@class-comfyui/config";
import {
  hashToken,
  newVerificationToken,
  randomToken,
  checkAdminCode,
  hashPassword,
  verifyPassword,
  hasPassword,
  signWorkspaceToken,
  parseRosterCsv,
  reconcileRoster,
} from "@class-comfyui/auth";
import {
  EmailSchema,
  PasswordSchema,
  ClassCreateSchema,
  WorkerCreateSchema,
  canonicalEmail,
} from "@class-comfyui/shared";
import { currentUser } from "./auth-helpers";
import { requireOrigin } from "./origin";
import { checkRateLimit, clientIp } from "./rate-limit";
import { createSession, sessionCookieValue, destroySessionByCookie, clearSessionCookie } from "./session";
import {
  sendMail,
  activationEmail,
  buildActivationLink,
  passwordResetEmail,
  buildResetLink,
  signupInviteEmail,
} from "./mailer";
import { generateSignupUrl, validateSignupToken, setSignupEnabled } from "./signup";
import { purgeClass, ActiveJobsError } from "./purge";
class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}
function fail(status: number, message: string, code?: string): never {
  throw new ApiError(status, message, code);
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
const RegisterSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  firstName: z.string().trim().max(100).default(""),
  lastName: z.string().trim().max(100).default(""),
  classSlug: z.string().max(100).default(""),
  signupToken: z.string().max(200).default(""),
  adminCode: z.string().max(1000).default(""),
});
const TokenSchema = z.string().min(20).max(200);

function sessionResponse(u: User, extra: Record<string, unknown> = {}) {
  const session = createSession(u.id);
  const res = json({ ok: true, role: u.globalRole, userId: u.id, ...extra });
  res.headers.set("Set-Cookie", sessionCookieValue(session.raw, session.expiresAt));
  return res;
}

/**
 * Issues a fresh activation challenge, carrying over the class context of the
 * challenge it replaces so a re-sent link still enrolls the student. Callers must
 * already hold a write transaction.
 */
function issueActivation(u: User): string {
  const db = getDb(),
    raw = newVerificationToken();
  const previous = db
    .list("verifications", "email=?", [u.email])
    .filter((v) => v.purpose === "ACTIVATE" && !v.consumedAt)
    .sort((a, b) => a.expiresAt - b.expiresAt)
    .at(-1);
  db.deleteWhere("verifications", "email=? AND json_extract(data,'$.purpose')='ACTIVATE'", [u.email]);
  const row: Verification = {
    id: hashToken(raw),
    email: u.email,
    purpose: "ACTIVATE",
    userId: u.id,
    classId: previous?.classId ?? null,
    enrollmentIds: previous?.enrollmentIds ?? [],
    signupVersion: previous?.signupVersion ?? null,
    expiresAt: Date.now() + getEnv().VERIFICATION_TTL_MINUTES * 60000,
    consumedAt: null,
  };
  db.put("verifications", row);
  return raw;
}

async function deliverActivation(email: string, raw: string) {
  try {
    await sendMail(activationEmail(email, buildActivationLink(raw, email)));
  } catch {
    getDb().deleteWhere("verifications", "id=?", [hashToken(raw)]);
    fail(502, "Email delivery failed. Please retry or contact the administrator.");
  }
}

/**
 * One registration endpoint for both roles. The password is chosen here and the
 * account is created inactive; a single confirmation of the address activates it,
 * and every later sign-in is password-only.
 *
 * An administrator registration code produces an administrator, a valid class
 * signup link produces a student, and neither produces nothing: self-service
 * accounts are impossible.
 */
async function register(req: Request, b: Record<string, any>) {
  const input = RegisterSchema.parse(b),
    env = getEnv(),
    ip = clientIp(req.headers);
  limit("register-ip", ip, 20, 300000);
  limit("register-email", input.email, 5, 300000);
  if (input.adminCode) limit("admin-register", ip, 5, 300000);
  // Hashing is deliberately expensive, so it happens before the writer transaction.
  const passwordHash = await hashPassword(input.password);
  const raw = newVerificationToken();
  getDb().transaction(() => {
    const db = getDb(),
      existing = db.userByEmail(input.email);
    // An unactivated account is not proof of ownership, so its owner-to-be may
    // register over it. That is what stops one from squatting someone's address.
    if (existing && existing.status !== "PENDING")
      fail(409, "An account with this email already exists. Sign in, or use the password reset link.", "EXISTS");

    let role: Role = "STUDENT",
      classId: string | null = null,
      signupVersion: number | null = null,
      enrollmentIds: string[] = [],
      rosterFirst = "",
      rosterLast = "";
    if (input.adminCode) {
      if (!checkAdminCode(input.adminCode, env.ADMIN_REGISTRATION_CODE))
        fail(403, "Incorrect administrator registration code");
      role = "ADMIN";
    } else if (input.classSlug || input.signupToken) {
      if (!input.classSlug || !input.signupToken) fail(403, "A valid class signup link is required");
      const valid = validateSignupToken(input.classSlug, input.signupToken);
      if (!valid.ok) fail(403, "Invalid or disabled signup link");
      const enrollment = db
        .list("enrollments", "class_id=? AND email=?", [valid.classId!, input.email])
        .find((e) => e.status !== "ARCHIVED");
      if (!enrollment) fail(403, "This email is not eligible for this class");
      if (enrollment.userId) fail(409, "That enrollment already belongs to an account. Sign in instead.", "EXISTS");
      classId = valid.classId!;
      signupVersion = valid.version!;
      enrollmentIds = [enrollment.id];
      rosterFirst = enrollment.firstName;
      rosterLast = enrollment.lastName;
    } else {
      fail(403, "Use your class signup link, or an administrator registration code, to create an account.");
    }

    const now = new Date().toISOString();
    const u: User = existing ?? {
      id: randomUUID(),
      email: input.email,
      firstName: "",
      lastName: "",
      passwordHash: "",
      emailVerifiedAt: null,
      status: "PENDING",
      globalRole: role,
      lastLoginAt: null,
      createdAt: now,
    };
    u.firstName = input.firstName || rosterFirst || u.firstName;
    u.lastName = input.lastName || rosterLast || u.lastName;
    u.passwordHash = passwordHash;
    u.globalRole = role;
    u.status = "PENDING";
    db.put("users", u);
    db.deleteWhere("verifications", "email=? AND json_extract(data,'$.purpose')='ACTIVATE'", [input.email]);
    db.put("verifications", {
      id: hashToken(raw),
      email: input.email,
      purpose: "ACTIVATE",
      userId: u.id,
      classId,
      enrollmentIds,
      signupVersion,
      expiresAt: Date.now() + env.VERIFICATION_TTL_MINUTES * 60000,
      consumedAt: null,
    });
  });
  await deliverActivation(input.email, raw);
  return json({
    ok: true,
    message: "Account created. Open the confirmation email to activate it, then sign in.",
  });
}

/** The one email confirmation in an account's life: it activates and signs in. */
function activate(req: Request, b: Record<string, any>) {
  const input = z.object({ email: EmailSchema, token: TokenSchema }).parse(b);
  limit("verification", clientIp(req.headers), 120);
  return getDb().transaction(() => {
    const db = getDb(),
      row = db.get("verifications", hashToken(input.token));
    if (
      !row ||
      row.purpose !== "ACTIVATE" ||
      row.email !== input.email ||
      row.consumedAt ||
      row.expiresAt <= Date.now()
    )
      fail(400, "Invalid, used or expired activation link");
    const u = db.get("users", row.userId);
    if (!u || canonicalEmail(u.email) !== input.email) fail(400, "Invalid activation link");
    if (u.status === "DISABLED") fail(403, "Account unavailable");
    // Eligibility is re-read here: a roster change or a regenerated signup link
    // between registration and confirmation must win.
    const memberships: Enrollment[] = [];
    if (row.classId) {
      const c = db.get("classes", row.classId);
      if (!c?.active || !c.signupEnabled || c.signupTokenVersion !== row.signupVersion)
        fail(403, "Signup is no longer available; request a new link");
      for (const id of row.enrollmentIds) {
        const e = db.get("enrollments", id);
        if (!e || e.classId !== row.classId || canonicalEmail(e.rosterEmail) !== input.email || e.status === "ARCHIVED")
          fail(403, "Enrollment no longer eligible");
        memberships.push(e);
      }
      if (!memberships.length) fail(403, "Enrollment required");
    }
    const now = new Date().toISOString();
    const activating = u.status === "PENDING";
    u.status = "ACTIVE";
    u.emailVerifiedAt = u.emailVerifiedAt ?? now;
    u.lastLoginAt = now;
    db.put("users", u);
    for (const e of memberships) {
      e.userId = u.id;
      e.status = "ACTIVE";
      db.put("enrollments", e);
    }
    row.consumedAt = Date.now();
    db.put("verifications", row);
    if (activating)
      audit("ACCOUNT_ACTIVATED", {
        actorId: u.id,
        classId: row.classId,
        targetId: u.id,
        metadata: { role: u.globalRole },
      });
    if (activating && u.globalRole === "ADMIN") audit("ADMIN_REGISTERED", { actorId: u.id, targetId: u.id });
    return sessionResponse(u);
  });
}

// A stable decoy hash so signing in with an unknown address costs the same as
// signing in with a known one. Computed once, lazily, never stored.
let decoy: Promise<string> | undefined;

async function login(req: Request, b: Record<string, any>) {
  const input = z.object({ email: EmailSchema, password: z.string().min(1).max(200) }).parse(b);
  limit("login-ip", clientIp(req.headers), 60, 300000);
  limit("login-email", input.email, 10, 300000);
  const db = getDb(),
    u = db.userByEmail(input.email);
  const usable = u && hasPassword(u.passwordHash);
  const ok = await verifyPassword(
    input.password,
    usable ? u!.passwordHash : await (decoy ??= hashPassword(randomToken()))
  );
  if (!usable || !ok) fail(401, "Incorrect email or password");
  if (u!.status === "DISABLED") fail(403, "Account unavailable");
  if (u!.status === "PENDING")
    fail(403, "Confirm your email address to activate this account, then sign in.", "PENDING");
  return db.transaction(() => {
    const fresh = db.get("users", u!.id);
    if (!fresh || fresh.status !== "ACTIVE") fail(403, "Account unavailable");
    fresh.lastLoginAt = new Date().toISOString();
    db.put("users", fresh);
    return sessionResponse(fresh);
  });
}

/** Re-sends the activation link. Answers identically for addresses with no account. */
async function resendActivation(req: Request, b: Record<string, any>) {
  const input = z.object({ email: EmailSchema }).parse(b);
  limit("resend-ip", clientIp(req.headers), 20, 300000);
  limit("resend-email", input.email, 3, 900000);
  const quiet = json({ ok: true, message: "If that account is awaiting activation, a new link is on its way." });
  const u = getDb().userByEmail(input.email);
  if (!u || u.status !== "PENDING") return quiet;
  const raw = getDb().transaction(() => issueActivation(u));
  await deliverActivation(input.email, raw);
  return quiet;
}

/**
 * Password recovery, and the migration path for accounts created before passwords
 * existed. An account still awaiting activation gets its activation link instead,
 * because that is the link that also attaches its class enrollment.
 */
async function requestPasswordReset(req: Request, b: Record<string, any>) {
  const input = z.object({ email: EmailSchema }).parse(b);
  limit("reset-ip", clientIp(req.headers), 20, 300000);
  limit("reset-email", input.email, 3, 900000);
  const quiet = json({ ok: true, message: "If that address has an account, a password link is on its way." });
  const db = getDb(),
    u = db.userByEmail(input.email);
  if (!u || u.status === "DISABLED") return quiet;
  if (u.status === "PENDING") {
    const raw = db.transaction(() => issueActivation(u));
    await deliverActivation(input.email, raw);
    return quiet;
  }
  const raw = newVerificationToken();
  db.transaction(() => {
    db.deleteWhere("verifications", "email=? AND json_extract(data,'$.purpose')='RESET'", [input.email]);
    db.put("verifications", {
      id: hashToken(raw),
      email: input.email,
      purpose: "RESET",
      userId: u.id,
      classId: null,
      enrollmentIds: [],
      signupVersion: null,
      expiresAt: Date.now() + getEnv().VERIFICATION_TTL_MINUTES * 60000,
      consumedAt: null,
    });
  });
  try {
    await sendMail(passwordResetEmail(input.email, buildResetLink(raw, input.email)));
  } catch {
    db.deleteWhere("verifications", "id=?", [hashToken(raw)]);
    fail(502, "Email delivery failed. Please retry or contact the administrator.");
  }
  return quiet;
}

async function confirmPasswordReset(req: Request, b: Record<string, any>) {
  const input = z.object({ email: EmailSchema, token: TokenSchema, password: PasswordSchema }).parse(b);
  limit("reset-confirm", clientIp(req.headers), 60, 300000);
  const passwordHash = await hashPassword(input.password);
  return getDb().transaction(() => {
    const db = getDb(),
      row = db.get("verifications", hashToken(input.token));
    if (!row || row.purpose !== "RESET" || row.email !== input.email || row.consumedAt || row.expiresAt <= Date.now())
      fail(400, "Invalid, used or expired password link");
    const u = db.get("users", row.userId);
    if (!u || u.status === "DISABLED") fail(403, "Account unavailable");
    if (u.status === "PENDING") fail(403, "Activate this account from its confirmation email first.", "PENDING");
    u.passwordHash = passwordHash;
    u.emailVerifiedAt = u.emailVerifiedAt ?? new Date().toISOString();
    db.put("users", u);
    row.consumedAt = Date.now();
    db.put("verifications", row);
    // A new password ends every established session, workspace included.
    db.deleteWhere("sessions", "user_id=?", [u.id]);
    db.deleteWhere("gateway_sessions", "user_id=?", [u.id]);
    db.deleteWhere("workspace_tickets", "user_id=?", [u.id]);
    audit("PASSWORD_RESET", { actorId: u.id, targetId: u.id });
    return json({ ok: true, message: "Password updated. Sign in with your new password." });
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
    if (method === "POST" && p === "/api/auth/register") return await register(req, b);
    if (method === "POST" && p === "/api/auth/login") return await login(req, b);
    if (method === "POST" && p === "/api/auth/verify") return activate(req, b);
    if (method === "POST" && p === "/api/auth/resend") return await resendActivation(req, b);
    if (method === "POST" && p === "/api/auth/password-reset") return await requestPasswordReset(req, b);
    if (method === "POST" && p === "/api/auth/password-reset/confirm") return await confirmPasswordReset(req, b);
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
    // Joining a second class needs no new email confirmation: the account's address
    // is already proven, and the roster plus signup link still gate eligibility.
    if (p === "/api/enroll" && method === "POST")
      return db.transaction(() => {
        const input = z.object({ classSlug: z.string().max(100), signupToken: TokenSchema }).parse(b);
        limit("enroll", user.id, 10, 300000);
        const valid = validateSignupToken(input.classSlug, input.signupToken);
        if (!valid.ok) fail(403, "Invalid or disabled signup link");
        const e = db
          .list("enrollments", "class_id=? AND email=?", [valid.classId!, user.email])
          .find((v) => v.status !== "ARCHIVED");
        if (!e) fail(403, "This email is not eligible for this class");
        if (e.userId && e.userId !== user.id) fail(409, "That enrollment belongs to another account");
        if (e.userId === user.id && e.status === "ACTIVE") return json({ ok: true, classId: valid.classId! });
        e.userId = user.id;
        e.status = "ACTIVE";
        db.put("enrollments", e);
        audit("ENROLLMENT_JOINED", { actorId: user.id, classId: valid.classId!, targetId: e.id });
        return json({ ok: true, classId: valid.classId! });
      });
    // Lets an existing signed-in account claim administrator rights with the code,
    // so becoming an administrator never needs a second account.
    if (p === "/api/auth/admin-code" && method === "POST")
      return db.transaction(() => {
        const input = z.object({ adminCode: z.string().min(1).max(1000) }).parse(b);
        limit("admin-elevate-ip", clientIp(req.headers), 5, 300000);
        limit("admin-elevate", user.id, 5, 300000);
        if (!checkAdminCode(input.adminCode, getEnv().ADMIN_REGISTRATION_CODE))
          fail(403, "Incorrect administrator registration code");
        const u = db.get("users", user.id);
        if (!u || u.status !== "ACTIVE") fail(403, "Account unavailable");
        if (u.globalRole !== "ADMIN") {
          u.globalRole = "ADMIN";
          db.put("users", u);
          audit("ADMIN_REGISTERED", { actorId: u.id, targetId: u.id });
        }
        return json({ ok: true, role: u.globalRole });
      });
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
        students: db.list("users").filter((u) => u.globalRole === "STUDENT" && u.status === "ACTIVE").length,
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
    // Permanent class deletion touches the filesystem, so it cannot run inside the
    // single administrative write transaction below.
    const purgeMatch = p.match(/^\/api\/admin\/classes\/([^/]+)$/);
    if (purgeMatch && method === "DELETE") {
      const c = db.get("classes", purgeMatch[1]);
      if (!c) fail(404, "Class not found");
      const input = z.object({ confirm: z.string().max(200) }).parse(b);
      // Typing the slug is the confirmation: this destroys student work irreversibly.
      if (input.confirm !== c.slug) fail(400, `Type the class slug "${c.slug}" to confirm permanent deletion`);
      limit("class-delete", user.id, 5, 300000);
      let result;
      try {
        result = await purgeClass(c.id, user.id);
      } catch (e) {
        if (e instanceof ActiveJobsError) fail(409, e.message, "ACTIVE_JOBS");
        throw e;
      }
      if (!result) fail(404, "Class not found");
      return json({
        ok: !result.failures.length,
        slug: result.slug,
        deleted: result.rows,
        filesDeleted: result.filesDeleted,
        directoriesDeleted: result.directoriesDeleted,
        failures: result.failures,
        message: result.failures.length
          ? `Class deleted, but ${result.failures.length} path(s) could not be removed from disk.`
          : "Class and all of its stored data deleted.",
      });
    }
    // Every administrative read/modify/write runs under one short writer transaction.
    return db.transaction(() => adminRoute(user, p, method, b, url));
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status);
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
    // DELETE is permanent removal and is handled before this transaction; archiving
    // a class is `PATCH { active: false }`.
    if (method === "PATCH") {
      const input = z
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
      // An administrator may block an unconfirmed account but never confirm one for
      // its owner: activation is what proves the address and attaches the enrollment.
      if (u.status === "PENDING" && input.status === "ACTIVE")
        fail(409, "This account has not confirmed its email address yet and cannot be activated for it.");
      const losingAdmin =
        u.status === "ACTIVE" &&
        u.globalRole === "ADMIN" &&
        (input.status === "DISABLED" || (input.globalRole && input.globalRole !== "ADMIN"));
      if (losingAdmin && db.list("users").filter((v) => v.status === "ACTIVE" && v.globalRole === "ADMIN").length === 1)
        fail(409, "Cannot disable or demote the final active administrator");
      Object.assign(u, input);
      // Re-enabling an account that never confirmed its address returns it to
      // PENDING rather than ACTIVE, so blocking and unblocking cannot be used as a
      // two-step way around activation.
      if (u.status === "ACTIVE" && !u.emailVerifiedAt) u.status = "PENDING";
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
