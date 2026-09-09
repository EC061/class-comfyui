// Minimal mock ComfyUI worker for gateway smoke test.
// Usage: PORT=38188 node scripts/mock-comfy.mjs
import { createServer } from "node:http";
const state = { prompts: 0, history: {} };
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/system_stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ system: { gpu: "mock-4090" } }));
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
        [id]: { outputs: { 1: { images: [{ filename: "out_001.png", subfolder: "", type: "output" }] } } },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ prompt_id: id }));
    });
    return;
  }
  if (url.pathname.startsWith("/history/")) {
    const id = url.pathname.split("/").pop();
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
const PORT = Number(process.env.PORT ?? 38188);
server.listen(PORT, () => console.log(`[mock-comfy] :${PORT}`));
