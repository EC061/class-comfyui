import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { getEnv, comfyCanonicalOrigin } from "@class-comfyui/config";
import { verifyWorkspaceToken } from "@class-comfyui/auth";
import { stripIdentityHeaders, sanitizePathSegment } from "@class-comfyui/shared";

// ---- Types ----
interface WorkerInfo {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  tags: string[];
  maxConcurrentJobs: number;
  healthStatus: "ONLINE" | "BUSY" | "OFFLINE" | "DISABLED";
  load: number;
}

interface GatewaySession {
  id: string;
  userId: string;
  classId: string;
  enrollmentId: string;
  expiresAt: number;
  workerId: string | null; // affinity
}

interface JobRecord {
  id: string;
  classId: string;
  userId: string;
  workerId: string | null;
  comfyPromptId: string;
  status: string;
  submittedAt: string;
  promptJson: unknown;
}

// ---- State (single-instance; Postgres is source of truth for workers/jobs when configured) ----
const workers = new Map<string, WorkerInfo>();
const sessions = new Map<string, GatewaySession>();
const consumedJtis = new Map<string, number>();
const jobs = new Map<string, JobRecord>();
const userActive = new Map<string, number>();
const userQueued = new Map<string, number[]>();

const env = getEnv();
const GATEWAY_COOKIE = "comfy_gateway";
const isSecure = (() => {
  try {
    return new URL(env.COMFY_PUBLIC_URL).protocol === "https:";
  } catch {
    return false;
  }
})();

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookieValue(id: string): string {
  return `${GATEWAY_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${isSecure ? "; Secure" : ""}`;
}

function getSession(req: express.Request): GatewaySession | null {
  const cookies = parseCookies(req.headers.cookie);
  const id = cookies[GATEWAY_COOKIE];
  if (!id) return null;
  const s = sessions.get(id);
  if (!s || s.expiresAt <= Date.now()) {
    if (id) sessions.delete(id);
    return null;
  }
  return s;
}

// Seed a mock worker entry if DB has none (dev). Production registers via web UI -> Postgres;
// gateway loads workers from Postgres when DATABASE_URL is real (see loadWorkers()).
function seedWorkers() {
  if (workers.size === 0) {
    workers.set("mock", {
      id: "mock",
      name: "mock-4090",
      baseUrl: process.env.MOCK_COMFY_URL ?? "http://127.0.0.1:8188",
      enabled: true,
      tags: ["4090", "24gb"],
      maxConcurrentJobs: 1,
      healthStatus: "OFFLINE",
      load: 0,
    });
  }
}

async function loadWorkersFromDb() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url || url.includes("CHANGE_ME")) return;
  try {
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: url, max: 2 });
    const { rows } = await pool.query(
      "SELECT id, name, base_url, enabled, tags, max_concurrent_jobs, health_status FROM workers"
    );
    for (const r of rows) {
      const existing = workers.get(String(r.id));
      workers.set(String(r.id), {
        id: String(r.id),
        name: r.name,
        baseUrl: r.base_url,
        enabled: r.enabled,
        tags: Array.isArray(r.tags) ? r.tags : [],
        maxConcurrentJobs: r.max_concurrent_jobs ?? 1,
        healthStatus: existing?.healthStatus ?? ((r.health_status as WorkerInfo["healthStatus"]) || "OFFLINE"),
        load: existing?.load ?? 0,
      });
    }
    await pool.end();
  } catch (e) {
    console.warn("[gateway] worker DB load failed, using in-memory:", (e as Error).message);
  }
}

export function selectWorker(requiredTags: string[] = []): WorkerInfo | null {
  const eligible = [...workers.values()].filter(
    (w) =>
      w.enabled &&
      (w.healthStatus === "ONLINE" || w.healthStatus === "BUSY") &&
      w.load < w.maxConcurrentJobs &&
      requiredTags.every((t) => w.tags.includes(t))
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => a.load - b.load || (a.id < b.id ? -1 : 1));
  return eligible[0];
}

async function healthCheckLoop() {
  for (const w of workers.values()) {
    if (!w.enabled) {
      w.healthStatus = "DISABLED";
      continue;
    }
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch(`${w.baseUrl.replace(/\/$/, "")}/system_stats`, { signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) {
        w.healthStatus = w.load > 0 ? "BUSY" : "ONLINE";
      } else {
        w.healthStatus = "OFFLINE";
      }
    } catch {
      w.healthStatus = "OFFLINE";
    }
  }
}

function expectedComfyOrigin(): string {
  try {
    return comfyCanonicalOrigin(env.COMFY_PUBLIC_URL);
  } catch {
    return "";
  }
}

function enforceGatewayOrigin(req: express.Request, res: express.Response): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const origin = req.headers.origin;
  const expected = expectedComfyOrigin();
  if (origin && origin !== expected) {
    res.status(403).json({ error: `Origin check failed. Expected ${expected}.` });
    return false;
  }
  return true;
}

async function archiveOutputs(job: JobRecord, worker: WorkerInfo, classSlug: string, orgId: string) {
  const base = process.env.AUDIT_DATA_DIR ?? "/data/audit";
  const d = new Date();
  const dir = path.join(
    base,
    sanitizePathSegment(classSlug || "unknown-class"),
    sanitizePathSegment(orgId || job.userId),
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    sanitizePathSegment(job.id)
  );
  fs.mkdirSync(path.join(dir, "outputs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "api_prompt.json"), JSON.stringify(job.promptJson ?? {}, null, 2));
  fs.writeFileSync(
    path.join(dir, "job.json"),
    JSON.stringify({ ...job, worker: worker.name, archivedAt: new Date().toISOString() }, null, 2)
  );
  // Fetch history, then stream each output via /view without buffering whole files in memory.
  try {
    const h = await fetch(`${worker.baseUrl.replace(/\/$/, "")}/history/${job.comfyPromptId}`);
    if (!h.ok) {
      fs.writeFileSync(path.join(dir, "archive_error.json"), JSON.stringify({ error: `history ${h.status}` }));
      return { ok: false as const, dir };
    }
    const hist = (await h.json()) as Record<
      string,
      { outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }> }
    >;
    const entry = hist[job.comfyPromptId];
    const images = Object.values(entry?.outputs ?? {}).flatMap((o) => o.images ?? []);
    const manifest: Array<Record<string, unknown>> = [];
    for (const img of images) {
      const q = new URLSearchParams({
        filename: img.filename,
        subfolder: img.subfolder ?? "",
        type: img.type ?? "output",
      });
      const resp = await fetch(`${worker.baseUrl.replace(/\/$/, "")}/view?${q.toString()}`);
      if (!resp.ok || !resp.body) continue;
      const safeName = path.basename(img.filename).replace(/[^a-zA-Z0-9._-]+/g, "_");
      const dest = path.join(dir, "outputs", safeName);
      const fileStream = fs.createWriteStream(dest);
      const hash = createHash("sha256");
      let size = 0;
      const reader = resp.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        hash.update(value);
        fileStream.write(Buffer.from(value));
      }
      fileStream.end();
      await new Promise<void>((resolve) => fileStream.on("finish", () => resolve()));
      manifest.push({ fileName: safeName, sizeBytes: size, sha256: hash.digest("hex"), workerFileName: img.filename });
    }
    fs.writeFileSync(path.join(dir, "outputs_manifest.json"), JSON.stringify(manifest, null, 2));
    return { ok: true as const, dir, count: manifest.length };
  } catch (e) {
    fs.writeFileSync(path.join(dir, "archive_error.json"), JSON.stringify({ error: String(e) }));
    return { ok: false as const, dir };
  }
}

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "10mb" }));

  // Strip forged identity headers: never trust browser-provided identity.
  app.use((req, _res, next) => {
    const cleaned = stripIdentityHeaders(req.headers as unknown as Record<string, unknown>);
    for (const k of Object.keys(req.headers)) delete req.headers[k];
    Object.assign(req.headers, cleaned);
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true, service: "gateway", time: new Date().toISOString() }));

  // One-time workspace token exchange: sets gateway HttpOwn session cookie.
  app.get("/auth/exchange", (req, res) => {
    const token = String(req.query.token ?? "");
    if (!token) return res.status(400).send("Missing token");
    const claims = verifyWorkspaceToken(token, env.WORKSPACE_JWT_SECRET);
    if (!claims) return res.status(401).send("Invalid or expired token");
    if (consumedJtis.has(claims.jti)) return res.status(401).send("Token already used");
    consumedJtis.set(claims.jti, claims.exp * 1000);
    const sid = randomUUID();
    sessions.set(sid, {
      id: sid,
      userId: claims.sub,
      classId: claims.classId,
      enrollmentId: claims.enrollmentId,
      expiresAt: Date.now() + 24 * 3600 * 1000,
      workerId: null,
    });
    res.setHeader("Set-Cookie", sessionCookieValue(sid));
    // Redirect to ComfyUI root (served via proxy below)
    res.redirect(302, "/");
  });

  // Intercept prompt submission: auth, quota, job record, scheduling, forward, archive.
  app.post("/prompt", async (req, res) => {
    if (!enforceGatewayOrigin(req, res)) return;
    const sess = getSession(req);
    if (!sess) return res.status(401).json({ error: "Gateway session required" });
    const prompt = req.body?.prompt ?? req.body;
    if (!prompt || typeof prompt !== "object") return res.status(400).json({ error: "Invalid prompt" });

    const active = userActive.get(sess.userId) ?? 0;
    const queued = userQueued.get(sess.userId)?.length ?? 0;
    const maxActive = Number(process.env.MAX_ACTIVE_JOBS_PER_USER ?? 1);
    const maxQueued = Number(process.env.MAX_QUEUED_JOBS_PER_USER ?? 3);
    if (active >= maxActive) return res.status(429).json({ error: "Active job limit reached" });
    if (queued >= maxQueued) return res.status(429).json({ error: "Queued job limit reached" });

    // Worker affinity: reuse session worker if healthy, else select least-loaded.
    let worker = sess.workerId ? (workers.get(sess.workerId) ?? null) : null;
    if (!worker || !worker.enabled || worker.healthStatus === "OFFLINE" || worker.healthStatus === "DISABLED") {
      worker = selectWorker();
    }
    if (!worker) return res.status(503).json({ error: "No GPU worker available" });
    sess.workerId = worker.id;

    const jobId = randomUUID();
    const job: JobRecord = {
      id: jobId,
      classId: sess.classId,
      userId: sess.userId,
      workerId: worker.id,
      comfyPromptId: "",
      status: "DISPATCHING",
      submittedAt: new Date().toISOString(),
      promptJson: prompt,
    };
    jobs.set(jobId, job);
    userActive.set(sess.userId, active + 1);
    worker.load += 1;
    worker.healthStatus = "BUSY";

    try {
      const r = await fetch(`${worker.baseUrl.replace(/\/$/, "")}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!r.ok) throw new Error(`worker ${r.status}`);
      const j = (await r.json()) as { prompt_id?: string; promptId?: string };
      job.comfyPromptId = j.prompt_id ?? j.promptId ?? randomUUID();
      job.status = "RUNNING";
      // Best-effort: poll history briefly, then archive asynchronously.
      setImmediate(async () => {
        try {
          for (let i = 0; i < 120; i++) {
            await new Promise((r2) => setTimeout(r2, 2000));
            try {
              const h = await fetch(`${worker!.baseUrl.replace(/\/$/, "")}/history/${job.comfyPromptId}`);
              if (h.ok) {
                const hist = (await h.json()) as Record<string, unknown>;
                if (hist[job.comfyPromptId]) break;
              }
            } catch {
              /* keep polling */
            }
          }
          job.status = "COMPLETED";
          await archiveOutputs(job, worker!, "class", sess.userId);
        } catch (e) {
          job.status = "FAILED";
        } finally {
          worker!.load = Math.max(0, worker!.load - 1);
          userActive.set(sess.userId, Math.max(0, (userActive.get(sess.userId) ?? 1) - 1));
        }
      });
      return res.json({ prompt_id: job.comfyPromptId, jobId });
    } catch (e) {
      worker.load = Math.max(0, worker.load - 1);
      userActive.set(sess.userId, Math.max(0, (userActive.get(sess.userId) ?? 1) - 1));
      job.status = "FAILED";
      return res.status(502).json({ error: "Worker failed to accept prompt" });
    }
  });

  // Transparent proxy for other ComfyUI routes (GET assets, /history, /view, /queue, /object_info...)
  app.use(async (req, res) => {
    if (req.path.startsWith("/auth/") || req.path === "/health") return res.status(404).end();
    const sess = getSession(req);
    if (!sess)
      return res.status(401).json({ error: "Gateway session required. Open ComfyUI from your class dashboard." });
    let worker = sess.workerId ? (workers.get(sess.workerId) ?? null) : selectWorker();
    if (!worker) return res.status(503).json({ error: "No GPU worker available" });
    sess.workerId = worker.id;
    const target = `${worker.baseUrl.replace(/\/$/, "")}${req.originalUrl}`;
    try {
      const headers: Record<string, string> = {};
      if (req.headers["content-type"]) headers["content-type"] = String(req.headers["content-type"]);
      const init: RequestInit = { method: req.method, headers };
      if (!["GET", "HEAD"].includes(req.method)) init.body = JSON.stringify(req.body ?? {});
      const r = await fetch(target, init);
      res.status(r.status);
      r.headers.forEach((v, k) => {
        if (!["content-encoding", "transfer-encoding"].includes(k.toLowerCase())) res.setHeader(k, v);
      });
      if (!r.body) return res.end();
      // Stream without buffering whole files in memory
      const reader = r.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch {
      worker.healthStatus = "OFFLINE";
      return res.status(502).json({ error: "Worker unreachable" });
    }
  });

  return app;
}

// WebSocket proxy for /ws (ComfyUI live status)
export function attachWs(server: ReturnType<typeof createServer>) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/ws", "http://localhost");
    if (!url.pathname.startsWith("/ws")) {
      socket.destroy();
      return;
    }
    const cookies = parseCookies(req.headers.cookie);
    const sess = cookies[GATEWAY_COOKIE] ? sessions.get(cookies[GATEWAY_COOKIE]) : null;
    if (!sess || sess.expiresAt <= Date.now()) {
      socket.destroy();
      return;
    }
    const worker = (sess.workerId && workers.get(sess.workerId)) || selectWorker();
    if (!worker) {
      socket.destroy();
      return;
    }
    const target = worker.baseUrl.replace(/^http/, "ws").replace(/\/$/, "") + (req.url ?? "/ws");
    const upstream = new WebSocket(target);
    wss.handleUpgrade(req, socket, head, (client) => {
      const relay = (a: WebSocket, b: WebSocket) => {
        a.on("message", (m) => {
          if (b.readyState === WebSocket.OPEN) b.send(m as Buffer);
        });
        a.on("close", () => {
          try {
            b.close();
          } catch {
            /* noop */
          }
        });
      };
      upstream.on("open", () => {
        relay(client, upstream);
        relay(upstream, client);
      });
      upstream.on("error", () => {
        try {
          client.close();
        } catch {
          /* noop */
        }
      });
    });
  });
}

if (process.env.GATEWAY_RUN !== "0") {
  seedWorkers();
  loadWorkersFromDb().finally(() => {
    setInterval(() => {
      healthCheckLoop().catch(() => undefined);
    }, 15_000);
    healthCheckLoop().catch(() => undefined);
    const app = createApp();
    const server = createServer(app);
    attachWs(server);
    const port = Number(process.env.GATEWAY_PORT ?? 8081);
    server.listen(port, () => console.log(`[gateway] listening on :${port}`));
  });
}
