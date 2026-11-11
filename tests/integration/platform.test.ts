import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { getDb, closeDb, LabDatabase } from "@class-comfyui/database";
import { hashSessionToken } from "@class-comfyui/auth";
import { handleApi } from "../../apps/web/lib/api";
import { createApp, attachWs } from "../../apps/gateway/src/index";
import { Scheduler } from "../../apps/gateway/src/scheduler";
import { mockComfy } from "../mock-comfy";
let smtp: SMTPServer;
const emails: Array<{ to: string; text: string }> = [];
let dir: string;
const origin = "https://comfy-admin.example.edu";
let mock: Awaited<ReturnType<typeof mockComfy>>,
  gateway: ReturnType<typeof createServer>,
  gatewayUrl: string,
  scheduler: Scheduler | undefined;
async function api(
  p: string,
  b?: unknown,
  cookie = "",
  method = b === undefined ? "GET" : "POST",
  requestOrigin: string | null = origin
) {
  const h: Record<string, string> = { "Content-Type": "application/json", Host: new URL(origin).host };
  if (requestOrigin !== null) h.Origin = requestOrigin;
  if (cookie) h.Cookie = cookie;
  return handleApi(
    new Request(origin + "/api" + p, { method, headers: h, body: b === undefined ? undefined : JSON.stringify(b) })
  );
}
const authCookie = (r: Response) => r.headers.get("set-cookie")!.split(";")[0];
const PASSWORD = "correct-horse-battery-staple";
function mailLink(email: string) {
  const text = emails.filter((m) => m.to === email.toLowerCase()).at(-1)!.text;
  return new URL(text.match(/https?:\/\/\S+/)![0]);
}
/** Opens the one activation link an account ever receives. */
async function consume(email: string) {
  return api("/auth/verify", { email, token: mailLink(email).searchParams.get("token") });
}
async function login(email: string, password = PASSWORD) {
  return api("/auth/login", { email, password });
}
async function admin(email = "admin@example.edu") {
  const r = await api("/auth/register", {
    email,
    password: PASSWORD,
    adminCode: process.env.ADMIN_REGISTRATION_CODE,
  });
  expect(r.status).toBe(200);
  const res = await consume(email);
  expect(res.status).toBe(200);
  return authCookie(res);
}
async function createClass(cookie: string, slug = "class-a") {
  const r = await api(
    "/admin/classes",
    { name: "Web Programming", courseCode: "CSCI 4300", term: "Fall 2026", slug },
    cookie
  );
  expect(r.status).toBe(201);
  return (await r.json()).class;
}
async function roster(
  cookie: string,
  id: string,
  rows = ["#100000001,Example,Alice,student1@example.edu,#", "#100000002,Example,Bob,student2@example.edu,#"]
) {
  const csv = "OrgDefinedId,Last Name,First Name,Email,End-of-Line Indicator\n" + rows.join("\n");
  const r = await api("/roster/preview", { classId: id, csv }, cookie);
  expect(r.status).toBe(200);
  const preview = await r.json();
  const commit = await api("/roster/import", { importId: preview.importId }, cookie);
  expect(commit.status).toBe(200);
  return preview;
}
async function signup(cookie: string, c: any) {
  const r = await api(`/admin/classes/${c.id}/signup`, {}, cookie);
  expect(r.status).toBe(201);
  return (await r.json()).url as string;
}
async function register(c: any, url: string, email = "student1@example.edu", password = PASSWORD) {
  return api("/auth/register", { classSlug: c.slug, signupToken: url.split("/").at(-1), email, password });
}
async function student(c: any, url: string, email = "student1@example.edu") {
  expect((await register(c, url, email)).status).toBe(200);
  const v = await consume(email);
  expect(v.status).toBe(200);
  return authCookie(v);
}
async function workspace(cookie: string, classId: string) {
  const r = await api("/workspace/session", { classId }, cookie);
  expect(r.status).toBe(200);
  const u = new URL((await r.json()).url);
  const exchange = await fetch(gatewayUrl + u.pathname + u.search, { redirect: "manual" });
  expect(exchange.status).toBe(303);
  return authCookie(exchange);
}
async function gw(p: string, b?: unknown, cookie = "", requestOrigin: string | null = process.env.COMFY_PUBLIC_URL!) {
  return fetch(gatewayUrl + p, {
    method: b === undefined ? "GET" : "POST",
    headers: {
      ...(requestOrigin ? { Origin: requestOrigin } : {}),
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
}
const prompt = {
  prompt: {
    "1": { class_type: "SaveImage", inputs: { filename_prefix: "../../other-user", images: ["2", 0] } },
    "2": { class_type: "EmptyLatentImage", inputs: {} },
  },
  extra_data: { extra_pnginfo: { workflow: { id: "wf-integration", nodes: [{ id: 1 }] } } },
};
async function waitFor<T>(fn: () => T | Promise<T>, check: (v: T) => boolean, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await fn();
    if (check(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out");
}
beforeAll(async () => {
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["AUTH", "STARTTLS"],
    onData(stream, session, callback) {
      simpleParser(stream)
        .then((mail) => {
          emails.push({ to: session.envelope.rcptTo[0].address.toLowerCase(), text: mail.text || "" });
          callback();
        })
        .catch(callback);
    },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String((smtp.server.address() as { port: number }).port);
  process.env.SMTP_SECURE = "false";
  process.env.AUTH_SECRET = "test-auth-secret-that-is-at-least-32-characters";
  process.env.WORKSPACE_JWT_SECRET = "test-workspace-secret-that-is-at-least-32-characters";
  process.env.ADMIN_REGISTRATION_CODE = "test-admin-code-that-is-at-least-32-characters";
  process.env.GATEWAY_RUN = "0";
});
beforeEach(async () => {
  closeDb();
  emails.length = 0;
  dir = mkdtempSync(path.join(tmpdir(), "comfy-test-"));
  process.env.SQLITE_PATH = path.join(dir, "lab.sqlite");
  process.env.AUDIT_DATA_DIR = path.join(dir, "audit");
  process.env.UPLOAD_DATA_DIR = path.join(dir, "uploads");
  process.env.MAX_ARCHIVE_MB = "20480";
  process.env.PUBLIC_URL = origin;
  process.env.COMFY_PUBLIC_URL = "http://comfy.localhost:8080";
  getDb();
  mock = await mockComfy();
  gateway = createServer(createApp());
  attachWs(gateway);
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
  gatewayUrl = "http://127.0.0.1:" + (gateway.address() as { port: number }).port;
});
afterEach(async () => {
  await scheduler?.stop();
  scheduler = undefined;
  await new Promise((r) => setTimeout(r, 600));
  await new Promise<void>((r) => gateway.close(() => r()));
  await mock.close();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
afterAll(async () => {
  await new Promise<void>((r) => smtp.close(() => r()));
});
describe("real API, SQLite WAL, SMTP and gateway", () => {
  it("enforces exact origins and rejects Host-only fallback", async () => {
    for (const invalid of [
      "https://evil.example.com",
      "http://comfy-admin.example.edu",
      "https://comfy-admin.example.edu.evil.com",
      "https://sub.comfy-admin.example.edu",
      null,
    ])
      expect(
        (await api("/auth/login", { email: "a@example.edu", password: PASSWORD }, "", "POST", invalid)).status
      ).toBe(403);
    expect((await api("/auth/login", { email: "a@example.edu", password: PASSWORD })).status).toBe(401);
    // Neither a class signup link nor the administrator code: no account is possible.
    expect((await api("/auth/register", { email: "a@example.edu", password: PASSWORD })).status).toBe(403);
    const c = await admin();
    expect(
      (await api("/admin/classes", { name: "Allowed", slug: "allowed", courseCode: "A", term: "T" }, c)).status
    ).toBe(201);
  });
  it("persists admin, class, roster and session across connections and restarts; admin login works", async () => {
    const a = await admin(),
      c = await createClass(a);
    await roster(a, c.id);
    const file = process.env.SQLITE_PATH!;
    expect(getDb().sql.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    const second = new LabDatabase(file);
    expect(second.list("classes")[0].id).toBe(c.id);
    second.close();
    closeDb();
    expect((await api("/admin/classes", undefined, a)).status).toBe(200);
    expect((await login("admin@example.edu")).status).toBe(200);
    expect((await login("admin@example.edu", "wrong-password-entirely")).status).toBe(401);
  });
  it("requires roster and email ownership, binds class, revokes old links and pending challenges", async () => {
    const a = await admin(),
      c = await createClass(a);
    await roster(a, c.id);
    const url = await signup(a, c);
    const before = emails.length;
    expect((await register(c, url, "attacker@example.com")).status).toBe(403);
    expect(emails.length).toBe(before);
    expect(getDb().userByEmail("attacker@example.com")).toBeUndefined();
    const wrong = await createClass(a, "class-b"),
      wrongUrl = await signup(a, wrong);
    expect((await register(wrong, wrongUrl, "student1@example.edu")).status).toBe(403);
    expect((await register(c, url, "student1@example.edu")).status).toBe(200);
    // A password alone activates nothing: the account cannot sign in until its
    // address is confirmed, and its enrollment stays unclaimed.
    expect(getDb().userByEmail("student1@example.edu")?.status).toBe("PENDING");
    expect(getDb().list("enrollments", "email=?", ["student1@example.edu"])[0].userId).toBeNull();
    expect((await login("student1@example.edu")).status).toBe(403);
    // An administrator may block an unconfirmed account but cannot confirm it for its owner.
    const pendingId = getDb().userByEmail("student1@example.edu")!.id;
    expect((await api("/admin/users?id=" + pendingId, { status: "ACTIVE" }, a, "PATCH")).status).toBe(409);
    expect((await api("/admin/users?id=" + pendingId, { status: "DISABLED" }, a, "PATCH")).status).toBe(200);
    // Unblocking returns it to PENDING, so this is not a two-step way around activation.
    expect((await api("/admin/users?id=" + pendingId, { status: "ACTIVE" }, a, "PATCH")).status).toBe(200);
    expect(getDb().get("users", pendingId)?.status).toBe("PENDING");
    expect((await login("student1@example.edu")).status).toBe(403);
    await signup(a, c);
    expect((await consume("student1@example.edu")).status).toBe(403);
    expect(getDb().userByEmail("student1@example.edu")?.status).toBe("PENDING");
    expect(getDb().list("enrollments", "email=?", ["student1@example.edu"])[0].userId).toBeNull();
    expect((await register(c, url, "student2@example.edu")).status).toBe(403);
    // Re-registering over an unconfirmed account replaces its password, so the
    // rightful owner of an address can always take it back.
    const fresh = await signup(a, c);
    expect((await register(c, fresh, "student1@example.edu", "a-different-long-password")).status).toBe(200);
    expect((await consume("student1@example.edu")).status).toBe(200);
    expect((await login("student1@example.edu", "a-different-long-password")).status).toBe(200);
    expect((await login("student1@example.edu")).status).toBe(401);
  });
  it("registration is single use, preserves global account, and disabled signup does not disable login", async () => {
    const a = await admin(),
      c = await createClass(a);
    await roster(a, c.id);
    const url = await signup(a, c);
    const alice = await student(c, url, "Student1@Example.EDU");
    expect((await consume("student1@example.edu")).status).toBe(400);
    const u = getDb().userByEmail("student1@example.edu")!;
    await api(`/admin/classes/${c.id}/signup`, { enabled: false }, a, "PATCH");
    expect((await login("student1@example.edu")).status).toBe(200);
    const c2 = await createClass(a, "class-b");
    await roster(a, c2.id);
    const url2 = await signup(a, c2);
    // Registering again over a confirmed account is refused; the second class is
    // joined from the signed-in session and sends no further confirmation email.
    expect((await register(c2, url2, "student1@example.edu")).status).toBe(409);
    const before = emails.length;
    const join = await api("/enroll", { classSlug: c2.slug, signupToken: url2.split("/").at(-1) }, alice);
    expect(join.status).toBe(200);
    expect(emails.length).toBe(before);
    expect(getDb().userByEmail(u.email)?.id).toBe(u.id);
    expect(getDb().list("enrollments", "user_id=?", [u.id])).toHaveLength(2);
  });
  it("expired verification and disabled accounts are denied; final admin changes are atomic", async () => {
    const a = await admin();
    const adminUser = getDb().userByEmail("admin@example.edu")!;
    expect((await api("/admin/users?id=" + adminUser.id, { status: "DISABLED" }, a, "PATCH")).status).toBe(409);
    expect((await api("/auth/password-reset", { email: "admin@example.edu" })).status).toBe(200);
    for (const t of getDb().list("verifications")) {
      t.expiresAt = 0;
      getDb().put("verifications", t);
    }
    expect(
      (
        await api("/auth/password-reset/confirm", {
          email: "admin@example.edu",
          token: mailLink("admin@example.edu").searchParams.get("token"),
          password: "yet-another-long-password",
        })
      ).status
    ).toBe(400);
    expect((await login("admin@example.edu")).status).toBe(200);
    const c = await createClass(a);
    await roster(a, c.id);
    await student(c, await signup(a, c));
    const u = getDb().userByEmail("student1@example.edu")!;
    await api("/admin/users?id=" + u.id, { status: "DISABLED" }, a, "PATCH");
    expect((await login(u.email)).status).toBe(403);
  });
  it("previews, reconciles, and rolls back conflicting roster import", async () => {
    const a = await admin(),
      c = await createClass(a);
    const preview = await roster(a, c.id);
    expect(preview.preview.newCount).toBe(2);
    const re = await roster(a, c.id);
    expect(re.preview.unchangedCount).toBe(2);
    const csv =
      "OrgDefinedId,Last Name,First Name,Email,End-of-Line Indicator\n#100000003,New,One,new@example.edu,#\n#100000002,Conflict,Two,student1@example.edu,#";
    const p = await api("/roster/preview", { classId: c.id, csv }, a);
    const id = (await p.json()).importId;
    expect((await api("/roster/import", { importId: id }, a)).status).toBe(409);
    expect(getDb().list("enrollments", "class_id=?", [c.id])).toHaveLength(2);
  });
  it("does not log tokens or report success when SMTP fails; invitation URL is canonical", async () => {
    const a = await admin(),
      c = await createClass(a);
    await roster(a, c.id);
    const url = await signup(a, c);
    expect(
      (
        await api(
          `/admin/classes/${c.id}/email-signup`,
          { signupUrl: url.replace(origin, "https://evil.example.com") },
          a
        )
      ).status
    ).toBe(400);
    const old = process.env.SMTP_PORT;
    process.env.SMTP_PORT = "1";
    expect((await api("/auth/password-reset", { email: "admin@example.edu" })).status).toBe(502);
    process.env.SMTP_PORT = old;
    expect(
      getDb()
        .list("verifications")
        .filter((v) => !v.consumedAt)
    ).toHaveLength(0);
  });
  it("queues multiple users, limits worker concurrency, archives checksummed outputs and isolates history, files, websocket and userdata", async () => {
    const a = await admin(),
      c = await createClass(a);
    await roster(a, c.id);
    const url = await signup(a, c),
      alice = await student(c, url),
      bob = await student(c, url, "student2@example.edu");
    await api("/workers", { name: "GPU", baseUrl: mock.url }, a);
    const w = getDb().list("workers")[0];
    w.healthStatus = "ONLINE";
    getDb().put("workers", w);
    const ga = await workspace(alice, c.id),
      gb = await workspace(bob, c.id);
    const messages: any[] = [];
    const ws = new WebSocket(gatewayUrl.replace("http", "ws") + "/ws", {
      headers: { Cookie: ga, Origin: process.env.COMFY_PUBLIC_URL! },
    });
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => ws.once("open", r));
    const ar = await gw("/prompt", prompt, ga),
      br = await gw("/prompt", prompt, gb);
    expect(ar.status).toBe(200);
    expect(br.status).toBe(200);
    const aid = (await ar.json()).prompt_id,
      bid = (await br.json()).prompt_id;
    expect((await (await gw("/queue", undefined, ga)).json()).queue_pending.map((v: any) => v[1])).toEqual([aid]);
    scheduler = new Scheduler((j, e) => {
      if (j.userId === getDb().userByEmail("student1@example.edu")?.id) messages.push(e);
    });
    scheduler.start();
    await waitFor(
      () => getDb().get("jobs", bid),
      (j) => j?.archiveStatus === "COMPLETE"
    );
    expect(mock.maxRunning).toBe(1);
    expect(mock.submissions.every((v) => v.client_id && v.prompt["1"].inputs.filename_prefix.startsWith("lab/"))).toBe(
      true
    );
    const outputs = getDb().list("outputs"),
      ao = outputs.find((o) => o.jobId === aid)!,
      bo = outputs.find((o) => o.jobId === bid)!;
    expect(ao.fileName).not.toBe(bo.fileName);
    expect(ao.storagePath).toContain("/class-a/100000001/");
    expect(ao.sha256).toBe(createHash("sha256").update(readFileSync(ao.storagePath)).digest("hex"));
    expect((await gw("/history/" + bid, undefined, ga)).status).toBe(200);
    expect(await (await gw("/history/" + bid, undefined, ga)).json()).toEqual({});
    // The frontend's Jobs panel polls the gateway's own list. It must be scoped
    // like /queue and /history: the worker's /api/jobs reads prompt_queue and
    // history globally, so proxying it would show each student the whole class.
    const mine = await (await gw("/jobs?limit=64&offset=0", undefined, ga)).json();
    expect(mine.jobs.map((j: any) => j.id)).toEqual([aid]);
    // The worker's own field names (comfy_execution/jobs.py normalize_*), so the
    // panel needs no special-casing. `created_at`/`execution_duration` name sort
    // behaviors there, not fields, and must not appear on the job.
    expect(mine.jobs[0].create_time).toBe(Date.parse(getDb().get("jobs", aid)!.submittedAt));
    expect(mine.jobs[0]).not.toHaveProperty("created_at");
    expect(mine.jobs[0]).not.toHaveProperty("execution_duration");
    expect(typeof mine.jobs[0].outputs_count).toBe("number");
    // workflow_id is the submitted graph's own id, and filtering on it stays
    // inside the student's own jobs.
    expect(mine.jobs[0].workflow_id).toBe("wf-integration");
    const filtered = await (await gw("/jobs?workflow_id=wf-integration", undefined, ga)).json();
    expect(filtered.jobs.map((j: any) => j.id)).toEqual([aid]);
    expect((await (await gw("/jobs?workflow_id=other", undefined, ga)).json()).pagination.total).toBe(0);
    expect(mine.pagination).toEqual({ offset: 0, limit: 64, total: 1, has_more: false });
    expect(["pending", "in_progress", "completed", "failed", "cancelled"]).toContain(mine.jobs[0].status);
    const theirs = await (await gw("/jobs", undefined, gb)).json();
    expect(theirs.jobs.map((j: any) => j.id)).toEqual([bid]);
    // A finished job carries what the panel renders from history: the execution
    // span and a preview pointing at the archived filename, never the worker's.
    const done = theirs.jobs[0];
    expect(done.status).toBe("completed");
    expect(done.outputs_count).toBeGreaterThan(0);
    expect(done.previewable_outputs_count).toBeGreaterThan(0);
    expect(done.execution_end_time).toBeGreaterThanOrEqual(done.execution_start_time);
    expect(done.preview_output.filename).toBe(bo.fileName);
    expect(done.preview_output.nodeId).toBeTruthy();
    expect(done).not.toHaveProperty("execution_error");
    // Detail endpoint (/api/jobs/:id) returns outputs, execution_status, and workflow for owner only.
    const detailRes = await gw("/jobs/" + aid, undefined, ga);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.id).toBe(aid);
    expect(detail.outputs).toBeTruthy();
    expect(detail.execution_status).toMatchObject({ status_str: "success", completed: true });
    expect((await gw("/jobs/" + bid, undefined, ga)).status).toBe(404);
    expect((await gw("/jobs/" + aid + "/cancel", {}, gb)).status).toBe(404);
    // A status the worker would reject must not silently return everything.
    expect((await gw("/jobs?status=finished", undefined, ga)).status).toBe(400);
    expect((await gw("/jobs?sort_by=user_id", undefined, ga)).status).toBe(400);
    expect((await gw("/jobs?limit=0", undefined, ga)).status).toBe(400);
    expect((await gw("/jobs?status=pending,in_progress&offset=99", undefined, ga)).status).toBe(200);
    expect((await gw("/jobs")).status).toBe(401);
    expect((await gw("/view?filename=" + bo.fileName, undefined, ga)).status).toBe(404);
    expect((await api("/outputs/" + bo.id, undefined, alice)).status).toBe(404);
    expect((await api("/outputs/" + ao.id, undefined, alice)).status).toBe(200);
    expect((await api("/jobs", undefined, a)).status).toBe(200);
    expect((await (await api("/jobs", undefined, alice)).json()).jobs.map((j: any) => j.id)).toEqual([aid]);
    await gw("/userdata/workflows/test.json", { nodes: ["alice"] }, ga);
    const listing = await (await gw("/api/userdata?dir=workflows&recurse=true&full_info=true", undefined, ga)).json();
    const paths = listing.map((v: any) => v.path);
    expect(paths).toContain("test.json");
    // Starter workflows are seeded on workspace entry, so the directory is not
    // empty for a student who has never saved anything.
    expect(paths).toContain("1 - Image (Flux).json");
    expect(paths).toContain("1b - Image (Qwen 2.1 Turbo).json");
    expect(paths).toContain("1c - Image Edit (Qwen 2.1 Turbo).json");
    expect(paths).toContain("2 - Video (Wan 1.3B).json");
    // The seeding marker shares the user_data table with the student's files but
    // must never surface as one.
    expect(await (await gw("/api/userdata?recurse=true", undefined, ga)).json()).not.toContain("__starters__");
    // The template browser reads its own index. It lists the curated starters
    // and nothing else: a stock graph would open in the editor and then fail at
    // submit time on a missing model or a denied node.
    const templates = await (await gw("/templates/index.json", undefined, ga)).json();
    const names = templates.flatMap((c: any) => c.templates.map((t: any) => t.name));
    expect(names).toEqual([
      "class_image_flux",
      "class_image_qwen_2_1_turbo",
      "class_image_qwen_2_1_turbo_edit",
      "class_video_wan_t2v_1_3b",
    ]);
    const graph = await gw("/templates/class_image_flux.json", undefined, ga);
    expect(graph.status).toBe(200);
    expect((await graph.json()).nodes.length).toBeGreaterThan(0);
    const qwenGraph = await gw("/templates/class_image_qwen_2_1_turbo.json", undefined, ga);
    expect(qwenGraph.status).toBe(200);
    expect((await qwenGraph.json()).nodes.length).toBeGreaterThan(0);
    const qwenEditGraph = await gw("/templates/class_image_qwen_2_1_turbo_edit.json", undefined, ga);
    expect(qwenEditGraph.status).toBe(200);
    expect((await qwenEditGraph.json()).nodes.length).toBeGreaterThan(0);
    const videoGraph = await gw("/templates/class_video_wan_t2v_1_3b.json", undefined, ga);
    expect(videoGraph.status).toBe(200);
    expect((await videoGraph.json()).nodes.length).toBeGreaterThan(0);
    expect((await gw("/templates/image_z_image_turbo.json", undefined, ga)).status).toBe(404);
    expect(await (await gw("/api/workflow_templates", undefined, ga)).json()).toEqual({});
    expect((await gw("/templates/index.json")).status).toBe(401);
    // Default queue progress settings are enabled out of the box.
    expect(await (await gw("/api/settings/Comfy.Queue.QPOV2", undefined, ga)).json()).toBe(true);
    expect(await (await gw("/api/settings/Comfy.Queue.ShowRunProgressBar", undefined, ga)).json()).toBe(true);
    const settings = await fetch(gatewayUrl + "/api/settings/theme", {
      method: "POST",
      headers: { Cookie: ga, Origin: process.env.COMFY_PUBLIC_URL! },
      body: JSON.stringify("dark"),
    });
    expect(settings.status).toBe(200);
    expect(await (await gw("/api/settings/theme", undefined, ga)).json()).toBe("dark");
    expect(await (await gw("/api/settings/theme", undefined, gb)).json()).toBeNull();
    const rename = await gw(
      "/api/userdata/workflows%2Ftest.json/move/workflows%2Frenamed.json?overwrite=false",
      {},
      ga
    );
    expect(rename.status).toBe(200);
    expect((await gw("/api/userdata/workflows%2Frenamed.json", undefined, ga)).status).toBe(200);
    expect((await gw("/api/userdata/workflows%2Frenamed.json", undefined, gb)).status).toBe(404);

    expect((await gw("/userdata/workflows/test.json", undefined, gb)).status).toBe(404);
    expect(messages.some((m) => m.data?.prompt_id === bid)).toBe(false);
    // Frontend 1.58.5 relies on execution_start, execution_cached, progress_state (with rewritten node prompt_id), and executed (with display_node).
    expect(messages.some((m) => m.type === "execution_start" && m.data?.prompt_id === aid)).toBe(true);
    expect(messages.some((m) => m.type === "execution_cached" && m.data?.prompt_id === aid)).toBe(true);
    const progressState = messages.find((m) => m.type === "progress_state" && m.data?.prompt_id === aid);
    expect(progressState).toBeTruthy();
    expect(progressState.data.nodes["1"].prompt_id).toBe(aid);
    const executedMsg = messages.find((m) => m.type === "executed" && m.data?.prompt_id === aid);
    expect(executedMsg).toBeTruthy();
    expect(executedMsg.data.display_node).toBe("1");
    ws.send(JSON.stringify({ type: "feature_flags", data: { supports_preview_metadata: true } }));
    await waitFor(
      () => messages.find((m) => m.type === "feature_flags"),
      (v) => Boolean(v)
    );
    expect((await gw("/private", undefined, ga)).status).toBe(404);
    expect((await gw("/queue", { clear: true }, ga, "https://evil.example.com")).status).toBe(403);
    expect((await gw("/queue", { clear: true }, ga, null)).status).toBe(403);
    await new Promise<void>((resolve) => {
      const bad = new WebSocket(gatewayUrl.replace("http", "ws") + "/ws", {
        headers: { Cookie: ga, Origin: "https://evil.example.com" },
      });
      bad.on("unexpected-response", (_r, r) => {
        expect(r.statusCode).toBe(403);
        r.resume();
        bad.terminate();
        resolve();
      });
      bad.on("error", () => {});
    });
    const u = getDb().userByEmail("student1@example.edu")!;
    await api("/admin/users?id=" + u.id, { status: "DISABLED" }, a, "PATCH");
    expect((await gw("/history", undefined, ga)).status).toBe(401);
    ws.close();
  });

  it("isolates identical upload filenames and rejects cross-user image references before scheduling", async () => {
    const a = await admin(),
      c = await createClass(a);
    await roster(a, c.id);
    const link = await signup(a, c),
      alice = await student(c, link),
      bob = await student(c, link, "student2@example.edu");
    await api("/workers", { name: "GPU", baseUrl: mock.url }, a);
    const w = getDb().list("workers")[0];
    w.healthStatus = "ONLINE";
    getDb().put("workers", w);
    const ga = await workspace(alice, c.id),
      gb = await workspace(bob, c.id);
    async function upload(cookie: string) {
      const form = new FormData();
      form.set("image", new Blob([Buffer.from("fake-png-for-transport-test")], { type: "image/png" }), "same-name.png");
      const r = await fetch(gatewayUrl + "/upload/image", {
        method: "POST",
        headers: { Origin: process.env.COMFY_PUBLIC_URL!, Cookie: cookie },
        body: form,
      });
      expect(r.status).toBe(200);
      return (await r.json()).name as string;
    }
    const [ua, ub] = await Promise.all([upload(ga), upload(gb)]);
    expect(ua).not.toBe(ub);
    const info = await (await gw("/object_info", undefined, ga)).json();
    expect(info.LoadImage.input.required.image[0]).toEqual([ua]);
    expect((await gw("/view?filename=" + ub, undefined, ga)).status).toBe(404);
    const input = { prompt: { "1": { class_type: "LoadImage", inputs: { image: ub } } } };
    expect((await gw("/prompt", input, ga)).status).toBe(403);
    input.prompt["1"].inputs.image = ua;
    const r = await gw("/prompt", input, ga);
    expect(r.status).toBe(200);
    const id = (await r.json()).prompt_id;
    scheduler = new Scheduler();
    scheduler.start();
    await waitFor(
      () => getDb().get("jobs", id)?.archiveStatus,
      (v) => v === "COMPLETE"
    );
  });
  it("handles 30 simultaneous users with fair scheduling, durable quotas and no duplicate dispatch across schedulers", async () => {
    const a = await admin(),
      c = await createClass(a);
    await api("/workers", { name: "GPU", baseUrl: mock.url }, a);
    const w = getDb().list("workers")[0];
    w.healthStatus = "ONLINE";
    getDb().put("workers", w);
    mock.delay = 20;
    const cookies: string[] = [];
    getDb().transaction(() => {
      for (let i = 0; i < 30; i++) {
        const id = randomUUID(),
          enrollmentId = randomUUID(),
          raw = randomUUID();
        getDb().put("users", {
          id,
          email: `load${i}@example.edu`,
          firstName: "Load",
          lastName: String(i),
          passwordHash: "",
          emailVerifiedAt: new Date().toISOString(),
          status: "ACTIVE",
          globalRole: "STUDENT",
          lastLoginAt: null,
          createdAt: new Date().toISOString(),
        });
        getDb().put("enrollments", {
          id: enrollmentId,
          userId: id,
          classId: c.id,
          rosterEmail: `load${i}@example.edu`,
          orgDefinedId: String(200000000 + i),
          firstName: "Load",
          lastName: String(i),
          role: "STUDENT",
          status: "ACTIVE",
        });
        getDb().put("gateway_sessions", {
          id: hashSessionToken(raw, process.env.AUTH_SECRET!),
          userId: id,
          classId: c.id,
          enrollmentId,
          expiresAt: Date.now() + 60000,
        });
        cookies.push("comfy_gateway=" + raw);
      }
    });
    const submitted = await Promise.all(cookies.map((cookie) => gw("/prompt", prompt, cookie)));
    expect(submitted.every((r) => r.status === 200)).toBe(true);
    // User zero may queue two additional jobs, but a fourth waiting job is denied.
    expect((await gw("/prompt", prompt, cookies[0])).status).toBe(200);
    expect((await gw("/prompt", prompt, cookies[0])).status).toBe(200);
    expect((await gw("/prompt", prompt, cookies[0])).status).toBe(429);
    const second = new Scheduler();
    scheduler = new Scheduler();
    scheduler.start();
    second.start();
    try {
      await waitFor(
        async () => {
          await scheduler!.tick();
          await second.tick();
          return getDb()
            .list("jobs")
            .filter((j) => j.archiveStatus === "COMPLETE").length;
        },
        (n) => n === 32,
        45000
      );
    } finally {
      await second.stop();
    }
    expect(mock.submissions).toHaveLength(32);
    expect(mock.maxRunning).toBe(1);
    const ordered = getDb()
      .list("jobs")
      .sort((a, b) => Date.parse(a.startedAt!) - Date.parse(b.startedAt!));
    expect(new Set(ordered.slice(0, 30).map((j) => j.userId)).size).toBe(30);
    expect(getDb().list("outputs")).toHaveLength(32);
  });
  it("gates the H3 example on a teacher grant: hidden until given, seeded on next entry, never deleted on revoke", async () => {
    const a = await admin(),
      c = await createClass(a);
    await roster(a, c.id);
    const url = await signup(a, c),
      alice = await student(c, url);
    const enrollments = (await (await api(`/admin/classes/${c.id}`, undefined, a)).json()).enrollments as any[];
    const mine = enrollments.find((e) => e.userId === getDb().userByEmail("student1@example.edu")?.id)!;
    const pending = enrollments.find((e) => !e.userId)!;
    expect(mine.h3Video).toBe(false);
    // Teachers can grant H3 to an enrollment even before the student registers; once
    // that student signs up, H3 is ready on their very first ComfyUI visit.
    const preGrant = await api(`/admin/classes/${c.id}/enrollments`, { id: pending.id, h3Video: true }, a, "PATCH");
    expect(preGrant.status).toBe(200);
    expect((await preGrant.json()).h3Video).toBe(true);
    const bob = await student(c, url, pending.rosterEmail);
    const gBob = await workspace(bob, c.id);
    expect((await gw("/templates/class_video_minimax_h3.json", undefined, gBob)).status).toBe(200);
    // A student cannot grant themselves the example.
    expect((await api(`/admin/classes/${c.id}/enrollments`, { id: mine.id, h3Video: true }, alice)).status).toBe(403);
    const ga = await workspace(alice, c.id);
    const names = async (cookie: string) =>
      (await (await gw("/templates/index.json", undefined, cookie)).json()).flatMap((cat: any) =>
        cat.templates.map((t: any) => t.name)
      );
    expect(await names(ga)).toEqual([
      "class_image_flux",
      "class_image_qwen_2_1_turbo",
      "class_image_qwen_2_1_turbo_edit",
      "class_video_wan_t2v_1_3b",
    ]);
    expect((await gw("/templates/class_video_minimax_h3.json", undefined, ga)).status).toBe(404);
    expect((await gw("/templates/class_video_qwen_minimax_h3.json", undefined, ga)).status).toBe(404);
    const grant = await api(`/admin/classes/${c.id}/enrollments`, { id: mine.id, h3Video: true }, a, "PATCH");
    expect(grant.status).toBe(200);
    expect((await grant.json()).h3Video).toBe(true);
    // The grant lands on the next workspace entry, without touching the base starters.
    const gb = await workspace(alice, c.id);
    expect(await names(gb)).toEqual([
      "class_image_flux",
      "class_image_qwen_2_1_turbo",
      "class_image_qwen_2_1_turbo_edit",
      "class_video_wan_t2v_1_3b",
      "class_video_minimax_h3",
      "class_video_qwen_minimax_h3",
    ]);
    const graph = await gw("/templates/class_video_minimax_h3.json", undefined, gb);
    expect(graph.status).toBe(200);
    expect((await graph.json()).nodes.length).toBeGreaterThan(0);
    const qwenH3Graph = await gw("/templates/class_video_qwen_minimax_h3.json", undefined, gb);
    expect(qwenH3Graph.status).toBe(200);
    expect((await qwenH3Graph.json()).nodes.length).toBeGreaterThan(0);
    const files = (await (await gw("/api/userdata?dir=workflows&recurse=true", undefined, gb)).json()) as string[];
    expect(files).toContain("2 - Video with audio (MiniMax H3).json");
    expect(files).toContain("2b - Text to Image to Video (Qwen 2.1 + MiniMax H3).json");
    // Revoking hides the template and its graph but never deletes placed work.
    expect((await api(`/admin/classes/${c.id}/enrollments`, { id: mine.id, h3Video: false }, a, "PATCH")).status).toBe(
      200
    );
    expect(await names(gb)).toEqual([
      "class_image_flux",
      "class_image_qwen_2_1_turbo",
      "class_image_qwen_2_1_turbo_edit",
      "class_video_wan_t2v_1_3b",
    ]);
    expect((await gw("/templates/class_video_minimax_h3.json", undefined, gb)).status).toBe(404);
    expect((await gw("/templates/class_video_qwen_minimax_h3.json", undefined, gb)).status).toBe(404);
    const kept = (await (await gw("/api/userdata?dir=workflows&recurse=true", undefined, gb)).json()) as string[];
    expect(kept).toContain("2 - Video with audio (MiniMax H3).json");
    expect(kept).toContain("2b - Text to Image to Video (Qwen 2.1 + MiniMax H3).json");
    // A starter version bump never overwrites a student's edited starter (whether
    // already listed in marker.seeded or pre-existing on disk before seeding).
    await gw("/userdata/workflows/1%20-%20Image%20(Flux).json", { nodes: ["student-custom-edit"] }, gb);
    await gw("/userdata/workflows/1b%20-%20Image%20(Qwen%202.1%20Turbo).json", { nodes: ["student-qwen-edit"] }, gb);
    const markerRow = getDb().list("user_data", "user_id=? AND class_id=? AND path=?", [
      mine.userId,
      c.id,
      "__starters__",
    ])[0]!;
    markerRow.content = JSON.stringify({
      version: 2,
      seeded: ["workflows/1 - Image (Flux).json", "workflows/2 - Video (Wan 1.3B).json"],
    });
    getDb().put("user_data", markerRow);
    const gc = await workspace(alice, c.id);
    const editedFlux = await (await gw("/userdata/workflows/1%20-%20Image%20(Flux).json", undefined, gc)).json();
    expect(editedFlux).toEqual({ nodes: ["student-custom-edit"] });
    const editedQwen = await (
      await gw("/userdata/workflows/1b%20-%20Image%20(Qwen%202.1%20Turbo).json", undefined, gc)
    ).json();
    expect(editedQwen).toEqual({ nodes: ["student-qwen-edit"] });
  });
  it("keeps jobs queued while worker is offline, reconnects without duplicates, records execution and archive failures separately", async () => {
    const a = await admin(),
      c = await createClass(a);
    await roster(a, c.id);
    const s = await student(c, await signup(a, c));
    await api("/workers", { name: "GPU", baseUrl: mock.url }, a);
    const w = getDb().list("workers")[0];
    w.healthStatus = "ONLINE";
    getDb().put("workers", w);
    const g = await workspace(s, c.id);
    // Prime validated node metadata, then disconnect the backend.
    expect((await gw("/object_info", undefined, g)).status).toBe(200);
    mock.online = false;
    const r = await gw("/prompt", prompt, g);
    expect(r.status).toBe(200);
    const id = (await r.json()).prompt_id;
    scheduler = new Scheduler();
    scheduler.start();
    await waitFor(
      () => getDb().get("workers", w.id)?.healthStatus,
      (v) => v === "OFFLINE"
    );
    expect(getDb().get("jobs", id)?.status).toBe("QUEUED");
    // Cancel via /jobs/:id/cancel while worker is offline and job is QUEUED
    const toCancelRes = await gw("/prompt", prompt, g);
    expect(toCancelRes.status).toBe(200);
    const cancelId = (await toCancelRes.json()).prompt_id;
    expect((await gw("/jobs/" + cancelId + "/cancel", {}, g)).status).toBe(200);
    expect(getDb().get("jobs", cancelId)?.status).toBe("CANCELLED");
    mock.online = true;
    await waitFor(
      () => getDb().get("jobs", id)?.archiveStatus,
      (v) => v === "COMPLETE"
    );
    expect(mock.submissions).toHaveLength(1);
    mock.fail = true;
    const failure = await gw("/prompt", prompt, g),
      fid = (await failure.json()).prompt_id;
    await waitFor(
      () => getDb().get("jobs", fid)?.status,
      (v) => v === "FAILED"
    );
    expect(getDb().get("jobs", fid)?.archiveStatus).toBe("PENDING");
    const failedJob = await (await gw("/jobs/" + fid, undefined, g)).json();
    expect(failedJob.status).toBe("failed");
    expect(failedJob.execution_error).toMatchObject({
      node_id: expect.any(String),
      node_type: expect.any(String),
      exception_message: expect.any(String),
      exception_type: expect.any(String),
      traceback: expect.any(Array),
    });
    mock.fail = false;
    mock.failView = true;
    const third = await gw("/prompt", prompt, g);
    expect(third.status).toBe(200);
    const tid = (await third.json()).prompt_id;
    await waitFor(
      () => getDb().get("jobs", tid)?.archiveStatus,
      (v) => v === "FAILED"
    );
    expect(getDb().get("jobs", tid)?.status).toBe("COMPLETED");
    mock.failView = false;
    expect((await api("/jobs/" + tid + "/archive", {}, a)).status).toBe(200);
    await waitFor(
      () => getDb().get("jobs", tid)?.archiveStatus,
      (v) => v === "COMPLETE"
    );
  });
  it("consumes workspace tickets only once across connections and rejects an expired or revoked enrollment", async () => {
    const a = await admin(),
      c = await createClass(a);
    await roster(a, c.id);
    const s = await student(c, await signup(a, c));
    const r = await api("/workspace/session", { classId: c.id }, s),
      u = new URL((await r.json()).url);
    const exchange = () => fetch(gatewayUrl + u.pathname + u.search, { redirect: "manual" });
    expect((await exchange()).status).toBe(303);
    closeDb();
    expect((await exchange()).status).toBe(401);
    const e = getDb().list("enrollments", "email=?", ["student1@example.edu"])[0];
    e.status = "ARCHIVED";
    getDb().put("enrollments", e);
    expect((await api("/workspace/session", { classId: c.id }, s)).status).toBe(403);
  });
  it("runs two GPUs concurrently without exceeding either worker's capacity", async () => {
    const other = await mockComfy();
    other.delay = 1000;
    mock.delay = 1000;
    try {
      const a = await admin(),
        c = await createClass(a);
      await roster(a, c.id);
      const link = await signup(a, c),
        sa = await student(c, link),
        sb = await student(c, link, "student2@example.edu");
      for (const [name, url] of [
        ["gpu-a", mock.url],
        ["gpu-b", other.url],
      ]) {
        await api("/workers", { name, baseUrl: url }, a);
      }
      for (const w of getDb().list("workers")) {
        w.healthStatus = "ONLINE";
        getDb().put("workers", w);
      }
      const ga = await workspace(sa, c.id),
        gb = await workspace(sb, c.id);
      await Promise.all([gw("/prompt", prompt, ga), gw("/prompt", prompt, gb)]);
      scheduler = new Scheduler();
      scheduler.start();
      await waitFor(
        () =>
          getDb()
            .list("jobs")
            .filter((j) => j.status === "RUNNING"),
        (jobs) => jobs.length === 2
      );
      expect(
        new Set(
          getDb()
            .list("jobs")
            .map((j) => j.workerId)
        ).size
      ).toBe(2);
      await waitFor(
        () =>
          getDb()
            .list("jobs")
            .filter((j) => j.archiveStatus === "COMPLETE").length,
        (n) => n === 2
      );
      expect(mock.maxRunning).toBe(1);
      // Terminal jobs release VRAM immediately: the scheduler POSTs /free once
      // no platform job still needs the worker.
      expect(mock.frees.length).toBeGreaterThan(0);
      expect(mock.frees.every((v) => v.unload_models === true && v.free_memory === true)).toBe(true);
      expect(other.maxRunning).toBe(1);
    } finally {
      await scheduler?.stop();
      await other.close();
    }
  });
  it("recovers running jobs from persisted prompt IDs after scheduler restart without resubmission", async () => {
    const a = await admin(),
      c = await createClass(a);
    await roster(a, c.id);
    const s = await student(c, await signup(a, c));
    await api("/workers", { name: "GPU", baseUrl: mock.url }, a);
    const w = getDb().list("workers")[0];
    w.healthStatus = "ONLINE";
    getDb().put("workers", w);
    mock.delay = 2000;
    const g = await workspace(s, c.id),
      r = await gw("/prompt", prompt, g),
      id = (await r.json()).prompt_id;
    scheduler = new Scheduler();
    scheduler.start();
    await waitFor(
      () => getDb().get("jobs", id)?.status,
      (v) => v === "RUNNING"
    );
    await scheduler.stop();
    await new Promise((r) => setTimeout(r, 700));
    closeDb();
    scheduler = new Scheduler();
    scheduler.start();
    await waitFor(
      () => getDb().get("jobs", id)?.archiveStatus,
      (v) => v === "COMPLETE",
      20000
    );
    expect(mock.submissions).toHaveLength(1);
  });
  it("signs in with a password, and a reset link sets a new one and ends existing sessions", async () => {
    const a = await admin();
    // A confirmed account cannot be re-registered, with the code or otherwise.
    expect(
      (
        await api("/auth/register", {
          email: "admin@example.edu",
          password: PASSWORD,
          adminCode: process.env.ADMIN_REGISTRATION_CODE,
        })
      ).status
    ).toBe(409);
    const c = await createClass(a);
    await roster(a, c.id);
    const url = await signup(a, c);
    expect((await register(c, url, "student1@example.edu", "short")).status).toBe(400);
    const s = await student(c, url);
    expect((await (await api("/auth/session", undefined, s)).json()).user.email).toBe("student1@example.edu");
    expect((await api("/auth/password-reset", { email: "student1@example.edu" })).status).toBe(200);
    const token = mailLink("student1@example.edu").searchParams.get("token");
    expect(
      (
        await api("/auth/password-reset/confirm", {
          email: "student1@example.edu",
          token,
          password: "brand-new-long-password",
        })
      ).status
    ).toBe(200);
    expect((await (await api("/auth/session", undefined, s)).json()).user).toBeNull();
    expect((await login("student1@example.edu")).status).toBe(401);
    expect((await login("student1@example.edu", "brand-new-long-password")).status).toBe(200);
    expect(
      (
        await api("/auth/password-reset/confirm", {
          email: "student1@example.edu",
          token,
          password: "a-third-long-password",
        })
      ).status
    ).toBe(400);
    // An account carried over from the passwordless schema has no usable hash: it
    // cannot sign in, and the same emailed link is how it gets its first password.
    const u = getDb().userByEmail("student1@example.edu")!;
    u.passwordHash = "";
    getDb().put("users", u);
    expect((await login("student1@example.edu", "brand-new-long-password")).status).toBe(401);
    expect((await api("/auth/password-reset", { email: "student1@example.edu" })).status).toBe(200);
    expect(
      (
        await api("/auth/password-reset/confirm", {
          email: "student1@example.edu",
          token: mailLink("student1@example.edu").searchParams.get("token"),
          password: "post-migration-password",
        })
      ).status
    ).toBe(200);
    expect((await login("student1@example.edu", "post-migration-password")).status).toBe(200);
    // Unknown addresses get the same answer as known ones, and send no mail.
    const before = emails.length;
    expect((await api("/auth/password-reset", { email: "nobody@example.edu" })).status).toBe(200);
    expect(emails.length).toBe(before);
  });
  it("restricts administrative routes by role and promotes an existing account with the code", async () => {
    const a = await admin(),
      c = await createClass(a);
    await roster(a, c.id);
    const s = await student(c, await signup(a, c));
    for (const route of ["/admin/classes", "/admin/users", "/admin/metrics", "/workers", `/admin/classes/${c.id}`])
      expect((await api(route, undefined, s)).status).toBe(403);
    expect(
      (await api("/admin/classes", { name: "Sneaky", slug: "sneaky", courseCode: "X", term: "Y" }, s)).status
    ).toBe(403);
    expect((await api("/roster/preview", { classId: c.id, csv: "x" }, s)).status).toBe(403);
    expect((await api("/admin/classes", undefined)).status).toBe(401);
    // A student keeps their own views.
    expect((await api("/jobs", undefined, s)).status).toBe(200);
    expect((await api("/auth/session", undefined, s)).status).toBe(200);
    expect((await api("/auth/admin-code", { adminCode: "not-the-code" }, s)).status).toBe(403);
    expect((await api("/auth/admin-code", { adminCode: process.env.ADMIN_REGISTRATION_CODE }, s)).status).toBe(200);
    expect(getDb().userByEmail("student1@example.edu")?.globalRole).toBe("ADMIN");
    expect((await api("/admin/metrics", undefined, s)).status).toBe(200);
  });
  it("updates only the worker fields a PATCH sends", async () => {
    const a = await admin();
    const created = await api(
      "/workers",
      { name: "GPU", baseUrl: mock.url, gpuName: "RTX 6000", vramMb: 49152, tags: ["video"], maxConcurrentJobs: 4 },
      a
    );
    expect(created.status).toBe(201);
    const id = (await created.json()).worker.id;
    // The admin page's enable toggle sends only `enabled`; nothing else may reset to its default.
    expect((await api(`/workers/${id}`, { enabled: false }, a, "PATCH")).status).toBe(200);
    const w = getDb().get("workers", id)!;
    expect(w).toMatchObject({
      enabled: false,
      healthStatus: "DISABLED",
      gpuName: "RTX 6000",
      vramMb: 49152,
      tags: ["video"],
      maxConcurrentJobs: 4,
    });
    expect((await api(`/workers/${id}`, { maxConcurrentJobs: 0 }, a, "PATCH")).status).toBe(400);
  });
  it("refuses to delete a class while its jobs are queued or running", async () => {
    const a = await admin(),
      c = await createClass(a);
    await roster(a, c.id);
    const s = await student(c, await signup(a, c));
    await api("/workers", { name: "GPU", baseUrl: mock.url }, a);
    const w = getDb().list("workers")[0];
    w.healthStatus = "ONLINE";
    getDb().put("workers", w);
    const g = await workspace(s, c.id);
    expect((await gw("/prompt", prompt, g)).status).toBe(200);
    const r = await api(`/admin/classes/${c.id}`, { confirm: c.slug }, a, "DELETE");
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("ACTIVE_JOBS");
    expect(getDb().list("classes")).toHaveLength(1);
  });
  it("permanently deletes a class with every record and file it owns", async () => {
    const a = await admin(),
      c = await createClass(a);
    await roster(a, c.id);
    const s = await student(c, await signup(a, c));
    await api("/workers", { name: "GPU", baseUrl: mock.url }, a);
    const w = getDb().list("workers")[0];
    w.healthStatus = "ONLINE";
    getDb().put("workers", w);
    const g = await workspace(s, c.id);
    // Produce one of everything the class owns on disk: a staged input, a saved
    // workflow, and an archived output.
    const form = new FormData();
    form.set("image", new Blob([Buffer.from("fake-png-bytes")], { type: "image/png" }), "input.png");
    expect(
      (
        await fetch(gatewayUrl + "/upload/image", {
          method: "POST",
          headers: { Origin: process.env.COMFY_PUBLIC_URL!, Cookie: g },
          body: form,
        })
      ).status
    ).toBe(200);
    await gw("/userdata/workflows/keep.json", { nodes: [] }, g);
    const submitted = await gw("/prompt", prompt, g),
      id = (await submitted.json()).prompt_id;
    scheduler = new Scheduler();
    scheduler.start();
    await waitFor(
      () => getDb().get("jobs", id)?.archiveStatus,
      (v) => v === "COMPLETE"
    );
    await scheduler.stop();
    scheduler = undefined;

    const output = getDb().list("outputs")[0],
      upload = getDb().list("uploads")[0],
      classDir = path.join(process.env.AUDIT_DATA_DIR!, c.slug);
    expect(existsSync(output.storagePath)).toBe(true);
    expect(existsSync(upload.storagePath)).toBe(true);
    expect(getDb().list("user_data", "class_id=?", [c.id]).length).toBeGreaterThan(0);
    expect(getDb().list("audits", "class_id=?", [c.id]).length).toBeGreaterThan(0);

    // The slug is the confirmation, and a student may not delete anything.
    expect((await api(`/admin/classes/${c.id}`, { confirm: "not-the-slug" }, a, "DELETE")).status).toBe(400);
    expect((await api(`/admin/classes/${c.id}`, { confirm: c.slug }, s, "DELETE")).status).toBe(403);
    expect(getDb().list("classes")).toHaveLength(1);

    const deleted = await api(`/admin/classes/${c.id}`, { confirm: c.slug }, a, "DELETE");
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).failures).toEqual([]);

    for (const table of [
      "classes",
      "enrollments",
      "jobs",
      "outputs",
      "uploads",
      "user_data",
      "signup_tokens",
      "roster_imports",
      "roster_import_rows",
      "invitations",
      "workspace_tickets",
      "gateway_sessions",
    ] as const)
      expect(getDb().list(table), table).toHaveLength(0);
    expect(getDb().list("audits", "class_id=?", [c.id])).toHaveLength(0);
    // The administrator's own action is what survives, not the class's history.
    const record = getDb()
      .list("audits")
      .find((e) => e.type === "CLASS_DELETED")!;
    expect(record.classId).toBeNull();
    expect(record.metadata.slug).toBe(c.slug);
    expect(existsSync(output.storagePath)).toBe(false);
    expect(existsSync(upload.storagePath)).toBe(false);
    expect(existsSync(classDir)).toBe(false);
    expect(existsSync(path.dirname(upload.storagePath))).toBe(false);
    // The student's account and their sign-in survive; only the class is gone.
    expect((await login("student1@example.edu")).status).toBe(200);
    expect((await (await api("/jobs", undefined, a)).json()).jobs).toHaveLength(0);
    expect((await api(`/admin/classes/${c.id}`, undefined, a)).status).toBe(404);
    expect((await api(`/admin/classes/${c.id}`, { confirm: c.slug }, a, "DELETE")).status).toBe(404);
  });
  it("upgrades a passwordless v1 database and still fails closed on a newer one", () => {
    const file = path.join(dir, "legacy.sqlite"),
      legacy = new LabDatabase(file),
      now = new Date().toISOString();
    legacy.put("users", {
      id: randomUUID(),
      email: "legacy@example.edu",
      firstName: "Legacy",
      lastName: "Admin",
      passwordHash: "",
      emailVerifiedAt: now,
      status: "ACTIVE",
      globalRole: "ADMIN",
      lastLoginAt: null,
      createdAt: now,
    });
    // Rewind to the passwordless shape: no stored hash, one outstanding challenge.
    legacy.sql.exec("UPDATE users SET data=json_remove(data,'$.passwordHash')");
    legacy.sql.exec(
      `INSERT INTO verifications(id,data) VALUES('old',json('{"id":"old","email":"legacy@example.edu","purpose":"LOGIN"}'))`
    );
    legacy.sql.exec("PRAGMA user_version=1");
    legacy.close();

    const upgraded = new LabDatabase(file);
    expect((upgraded.sql.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    expect(upgraded.userByEmail("legacy@example.edu")?.passwordHash).toBe("");
    expect(upgraded.list("verifications")).toHaveLength(0);
    upgraded.sql.exec("PRAGMA user_version=99");
    upgraded.close();
    expect(() => new LabDatabase(file)).toThrow(/newer than this application/);
  });
  it("shares rate limits and commits across independent OS processes", async () => {
    const script = `import {LabDatabase} from './packages/database/src/index.ts';const d=new LabDatabase(process.env.SQLITE_PATH);for(let i=0;i<15;i++)d.rateLimit('parallel',1000,60000);d.close();`;
    await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
              cwd: process.cwd(),
              env: process.env,
              stdio: "pipe",
            });
            let errors = "";
            child.stderr.on("data", (c) => (errors += c));
            child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(errors))));
          })
      )
    );
    expect(getDb().sql.prepare("SELECT count FROM rate_limits WHERE id='parallel'").get()?.count).toBe(60);
  });
  it("skips unwired MiniMax H3 during candidate image generation, caches unchanged image branches across runs, and forwards partial_execution_targets", async () => {
    const a = await admin(),
      c = await createClass(a);
    await roster(a, c.id);
    const s = await student(c, await signup(a, c));
    await api("/workers", { name: "GPU", baseUrl: mock.url }, a);
    const w = getDb().list("workers")[0];
    w.healthStatus = "ONLINE";
    getDb().put("workers", w);
    scheduler = new Scheduler();
    scheduler.start();
    const g = await workspace(s, c.id);

    // Stage 1: two candidate image branches (with ComfySwitchNode refine_prompt=false)
    // + unwired MiniMaxH3ReferenceToVideo (with ComfySwitchNode turbo_mode=true).
    const stage1Prompt: Record<string, any> = {
      "8": { class_type: "TextGenerate", inputs: { prompt: "unused enhancer" } },
      "9": {
        class_type: "ComfySwitchNode",
        inputs: { switch: false, on_false: "raw prompt 1", on_true: ["8", 0] },
      },
      "10": { class_type: "EmptyLatentImage", inputs: { seed: 101, text: ["9", 0] } },
      "11": { class_type: "VAEDecode", inputs: { samples: ["10", 0] } },
      "12": { class_type: "PreviewImage", inputs: { images: ["11", 0] } },
      "20": { class_type: "EmptyLatentImage", inputs: { seed: 202 } },
      "21": { class_type: "VAEDecode", inputs: { samples: ["20", 0] } },
      "22": { class_type: "PreviewImage", inputs: { images: ["21", 0] } },
      "37": { class_type: "PrimitiveInt", inputs: { value: 20 } },
      "38": { class_type: "PrimitiveInt", inputs: { value: 4 } },
      "39": { class_type: "PrimitiveBoolean", inputs: { value: true } },
      "36": {
        class_type: "ComfySwitchNode",
        inputs: { switch: ["39", 0], on_false: ["37", 0], on_true: ["38", 0] },
      },
      "40": { class_type: "MiniMaxH3ReferenceToVideo", inputs: { prompt: "hero video", steps: ["36", 0] } },
      "50": { class_type: "SaveVideo", inputs: { video: ["40", 0], filename_prefix: "video" } },
    };
    const r1 = await gw("/prompt", { prompt: stage1Prompt }, g);
    expect(r1.status).toBe(200);
    const id1 = (await r1.json()).prompt_id;
    await waitFor(
      () => getDb().get("jobs", id1)?.archiveStatus,
      (v) => v === "COMPLETE"
    );
    // Unwired MiniMaxH3ReferenceToVideo ("40") and SaveVideo ("50") were pruned,
    // and inactive TextGenerate ("8") was pruned with its dangling link removed from ComfySwitchNode ("9").
    expect(mock.submissions[0].prompt["40"]).toBeUndefined();
    expect(mock.submissions[0].prompt["50"]).toBeUndefined();
    expect(mock.submissions[0].prompt["8"]).toBeUndefined();
    expect(mock.submissions[0].prompt["9"].inputs.on_true).toBeUndefined();
    expect(mock.submissions[0].prompt["11"].class_type).toBe("VAEDecode");
    expect(mock.submissions[0].prompt["21"].class_type).toBe("VAEDecode");

    // Stage 2: change seed on candidate 2 ("20") only; candidate 1 ("11") is cached via LoadImage.
    const stage2Prompt = structuredClone(stage1Prompt);
    stage2Prompt["20"].inputs.seed = 999;
    const r2 = await gw("/prompt", { prompt: stage2Prompt, partial_execution_targets: ["22"] }, g);
    expect(r2.status).toBe(200);
    const id2 = (await r2.json()).prompt_id;
    await waitFor(
      () => getDb().get("jobs", id2)?.archiveStatus,
      (v) => v === "COMPLETE"
    );
    expect(mock.submissions[1].partial_execution_targets).toEqual(["22"]);
    expect(mock.submissions[1].prompt["11"].class_type).toBe("LoadImage");
    expect(mock.submissions[1].prompt["10"]).toBeUndefined();
    expect(mock.submissions[1].prompt["21"].class_type).toBe("VAEDecode");

    // Stage 3: wire both candidate previews into MiniMaxH3ReferenceToVideo; both image branches use cached LoadImage
    // and the inactive steps branch ("37") is pruned cleanly from ComfySwitchNode ("36").
    const stage3Prompt: Record<string, any> = structuredClone(stage2Prompt);
    stage3Prompt["40"].inputs = {
      prompt: "hero video",
      steps: ["36", 0],
      "ref_images.ref_image_0": ["12", 0],
      "ref_images.ref_image_1": ["22", 0],
    };
    const r3 = await gw("/prompt", { prompt: stage3Prompt }, g);
    expect(r3.status).toBe(200);
    const id3 = (await r3.json()).prompt_id;
    await waitFor(
      () => getDb().get("jobs", id3)?.archiveStatus,
      (v) => v === "COMPLETE"
    );
    expect(mock.submissions[2].prompt["40"].class_type).toBe("MiniMaxH3ReferenceToVideo");
    expect(mock.submissions[2].prompt["50"].class_type).toBe("SaveVideo");
    expect(mock.submissions[2].prompt["37"]).toBeUndefined();
    expect(mock.submissions[2].prompt["36"].inputs.on_false).toBeUndefined();
    expect(mock.submissions[2].prompt["11"].class_type).toBe("LoadImage");
    expect(mock.submissions[2].prompt["21"].class_type).toBe("LoadImage");
    expect(mock.submissions[2].prompt["10"]).toBeUndefined();
    expect(mock.submissions[2].prompt["20"]).toBeUndefined();
  });
  it("pauses and resumes class access while keeping student dashboard, jobs, and outputs visible", async () => {
    const a = await admin(),
      c = await createClass(a);
    await roster(a, c.id);
    const s = await student(c, await signup(a, c));
    await api("/workers", { name: "GPU", baseUrl: mock.url }, a);
    const w = getDb().list("workers")[0];
    w.healthStatus = "ONLINE";
    getDb().put("workers", w);
    scheduler = new Scheduler();
    scheduler.start();

    const g = await workspace(s, c.id);
    const submitted = await gw("/prompt", prompt, g);
    expect(submitted.status).toBe(200);
    const jobId = (await submitted.json()).prompt_id;
    await waitFor(
      () => getDb().get("jobs", jobId)?.archiveStatus,
      (v) => v === "COMPLETE"
    );

    // Submit a slower job, then pause access while it is in flight (M5): workspace access
    // is blocked immediately, while the already-admitted job finishes cleanly.
    mock.delay = 350;
    const inFlightSub = await gw("/prompt", prompt, g);
    expect(inFlightSub.status).toBe(200);
    const inFlightId = (await inFlightSub.json()).prompt_id as string;

    const pausedRes = await api(`/admin/classes/${c.id}`, { paused: true }, a, "PATCH");
    expect(pausedRes.status).toBe(200);
    expect((await pausedRes.json()).class.paused).toBe(true);

    // Existing ComfyUI gateway session is immediately rejected.
    expect((await gw("/prompt", prompt, g)).status).toBe(401);

    // Clicking Open ComfyUI returns 403 with CLASS_PAUSED and a clear message.
    const wsBlocked = await api("/workspace/session", { classId: c.id }, s);
    expect(wsBlocked.status).toBe(403);
    const wsBlockedJson = await wsBlocked.json();
    expect(wsBlockedJson.code).toBe("CLASS_PAUSED");
    expect(wsBlockedJson.error).toMatch(/paused/i);

    await waitFor(
      () => getDb().get("jobs", inFlightId)?.archiveStatus,
      (v) => v === "COMPLETE"
    );
    expect(getDb().get("jobs", inFlightId)?.status).toBe("COMPLETED");

    // Student can still sign in and see their enrolled class, jobs, and outputs on the dashboard.
    const sessionRes = await api("/auth/session", undefined, s);
    expect(sessionRes.status).toBe(200);
    const sessionJson = await sessionRes.json();
    expect(sessionJson.enrollments).toHaveLength(1);
    expect(sessionJson.enrollments[0].classActive).toBe(true);
    expect(sessionJson.enrollments[0].classPaused).toBe(true);

    const jobsRes = await api("/jobs", undefined, s);
    expect(jobsRes.status).toBe(200);
    const jobsJson = await jobsRes.json();
    expect(jobsJson.jobs).toHaveLength(2);
    expect(jobsJson.jobs[0].outputs).toHaveLength(1);
    const outRes = await api(`/outputs/${jobsJson.jobs[0].outputs[0].id}`, undefined, s);
    expect(outRes.status).toBe(200);

    // Resume access on the class: student can open ComfyUI again.
    const resumedRes = await api(`/admin/classes/${c.id}`, { paused: false }, a, "PATCH");
    expect(resumedRes.status).toBe(200);
    expect((await resumedRes.json()).class.paused).toBe(false);
    const g2 = await workspace(s, c.id);
    expect((await gw("/prompt", prompt, g2)).status).toBe(200);
  });
  it("never dispatches, uploads, or calls /free on GPUs occupied by external VRAM processes and distinguishes ComfyUI PyTorch models", async () => {
    const externalGpu = await mockComfy();
    // Simulate VLLM::EngineCore occupying ~34 GiB of a 48 GiB RTX A6000 outside ComfyUI's PyTorch pool.
    externalGpu.vramTotal = 49152 * 1024 * 1024;
    externalGpu.vramFree = 14336 * 1024 * 1024;
    externalGpu.torchVramTotal = 128 * 1024 * 1024;
    externalGpu.torchVramFree = 108 * 1024 * 1024;

    // H1 regression: clean worker holds 30 GiB of its own cached ComfyUI PyTorch weights!
    // Must NOT be misclassified as an external GPU process.
    mock.vramTotal = 49152 * 1024 * 1024;
    mock.torchVramTotal = 31744 * 1024 * 1024; // 31 GiB reserved by ComfyUI PyTorch
    mock.torchVramFree = 1024 * 1024 * 1024; // 1 GiB free inside PyTorch pool -> 30 GiB active weights
    mock.vramFree = (16896 + 1024) * 1024 * 1024; // ~512 MiB non-PyTorch CUDA context

    try {
      const a = await admin(),
        c = await createClass(a);
      await roster(a, c.id);
      const url = await signup(a, c),
        alice = await student(c, url, "student1@example.edu"),
        bob = await student(c, url, "student2@example.edu");
      const rExt = await api("/workers", { name: "GPU-0-vLLM", baseUrl: externalGpu.url }, a);
      expect(rExt.status).toBe(201);
      const extWorkerId = (await rExt.json()).worker.id as string;
      const rClean = await api("/workers", { name: "GPU-2-Clean", baseUrl: mock.url }, a);
      expect(rClean.status).toBe(201);
      const cleanWorkerId = (await rClean.json()).worker.id as string;

      scheduler = new Scheduler();
      (scheduler as any).renew();
      await scheduler.tick();

      const extAfterHealth = getDb().get("workers", extWorkerId)!;
      expect(extAfterHealth.externalBusy).toBe(true);
      expect(extAfterHealth.healthStatus).toBe("BUSY");
      expect(extAfterHealth.externalBusyReason).toMatch(/External GPU process/i);

      // Clean worker with 30 GiB of ComfyUI's own PyTorch weights remains ONLINE & not externalBusy (H1).
      const cleanAfterHealth = getDb().get("workers", cleanWorkerId)!;
      expect(cleanAfterHealth.externalBusy).toBe(false);
      expect(cleanAfterHealth.healthStatus).toBe("ONLINE");

      const metrics = await (await api("/admin/metrics", undefined, a)).json();
      expect(metrics.gpus).toBe(1);
      expect(metrics.externalBusyGpus).toBe(1);

      // Slow clean worker so jobs queue, testing interleaved round-robin queue positions (M4).
      mock.delay = 450;
      const ga = await workspace(alice, c.id),
        gb = await workspace(bob, c.id);
      const rootHtml = await (await gw("/", undefined, ga)).text();
      expect(rootHtml).toContain("/lab/status-widget.js");
      expect((await gw("/lab/status")).status).toBe(401);

      // Alice submits 2 queued jobs BEFORE scheduler runs; Bob submits 1 queued job.
      // Round-robin interleaving must place Bob at #2 (ahead of Alice's 2nd job at #3).
      const subA1 = await gw("/prompt", prompt, ga);
      const jobA1 = (await subA1.json()).prompt_id as string;
      const subA2 = await gw("/prompt", prompt, ga);
      const jobA2 = (await subA2.json()).prompt_id as string;
      const subB = await gw("/prompt", prompt, gb);
      const jobB = (await subB.json()).prompt_id as string;

      const preDispatchBobStatus = await (await gw("/lab/status", undefined, gb)).json();
      expect(preDispatchBobStatus.totalQueued).toBe(3);
      expect(preDispatchBobStatus.activeJobs[0].queuePosition).toBe(2);

      await scheduler.tick();
      await waitFor(
        () => getDb().get("jobs", jobA1)?.status,
        (v) => v === "RUNNING"
      );

      // Now jobA1 is RUNNING on Alice's slot, so Bob's jobB moves to #1 ahead of jobA2 (#2)!
      const bobStatus = await (await gw("/lab/status", undefined, gb)).json();
      expect(bobStatus.availableWorkers).toBe(1);
      expect(bobStatus.totalQueued).toBe(2);
      expect(bobStatus.activeJobs[0].id).toBe(jobB);
      expect(bobStatus.activeJobs[0].queuePosition).toBe(1);

      const bobWebJobs = await (await api("/jobs", undefined, bob)).json();
      expect(bobWebJobs.queueSummary).toEqual({ availableGpus: 1, runningJobs: 1, queuedJobs: 2 });
      expect(bobWebJobs.jobs[0].queuePosition).toBe(1);
      expect(bobWebJobs.jobs[0].promptJson).toBeUndefined();

      scheduler.start();
      await waitFor(
        () => getDb().get("jobs", jobA2)?.archiveStatus,
        (v) => v === "COMPLETE"
      );
      await scheduler.stop();
      expect(getDb().get("jobs", jobB)?.archiveStatus).toBe("COMPLETE");

      // External GPU must have ZERO submissions, ZERO uploads, and ZERO /free calls!
      expect(externalGpu.submissions).toHaveLength(0);
      expect(externalGpu.uploads).toHaveLength(0);
      expect(externalGpu.frees).toHaveLength(0);
      expect(mock.submissions).toHaveLength(3);

      // H2 regression: suppose VLLM::EngineCore starts MID-JOB on mock while a job is RUNNING.
      // When that job finishes, freeIfIdle must detect the external VRAM and NEVER call POST /free!
      const freesBeforeMidJobSpike = mock.frees.length;
      mock.delay = 350;
      const subMid = await gw("/prompt", prompt, ga);
      const midJobId = (await subMid.json()).prompt_id as string;
      const midScheduler = new Scheduler();
      (midScheduler as any).renew();
      await midScheduler.tick();
      await waitFor(
        () => getDb().get("jobs", midJobId)?.status,
        (v) => v === "RUNNING"
      );
      // External process grabs 28 GiB on mock while midJobId is running!
      mock.torchVramTotal = 4096 * 1024 * 1024;
      mock.torchVramFree = 512 * 1024 * 1024;
      mock.vramFree = (16000 + 512) * 1024 * 1024; // ~29.5 GiB non-ComfyUI VRAM!
      await waitFor(
        () => getDb().get("jobs", midJobId)?.archiveStatus,
        (v) => v === "COMPLETE"
      );
      await midScheduler.stop();
      expect(mock.frees.length).toBe(freesBeforeMidJobSpike);
      expect(getDb().get("workers", cleanWorkerId)?.externalBusy).toBe(true);

      // Reset mock back to clean, then mark it OFFLINE to test M2 (reachable externalBusy beats stopped OFFLINE for UI)
      // and pre-dispatch race + M1 lease-loss re-queue.
      mock.online = false;
      const cw = getDb().get("workers", cleanWorkerId)!;
      cw.healthStatus = "OFFLINE";
      cw.externalBusy = false;
      cw.nodeDefinitions = { SaveImage: { input: { required: {} }, output: [], output_node: true } };
      getDb().put("workers", cw);

      // M2: GET / still loads from reachable externalGpu (200) instead of hitting stopped mock (502)!
      const m2Root = await gw("/", undefined, ga);
      expect(m2Root.status).toBe(200);

      // Pre-dispatch race guard: suppose externalGpu was marked clean at health(), then VLLM grabs VRAM.
      const cleanState = getDb().get("workers", extWorkerId)!;
      cleanState.externalBusy = false;
      cleanState.healthStatus = "ONLINE";
      cleanState.lastAssignedAt = 0;
      getDb().put("workers", cleanState);

      const subRace = await gw("/prompt", prompt, ga);
      const raceJobId = (await subRace.json()).prompt_id as string;
      const raceScheduler = new Scheduler();
      (raceScheduler as any).leader = true;
      const claimed = raceScheduler.claim();
      expect(claimed?.id).toBe(raceJobId);
      expect(claimed?.workerId).toBe(extWorkerId);
      await (raceScheduler as any).dispatch(claimed);

      expect(externalGpu.submissions).toHaveLength(0);
      expect(externalGpu.frees).toHaveLength(0);
      expect(getDb().get("workers", extWorkerId)?.externalBusy).toBe(true);
      expect(getDb().get("jobs", raceJobId)?.status).toBe("QUEUED");
      expect(getDb().get("jobs", raceJobId)?.workerId).toBeNull();

      // M1 regression: if scheduler loses leadership before sending, dispatch re-queues cleanly instead of stranding DISPATCHING.
      mock.online = true;
      mock.vramFree = 48640 * 1024 * 1024;
      mock.torchVramTotal = 128 * 1024 * 1024;
      mock.torchVramFree = 108 * 1024 * 1024;
      const cwOnline = getDb().get("workers", cleanWorkerId)!;
      cwOnline.healthStatus = "ONLINE";
      cwOnline.externalBusy = false;
      getDb().put("workers", cwOnline);
      const leaseScheduler = new Scheduler();
      (leaseScheduler as any).leader = true;
      const claimedM1 = leaseScheduler.claim();
      expect(claimedM1?.id).toBe(raceJobId);
      (leaseScheduler as any).leader = false;
      await (leaseScheduler as any).dispatch(claimedM1);
      expect(getDb().get("jobs", raceJobId)?.status).toBe("QUEUED");
      expect(getDb().get("jobs", raceJobId)?.leaseOwner).toBeNull();
    } finally {
      await externalGpu.close();
    }
  });
  it("strips passwordHash and nodeDefinitions from API responses, validates optional and V3 COMBO dropdowns, and persists failed auth/admin-code audits and rate limits", async () => {
    const a = await admin();
    const rosterRows = Array.from(
      { length: 25 },
      (_, i) => `#2000000${String(i + 1).padStart(2, "0")},Student,Num${i + 1},s${i + 1}@example.edu,#`
    );
    const c = await createClass(a);
    await roster(a, c.id, rosterRows);
    const url = await signup(a, c);

    // 25 students behind a single shared campus NAT IP register concurrently without hitting 429.
    for (let i = 1; i <= 25; i++) {
      const regRes = await register(c, url, `s${i}@example.edu`);
      expect(regRes.status).toBe(200);
    }
    const s1 = authCookie(await consume("s1@example.edu"));

    // API responses never leak passwordHash or 600KB nodeDefinitions.
    const sessJson = await (await api("/auth/session", undefined, s1)).json();
    expect(sessJson.user.email).toBe("s1@example.edu");
    expect("passwordHash" in sessJson.user).toBe(false);
    const usersJson = await (await api("/admin/users", undefined, a)).json();
    expect(usersJson.users.every((u: any) => !("passwordHash" in u))).toBe(true);

    await api("/workers", { name: "GPU-Meta", baseUrl: mock.url }, a);
    const w = getDb().list("workers")[0];
    w.healthStatus = "ONLINE";
    getDb().put("workers", w);
    const g1 = await workspace(s1, c.id);
    expect((await gw("/object_info", undefined, g1)).status).toBe(200);
    expect(getDb().get("workers", w.id)?.nodeDefinitions).toBeTruthy();
    const workersJson = await (await api("/workers", undefined, a)).json();
    expect("nodeDefinitions" in workersJson.workers[0]).toBe(false);

    // Optional legacy dropdown, non-string scalar bypass, and V3 COMBO dropdowns are all strictly enforced (M7).
    const badOpt = await gw(
      "/prompt",
      {
        prompt: {
          "1": { class_type: "TextGenerate", inputs: { prompt: "hello", device: "../../etc/passwd" } },
        },
      },
      g1
    );
    expect(badOpt.status).toBe(400);
    expect((await badOpt.json()).error).toContain("TextGenerate.device");

    const badOptNonString = await gw(
      "/prompt",
      {
        prompt: {
          "1": { class_type: "TextGenerate", inputs: { prompt: "hello", device: 999 } },
        },
      },
      g1
    );
    expect(badOptNonString.status).toBe(400);

    const badV3Combo = await gw(
      "/prompt",
      {
        prompt: {
          "1": { class_type: "MiniMaxH3ReferenceToVideo", inputs: { prompt: "hello", mode: "unapproved" } },
        },
      },
      g1
    );
    expect(badV3Combo.status).toBe(400);
    expect((await badV3Combo.json()).error).toContain("MiniMaxH3ReferenceToVideo.mode");

    // Failed login and failed admin-code attempts persist audits and enforce rollback-proof rate limits.
    expect((await login("s1@example.edu", "wrong-password")).status).toBe(401);
    for (let i = 0; i < 5; i++) {
      expect((await api("/auth/admin-code", { adminCode: "wrong-code" }, s1)).status).toBe(403);
    }
    expect((await api("/auth/admin-code", { adminCode: "wrong-code" }, s1)).status).toBe(429);

    const auditTypes = getDb()
      .list("audits")
      .map((ev) => ev.type);
    expect(auditTypes).toContain("WORKSPACE_EXCHANGED");
    expect(auditTypes).toContain("PROMPT_REJECTED");
    expect(auditTypes).toContain("LOGIN_FAILED");
    expect(auditTypes).toContain("ADMIN_CODE_FAILED");
  });

  it("supports class-wide H3 before signup, manual add/delete student buttons with disk cleanup, and direct admin ComfyUI workspace access", async () => {
    const a = await admin();
    await api("/workers", { name: "GPU-Direct", baseUrl: mock.url }, a);
    scheduler = new Scheduler();
    scheduler.start();

    // 1. Direct Admin ComfyUI workspace access without any student account or class enrollment.
    const adminWsRes = await api("/workspace/session", {}, a);
    expect(adminWsRes.status).toBe(200);
    const adminExchangeUrl = new URL((await adminWsRes.json()).url);
    const adminExchange = await fetch(gatewayUrl + adminExchangeUrl.pathname + adminExchangeUrl.search, {
      redirect: "manual",
    });
    expect(adminExchange.status).toBe(303);
    const gAdmin = authCookie(adminExchange);
    const adminTemplates = (await (await gw("/templates/index.json", undefined, gAdmin)).json()).flatMap((cat: any) =>
      cat.templates.map((t: any) => t.name)
    );
    expect(adminTemplates).toContain("class_video_minimax_h3");
    expect(adminTemplates).toContain("class_video_qwen_minimax_h3");
    const adminSeeded = (await (
      await gw("/api/userdata?dir=workflows&recurse=true", undefined, gAdmin)
    ).json()) as string[];
    expect(adminSeeded).toContain("2 - Video with audio (MiniMax H3).json");
    expect(adminSeeded).toContain("2b - Text to Image to Video (Qwen 2.1 + MiniMax H3).json");
    const adminJobSub = await gw("/prompt", prompt, gAdmin);
    expect(adminJobSub.status).toBe(200);
    const adminJobId = (await adminJobSub.json()).prompt_id as string;
    await waitFor(
      () => getDb().get("jobs", adminJobId)?.archiveStatus,
      (v) => v === "COMPLETE"
    );

    // Internal __admin-workspace__ never leaks into admin class listings, metrics, or session enrollments.
    expect((await (await api("/admin/classes", undefined, a)).json()).classes).toHaveLength(0);
    expect((await (await api("/admin/metrics", undefined, a)).json()).activeClasses).toBe(0);
    expect((await (await api("/auth/session", undefined, a)).json()).enrollments).toHaveLength(0);

    // 2. Class-wide H3 enabled BEFORE any students exist or sign up, plus manual Add student button.
    const c = await createClass(a);
    const enableAllRes = await api(`/admin/classes/${c.id}`, { h3Video: true }, a, "PATCH");
    expect(enableAllRes.status).toBe(200);
    expect((await enableAllRes.json()).class.h3Video).toBe(true);

    // Add student manually without Student ID (auto-generated) BEFORE signup.
    const addRes = await api(
      `/admin/classes/${c.id}/enrollments`,
      { email: "manual1@example.edu", firstName: "Maya", lastName: "Lin" },
      a
    );
    expect(addRes.status).toBe(201);
    const addedEnrollment = (await addRes.json()).enrollment;
    expect(addedEnrollment.rosterEmail).toBe("manual1@example.edu");
    expect(addedEnrollment.orgDefinedId).toMatch(/^manual-/);
    expect(addedEnrollment.h3Video).toBe(true);

    // Toggling unrelated class settings (e.g., paused: true/false) preserves per-student H3 overrides.
    expect(
      (await api(`/admin/classes/${c.id}/enrollments`, { id: addedEnrollment.id, h3Video: false }, a, "PATCH")).status
    ).toBe(200);
    expect((await api(`/admin/classes/${c.id}`, { paused: true, h3Video: true }, a, "PATCH")).status).toBe(200);
    expect(getDb().get("enrollments", addedEnrollment.id)?.h3Video).toBe(false);
    expect((await api(`/admin/classes/${c.id}`, { paused: false, h3Video: false }, a, "PATCH")).status).toBe(200);
    expect((await api(`/admin/classes/${c.id}`, { h3Video: true }, a, "PATCH")).status).toBe(200);
    expect(getDb().get("enrollments", addedEnrollment.id)?.h3Video).toBeUndefined();

    // Duplicate email is rejected with 409.
    expect((await api(`/admin/classes/${c.id}/enrollments`, { email: "manual1@example.edu" }, a)).status).toBe(409);

    // Student signs up using the class signup link; non-admin calling /workspace/session {} gets 400.
    const url = await signup(a, c);
    const maya = await student(c, url, "manual1@example.edu");
    expect((await api("/workspace/session", {}, maya)).status).toBe(400);

    // On Maya's very first ComfyUI entry, H3 is already unlocked and seeded!
    const gMaya = await workspace(maya, c.id);
    expect((await gw("/templates/class_video_minimax_h3.json", undefined, gMaya)).status).toBe(200);
    expect((await gw("/templates/class_video_qwen_minimax_h3.json", undefined, gMaya)).status).toBe(200);
    const mayaFiles = (await (
      await gw("/api/userdata?dir=workflows&recurse=true", undefined, gMaya)
    ).json()) as string[];
    expect(mayaFiles).toContain("2 - Video with audio (MiniMax H3).json");

    // Maya submits a job so archived output files exist on disk.
    const mayaSub = await gw("/prompt", prompt, gMaya);
    expect(mayaSub.status).toBe(200);
    const mayaJobId = (await mayaSub.json()).prompt_id as string;
    await waitFor(
      () => getDb().get("jobs", mayaJobId)?.archiveStatus,
      (v) => v === "COMPLETE"
    );
    const mayaOutput = getDb().list("outputs", "job_id=?", [mayaJobId])[0]!;
    expect(existsSync(mayaOutput.storagePath)).toBe(true);

    // Adding an already-registered student to a second class (created with h3Video: true) attaches immediately!
    const c2Res = await api(
      "/admin/classes",
      {
        name: "Advanced Studio",
        courseCode: "ARTS 4900",
        term: "Spring 2027",
        slug: "arts4900-spring-2027",
        description: "",
        h3Video: true,
      },
      a
    );
    expect(c2Res.status).toBe(201);
    const c2 = (await c2Res.json()).class;
    expect(c2.h3Video).toBe(true);
    const addExistingRes = await api(
      `/admin/classes/${c2.id}/enrollments`,
      { email: "manual1@example.edu", orgDefinedId: "#90012345" },
      a
    );
    expect(addExistingRes.status).toBe(201);
    const attached = (await addExistingRes.json()).enrollment;
    expect(attached.status).toBe("ACTIVE");
    expect(attached.orgDefinedId).toBe("90012345");
    expect(attached.h3Video).toBe(true);

    // 3. Deleting an enrollment while a job is active (or mid-handoff COMPLETED + archiveStatus PENDING) returns 409 ACTIVE_JOBS.
    await scheduler.stop();
    const queuedSub = await gw("/prompt", prompt, gMaya);
    expect(queuedSub.status).toBe(200);
    const queuedJobId = (await queuedSub.json()).prompt_id as string;
    const blockedDel = await api(`/admin/classes/${c.id}/enrollments/${addedEnrollment.id}`, undefined, a, "DELETE");
    expect(blockedDel.status).toBe(409);
    expect((await blockedDel.json()).code).toBe("ACTIVE_JOBS");

    const handoffJob = getDb().get("jobs", queuedJobId)!;
    handoffJob.status = "COMPLETED";
    handoffJob.archiveStatus = "PENDING";
    getDb().put("jobs", handoffJob);
    expect((await api(`/admin/classes/${c.id}/enrollments/${addedEnrollment.id}`, undefined, a, "DELETE")).status).toBe(
      409
    );

    // Mark job cancelled, then delete Maya from class 1.
    handoffJob.status = "CANCELLED";
    getDb().put("jobs", handoffJob);
    const delRes = await api(`/admin/classes/${c.id}/enrollments/${addedEnrollment.id}`, undefined, a, "DELETE");
    expect(delRes.status).toBe(200);
    const delJson = await delRes.json();
    expect(delJson.ok).toBe(true);
    expect(existsSync(mayaOutput.storagePath)).toBe(false);
    expect(getDb().get("enrollments", addedEnrollment.id)).toBeUndefined();
    expect((await gw("/prompt", prompt, gMaya)).status).toBe(401);

    // Maya's global account and her enrollment in class 2 remain intact!
    expect(getDb().userByEmail("manual1@example.edu")?.status).toBe("ACTIVE");
    const gMayaC2 = await workspace(maya, c2.id);
    expect((await gw("/templates/class_video_minimax_h3.json", undefined, gMayaC2)).status).toBe(200);
  });
});
