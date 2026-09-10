import express from "express";
import multer from "multer";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { getEnv, validateStartup, isAllowedBrowserOrigin } from "@class-comfyui/config";
import { getDb, activeMembership, audit, type Job, type Session, type Worker } from "@class-comfyui/database";
import { verifyWorkspaceToken, hashSessionToken, newSessionToken } from "@class-comfyui/auth";
import { Scheduler } from "./scheduler";
import { workerFetch } from "./storage";
import { installUserData, saveUserData } from "./userdata";
const cookieName = "comfy_gateway";
function cookie(header: string | undefined) {
  return header
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
}
function session(req: IncomingMessage): Session | undefined {
  const raw = cookie(req.headers.cookie);
  if (!raw) return;
  const db = getDb(),
    s = db.get("gateway_sessions", hashSessionToken(raw, getEnv().AUTH_SECRET));
  if (
    !s ||
    s.expiresAt <= Date.now() ||
    !s.classId ||
    !s.enrollmentId ||
    !activeMembership(db, s.userId, s.classId, s.enrollmentId)
  )
    return;
  return s;
}
function sameOrigin(req: IncomingMessage) {
  return isAllowedBrowserOrigin({
    publicUrl: getEnv().COMFY_PUBLIC_URL,
    originHeader: req.headers.origin,
    hostHeader: req.headers.host,
    fetchSite: req.headers["sec-fetch-site"] as string | undefined,
    referer: req.headers.referer,
  });
}
const clients = new Map<WebSocket, Session>();
function notify(job: Job, event: Record<string, any>) {
  for (const [client, s] of clients) {
    if (s.userId !== job.userId || s.classId !== job.classId) continue;
    if (client.readyState === WebSocket.OPEN && activeMembership(getDb(), s.userId, s.classId!, s.enrollmentId))
      client.send(JSON.stringify(event));
  }
}
const coreNodes = [
  "CheckpointLoaderSimple",
  "CLIPTextEncode",
  "CLIPSetLastLayer",
  "EmptyLatentImage",
  "KSampler",
  "KSamplerAdvanced",
  "VAEDecode",
  "VAEEncode",
  "VAELoader",
  "SaveImage",
  "PreviewImage",
  "LoadImage",
  "ImageScale",
  "ImageScaleBy",
  "ImageInvert",
  "ImageBatch",
  "ImagePadForOutpaint",
  "LatentUpscale",
  "LatentUpscaleBy",
  "LatentComposite",
  "LatentBlend",
  "RepeatLatentBatch",
  "LoraLoader",
  "LoraLoaderModelOnly",
  "ConditioningCombine",
  "ConditioningConcat",
  "ConditioningAverage",
  "ConditioningSetArea",
  "ConditioningSetMask",
  "ControlNetLoader",
  "ControlNetApply",
  "ControlNetApplyAdvanced",
  "CLIPVisionLoader",
  "CLIPVisionEncode",
  "UNETLoader",
  "DualCLIPLoader",
  "CLIPLoader",
  "FluxGuidance",
  "ModelSamplingFlux",
  "EmptySD3LatentImage",
  "SaveAnimatedWEBP",
  // MiniMax-H3 video+audio, running on the lab's own weights. The ComfyCloud*
  // and Minimax*Node variants are deliberately absent: identical names, but they
  // POST student prompts and images to a paid third-party API.
  "MiniMaxH3ImageToVideo",
  "MiniMaxH3ReferenceToVideo",
  "MiniMaxH3AddGuide",
  "MiniMaxH3SigmaShift",
  "MiniMaxH3FunControlNetApply",
  "EmptyMiniMaxH3LatentAV",
  "VAEDecodeAudio",
  "ModelPatchLoader",
  // H3 graphs sample through SamplerCustomAdvanced rather than KSampler.
  "SamplerCustomAdvanced",
  "BasicGuider",
  "BasicScheduler",
  "KSamplerSelect",
  "RandomNoise",
  // Video and audio I/O.
  "CreateVideo",
  "SaveVideo",
  "SaveAudio",
  "LoadVideo",
  "GetVideoComponents",
  "Video Slice",
  // Utility nodes the stock H3 templates wire in.
  "ResolutionSelector",
  "GetImageSize",
  "ImageScaleToTotalPixels",
  "ComfyMathExpression",
  "ComfySwitchNode",
  "PrimitiveInt",
  "PrimitiveFloat",
  "PrimitiveBoolean",
  "PrimitiveString",
  "PrimitiveStringMultiline",
];
function approvedNodes() {
  return new Set(
    (process.env.COMFY_ALLOWED_NODES || coreNodes.join(","))
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  );
}
function metadataWorker(): Worker | undefined {
  return getDb()
    .list("workers")
    .filter((w) => w.enabled && (["ONLINE", "BUSY"].includes(w.healthStatus) || w.nodeDefinitions))
    .sort(
      (a, b) => Number(b.healthStatus === "ONLINE") - Number(a.healthStatus === "ONLINE") || a.id.localeCompare(b.id)
    )[0];
}
async function objectInfo(worker: Worker, s: Session) {
  let info: Record<string, any>;
  try {
    const r = await workerFetch(worker, "/object_info", {}, 3000);
    if (!r.ok) throw new Error("Worker metadata unavailable");
    info = (await r.json()) as Record<string, any>;
    getDb().transaction(() => {
      const current = getDb().get("workers", worker.id);
      if (current) {
        current.nodeDefinitions = info;
        getDb().put("workers", current);
      }
    });
  } catch {
    if (!worker.nodeDefinitions) throw new Error("Worker metadata unavailable");
    info = structuredClone(worker.nodeDefinitions);
  }
  const allowed = approvedNodes();
  for (const name of Object.keys(info)) if (!allowed.has(name)) delete info[name];
  const inputs = getDb()
    .list("uploads", "user_id=? AND class_id=?", [s.userId, s.classId!])
    .map((u) => u.filename);
  if (info.LoadImage?.input?.required?.image) info.LoadImage.input.required.image = [inputs, { image_upload: true }];
  return info;
}
function ownJobs(s: Session) {
  return getDb().list("jobs", "user_id=? AND class_id=?", [s.userId, s.classId!]);
}
function queue(s: Session) {
  const jobs = ownJobs(s),
    shape = (j: Job) => [Date.parse(j.submittedAt), j.id, j.promptJson, {}, []];
  return {
    queue_running: jobs.filter((j) => ["DISPATCHING", "RUNNING"].includes(j.status)).map(shape),
    queue_pending: jobs.filter((j) => j.status === "QUEUED").map(shape),
  };
}
function allowedFile(base: string, file: string) {
  const resolved = path.resolve(file);
  return resolved.startsWith(path.resolve(base) + path.sep) ? resolved : undefined;
}
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    });
    for (const h of ["comfy-user", "x-user-id", "x-admin", "x-class-id", "x-role"]) delete req.headers[h];
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameOrigin(req)) {
      res.status(403).json({ error: "Origin check failed" });
      return;
    }
    if (req.url.startsWith("/api/")) req.url = req.url.slice(4);
    next();
  });
  app.get("/health", (_req, res) => {
    getDb().sql.prepare("SELECT 1").get();
    res.json({ ok: true, service: "gateway", database: "sqlite-wal" });
  });
  app.get("/auth/exchange", (req, res) => {
    const token = String(req.query.token || ""),
      env = getEnv(),
      claims = verifyWorkspaceToken(token, env.WORKSPACE_JWT_SECRET);
    if (!claims) {
      res.status(401).send("Invalid or expired workspace link");
      return;
    }
    const raw = getDb().transaction(() => {
      const db = getDb(),
        ticket = db.get("workspace_tickets", claims.jti);
      if (
        !ticket ||
        ticket.consumedAt ||
        ticket.expiresAt <= Date.now() ||
        ticket.userId !== claims.sub ||
        ticket.classId !== claims.classId ||
        ticket.enrollmentId !== claims.enrollmentId ||
        !activeMembership(db, claims.sub, claims.classId, claims.enrollmentId)
      )
        return null;
      ticket.consumedAt = Date.now();
      db.put("workspace_tickets", ticket);
      const raw = newSessionToken();
      db.put("gateway_sessions", {
        id: hashSessionToken(raw, getEnv().AUTH_SECRET),
        userId: claims.sub,
        classId: claims.classId,
        enrollmentId: claims.enrollmentId,
        expiresAt: Date.now() + env.SESSION_TTL_HOURS * 3600000,
      });
      return raw;
    });
    if (!raw) {
      res.status(401).send("Workspace link used, expired, or access revoked");
      return;
    }
    res.setHeader(
      "Set-Cookie",
      `${cookieName}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${env.SESSION_TTL_HOURS * 3600}${env.COMFY_PUBLIC_URL.startsWith("https:") ? "; Secure" : ""}`
    );
    res.redirect(303, "/");
  });
  app.use((req, res, next) => {
    const s = session(req);
    if (!s) {
      res.status(401).send("Open ComfyUI from your class dashboard to sign in.");
      return;
    }
    res.locals.session = s;
    next();
  });
  app.use(
    express.json({
      limit: "5mb",
      strict: false,
      type: (req) =>
        !req.url?.startsWith("/userdata/") && !String(req.headers["content-type"] || "").startsWith("multipart/"),
    })
  );
  app.post("/prompt", async (req, res, next) => {
    try {
      const s = res.locals.session as Session,
        db = getDb(),
        env = getEnv();
      if (!db.rateLimit("prompt:" + s.userId, 30, 60000)) {
        res.status(429).json({ error: "Submission rate limit" });
        return;
      }
      const input = z
        .object({
          prompt: z
            .record(
              z.string(),
              z.object({
                class_type: z.string(),
                inputs: z.record(z.string(), z.unknown()),
                _meta: z.unknown().optional(),
              })
            )
            .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 1000),
          extra_data: z.record(z.string(), z.unknown()).default({}),
          required_tags: z.array(z.string().max(50)).max(20).default([]),
        })
        .parse(req.body);
      const worker = metadataWorker();
      if (!worker) {
        res.status(503).json({ error: "No online worker available to validate the workflow" });
        return;
      }
      const info = await objectInfo(worker, s),
        allowed = approvedNodes(),
        jobId = randomUUID(),
        uploads = new Set(
          db.list("uploads", "user_id=? AND class_id=?", [s.userId, s.classId!]).map((u) => u.filename)
        );
      const submittedPromptJson = structuredClone(input.prompt);
      for (const node of Object.values(input.prompt)) {
        if (!allowed.has(node.class_type) || !info[node.class_type]) {
          res.status(400).json({ error: `Node ${node.class_type} is not approved or available` });
          return;
        }
        if (
          node.class_type === "LoadImage" &&
          (typeof node.inputs.image !== "string" || !uploads.has(node.inputs.image))
        ) {
          res.status(403).json({ error: "Use an image uploaded in this workspace" });
          return;
        }
        if ("filename_prefix" in node.inputs || node.class_type.startsWith("Save"))
          node.inputs.filename_prefix = `lab/${jobId}/output`;
        // Model selectors must use worker-advertised choices, not arbitrary paths.
        const required = info[node.class_type]?.input?.required || {};
        for (const [key, value] of Object.entries(node.inputs)) {
          const options = required[key]?.[0];
          if (Array.isArray(options) && typeof value === "string" && !options.includes(value)) {
            res.status(400).json({ error: `Invalid selection for ${node.class_type}.${key}` });
            return;
          }
        }
      }
      const job = db.transaction(() => {
        const member = activeMembership(db, s.userId, s.classId!, s.enrollmentId);
        if (!member) return null;
        if (db.list("jobs", "user_id=? AND status='QUEUED'", [s.userId]).length >= env.MAX_QUEUED_JOBS_PER_USER)
          return null;
        const j: Job = {
          id: jobId,
          userId: s.userId,
          classId: s.classId!,
          enrollmentId: member.id,
          orgDefinedId: member.orgDefinedId,
          workerId: null,
          comfyPromptId: null,
          status: "QUEUED",
          archiveStatus: "PENDING",
          submittedAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
          runtimeMs: null,
          promptJson: input.prompt,
          submittedPromptJson,
          workflowJson: (input.extra_data.extra_pnginfo as any)?.workflow ?? null,
          extraData: {},
          requiredTags: input.required_tags,
          error: null,
          archiveError: null,
          history: null,
          cancelRequested: false,
          leaseOwner: null,
        };
        db.put("jobs", j);
        audit("JOB_QUEUED", { actorId: s.userId, classId: s.classId!, targetId: j.id });
        return j;
      });
      if (!job) {
        res.status(429).json({ error: "Queue full or enrollment revoked" });
        return;
      }
      res.json({ prompt_id: job.id, number: Date.parse(job.submittedAt), node_errors: {} });
    } catch (e) {
      next(e);
    }
  });
  app.get("/prompt", (_req, res) => {
    const s = res.locals.session as Session;
    res.json({ exec_info: { queue_remaining: queue(s).queue_pending.length + queue(s).queue_running.length } });
  });
  app.get("/queue", (_req, res) => res.json(queue(res.locals.session)));
  app.post("/queue", (req, res) => {
    const s = res.locals.session as Session;
    getDb().transaction(() => {
      for (const j of ownJobs(s)) {
        if (j.status !== "QUEUED") continue;
        if (req.body.clear === true || (Array.isArray(req.body.delete) && req.body.delete.includes(j.id))) {
          j.status = "CANCELLED";
          j.completedAt = new Date().toISOString();
          getDb().put("jobs", j);
        }
      }
    });
    res.json({ ok: true });
  });
  app.post("/interrupt", (_req, res) => {
    getDb().transaction(() => {
      for (const j of ownJobs(res.locals.session)) {
        if (["RUNNING", "DISPATCHING"].includes(j.status)) {
          j.cancelRequested = true;
          getDb().put("jobs", j);
        }
      }
    });
    res.json({ ok: true });
  });
  app.get(["/history", "/history/:id"], (req, res) => {
    let jobs = ownJobs(res.locals.session).filter((j) => j.history && j.archiveStatus === "COMPLETE");
    if (req.params.id) jobs = jobs.filter((j) => j.id === req.params.id);
    res.json(
      Object.fromEntries(
        jobs
          .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
          .slice(0, 200)
          .map((j) => [j.id, j.history])
      )
    );
  });
  app.get("/view", (req, res) => {
    const s = res.locals.session as Session,
      db = getDb(),
      name = String(req.query.filename || "");
    let file: string | undefined,
      mime = "application/octet-stream";
    const upload = db.list("uploads", "user_id=? AND class_id=? AND filename=?", [s.userId, s.classId!, name])[0];
    if (upload) {
      file = allowedFile(getEnv().UPLOAD_DATA_DIR, upload.storagePath);
      mime = upload.mimeType;
    } else {
      const output = db.list("outputs", "json_extract(data,'$.fileName')=?", [name])[0];
      const job = output ? db.get("jobs", output.jobId) : undefined;
      if (output && job && job.userId === s.userId && job.classId === s.classId && job.archiveStatus === "COMPLETE") {
        file = allowedFile(getEnv().AUDIT_DATA_DIR, output.storagePath);
        mime = output.mimeType;
      }
    }
    if (!file || !fs.existsSync(file)) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    if (!/^(image\/(png|jpeg|webp|gif|avif)|video\/(mp4|webm)|audio\/(wav|mpeg|ogg|flac))$/.test(mime))
      res.setHeader("Content-Disposition", "attachment");
    res.type(mime).sendFile(file);
  });
  const upload = multer({
    dest: path.join(getEnv().UPLOAD_DATA_DIR, ".incoming"),
    limits: { fileSize: getEnv().MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 4, fieldSize: 1024 },
  });
  app.post("/upload/image", upload.single("image"), async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "Image required" });
        return;
      }
      const s = res.locals.session as Session,
        env = getEnv(),
        mime = req.file.mimetype;
      const exts: Record<string, string> = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
      };
      if (!exts[mime]) {
        await fsp.rm(req.file.path, { force: true });
        res.status(400).json({ error: "PNG, JPEG, WebP and GIF uploads are supported" });
        return;
      }
      const id = randomUUID(),
        filename = id + exts[mime],
        dest = path.resolve(env.UPLOAD_DATA_DIR, s.userId, s.classId!, filename);
      await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      const accepted = getDb().transaction(() => {
        const db = getDb();
        if (!activeMembership(db, s.userId, s.classId!, s.enrollmentId)) return false;
        const used = db.list("uploads", "user_id=?", [s.userId]).reduce((n, u) => {
          try {
            return n + fs.statSync(u.storagePath).size;
          } catch {
            return n;
          }
        }, 0);
        if (used + req.file!.size > env.MAX_USER_STORAGE_MB * 1024 * 1024) return false;
        fs.renameSync(req.file!.path, dest);
        db.put("uploads", {
          id,
          userId: s.userId,
          classId: s.classId!,
          filename,
          storagePath: dest,
          mimeType: mime,
          createdAt: new Date().toISOString(),
        });
        return true;
      });
      if (!accepted) {
        await fsp.rm(req.file.path, { force: true });
        res.status(413).json({ error: "Storage quota exceeded or access revoked" });
        return;
      }
      res.json({ name: filename, subfolder: "", type: "input" });
    } catch (e) {
      if (req.file) await fsp.rm(req.file.path, { force: true });
      next(e);
    }
  });
  app.get(["/object_info", "/object_info/:name"], async (req, res, next) => {
    try {
      const worker = metadataWorker();
      if (!worker) {
        res.status(503).json({ error: "No worker available" });
        return;
      }
      const info = await objectInfo(worker, res.locals.session);
      res.json(req.params.name ? { [req.params.name]: info[req.params.name] } : info);
    } catch (e) {
      next(e);
    }
  });
  // Real versions so the frontend can version-check nodes rather than warn blindly.
  // `devices` stays empty on purpose: GPU inventory is not a student's business.
  app.get("/system_stats", (_req, res) => {
    const w = metadataWorker();
    res.json({
      system: {
        comfyui_version: w?.comfyVersion ?? "managed",
        python_version: w?.pythonVersion ?? "managed",
        embedded_python: false,
      },
      devices: [],
    });
  });
  app.get("/users", (_req, res) => res.json({ storage: "server", migrated: true }));
  app.get("/settings", (_req, res) => {
    const s = res.locals.session as Session;
    res.json(
      JSON.parse(
        getDb().list("user_data", "user_id=? AND class_id=? AND path=?", [s.userId, s.classId!, "__settings__"])[0]
          ?.content || "{}"
      )
    );
  });
  app.get("/settings/:id", (req, res) => {
    const s = res.locals.session as Session;
    const all = JSON.parse(
      getDb().list("user_data", "user_id=? AND class_id=? AND path=?", [s.userId, s.classId!, "__settings__"])[0]
        ?.content || "{}"
    );
    res.json(Object.hasOwn(all, req.params.id) ? all[req.params.id] : null);
  });
  app.post("/settings", (req, res) => {
    saveUserData(res.locals.session, "__settings__", JSON.stringify(req.body));
    res.json({});
  });
  app.post("/settings/:id", (req, res) => {
    const s = res.locals.session as Session;
    getDb().transaction(() => {
      const all = JSON.parse(
        getDb().list("user_data", "user_id=? AND class_id=? AND path=?", [s.userId, s.classId!, "__settings__"])[0]
          ?.content || "{}"
      );
      all[req.params.id] = req.body;
      saveUserData(s, "__settings__", JSON.stringify(all));
    });
    res.json({});
  });
  installUserData(app);
  // Public frontend assets and read-only model catalogs only. Worker-global APIs,
  // custom extension APIs, filesystem routes, manager/install and arbitrary mutations
  // are deliberately not proxied. Add vetted APIs explicitly with owner checks.
  app.get("*", async (req, res, next) => {
    try {
      const asset =
        req.path === "/" ||
        req.path === "/index.html" ||
        /^\/(assets|scripts|extensions|locales|i18n)\/[a-zA-Z0-9_./@-]+\.(js|css|json|svg|png|woff2?|ttf|ico)$/.test(
          req.path
        ) ||
        /^\/(favicon\.ico|robots\.txt)$/.test(req.path);
      const catalog =
        ["/models", "/embeddings", "/extensions", "/features"].includes(req.path) ||
        /^\/models\/[a-zA-Z0-9_-]+$/.test(req.path);
      if ((!asset && !catalog) || req.path.split("/").includes("..")) {
        res.status(404).json({ error: "Unsupported or private worker endpoint" });
        return;
      }
      const worker = metadataWorker();
      if (!worker) {
        res.status(503).send("No healthy worker available");
        return;
      }
      const response = await workerFetch(worker, req.path);
      res.status(response.status);
      if (response.headers.has("content-type")) res.setHeader("Content-Type", response.headers.get("content-type")!);
      if (!response.body) {
        res.end();
        return;
      }
      await pipeline(Readable.fromWeb(response.body as any), res);
    } catch (e) {
      next(e);
    }
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    if (error instanceof multer.MulterError) {
      res.status(413).json({ error: "Upload exceeds limits" });
      return;
    }
    console.error("[gateway] request failed", error instanceof Error ? error.name : "Error");
    res.status(502).json({ error: "Gateway request failed" });
  });
  return app;
}
export function attachWs(server: ReturnType<typeof createServer>) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url || "/", "http://localhost").pathname !== "/ws" || !sameOrigin(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const s = session(req);
    if (!s) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    if ([...clients.values()].filter((v) => v.userId === s.userId).length >= 10) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      clients.set(client, s);
      client.on("error", () => {});
      client.on("close", () => clients.delete(client));
      client.send(
        JSON.stringify({
          type: "status",
          data: {
            sid: randomUUID(),
            status: {
              exec_info: {
                queue_remaining: ownJobs(s).filter((j) => ["QUEUED", "RUNNING", "DISPATCHING"].includes(j.status))
                  .length,
              },
            },
          },
        })
      );
    });
  });
  const timer = setInterval(() => {
    for (const [client, s] of clients) {
      if (
        s.expiresAt <= Date.now() ||
        !getDb().get("gateway_sessions", s.id) ||
        !activeMembership(getDb(), s.userId, s.classId!, s.enrollmentId)
      ) {
        client.close(1008, "Session expired or access revoked");
        clients.delete(client);
      } else if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            type: "status",
            data: {
              status: {
                exec_info: {
                  queue_remaining: ownJobs(s).filter((j) => ["QUEUED", "RUNNING", "DISPATCHING"].includes(j.status))
                    .length,
                },
              },
            },
          })
        );
      }
    }
  }, 1000);
  timer.unref();
  server.on("close", () => {
    clearInterval(timer);
    for (const client of clients.keys()) client.close();
    wss.close();
  });
  return wss;
}
export function startGateway() {
  validateStartup();
  getDb();
  const app = createApp(),
    server = createServer(app);
  attachWs(server);
  const scheduler = new Scheduler(notify);
  server.listen(getEnv().GATEWAY_PORT, "0.0.0.0", () => console.log("Gateway ready"));
  scheduler.start();
  const stop = () => {
    void scheduler.stop();
    server.close();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return { server, scheduler };
}
if (process.env.GATEWAY_RUN !== "0") startGateway();
