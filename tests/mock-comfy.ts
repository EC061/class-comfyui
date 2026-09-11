import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
export async function mockComfy(port = 0) {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const server = createServer(app),
    wss = new WebSocketServer({ server, path: "/ws" });
  const history: Record<string, any> = {},
    running = new Map<string, any>();
  let online = true,
    delay = 150,
    fail = false;
  let failView = false;
  let maxRunning = 0;
  const submissions: any[] = [];
  const frees: any[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  app.use((_req, res, next) => {
    if (!online) {
      res.status(503).end();
      return;
    }
    next();
  });
  app.get("/system_stats", (_req, res) => res.json({ system: {}, devices: [{ name: "Mock A6000" }] }));
  app.get("/queue", (_req, res) =>
    res.json({ queue_running: [...running.values()].map((j, i) => [i, j.id, j.prompt]), queue_pending: [] })
  );
  app.get("/object_info", (_req, res) =>
    res.json({
      SaveImage: {
        input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } },
        output: [],
        output_node: true,
      },
      LoadImage: {
        input: { required: { image: [["secret-worker-image.png"], { image_upload: true }] } },
        output: ["IMAGE"],
      },
      EmptyLatentImage: { input: { required: {} }, output: ["LATENT"] },
    })
  );
  app.get("/history/:id", (req, res) =>
    res.json(history[req.params.id] ? { [req.params.id]: history[req.params.id] } : {})
  );
  app.get("/view", (_req, res) =>
    failView
      ? res.status(503).end()
      : res
          .type("image/png")
          .send(
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
              "base64"
            )
          )
  );
  app.post("/upload/image", (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const name = Buffer.concat(chunks)
        .toString()
        .match(/filename="([^"]+)"/)?.[1];
      res.json({ name, subfolder: "", type: "input" });
    });
  });
  app.post("/prompt", (req, res) => {
    const id = randomUUID(),
      job = { id, prompt: req.body.prompt };
    submissions.push(req.body);
    running.set(id, job);
    maxRunning = Math.max(maxRunning, running.size);
    for (const client of wss.clients)
      client.send(JSON.stringify({ type: "executing", data: { prompt_id: id, node: "1" } }));
    const shouldFail = fail;
    const timer = setTimeout(() => {
      timers.delete(timer);
      running.delete(id);
      history[id] = {
        prompt: [0, id, req.body.prompt, {}, []],
        outputs: shouldFail
          ? {}
          : { "1": { images: [{ filename: "shared-name.png", subfolder: "", type: "output" }] } },
        status: {
          completed: !shouldFail,
          status_str: shouldFail ? "error" : "success",
          messages: shouldFail ? [["execution_error", {}]] : [],
        },
      };
    }, delay);
    timers.add(timer);
    res.json({ prompt_id: id, number: 0, node_errors: {} });
  });
  app.post("/interrupt", (_req, res) => {
    for (const [id, j] of running) {
      history[id] = {
        prompt: [0, id, j.prompt, {}, []],
        outputs: {},
        status: { completed: false, status_str: "error", messages: [["execution_interrupted", {}]] },
      };
    }
    running.clear();
    res.json({});
  });
  app.post("/queue", (_req, res) => res.json({}));
  app.post("/free", (req, res) => {
    frees.push(req.body);
    res.json({});
  });
  app.get("/private", (_req, res) => res.json({ secret: "must never be proxied" }));
  app.get("/", (_req, res) =>
    res.type("html").send("<!doctype html><title>Mock ComfyUI</title><h1>Mock ComfyUI worker</h1>")
  );
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    submissions,
    frees,
    get maxRunning() {
      return maxRunning;
    },
    set online(v: boolean) {
      online = v;
    },
    set delay(v: number) {
      delay = v;
    },
    set fail(v: boolean) {
      fail = v;
    },
    set failView(v: boolean) {
      failView = v;
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
