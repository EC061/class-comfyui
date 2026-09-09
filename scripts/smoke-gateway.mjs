// Gateway live smoke: student login (web) -> workspace token -> exchange ->
// prompt -> proxy -> archival, plus negative cases.
// Usage:
//   WEB=http://localhost:3100 GW=http://localhost:38081 ADMIN_CODE=<code> \
//   WEB_LOG=/tmp/web.log AUDIT_DIR=/tmp/audit node scripts/smoke-gateway.mjs
import fs from "node:fs";
const WEB = process.env.WEB ?? "http://localhost:3100";
const GW = process.env.GW ?? "http://localhost:38081";
const GW_ORIGIN = process.env.GW_ORIGIN ?? GW;
const ADMIN_CODE = process.env.ADMIN_CODE ?? "smoke-admin-code-123";
const AUDIT_DIR = process.env.AUDIT_DIR ?? "/tmp/opencode/audit";
let pass = 0;
function ok(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    console.error(`FAIL ${name} ${extra}`);
    process.exitCode = 1;
  }
}
const LOG = process.env.WEB_LOG ?? "/tmp/opencode/web-start.log";
let logPos = fs.statSync(LOG).size;
function linksSince() {
  const size = fs.statSync(LOG).size;
  const chunk = fs.readFileSync(LOG, "utf8").slice(logPos);
  logPos = size;
  return [...chunk.matchAll(/https?:\/\/\S+/g)].map((m) => m[0].replace(/[),."']+$/, ""));
}

// Admin re-enables signup on the latest smoke class (prior run disabled it;
// direct student login requires an active + signup-enabled roster).
let r = await fetch(`${WEB}/api/auth/request-code`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: WEB },
  body: JSON.stringify({ email: "boss@example.edu", isAdmin: true, adminCode: ADMIN_CODE }),
});
let j = await r.json();
const aLink = new URL(linksSince().pop());
r = await fetch(`${WEB}/api/auth/verify`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: WEB },
  body: JSON.stringify({ email: "boss@example.edu", token: aLink.searchParams.get("token") }),
});
const adminCookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
const classes = await (await fetch(`${WEB}/api/admin/classes`, { headers: { Cookie: adminCookie } })).json();
const smokeClass = classes.classes?.filter((c) => c.slug.includes("smoke")).pop();
ok("smoke class found", !!smokeClass, JSON.stringify(classes.classes?.map((c) => c.slug)));
r = await fetch(`${WEB}/api/admin/classes/${smokeClass.id}/signup`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Origin: WEB, Cookie: adminCookie },
  body: JSON.stringify({ enabled: true }),
});
ok("signup re-enabled", r.status === 200, `${r.status}`);

// Fresh student login via direct flow (student1 enrolled in an active class from prior smoke)
r = await fetch(`${WEB}/api/auth/request-code`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: WEB },
  body: JSON.stringify({ email: "student1@example.edu" }),
});
j = await r.json();
ok("student login code sent", r.status === 200, JSON.stringify(j));
const vlink = new URL(linksSince().pop());
r = await fetch(`${WEB}/api/auth/verify`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: WEB },
  body: JSON.stringify({ email: "student1@example.edu", token: vlink.searchParams.get("token") }),
});
j = await r.json();
ok("student verified", r.status === 200, JSON.stringify(j));
const studentCookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
const sess = await (await fetch(`${WEB}/api/auth/session`, { headers: { Cookie: studentCookie } })).json();
const classId = sess.enrollments?.find((e) => e.status === "ACTIVE")?.classId;
ok("active enrollment found", !!classId, JSON.stringify(sess.enrollments));

// Workspace session -> exchange URL (do NOT follow redirect yet)
r = await fetch(`${WEB}/api/workspace/session`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: WEB, Cookie: studentCookie },
  body: JSON.stringify({ classId }),
});
j = await r.json();
ok("workspace url issued", r.status === 200 && j.url?.includes("/auth/exchange"), JSON.stringify(j));

// Exchange at gateway
r = await fetch(j.url, { redirect: "manual" });
const gwCookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
ok(
  "exchange sets gateway cookie",
  (r.status === 302 || r.status === 200) && gwCookie.startsWith("comfy_gateway="),
  `${r.status} ${r.headers.get("set-cookie")}`
);

// Replay of same one-time token must fail
r = await fetch(j.url, { redirect: "manual" });
const replayBody = await r.text().catch(() => "");
ok("workspace token single-use", r.status === 401, `${r.status} ${replayBody.slice(0, 60)}`);

// Authenticated prompt submission
r = await fetch(`${GW}/prompt`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: GW_ORIGIN, Cookie: gwCookie },
  body: JSON.stringify({ prompt: { 1: { class_type: "KSampler", inputs: {} } } }),
});
j = await r.json().catch(() => ({}));
ok("prompt accepted", r.status === 200 && !!j.prompt_id, `${r.status} ${JSON.stringify(j)}`);

// Unauthenticated prompt -> 401
r = await fetch(`${GW}/prompt`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: GW_ORIGIN },
  body: JSON.stringify({ prompt: { 1: {} } }),
});
ok("prompt requires gateway session", r.status === 401, `${r.status}`);

// Evil origin on prompt -> 403
r = await fetch(`${GW}/prompt`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "https://evil.example.com", Cookie: gwCookie },
  body: JSON.stringify({ prompt: { 1: {} } }),
});
ok("gateway origin attack blocked", r.status === 403, `${r.status}`);

// Proxied GET without session -> 401
r = await fetch(`${GW}/view?filename=out_001.png&subfolder=&type=output`);
ok("proxy requires session", r.status === 401, `${r.status}`);

// Proxied GET with session -> image bytes (never exposes worker URL to client)
r = await fetch(`${GW}/view?filename=out_001.png&subfolder=&type=output`, { headers: { Cookie: gwCookie } });
const buf = Buffer.from(await r.arrayBuffer());
ok("proxied view returns image", r.status === 200 && buf.length > 0, `${r.status} len=${buf.length}`);

// WS without session must be rejected
let wsRejected = false;
try {
  const ws = new WebSocket(`${GW.replace("http", "ws")}/ws?clientId=x`);
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve();
    }, 4000);
    ws.addEventListener("error", () => {
      wsRejected = true;
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener("close", () => {
      wsRejected = true;
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve();
    });
  });
} catch {
  wsRejected = true;
}
ok("ws without session rejected/closed", wsRejected === true, "");

// Archival: gateway polls history then streams outputs to AUDIT_DATA_DIR
await new Promise((res2) => setTimeout(res2, 8000));
import { execSync } from "node:child_process";
let found = "";
try {
  found = execSync(`find ${AUDIT_DIR} -name job.json 2>/dev/null | head -3`).toString();
} catch {}
ok("audit archive written", found.includes("job.json"), found.slice(0, 200));

console.log(`\n${pass} gateway checks passed.`);
