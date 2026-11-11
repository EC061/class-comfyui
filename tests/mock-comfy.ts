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
  let vramTotal = 49152 * 1024 * 1024;
  let vramFree = 48640 * 1024 * 1024;
  let torchVramTotal = 128 * 1024 * 1024;
  let torchVramFree = 108 * 1024 * 1024;
  let maxRunning = 0;
  const submissions: any[] = [];
  const frees: any[] = [];
  const uploads: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  app.use((_req, res, next) => {
    if (!online) {
      res.status(503).end();
      return;
    }
    next();
  });
  app.get("/system_stats", (_req, res) =>
    res.json({
      system: { comfyui_version: "0.3.26", python_version: "3.12.7" },
      devices: [
        {
          name: "Mock A6000",
          vram_total: vramTotal,
          vram_free: vramFree,
          torch_vram_total: torchVramTotal,
          torch_vram_free: torchVramFree,
        },
      ],
    })
  );
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
      PreviewImage: {
        input: { required: { images: ["IMAGE"] } },
        output: [],
        output_node: true,
      },
      LoadImage: {
        input: { required: { image: [["secret-worker-image.png"], { image_upload: true }] } },
        output: ["IMAGE"],
      },
      EmptyLatentImage: { input: { required: {} }, output: ["LATENT"] },
      VAEDecode: { input: { required: { samples: ["LATENT"] } }, output: ["IMAGE"] },
      MiniMaxH3ReferenceToVideo: {
        input: {
          required: { prompt: ["STRING"] },
          optional: { mode: ["COMBO", { options: ["fast", "quality"] }] },
        },
        output: ["CONDITIONING", "LATENT"],
      },
      SaveVideo: {
        input: { required: { video: ["VIDEO"], filename_prefix: ["STRING"] } },
        output: [],
        output_node: true,
      },
      ComfySwitchNode: {
        input: { required: { switch: ["BOOLEAN"] }, optional: { on_false: ["*"], on_true: ["*"] } },
        output: ["*"],
      },
      PrimitiveBoolean: {
        input: { required: { value: ["BOOLEAN"] } },
        output: ["BOOLEAN"],
      },
      PrimitiveInt: {
        input: { required: { value: ["INT"] } },
        output: ["INT"],
      },
      TextGenerate: {
        input: {
          required: { prompt: ["STRING"] },
          optional: { device: [["cuda", "cpu"]] },
        },
        output: ["STRING"],
      },
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
      if (name) uploads.push(name);
      res.json({ name, subfolder: "", type: "input" });
    });
  });
  app.post("/prompt", (req, res) => {
    const promptObj = (req.body.prompt || {}) as Record<string, any>;
    for (const [nid, node] of Object.entries(promptObj)) {
      for (const [k, v] of Object.entries((node?.inputs || {}) as Record<string, any>)) {
        if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number") {
          if (!promptObj[v[0]]) {
            res.status(400).json({
              error: { type: "invalid_prompt", message: `Dangling link ${nid}.${k} -> ${v[0]}` },
              node_errors: { [nid]: { errors: [{ type: "exception_during_inner_validation", details: v[0] }] } },
            });
            return;
          }
        }
      }
    }
    const id = randomUUID(),
      job = { id, prompt: req.body.prompt };
    submissions.push(req.body);
    running.set(id, job);
    maxRunning = Math.max(maxRunning, running.size);
    for (const client of wss.clients) {
      client.send(
        JSON.stringify({ type: "execution_cached", data: { prompt_id: id, nodes: ["2"], timestamp: Date.now() } })
      );
      client.send(JSON.stringify({ type: "executing", data: { prompt_id: id, node: "1", display_node: "1" } }));
      client.send(
        JSON.stringify({
          type: "progress_state",
          data: {
            prompt_id: id,
            nodes: {
              "1": {
                value: 1,
                max: 2,
                state: "running",
                node_id: "1",
                prompt_id: id,
                display_node_id: "1",
              },
            },
          },
        })
      );
    }
    const shouldFail = fail;
    const timer = setTimeout(() => {
      timers.delete(timer);
      running.delete(id);
      const imageOutNodes = Object.entries((req.body.prompt || {}) as Record<string, any>)
        .filter(([, n]) => ["SaveImage", "PreviewImage"].includes(n?.class_type))
        .map(([k]) => k);
      const outputs: Record<string, any> = {};
      if (!shouldFail) {
        for (const nid of imageOutNodes.length ? imageOutNodes : ["1"]) {
          outputs[nid] = { images: [{ filename: "shared-name.png", subfolder: "", type: "output" }] };
        }
      }
      history[id] = {
        prompt: [0, id, req.body.prompt, {}, []],
        outputs,
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
    res.type("html").send("<!doctype html><title>Mock ComfyUI</title><body><h1>Mock ComfyUI worker</h1></body>")
  );
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    submissions,
    frees,
    uploads,
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
    set vramTotal(v: number) {
      vramTotal = v;
    },
    set vramFree(v: number) {
      vramFree = v;
    },
    set torchVramTotal(v: number) {
      torchVramTotal = v;
    },
    set torchVramFree(v: number) {
      torchVramFree = v;
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
