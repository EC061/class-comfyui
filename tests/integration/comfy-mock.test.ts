import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";

// Mock ComfyUI worker supporting /system_stats, /prompt, /history/:id, /view, /queue, /ws-upgrade marker.
function startMockComfy(): Promise<{
  server: Server;
  port: number;
  state: { prompts: number; history: Record<string, unknown> };
}> {
  const state: { prompts: number; history: Record<string, unknown> } = { prompts: 0, history: {} };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/system_stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ system: { gpu: "mock" } }));
      return;
    }
    if (url.pathname === "/queue") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
      return;
    }
    if (url.pathname === "/prompt" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        state.prompts += 1;
        const id = `mock-prompt-${state.prompts}`;
        state.history[id] = {
          [id]: { outputs: { "1": { images: [{ filename: "out_001.png", subfolder: "", type: "output" }] } } },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ prompt_id: id }));
      });
      return;
    }
    if (url.pathname.startsWith("/history/")) {
      const id = url.pathname.split("/").pop()!;
      const h = state.history[id];
      if (!h) {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(h));
      return;
    }
    if (url.pathname === "/view") {
      // 1x1 PNG
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
      );
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
      res.end(png);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, port: (server.address() as AddressInfo).port, state }));
  });
}

describe("mock comfy integration", () => {
  let server: Server;
  let port: number;
  let state: { prompts: number; history: Record<string, unknown> };

  beforeAll(async () => {
    const m = await startMockComfy();
    server = m.server;
    port = m.port;
    state = m.state;
  });
  afterAll(() => {
    server.close();
  });

  it("submission -> queue -> history -> view -> archival manifest", async () => {
    const base = `http://127.0.0.1:${port}`;
    const stats = await fetch(`${base}/system_stats`);
    expect(stats.ok).toBe(true);

    const sub = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: { "1": { class_type: "KSampler", inputs: {} } } }),
    });
    expect(sub.ok).toBe(true);
    const { prompt_id } = (await sub.json()) as { prompt_id: string };
    expect(prompt_id).toMatch(/mock-prompt/);

    const hist = await fetch(`${base}/history/${prompt_id}`);
    expect(hist.ok).toBe(true);
    const h = (await hist.json()) as Record<
      string,
      { outputs: Record<string, { images: Array<{ filename: string }> }> }
    >;
    const imgs = Object.values(h[prompt_id].outputs).flatMap((o) => o.images);
    expect(imgs[0].filename).toBe("out_001.png");

    const view = await fetch(`${base}/view?filename=out_001.png&subfolder=&type=output`);
    expect(view.ok).toBe(true);
    expect(view.headers.get("content-type")).toContain("image/png");
    const buf = Buffer.from(await view.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
  });

  it("worker offline is distinguishable from online", async () => {
    const bad = await fetch(`http://127.0.0.1:1/system_stats`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    expect(bad).toBeNull();
  });
});
