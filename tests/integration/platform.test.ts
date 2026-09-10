import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
async function verified(email: string, isAdmin = false) {
  const r = await api("/auth/request-code", { email, isAdmin, adminCode: process.env.ADMIN_REGISTRATION_CODE });
  expect(r.status).toBe(200);
  return consume(email);
}
async function consume(email: string) {
  const text = emails.filter((m) => m.to === email.toLowerCase()).at(-1)!.text,
    url = new URL(text.match(/https?:\/\/\S+/)![0]);
  return api("/auth/verify", { email, token: url.searchParams.get("token") });
}
async function admin() {
  const res = await verified("admin@example.edu", true);
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
async function student(c: any, url: string, email = "student1@example.edu") {
  const r = await api("/signup/request", { classSlug: c.slug, signupToken: url.split("/").at(-1), email });
  expect(r.status).toBe(200);
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
  extra_data: { extra_pnginfo: { workflow: { nodes: [{ id: 1 }] } } },
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
      expect((await api("/auth/request-code", { email: "a@example.edu" }, "", "POST", invalid)).status).toBe(403);
    expect((await api("/auth/request-code", { email: "a@example.edu" })).status).toBe(403);
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
    expect((await verified("admin@example.edu")).status).toBe(200);
  });
  it("requires roster and email ownership, binds class, revokes old links and pending challenges", async () => {
    const a = await admin(),
      c = await createClass(a);
    await roster(a, c.id);
    const url = await signup(a, c),
      token = url.split("/").at(-1);
    const before = emails.length;
    expect(
      (await api("/signup/request", { classSlug: c.slug, signupToken: token, email: "attacker@example.com" })).status
    ).toBe(403);
    expect(emails.length).toBe(before);
    expect(getDb().userByEmail("student1@example.edu")).toBeUndefined();
    const wrong = await createClass(a, "class-b"),
      wrongUrl = await signup(a, wrong);
    expect(
      (
        await api("/signup/request", {
          classSlug: wrong.slug,
          signupToken: wrongUrl.split("/").at(-1),
          email: "student1@example.edu",
        })
      ).status
    ).toBe(403);
    expect(
      (await api("/signup/request", { classSlug: c.slug, signupToken: token, email: "student1@example.edu" })).status
    ).toBe(200);
    await signup(a, c);
    expect((await consume("student1@example.edu")).status).toBe(403);
    expect(getDb().userByEmail("student1@example.edu")).toBeUndefined();
    expect(
      (await api("/signup/request", { classSlug: c.slug, signupToken: token, email: "student2@example.edu" })).status
    ).toBe(403);
  });
  it("registration is single use, preserves global account, and disabled signup does not disable login", async () => {
    const a = await admin(),
      c = await createClass(a);
    await roster(a, c.id);
    const url = await signup(a, c);
    await student(c, url, "Student1@Example.EDU");
    expect((await consume("student1@example.edu")).status).toBe(400);
    const u = getDb().userByEmail("student1@example.edu")!;
    await api(`/admin/classes/${c.id}/signup`, { enabled: false }, a, "PATCH");
    expect((await verified("student1@example.edu")).status).toBe(200);
    const c2 = await createClass(a, "class-b");
    await roster(a, c2.id);
    const url2 = await signup(a, c2);
    await student(c2, url2);
    expect(getDb().userByEmail(u.email)?.id).toBe(u.id);
    expect(getDb().list("enrollments", "user_id=?", [u.id])).toHaveLength(2);
  });
  it("expired verification and disabled accounts are denied; final admin changes are atomic", async () => {
    const a = await admin();
    const adminUser = getDb().userByEmail("admin@example.edu")!;
    expect((await api("/admin/users?id=" + adminUser.id, { status: "DISABLED" }, a, "PATCH")).status).toBe(409);
    expect((await api("/auth/request-code", { email: "admin@example.edu" })).status).toBe(200);
    for (const t of getDb().list("verifications")) {
      t.expiresAt = 0;
      getDb().put("verifications", t);
    }
    expect((await consume("admin@example.edu")).status).toBe(400);
    const c = await createClass(a);
    await roster(a, c.id);
    await student(c, await signup(a, c));
    const u = getDb().userByEmail("student1@example.edu")!;
    await api("/admin/users?id=" + u.id, { status: "DISABLED" }, a, "PATCH");
    expect((await api("/auth/request-code", { email: u.email })).status).toBe(403);
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
    expect((await api("/auth/request-code", { email: "admin@example.edu" })).status).toBe(502);
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
    // The seeding marker shares the user_data table with the student's files but
    // must never surface as one.
    expect(await (await gw("/api/userdata?recurse=true", undefined, ga)).json()).not.toContain("__starters__");
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
});
