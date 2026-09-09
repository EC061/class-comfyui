// Live acceptance smoke test for the Next.js management app.
// Usage (against a dev server whose SMTP falls back to console logging):
//   BASE=http://localhost:3100 ORIGIN=http://localhost:3100 \
//   ADMIN_CODE=<code> WEB_LOG=/tmp/web.log node scripts/smoke-web.mjs
// Email links are scraped from the server log (dev SMTP logs links to stdout).
import fs from "node:fs";
const LOG = process.env.WEB_LOG ?? "/tmp/opencode/web-start.log";
let logPos = fs.statSync(LOG).size;
function linksSince() {
  const size = fs.statSync(LOG).size;
  const chunk = fs.readFileSync(LOG, "utf8").slice(logPos);
  logPos = size;
  const urls = [...chunk.matchAll(/https?:\/\/\S+/g)].map((m) => m[0].replace(/[),."']+$/, ""));
  return urls;
}
const BASE = process.env.BASE ?? "http://localhost:3100";
const ORIGIN = process.env.ORIGIN ?? BASE;
const ADMIN_CODE = process.env.ADMIN_CODE ?? "smoke-admin-code-123";
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
async function post(path, body, { cookie = "", origin = ORIGIN } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  let j = {};
  try {
    j = await r.json();
  } catch {}
  return { status: r.status, json: j, setCookie: r.headers.get("set-cookie") ?? "" };
}
async function get(path, { cookie = "" } = {}) {
  const r = await fetch(`${BASE}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const cookieOf = (setCookie) => setCookie.split(";")[0] ?? "";

// 1. Admin registration with wrong code -> 403
let r = await post("/api/auth/request-code", { email: "boss@example.edu", isAdmin: true, adminCode: "wrong" });
ok("admin wrong code denied", r.status === 403, JSON.stringify(r.json));

// 2. Correct code -> verification link (dev)
r = await post("/api/auth/request-code", {
  email: "boss@example.edu",
  isAdmin: true,
  adminCode: ADMIN_CODE,
  firstName: "Boss",
  lastName: "Admin",
});
ok("admin correct code accepted", r.status === 200, JSON.stringify(r.json));
const adminLink = new URL(linksSince().pop());
const adminToken = adminLink.searchParams.get("token");

// 3. Verify admin -> session cookie, ADMIN role
r = await post("/api/auth/verify", { email: "boss@example.edu", token: adminToken });
ok("admin verify", r.status === 200 && r.json.role === "ADMIN", JSON.stringify(r.json));
const adminCookie = cookieOf(r.setCookie);
ok("admin session cookie set", adminCookie.startsWith("comfy_session="));

// 4. Reuse of verification token denied
r = await post("/api/auth/verify", { email: "boss@example.edu", token: adminToken });
ok("verification reuse denied", r.status === 400, JSON.stringify(r.json));

// 5. Create class
const slug = `csci4300-smoke-${Date.now()}`;
r = await post(
  "/api/admin/classes",
  { name: "Web Programming", courseCode: "CSCI 4300", term: "Fall 2026", description: "smoke", slug },
  { cookie: adminCookie }
);
ok("class created", r.status === 201, JSON.stringify(r.json));
const classId = r.json.class?.id;

// 6. Origin attack on class creation -> 403
r = await post(
  "/api/admin/classes",
  { name: "Evil", courseCode: "EVIL 1", term: "Fall", slug: "evil-1" },
  { cookie: adminCookie, origin: "https://evil.example.com" }
);
ok("origin attack blocked (evil)", r.status === 403, JSON.stringify(r.json));
for (const evil of [
  `${ORIGIN}.evil.com`,
  `${ORIGIN.replace("http://", "https://")}`,
  `http://127.0.0.1:${new URL(ORIGIN).port}`,
  `http://localhost:9999`,
]) {
  const rr = await post(
    "/api/admin/classes",
    { name: "x", courseCode: "x", term: "x", slug: `x-${Date.now()}-${Math.random()}` },
    { cookie: adminCookie, origin: evil }
  );
  ok(`origin attack blocked (${evil})`, rr.status === 403, `${rr.status}`);
}
// Exact configured origin succeeds (subject to auth)
{
  const rr = await post(
    "/api/admin/classes",
    { name: "Ok", courseCode: "OK 1", term: "T", slug: `ok-${Date.now()}` },
    { cookie: adminCookie, origin: ORIGIN }
  );
  ok("valid origin succeeds", rr.status === 201, `${rr.status} ${JSON.stringify(rr.json)}`);
}

// 7. Roster preview
const csv = `OrgDefinedId,Last Name,First Name,Email,End-of-Line Indicator\n#811883567,Garcia,Amara,student1@example.edu,#\n#811883568,Chen,Liam,student2@example.edu,#`;
r = await post("/api/roster/preview", { classId, csv }, { cookie: adminCookie });
ok("roster preview", r.status === 200 && r.json.preview?.newCount === 2, JSON.stringify(r.json));

// 8. Roster import
r = await post("/api/roster/import", { classId, csv }, { cookie: adminCookie });
ok("roster import", r.status === 200 && r.json.created === 2, JSON.stringify(r.json));

// 9. Generate signup URL
let rr = await fetch(`${BASE}/api/admin/classes/${classId}/signup`, {
  method: "POST",
  headers: { Origin: ORIGIN, Cookie: adminCookie },
});
let jj = await rr.json();
ok("signup URL generated", rr.status === 201 && !!jj.url, JSON.stringify(jj));
const signupUrl1 = jj.url;
const rawToken1 = signupUrl1.split("/").pop();

// 10. Valid student gets verification
r = await post("/api/signup/request", { email: "student1@example.edu", classSlug: slug, signupToken: rawToken1 });
ok("valid student allowed", r.status === 200, JSON.stringify(r.json));
const sLink = new URL(linksSince().pop());
const sToken = sLink.searchParams.get("token");

// 11. Invalid student denied (no verification)
r = await post("/api/signup/request", { email: "not-in-roster@example.com", classSlug: slug, signupToken: rawToken1 });
ok("invalid student denied", r.status === 403 && !r.json.devLink, JSON.stringify(r.json));

// 12. Student verify -> enrollment active
r = await post("/api/auth/verify", { email: "student1@example.edu", token: sToken });
ok("student verify", r.status === 200, JSON.stringify(r.json));
const studentCookie = cookieOf(r.setCookie);
const sess = await get("/api/auth/session", { cookie: studentCookie });
ok(
  "student enrolled",
  sess.json.enrollments?.some((e) => e.classSlug === slug && e.status === "ACTIVE"),
  JSON.stringify(sess.json)
);

// 13. Regenerate -> old link dead, new works
rr = await fetch(`${BASE}/api/admin/classes/${classId}/signup`, {
  method: "POST",
  headers: { Origin: ORIGIN, Cookie: adminCookie },
});
jj = await rr.json();
const rawToken2 = jj.url.split("/").pop();
r = await post("/api/signup/request", { email: "student2@example.edu", classSlug: slug, signupToken: rawToken1 });
ok("old signup link invalid after regen", r.status === 403, JSON.stringify(r.json));
r = await post("/api/signup/request", { email: "student2@example.edu", classSlug: slug, signupToken: rawToken2 });
ok("new signup link works", r.status === 200, JSON.stringify(r.json));

// 14. Disable signup -> blocked immediately
rr = await fetch(`${BASE}/api/admin/classes/${classId}/signup`, {
  method: "PATCH",
  headers: { Origin: ORIGIN, "Content-Type": "application/json", Cookie: adminCookie },
  body: JSON.stringify({ enabled: false }),
});
ok("signup disabled", rr.status === 200, await rr.text());
r = await post("/api/signup/request", { email: "student2@example.edu", classSlug: slug, signupToken: rawToken2 });
ok("disabled signup blocks", r.status === 403, JSON.stringify(r.json));

// 15. Workspace session for student (re-enable not needed for session; enrollment active)
r = await post("/api/workspace/session", { classId }, { cookie: studentCookie });
ok(
  "workspace session issued",
  r.status === 200 && r.json.url?.includes("/auth/exchange?token="),
  JSON.stringify(r.json)
);
globalThis.__exchangeUrl = r.json.url;

// 16. Workspace session requires auth
r = await post("/api/workspace/session", { classId });
ok("workspace session requires auth", r.status === 401, JSON.stringify(r.json));

// 17. Jobs visible to admin; worker URLs never leak to students
const jobs = await get("/api/jobs", { cookie: adminCookie });
const sjobs = await get("/api/jobs", { cookie: studentCookie });
ok("jobs endpoints ok", jobs.status === 200 && sjobs.status === 200);
ok(
  "no worker baseUrl leaks",
  !JSON.stringify(sjobs.json).includes("10.0.0") && !JSON.stringify(sjobs.json).includes("baseUrl")
);

console.log(`\n${pass} checks passed. exchangeUrl=${globalThis.__exchangeUrl}`);
