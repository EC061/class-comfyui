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
async function verify(page: Page, email: string) {
  await page.goto(await mailLink(page.request, email));
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page).toHaveURL(/\/(admin|dashboard)$/);
}
async function api(page: Page, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return page.request.fetch(base + "/api" + path, { method, headers: { Origin: base }, data: body });
}
test("administrator and two isolated students complete the production flow; data and sessions survive restart", async ({
  browser,
  page,
}) => {
  await page.goto("/register/admin");
  await page.locator("input").nth(0).fill("admin@example.edu");
  await page.locator("input[type=password]").fill("e2e-admin-code-with-more-than-32-characters");
  await page.getByRole("button", { name: "Request verification" }).click();
  await expect(page.getByText("Check your email for a sign-in link.")).toBeVisible();
  await verify(page, "admin@example.edu");
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
  const invalid = await api(page, "/signup/request", {
    email: "not-in-roster@example.com",
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
  for (let i = 0; i < 2; i++) {
    const p = students[i];
    await p.goto(signup);
    await p.getByPlaceholder("you@example.edu").fill(`student${i + 1}@example.edu`);
    await p.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(p.getByText("Check your email for a sign-in link.")).toBeVisible();
    await verify(p, `student${i + 1}@example.edu`);
    await expect(p.getByRole("button", { name: "Open ComfyUI" })).toBeVisible();
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
  const old = await api(page, "/signup/request", {
    email: "student1@example.edu",
    classSlug: "csci4300-fall-2026",
    signupToken: signup.split("/").at(-1),
  });
  expect(old.status()).toBe(403);
  for (const context of contexts) await context.close();
});
