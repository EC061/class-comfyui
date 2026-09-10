import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
const base = "http://localhost:13000",
  comfy = "http://localhost:18081";
async function mailLink(request: APIRequestContext, email: string) {
  let url = "";
  await expect
    .poll(async () => {
      const r = await request.get("http://127.0.0.1:18325/mail"),
        messages = await r.json();
      url =
        messages
          .filter((m: any) => m.to === email)
          .at(-1)
          ?.text.match(/https?:\/\/\S+/)?.[0] || "";
      return url;
    })
    .not.toBe("");
  return url;
}
const PASSWORD = "e2e-correct-horse-battery-staple";
/** Opens the single activation link, which signs the new account straight in. */
async function activate(page: Page, email: string) {
  await page.goto(await mailLink(page.request, email));
  await page.getByRole("button", { name: "Activate account" }).click();
  await expect(page).toHaveURL(base + "/");
}
async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
async function api(page: Page, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return page.request.fetch(base + "/api" + path, { method, headers: { Origin: base }, data: body });
}
test("administrator and two isolated students complete the production flow; data and sessions survive restart", async ({
  browser,
  page,
}) => {
  // One registration page for both roles: the administrator code decides the role.
  await page.goto("/register/admin");
  await expect(page).toHaveURL(base + "/register");
  await page.getByLabel("Email", { exact: true }).fill("admin@example.edu");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "I have an administrator registration code" }).click();
  await page.getByLabel("Administrator registration code").fill("e2e-admin-code-with-more-than-32-characters");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(/Open the confirmation email/)).toBeVisible();
  await activate(page, "admin@example.edu");
  // The one shared entry point renders the administrator sections by role.
  await expect(page.getByRole("heading", { name: "Lab status" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Classes", exact: true })).toBeVisible();
  await page.goto("/admin/classes");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: "CSCI 4300 — Fall 2026" }).click();
  await expect(page).toHaveURL(/\/admin\/classes\/[0-9a-f-]{36}$/);
  const classId = page.url().split("/").at(-1)!;
  await page.getByRole("button", { name: "Roster", exact: true }).click();
  await page.getByLabel("Roster CSV file").setInputFiles({
    name: "fabricated.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "OrgDefinedId,Last Name,First Name,Email,End-of-Line Indicator\n#100000001,Example,Alice,student1@example.edu,#\n#100000002,Example,Bob,student2@example.edu,#"
    ),
  });
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByText(/2 rows · New: 2/)).toBeVisible();
  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByText(/Roster imported successfully/)).toBeVisible();
  await page.getByRole("button", { name: "Signup", exact: true }).click();
  const generated = page.waitForResponse((r) => r.url().endsWith("/signup") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Generate student signup link" }).click();
  const signup = (await (await generated).json()).url;
  await expect(page.getByRole("button", { name: "Copy URL" })).toBeVisible();
  const invalid = await api(page, "/auth/register", {
    email: "not-in-roster@example.com",
    password: PASSWORD,
    classSlug: "csci4300-fall-2026",
    signupToken: signup.split("/").at(-1),
  });
  expect(invalid.status()).toBe(403);
  await page.goto("/admin/workers");
  await page.locator("input").nth(1).fill("http://127.0.0.1:18188");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByText("Worker registered")).toBeVisible();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const students = await Promise.all(contexts.map((c) => c.newPage()));
  // A signed-out visitor never reaches an administrative page.
  await students[0].goto("/admin/classes");
  await expect(students[0]).toHaveURL(base + "/login");
  for (let i = 0; i < 2; i++) {
    const p = students[i];
    const email = `student${i + 1}@example.edu`;
    // The emailed class link lands on the same registration page, pre-scoped to
    // the class; a student never sees the administrator entry point.
    await p.goto(signup);
    await expect(p).toHaveURL(/\/register\?slug=csci4300-fall-2026&token=/);
    await expect(p.getByText("CSCI 4300 · Fall 2026")).toBeVisible();
    await expect(p.getByRole("link", { name: "Classes", exact: true })).toHaveCount(0);
    await p.getByLabel("Email", { exact: true }).fill(email);
    await p.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await p.getByLabel("Confirm password").fill(PASSWORD);
    await p.getByRole("button", { name: "Create account" }).click();
    await expect(p.getByText(/Open the confirmation email/)).toBeVisible();
    await activate(p, email);
    await expect(p.getByRole("button", { name: "Open ComfyUI" })).toBeVisible();
    // A student's landing page carries none of the administrator sections, and
    // the administrator routes are refused rather than rendered.
    await expect(p.getByRole("heading", { name: "Lab status" })).toHaveCount(0);
    await p.goto("/admin/classes");
    await expect(p).toHaveURL(base + "/");
    // Signing in again needs only the password: no second confirmation email.
    const mailBefore = (await (await p.request.get("http://127.0.0.1:18325/mail")).json()).length;
    await p.request.post(base + "/api/auth/logout", { headers: { Origin: base } });
    await signIn(p, email);
    await expect(p.getByRole("button", { name: "Open ComfyUI" })).toBeVisible();
    expect((await (await p.request.get("http://127.0.0.1:18325/mail")).json()).length).toBe(mailBefore);
  }
  await expect
    .poll(async () => {
      const r = await api(page, "/workers");
      return (await r.json()).workers[0].healthStatus;
    })
    .toBe("ONLINE");
  for (const p of students) {
    await p.getByRole("button", { name: "Open ComfyUI" }).click();
    await expect(p).toHaveURL(comfy + "/");
    await expect(p.getByRole("heading", { name: "Mock ComfyUI worker" })).toBeVisible();
  }
  for (const p of students)
    await p.evaluate(() => {
      (window as any).events = [];
      const ws = new WebSocket("ws://localhost:18081/ws");
      ws.onmessage = (e) => (window as any).events.push(JSON.parse(e.data));
    });
  const workflow = {
    prompt: {
      "1": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "output" } },
      "2": { class_type: "EmptyLatentImage", inputs: {} },
    },
    extra_data: { extra_pnginfo: { workflow: { nodes: [] } } },
  };
  const submitted = await Promise.all(
    students.map((p) => p.request.post(comfy + "/prompt", { headers: { Origin: comfy }, data: workflow }))
  );
  for (const r of submitted) expect(r.status()).toBe(200);
  const ids = await Promise.all(submitted.map(async (r) => (await r.json()).prompt_id));
  await expect
    .poll(
      async () => {
        const r = await api(page, "/jobs?classId=" + classId);
        return (await r.json()).jobs.filter((j: any) => j.archiveStatus === "COMPLETE").length;
      },
      { timeout: 30000 }
    )
    .toBe(2);
  for (let i = 0; i < 2; i++) {
    await expect
      .poll(() => students[i].evaluate(() => (window as any).events.some((e: any) => e.type === "execution_success")))
      .toBe(true);
    const events = await students[i].evaluate(() => (window as any).events);
    expect(events.some((e: any) => e.data?.prompt_id === ids[1 - i])).toBe(false);
  }
  const jobs = (await (await api(page, "/jobs")).json()).jobs;
  const output = jobs.find((j: any) => j.id === ids[1]).outputs[0];
  expect((await students[0].request.get(comfy + "/view?filename=" + output.fileName)).status()).toBe(404);
  expect(await (await students[0].request.get(comfy + "/history/" + ids[1])).json()).toEqual({});
  await page.goto("/jobs/" + ids[0]);
  await expect(page.getByRole("heading", { name: "Outputs", exact: true })).toBeVisible();
  await expect(page.getByText(/SHA-256:/)).toBeVisible();
  expect(
    (
      await page.request.post(base + "/api/admin/classes", {
        headers: { Origin: "https://evil.example.com" },
        data: {},
      })
    ).status()
  ).toBe(403);
  await page.request.post("http://127.0.0.1:18325/restart");
  await expect
    .poll(async () => {
      try {
        return (await page.request.get(base + "/api/health")).status();
      } catch {
        return 0;
      }
    })
    .toBe(200);
  expect((await api(page, "/admin/classes")).status()).toBe(200);
  expect((await (await api(page, "/jobs")).json()).jobs).toHaveLength(2);
  expect((await students[0].request.get(comfy + "/history")).status()).toBe(200);
  const regen = await api(page, `/admin/classes/${classId}/signup`, {});
  expect(regen.status()).toBe(201);
  const old = await api(page, "/auth/register", {
    email: "student3@example.edu",
    password: PASSWORD,
    classSlug: "csci4300-fall-2026",
    signupToken: signup.split("/").at(-1),
  });
  expect(old.status()).toBe(403);
  // Permanent deletion, driven through the control an administrator actually uses.
  await page.goto(`/admin/classes/${classId}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel(/to confirm/).fill("csci4300-fall-2026");
  await page.getByRole("button", { name: "Delete class and all data" }).click();
  await expect(page).toHaveURL(base + "/admin/classes");
  await expect(page.getByRole("link", { name: "CSCI 4300 — Fall 2026" })).toHaveCount(0);
  expect((await api(page, "/admin/classes/" + classId)).status()).toBe(404);
  expect((await (await api(page, "/jobs")).json()).jobs).toHaveLength(0);
  for (const context of contexts) await context.close();
});
