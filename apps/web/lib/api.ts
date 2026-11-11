import { z } from "zod";
import { randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import {
  getDb,
  audit,
  activeMembership,
  fairQueuedJobs,
  type Verification,
  type User,
  type Worker,
  type ClassRow,
  type Enrollment,
  type Role,
  type Job,
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
  WorkerUpdateSchema,
  ADMIN_WORKSPACE_SLUG,
  GRANTS_PATH,
  GrantSchema,
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
import { purgeClass, purgeEnrollment, ActiveJobsError } from "./purge";
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
function publicUser(u: User | null | undefined) {
  if (!u) return null;
  const { passwordHash: _omitted, ...safe } = u;
  return safe;
}
function publicWorker(w: Worker) {
  const { nodeDefinitions: _omitted, ...safe } = w;
  return safe;
}
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
  // Campus Wi-Fi puts all 30+ students behind a shared NAT IP, so IP buckets
  // accommodate a full classroom burst while per-email buckets stay strict.
  limit("register-ip", ip, 150, 300000);
  limit("register-email", input.email, 5, 300000);
  if (input.adminCode) {
    limit("admin-register", ip, 5, 300000);
    if (!checkAdminCode(input.adminCode, env.ADMIN_REGISTRATION_CODE)) {
      audit("ADMIN_CODE_FAILED", { metadata: { email: input.email, ip, source: "register" } });
      fail(403, "Incorrect administrator registration code");
    }
  }
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
  limit("verification", clientIp(req.headers), 180);
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
  const input = z.object({ email: EmailSchema, password: z.string().min(1).max(200) }).parse(b),
    ip = clientIp(req.headers);
  limit("login-ip", ip, 200, 300000);
  limit("login-email", input.email, 10, 300000);
  const db = getDb(),
    u = db.userByEmail(input.email);
  const usable = u && hasPassword(u.passwordHash);
  const ok = await verifyPassword(
    input.password,
    usable ? u!.passwordHash : await (decoy ??= hashPassword(randomToken()))
  );
  if (!usable || !ok) {
    audit("LOGIN_FAILED", { actorId: u?.id ?? null, metadata: { email: input.email, ip } });
    fail(401, "Incorrect email or password");
  }
  if (u!.status === "DISABLED") fail(403, "Account unavailable");
  if (u!.status === "PENDING")
    fail(403, "Confirm your email address to activate this account, then sign in.", "PENDING");
  return db.transaction(() => {
    const fresh = db.get("users", u!.id);
    if (!fresh || fresh.status !== "ACTIVE") fail(403, "Account unavailable");
    fresh.lastLoginAt = new Date().toISOString();
    db.put("users", fresh);
    audit("LOGIN_SUCCEEDED", { actorId: fresh.id, targetId: fresh.id }, db);
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

function shapedJobs(user: User, url: URL, precomputedQueue?: Job[]) {
  const db = getDb();
  const jobId = url.searchParams.get("jobId");
  const fairQueue = precomputedQueue ?? fairQueuedJobs(db, getEnv().MAX_ACTIVE_JOBS_PER_USER);
  const queuePosById = new Map<string, number>();
  fairQueue.forEach((qj, idx) => queuePosById.set(qj.id, idx + 1));

  const q = (url.searchParams.get("q") || "").toLowerCase(),
    from = url.searchParams.get("from"),
    to = url.searchParams.get("to"),
    type = url.searchParams.get("outputType");

  let jobs: Job[];
  if (jobId) {
    const single = db.get("jobs", jobId);
    jobs = single && (user.globalRole === "ADMIN" || single.userId === user.id) ? [single] : [];
  } else {
    const clauses: string[] = [];
    const params: (string | number | null)[] = [];
    if (user.globalRole !== "ADMIN") {
      clauses.push("user_id=?");
      params.push(user.id);
    }
    for (const [paramName, col] of [
      ["classId", "class_id"],
      ["userId", "user_id"],
      ["status", "status"],
      ["workerId", "worker_id"],
    ] as const) {
      const v = url.searchParams.get(paramName);
      if (v) {
        clauses.push(`${col}=?`);
        params.push(v);
      }
    }
    if (from) {
      clauses.push("submitted_at>=?");
      params.push(from);
    }
    if (to) {
      clauses.push("submitted_at<=?");
      params.push(to + "T23:59:59.999Z");
    }
    const whereSql = clauses.length ? clauses.join(" AND ") : "1";
    const sqlLimit = q || type ? 2000 : 500;
    const rawRows = db.sql
      .prepare(
        `SELECT json_remove(data,'$.promptJson','$.submittedPromptJson','$.workflowJson','$.history') AS data FROM jobs WHERE ${whereSql} ORDER BY submitted_at DESC LIMIT ?`
      )
      .all(...params, sqlLimit) as Array<{ data: string }>;
    jobs = rawRows.map((r) => JSON.parse(r.data) as Job);
  }

  const workerNames = new Map<string, string | null>();
  const userEmails = new Map<string, string | undefined>();
  const getWorkerName = (wid: string | null) => {
    if (!wid) return null;
    if (!workerNames.has(wid)) workerNames.set(wid, db.get("workers", wid)?.name ?? null);
    return workerNames.get(wid)!;
  };
  const getEmail = (uid: string) => {
    if (!userEmails.has(uid)) userEmails.set(uid, db.get("users", uid)?.email);
    return userEmails.get(uid);
  };

  if (q) {
    jobs = jobs.filter((j) => `${j.id} ${j.orgDefinedId} ${getEmail(j.userId) ?? ""}`.toLowerCase().includes(q));
  }
  if (!type) {
    jobs = jobs.slice(0, 500);
  }

  const outputsByJobId = new Map<string, ReturnType<typeof db.list<"outputs">>>();
  if (jobs.length > 0) {
    const ids = jobs.map((j) => j.id);
    const placeholders = ids.map(() => "?").join(",");
    for (const o of db.list("outputs", `job_id IN (${placeholders})`, ids)) {
      const arr = outputsByJobId.get(o.jobId);
      if (arr) arr.push(o);
      else outputsByJobId.set(o.jobId, [o]);
    }
  }

  return jobs
    .map((j) => ({
      ...j,
      ...(jobId
        ? {}
        : {
            promptJson: undefined,
            submittedPromptJson: undefined,
            workflowJson: undefined,
          }),
      leaseOwner: undefined,
      extraData: undefined,
      history: undefined,
      queuePosition: j.status === "QUEUED" ? (queuePosById.get(j.id) ?? null) : null,
      workerName: getWorkerName(j.workerId),
      email: getEmail(j.userId),
      outputs: (outputsByJobId.get(j.id) || []).map((o) => ({
        ...o,
        storagePath: undefined,
        url: `/api/outputs/${o.id}`,
      })),
    }))
    .filter((j) => !type || j.outputs.some((o) => o.mimeType.startsWith(type)))
    .slice(0, 500);
}
function rosterPreview(user: User, b: Record<string, any>) {
  const input = z.object({ classId: z.string(), csv: z.string().min(1).max(5_000_000) }).parse(b),
    db = getDb(),
    cls = db.get("classes", input.classId);
  if (!cls || cls.system) fail(404, "Class not found");
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
    if (!c || c.system) fail(404, "Class not found");
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
          db.deleteWhere("gateway_sessions", "json_extract(data,'$.enrollmentId')=?", [e.id]);
          db.deleteWhere("workspace_tickets", "json_extract(data,'$.enrollmentId')=?", [e.id]);
          e.userId = null;
          e.status = "INVITED";
          delete e.h3Video;
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
      db.deleteWhere("gateway_sessions", "json_extract(data,'$.enrollmentId')=?", [e.id]);
      db.deleteWhere("workspace_tickets", "json_extract(data,'$.enrollmentId')=?", [e.id]);
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
        ? db
            .list("enrollments", "user_id=?", [user.id])
            .map((e) => {
              const c = db.get("classes", e.classId);
              if (c?.system) return null;
              return {
                ...e,
                classSlug: c?.slug,
                className: c?.name,
                courseCode: c?.courseCode,
                term: c?.term,
                classActive: c?.active,
                classPaused: Boolean(c?.paused),
              };
            })
            .filter((v): v is NonNullable<typeof v> => v !== null)
        : [];
      return json({ user: publicUser(user), enrollments });
    }
    if (!user) fail(401, "Authentication required");
    // Joining a second class needs no new email confirmation: the account's address
    // is already proven, and the roster plus signup link still gate eligibility.
    if (p === "/api/enroll" && method === "POST") {
      const input = z.object({ classSlug: z.string().max(100), signupToken: TokenSchema }).parse(b);
      limit("enroll", user.id, 10, 300000);
      return db.transaction(() => {
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
    }
    // Lets an existing signed-in account claim administrator rights with the code,
    // so becoming an administrator never needs a second account.
    if (p === "/api/auth/admin-code" && method === "POST") {
      const input = z.object({ adminCode: z.string().min(1).max(1000) }).parse(b),
        ip = clientIp(req.headers);
      limit("admin-elevate-ip", ip, 5, 300000);
      limit("admin-elevate", user.id, 5, 300000);
      if (!checkAdminCode(input.adminCode, getEnv().ADMIN_REGISTRATION_CODE)) {
        audit("ADMIN_CODE_FAILED", { actorId: user.id, targetId: user.id, metadata: { ip, source: "admin-code" } });
        fail(403, "Incorrect administrator registration code");
      }
      return db.transaction(() => {
        const u = db.get("users", user.id);
        if (!u || u.status !== "ACTIVE") fail(403, "Account unavailable");
        if (u.globalRole !== "ADMIN") {
          u.globalRole = "ADMIN";
          db.put("users", u);
          audit("ADMIN_REGISTERED", { actorId: u.id, targetId: u.id });
        }
        return json({ ok: true, role: u.globalRole });
      });
    }
    if (p === "/api/workspace/session" && method === "POST") {
      const input = z.object({ classId: z.string().min(1).optional() }).parse(b);
      limit("workspace", user.id, 60);
      return db.transaction(() => {
        const actor = db.get("users", user.id);
        if (!actor || actor.status !== "ACTIVE") fail(403, "Account unavailable");
        let e: Enrollment | undefined;
        if (!input.classId) {
          if (actor.globalRole !== "ADMIN") fail(400, "classId is required");
          e = ensureAdminWorkspace(db, actor);
        } else {
          const cls = db.get("classes", input.classId);
          const enrolled = db
            .list("enrollments", "class_id=? AND user_id=?", [input.classId, actor.id])
            .find((v) => v.status === "ACTIVE");
          if (cls?.active && cls.paused && actor.globalRole !== "ADMIN" && enrolled) {
            fail(403, "Access to ComfyUI for this class is currently paused by your instructor.", "CLASS_PAUSED");
          }
          e = activeMembership(db, actor.id, input.classId);
          if (!e) fail(403, "No active class enrollment");
        }
        const env = getEnv(),
          jti = randomUUID();
        db.put("workspace_tickets", {
          id: jti,
          userId: actor.id,
          classId: e.classId,
          enrollmentId: e.id,
          expiresAt: Date.now() + env.WORKSPACE_TOKEN_TTL_SECONDS * 1000,
          consumedAt: null,
        });
        const token = signWorkspaceToken(
          { sub: actor.id, classId: e.classId, enrollmentId: e.id, jti, ttlSeconds: env.WORKSPACE_TOKEN_TTL_SECONDS },
          env.WORKSPACE_JWT_SECRET
        );
        return json({ url: appUrl(env.COMFY_PUBLIC_URL, `/auth/exchange?token=${encodeURIComponent(token)}`) });
      });
    }
    if (p === "/api/jobs" && method === "GET") {
      const fairQueue = fairQueuedJobs(db, getEnv().MAX_ACTIVE_JOBS_PER_USER);
      const availableGpus = db
        .list("workers")
        .filter((w) => w.enabled && ["ONLINE", "BUSY"].includes(w.healthStatus) && !w.externalBusy).length;
      const runningJobs = Number(
        (
          db.sql.prepare("SELECT COUNT(*) AS cnt FROM jobs WHERE status IN ('DISPATCHING','RUNNING')").get() as {
            cnt: number;
          }
        )?.cnt || 0
      );
      return json({
        jobs: shapedJobs(user, url, fairQueue),
        queueSummary: {
          availableGpus,
          runningJobs,
          queuedJobs: fairQueue.length,
        },
      });
    }
    const retryMatch = p.match(/^\/api\/jobs\/([^/]+)\/archive$/);
    if (retryMatch && method === "POST") {
      limit("archive-retry", user.id, 5, 300000);
      return db.transaction(() => {
        const j = db.get("jobs", retryMatch[1]);
        if (!j || (user.globalRole !== "ADMIN" && j.userId !== user.id)) fail(404, "Job not found");
        if (j.status !== "COMPLETED" || j.archiveStatus !== "FAILED") fail(409, "Only failed archives can be retried");
        j.archiveStatus = "ARCHIVING";
        db.put("jobs", j);
        audit("ARCHIVE_RETRY_REQUESTED", { actorId: user.id, classId: j.classId, targetId: j.id });
        return json({ ok: true });
      });
    }
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
            db.put("jobs", current);
            audit("JOB_CANCELLED", {
              actorId: user.id,
              classId: current.classId,
              targetId: current.id,
              metadata: { status: "CANCELLED", source: "web_api" },
            });
          } else if (["RUNNING", "DISPATCHING"].includes(current.status) && !current.cancelRequested) {
            current.cancelRequested = true;
            db.put("jobs", current);
            audit("JOB_CANCEL_REQUESTED", {
              actorId: user.id,
              classId: current.classId,
              targetId: current.id,
              metadata: { source: "web_api" },
            });
          }
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
      const allWorkers = db.list("workers"),
        todayPrefix = new Date().toISOString().slice(0, 10) + "%";
      const scalar = (sql: string, ...params: (string | number | null)[]) =>
        Number((db.sql.prepare(sql).get(...params) as { cnt: number } | undefined)?.cnt || 0);
      return json({
        activeClasses: db.list("classes").filter((c) => c.active && !c.system).length,
        students: db.list("users").filter((u) => u.globalRole === "STUDENT" && u.status === "ACTIVE").length,
        pending: db.list("enrollments").filter((e) => !e.userId && e.status === "INVITED" && e.role === "STUDENT")
          .length,
        queued: scalar("SELECT COUNT(*) AS cnt FROM jobs WHERE status='QUEUED'"),
        active: scalar("SELECT COUNT(*) AS cnt FROM jobs WHERE status IN ('RUNNING','DISPATCHING')"),
        workers: allWorkers.length,
        gpus: allWorkers.filter((w) => w.enabled && ["ONLINE", "BUSY"].includes(w.healthStatus) && !w.externalBusy)
          .length,
        externalBusyGpus: allWorkers.filter((w) => w.enabled && w.externalBusy).length,
        jobsToday: scalar("SELECT COUNT(*) AS cnt FROM jobs WHERE submitted_at LIKE ?", todayPrefix),
        failures: scalar("SELECT COUNT(*) AS cnt FROM jobs WHERE status IN ('FAILED','LOST')"),
        outputsToday: scalar(
          "SELECT COUNT(o.id) AS cnt FROM outputs o JOIN jobs j ON j.id=o.job_id WHERE json_extract(j.data,'$.completedAt') LIKE ?",
          todayPrefix
        ),
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
      if (!c?.active || c.system || !c.signupEnabled) fail(403, "Class signup unavailable");
      const input = z.object({ signupUrl: z.url().max(1000) }).parse(b),
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
    // Permanent enrollment deletion also cleans up stored class files on disk, so it
    // runs outside the synchronous administrative write transaction below.
    const enrollmentDeleteMatch = p.match(/^\/api\/admin\/classes\/([^/]+)\/enrollments(?:\/([^/]+))?$/);
    if (enrollmentDeleteMatch && method === "DELETE") {
      const actor = db.get("users", user.id);
      if (actor?.globalRole !== "ADMIN" || actor.status !== "ACTIVE") fail(403, "Administrator required");
      const c = db.get("classes", enrollmentDeleteMatch[1]);
      if (!c || c.system) fail(404, "Class not found");
      const enrollmentId = enrollmentDeleteMatch[2] || z.object({ id: z.string().min(1) }).parse(b).id;
      limit("enrollment-delete", user.id, 60, 60000);
      let result;
      try {
        result = await purgeEnrollment(c.id, enrollmentId, user.id);
      } catch (e) {
        if (e instanceof ActiveJobsError) fail(409, e.message, "ACTIVE_JOBS");
        if (e instanceof Error && e.message === "FORBIDDEN") fail(403, "Administrator required");
        throw e;
      }
      if (!result) fail(404, "Enrollment not found");
      return json({
        ok: !result.failures.length,
        deleted: result.rows,
        filesDeleted: result.filesDeleted,
        directoriesDeleted: result.directoriesDeleted,
        failures: result.failures,
      });
    }
    // Permanent class deletion touches the filesystem, so it cannot run inside the
    // single administrative write transaction below.
    const purgeMatch = p.match(/^\/api\/admin\/classes\/([^/]+)$/);
    if (purgeMatch && method === "DELETE") {
      const c = db.get("classes", purgeMatch[1]);
      if (!c || c.system) fail(404, "Class not found");
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
function ensureAdminWorkspace(db: ReturnType<typeof getDb>, actor: User): Enrollment {
  const now = new Date().toISOString();
  let cls = db.list("classes", "slug=?", [ADMIN_WORKSPACE_SLUG])[0];
  if (!cls) {
    cls = db.put("classes", {
      id: randomUUID(),
      slug: ADMIN_WORKSPACE_SLUG,
      name: "Administrator Workspace",
      courseCode: "ADMIN",
      term: "Internal",
      description: "Direct ComfyUI workspace for administrators",
      active: true,
      paused: false,
      h3Video: true,
      system: true,
      signupEnabled: false,
      signupTokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
  } else if (!cls.active || cls.paused || !cls.system || !cls.h3Video) {
    Object.assign(cls, { active: true, paused: false, system: true, h3Video: true, updatedAt: now });
    db.put("classes", cls);
  }
  const orgId = `admin-${actor.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24)}`;
  let enrollment =
    db.list("enrollments", "class_id=? AND user_id=?", [cls.id, actor.id])[0] ??
    db.list("enrollments", "class_id=? AND email=?", [cls.id, actor.email])[0];
  if (!enrollment) {
    enrollment = {
      id: randomUUID(),
      classId: cls.id,
      userId: actor.id,
      rosterEmail: actor.email,
      orgDefinedId: orgId,
      firstName: actor.firstName || "Admin",
      lastName: actor.lastName || "User",
      role: "INSTRUCTOR",
      status: "ACTIVE",
      h3Video: true,
    };
  } else {
    Object.assign(enrollment, {
      userId: actor.id,
      rosterEmail: actor.email,
      role: "INSTRUCTOR",
      status: "ACTIVE",
      h3Video: true,
    });
  }
  return db.put("enrollments", enrollment);
}
function readGrants(userId: string, classId: string) {
  const row = getDb().list("user_data", "user_id=? AND class_id=? AND path=?", [userId, classId, GRANTS_PATH])[0];
  if (!row?.content) return { h3Video: false };
  try {
    return GrantSchema.parse(JSON.parse(row.content));
  } catch {
    return { h3Video: false };
  }
}
/** Merge one grant flag into the student's reserved row, preserving the rest. */
function setGrant(userId: string, classId: string, h3Video: boolean) {
  const db = getDb();
  const current = readGrants(userId, classId);
  const existing = db.list("user_data", "user_id=? AND class_id=? AND path=?", [userId, classId, GRANTS_PATH])[0];
  db.put("user_data", {
    id: existing?.id || randomUUID(),
    userId,
    classId,
    path: GRANTS_PATH,
    content: JSON.stringify({ ...current, h3Video }),
    modified: Date.now(),
  });
  return h3Video;
}
function effectiveEnrollmentH3(c: ClassRow, e: Enrollment): boolean {
  if (c.system) return true;
  if (e.userId && getDb().get("users", e.userId)?.globalRole === "ADMIN") return true;
  if (typeof e.h3Video === "boolean") return e.h3Video;
  if (c.h3Video) return true;
  if (e.userId) return readGrants(e.userId, c.id).h3Video;
  return false;
}
function adminRoute(user: User, p: string, method: string, b: Record<string, any>, url: URL) {
  const db = getDb();
  const actor = db.get("users", user.id);
  if (actor?.globalRole !== "ADMIN" || actor.status !== "ACTIVE") fail(403, "Administrator required");
  if (p === "/api/admin/classes") {
    if (method === "GET")
      return json({
        classes: db
          .list("classes")
          .filter((c) => !c.system)
          .map((c) => {
            const e = db.list("enrollments", "class_id=?", [c.id]);
            return {
              ...c,
              paused: Boolean(c.paused),
              h3Video: Boolean(c.h3Video),
              enrolled: e.length,
              registered: e.filter((v) => v.userId && v.status === "ACTIVE").length,
            };
          }),
      });
    if (method === "POST") {
      const input = ClassCreateSchema.parse(b),
        now = new Date().toISOString(),
        c = db.put("classes", {
          ...input,
          id: randomUUID(),
          active: true,
          paused: false,
          h3Video: Boolean(input.h3Video),
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
    if (!c || c.system) fail(404, "Class not found");
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
    if (clsMatch[2] === "enrollments" && method === "POST") {
      const input = z
        .object({
          email: EmailSchema,
          firstName: z.string().trim().max(100).default(""),
          lastName: z.string().trim().max(100).default(""),
          orgDefinedId: z.string().trim().max(64).default(""),
          h3Video: z.boolean().optional(),
        })
        .parse(b);
      const existingByEmail = db.list("enrollments", "class_id=? AND email=?", [c.id, input.email])[0];
      if (existingByEmail)
        fail(
          409,
          existingByEmail.status === "ARCHIVED"
            ? "A student with this email is archived on this roster — click Reactivate in the roster table instead"
            : "A student with this email is already on the roster for this class"
        );
      let orgDefinedId = input.orgDefinedId.replace(/^#+/, "").trim();
      if (orgDefinedId) {
        if (!/^[a-zA-Z0-9._-]{1,64}$/.test(orgDefinedId))
          fail(400, "Student ID may only contain letters, digits, '.', '_', or '-'");
        if (db.list("enrollments", "class_id=? AND org_id=?", [c.id, orgDefinedId]).length)
          fail(409, "Another student in this class already has that student ID");
      } else {
        do {
          orgDefinedId = `manual-${randomUUID().slice(0, 8)}`;
        } while (db.list("enrollments", "class_id=? AND org_id=?", [c.id, orgDefinedId]).length > 0);
      }
      const existingUser = db.userByEmail(input.email);
      const attachedUser =
        existingUser && existingUser.status === "ACTIVE" && existingUser.emailVerifiedAt ? existingUser : null;
      const e: Enrollment = {
        id: randomUUID(),
        classId: c.id,
        userId: attachedUser?.id ?? null,
        rosterEmail: input.email,
        orgDefinedId,
        firstName: input.firstName || attachedUser?.firstName || "",
        lastName: input.lastName || attachedUser?.lastName || "",
        role: "STUDENT",
        status: attachedUser ? "ACTIVE" : "INVITED",
        ...(input.h3Video !== undefined ? { h3Video: input.h3Video } : {}),
      };
      db.put("enrollments", e);
      if (attachedUser && input.h3Video !== undefined) {
        setGrant(attachedUser.id, c.id, input.h3Video);
      }
      audit("ENROLLMENT_ADDED", {
        actorId: user.id,
        classId: c.id,
        targetId: e.id,
        metadata: { email: e.rosterEmail, orgDefinedId: e.orgDefinedId },
      });
      return json(
        {
          enrollment: {
            ...e,
            lastLogin: attachedUser?.lastLoginAt ?? null,
            accountStatus: attachedUser?.status ?? "PENDING",
            h3Video: effectiveEnrollmentH3(c, e),
            jobs: 0,
            outputs: 0,
          },
        },
        201
      );
    }
    if (clsMatch[2] === "enrollments" && method === "PATCH") {
      const input = z
          .object({
            id: z.string(),
            status: z.enum(["ARCHIVED", "INVITED"]).optional(),
            h3Video: z.boolean().optional(),
          })
          .refine((v) => v.status !== undefined || v.h3Video !== undefined, "Nothing to update")
          .parse(b),
        e = db.get("enrollments", input.id);
      if (!e || e.classId !== c.id) fail(404, "Enrollment not found");
      if (input.status !== undefined) {
        const linkedUser = e.userId ? db.get("users", e.userId) : undefined;
        e.status = input.status === "ARCHIVED" ? "ARCHIVED" : linkedUser?.status === "ACTIVE" ? "ACTIVE" : "INVITED";
        db.put("enrollments", e);
        if (input.status === "ARCHIVED") {
          db.deleteWhere("gateway_sessions", "json_extract(data,'$.enrollmentId')=?", [e.id]);
          db.deleteWhere("workspace_tickets", "json_extract(data,'$.enrollmentId')=?", [e.id]);
        }
        audit(input.status === "ARCHIVED" ? "ENROLLMENT_ARCHIVED" : "ENROLLMENT_REACTIVATED", {
          actorId: user.id,
          classId: c.id,
          targetId: e.id,
        });
      }
      let h3Video: boolean | undefined;
      if (input.h3Video !== undefined) {
        e.h3Video = input.h3Video;
        db.put("enrollments", e);
        if (e.userId) setGrant(e.userId, c.id, input.h3Video);
        h3Video = input.h3Video;
        audit("GRANT_UPDATED", {
          actorId: user.id,
          classId: c.id,
          targetId: e.userId ?? e.id,
          metadata: { enrollmentId: e.id, h3Video },
        });
      }
      return json({ enrollment: e, ...(h3Video !== undefined ? { h3Video } : {}) });
    }
    if (method === "GET") {
      const jobCounts = new Map<string, number>();
      for (const r of db.sql
        .prepare("SELECT enrollment_id, COUNT(*) AS cnt FROM jobs WHERE class_id=? GROUP BY enrollment_id")
        .all(c.id) as Array<{ enrollment_id: string; cnt: number }>) {
        jobCounts.set(r.enrollment_id, Number(r.cnt));
      }
      const outputCounts = new Map<string, number>();
      for (const r of db.sql
        .prepare(
          "SELECT j.enrollment_id AS enrollment_id, COUNT(o.id) AS cnt FROM jobs j JOIN outputs o ON o.job_id=j.id WHERE j.class_id=? GROUP BY j.enrollment_id"
        )
        .all(c.id) as Array<{ enrollment_id: string; cnt: number }>) {
        outputCounts.set(r.enrollment_id, Number(r.cnt));
      }
      return json({
        class: { ...c, paused: Boolean(c.paused), h3Video: Boolean(c.h3Video) },
        enrollments: db.list("enrollments", "class_id=?", [c.id]).map((e) => ({
          ...e,
          lastLogin: e.userId ? db.get("users", e.userId)?.lastLoginAt : null,
          accountStatus: e.userId ? db.get("users", e.userId)?.status : "PENDING",
          h3Video: effectiveEnrollmentH3(c, e),
          jobs: jobCounts.get(e.id) || 0,
          outputs: outputCounts.get(e.id) || 0,
        })),
      });
    }
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
          paused: z.boolean().optional(),
          h3Video: z.boolean().optional(),
        })
        .parse(b);
      const wasPaused = Boolean(c.paused);
      const wasH3 = Boolean(c.h3Video);
      Object.assign(c, input, { updatedAt: new Date().toISOString() });
      db.put("classes", c);
      if (input.h3Video !== undefined && Boolean(c.h3Video) !== wasH3) {
        for (const e of db.list("enrollments", "class_id=?", [c.id])) {
          if (e.h3Video !== undefined) {
            delete e.h3Video;
            db.put("enrollments", e);
          }
          if (e.userId) setGrant(e.userId, c.id, input.h3Video);
        }
      }
      if (!c.active || c.paused) {
        db.deleteWhere("gateway_sessions", "json_extract(data,'$.classId')=?", [c.id]);
        db.deleteWhere("workspace_tickets", "class_id=?", [c.id]);
      }
      if (input.paused !== undefined && Boolean(c.paused) !== wasPaused) {
        audit(c.paused ? "CLASS_PAUSED" : "CLASS_RESUMED", { actorId: user.id, classId: c.id, targetId: c.id });
      }
      if (input.h3Video !== undefined && Boolean(c.h3Video) !== wasH3) {
        audit(c.h3Video ? "CLASS_H3_ENABLED" : "CLASS_H3_DISABLED", {
          actorId: user.id,
          classId: c.id,
          targetId: c.id,
        });
      }
      if (
        (input.paused === undefined || Boolean(c.paused) === wasPaused) &&
        (input.h3Video === undefined || Boolean(c.h3Video) === wasH3)
      ) {
        audit(c.active ? "CLASS_UPDATED" : "CLASS_ARCHIVED", { actorId: user.id, classId: c.id, targetId: c.id });
      }
      return json({ ok: true, class: { ...c, paused: Boolean(c.paused), h3Video: Boolean(c.h3Video) } });
    }
  }
  if (p === "/api/admin/users") {
    if (method === "GET") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      return json({
        users: db
          .list("users")
          .filter((u) => !q || `${u.email} ${u.firstName} ${u.lastName}`.toLowerCase().includes(q))
          .map((u) => publicUser(u)),
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
      if (u.status === "DISABLED") {
        db.deleteWhere("sessions", "user_id=?", [u.id]);
        db.deleteWhere("gateway_sessions", "user_id=?", [u.id]);
        db.deleteWhere("workspace_tickets", "user_id=?", [u.id]);
      }
      audit(u.status === "DISABLED" ? "USER_DISABLED" : "USER_ENABLED", { actorId: user.id, targetId: u.id });
      return json({ user: publicUser(u) });
    }
  }
  if (p === "/api/workers") {
    if (method === "GET") return json({ workers: db.list("workers").map(publicWorker) });
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
      return json({ worker: publicWorker(w) }, 201);
    }
  }
  const wMatch = p.match(/^\/api\/workers\/([^/]+)$/);
  if (wMatch && (method === "PATCH" || method === "DELETE")) {
    const w = db.get("workers", wMatch[1]);
    if (!w) fail(404, "Worker not found");
    const input = method === "DELETE" ? { enabled: false } : WorkerUpdateSchema.parse(b);
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
    return json({ ok: true, worker: publicWorker(w) });
  }
  fail(404, "Route not found");
}
