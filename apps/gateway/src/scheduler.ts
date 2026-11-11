import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import fsp from "node:fs/promises";
import { getDb, activeMembership, audit, fairQueuedJobs, type Job, type Worker } from "@class-comfyui/database";
import { getEnv } from "@class-comfyui/config";
import { workerFetch, archive, archiveDirectory, stageUploads } from "./storage";
export type Notify = (job: Job, event: Record<string, any>) => void;
function sanitizeWorkerMessage(raw: unknown, fallback: string): string {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const cleaned = raw
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, "[path]")
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]+/g, "[path]")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, 280) : fallback;
}
function extractPromptRejectionReason(
  status: number,
  payload: any
): {
  message: string;
  nodeId: string;
  nodeType: string;
} {
  const fallback = `Worker rejected prompt (${status})`;
  if (!payload || typeof payload !== "object") return { message: fallback, nodeId: "", nodeType: "" };
  const nodeErrors = payload.node_errors;
  if (nodeErrors && typeof nodeErrors === "object") {
    for (const [nodeId, info] of Object.entries(nodeErrors as Record<string, any>)) {
      if (!info || typeof info !== "object") continue;
      const nodeType = typeof info.class_type === "string" ? info.class_type : "";
      const firstErr = Array.isArray(info.errors) ? info.errors[0] : undefined;
      const detail = firstErr?.details || firstErr?.message || payload.error?.message;
      const msg = sanitizeWorkerMessage(detail, fallback);
      const label = nodeType ? `Node #${nodeId} (${nodeType})` : `Node #${nodeId}`;
      return { message: `${label}: ${msg}`, nodeId: String(nodeId), nodeType };
    }
  }
  const topMsg = payload.error?.message ?? (typeof payload.error === "string" ? payload.error : undefined);
  return { message: sanitizeWorkerMessage(topMsg, fallback), nodeId: "", nodeType: "" };
}
function extractRuntimeErrorDetail(entry: Record<string, any>): {
  message: string;
  nodeId: string;
  nodeType: string;
} {
  const fallback = "Worker execution failed or interrupted";
  const messages = Array.isArray(entry?.status?.messages) ? entry.status.messages : [];
  for (const item of messages) {
    if (!Array.isArray(item) || item[0] !== "execution_error" || !item[1] || typeof item[1] !== "object") continue;
    const err = item[1] as Record<string, unknown>;
    const nodeId = err.node_id !== undefined && err.node_id !== null ? String(err.node_id) : "";
    const nodeType = typeof err.node_type === "string" ? err.node_type : "";
    const msg = sanitizeWorkerMessage(err.exception_message, fallback);
    const prefix = nodeId && nodeType ? `Node #${nodeId} (${nodeType}): ` : nodeType ? `${nodeType}: ` : "";
    return { message: `${prefix}${msg}`.slice(0, 300), nodeId, nodeType };
  }
  return { message: fallback, nodeId: "", nodeType: "" };
}
function evaluateWorkerTelemetry(
  statsBody: any,
  queueBody: any,
  managedPromptIds: Set<string | null>,
  managedCount: number,
  isReleasing: boolean
) {
  const sys = statsBody?.system;
  const dev = Array.isArray(statsBody?.devices) ? statsBody.devices[0] : undefined;
  const vramTotal = Number(dev?.vram_total ?? 0);
  const vramFree = Number(dev?.vram_free ?? 0);
  const torchVramTotal = Number(dev?.torch_vram_total);
  const torchVramFree = Number(dev?.torch_vram_free);
  const hasVram = Number.isFinite(vramTotal) && vramTotal > 0 && Number.isFinite(vramFree) && vramFree >= 0;
  const hasTorchVram =
    hasVram &&
    Number.isFinite(torchVramTotal) &&
    torchVramTotal >= 0 &&
    Number.isFinite(torchVramFree) &&
    torchVramFree >= 0;
  // ComfyUI sets vram_free = cuda_driver_free + torch_vram_free. Subtracting
  // ComfyUI's own PyTorch active/reserved pool isolates non-ComfyUI GPU processes
  // (e.g. VLLM::EngineCore) even when ComfyUI holds tens of GiB of cached models
  // or is actively running a job.
  const driverFreeBytes = hasTorchVram ? Math.max(0, vramFree - torchVramFree) : vramFree;
  const driverUsedBytes = hasVram ? Math.max(0, vramTotal - driverFreeBytes) : null;
  const torchActiveBytes = hasTorchVram ? Math.max(0, torchVramTotal - torchVramFree) : 0;
  const nonComfyVramBytes = hasVram
    ? hasTorchVram
      ? Math.max(0, vramTotal - vramFree - torchActiveBytes)
      : Math.max(0, vramTotal - vramFree)
    : null;
  const vramUsedMb = driverUsedBytes !== null ? Math.round(driverUsedBytes / (1024 * 1024)) : null;
  const vramFreeMb = hasVram ? Math.round(driverFreeBytes / (1024 * 1024)) : null;
  const work = [...(queueBody?.queue_running || []), ...(queueBody?.queue_pending || [])];
  const unmanagedQueue = work.some((v: any) => !managedPromptIds.has(v[1]));
  const thresholdBytes = getEnv().WORKER_EXTERNAL_VRAM_THRESHOLD_MB * 1024 * 1024;
  const externalVramBusy =
    nonComfyVramBytes !== null &&
    (hasTorchVram
      ? nonComfyVramBytes > thresholdBytes
      : managedCount === 0 && work.length === 0 && !isReleasing && nonComfyVramBytes > thresholdBytes);
  const externalBusy = unmanagedQueue || externalVramBusy;
  const nonComfyMb = nonComfyVramBytes !== null ? Math.round(nonComfyVramBytes / (1024 * 1024)) : vramUsedMb;
  const externalBusyReason = unmanagedQueue
    ? "Unmanaged ComfyUI queue items running on worker"
    : externalVramBusy
      ? `External GPU process occupying ${nonComfyMb} MB VRAM (protected)`
      : null;
  const state: Worker["healthStatus"] = work.length || managedCount || externalBusy || isReleasing ? "BUSY" : "ONLINE";
  return {
    versions: { comfy: sys?.comfyui_version, python: sys?.python_version },
    vramUsedMb,
    vramFreeMb,
    workLength: work.length,
    externalBusy,
    externalBusyReason,
    state,
  };
}
export class Scheduler {
  readonly owner = randomUUID();
  private busy = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private monitors = new Set<string>();
  private releasingWorkers = new Set<string>();
  private stopping = false;
  private leader = false;
  constructor(private notify: Notify = () => {}) {}
  start() {
    this.heartbeat = setInterval(() => this.renew(), 2000);
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
    this.renew();
    void this.tick();
  }
  private renew() {
    try {
      this.leader = getDb().acquireLease("scheduler", this.owner, 10000);
    } catch {
      this.leader = false;
    }
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    this.leader = false;
    try {
      getDb().sql.prepare("DELETE FROM leases WHERE id='scheduler' AND owner=?").run(this.owner);
    } catch {
      /* Database may already be closed during test teardown. */
    }
  }
  async tick() {
    if (this.busy || this.stopping || !this.leader) return;
    this.busy = true;
    try {
      await this.health();
      if (!this.leader) return;
      // DISPATCHING is deliberately not retried after a crash: the worker may have
      // accepted it before we recorded its prompt ID. Never submit it twice.
      getDb().transaction(() => {
        const db = getDb();
        for (const job of db.list("jobs", "status='DISPATCHING'")) {
          if (job.leaseOwner !== this.owner || !this.monitors.has(job.id)) {
            job.status = "LOST";
            job.completedAt = new Date().toISOString();
            job.error = "Gateway stopped during dispatch; inspect worker before retrying";
            db.put("jobs", job);
            audit(
              "JOB_LOST",
              { actorId: job.userId, classId: job.classId, targetId: job.id, metadata: { status: "LOST" } },
              db
            );
          }
        }
      });
      for (const job of getDb().list("jobs", "status='RUNNING'"))
        if (!this.monitors.has(job.id)) {
          this.monitors.add(job.id);
          void this.monitor(job.id).finally(() => this.monitors.delete(job.id));
        }
      // Resume archival interrupted by a restart; inference is never resubmitted.
      for (const job of getDb().list("jobs", "status='COMPLETED'")) {
        if (job.archiveStatus === "ARCHIVING" && !this.monitors.has(job.id) && job.workerId && job.comfyPromptId) {
          this.monitors.add(job.id);
          void this.recoverArchive(job).finally(() => this.monitors.delete(job.id));
        }
      }
      for (let i = 0; i < 64; i++) {
        const job = this.claim();
        if (!job) break;
        this.monitors.add(job.id);
        void this.dispatch(job).finally(() => this.monitors.delete(job.id));
      }
      await this.retention();
    } catch {
      console.error("[scheduler] tick failed; will retry");
    } finally {
      this.busy = false;
    }
  }
  private async health() {
    await Promise.all(
      getDb()
        .list("workers")
        .map(async (w) => {
          let state: Worker["healthStatus"] = "DISABLED",
            externalBusy = false,
            externalBusyReason: string | null = null,
            vramUsedMb: number | null = null,
            vramFreeMb: number | null = null,
            versions: { comfy?: string; python?: string } = {};
          if (w.enabled)
            try {
              const [stats, queue] = await Promise.all([
                workerFetch(w, "/system_stats", {}, 3000),
                workerFetch(w, "/queue", {}, 3000),
              ]);
              if (!stats.ok || !queue.ok) throw new Error();
              const statsBody = await stats.json();
              const queueBody = await queue.json();
              const managed = getDb().list("jobs", "worker_id=? AND status IN ('DISPATCHING','RUNNING')", [w.id]);
              const ids = new Set(managed.map((j) => j.comfyPromptId));
              const evalResult = evaluateWorkerTelemetry(
                statsBody,
                queueBody,
                ids,
                managed.length,
                this.releasingWorkers.has(w.id)
              );
              versions = evalResult.versions;
              vramUsedMb = evalResult.vramUsedMb;
              vramFreeMb = evalResult.vramFreeMb;
              externalBusy = evalResult.externalBusy;
              externalBusyReason = evalResult.externalBusyReason;
              state = evalResult.state;
            } catch {
              state = "OFFLINE";
            }
          getDb().transaction(() => {
            const db = getDb();
            const current = db.get("workers", w.id);
            if (!current) return;
            const prevExternal = Boolean(current.externalBusy);
            current.healthStatus = current.enabled ? state : "DISABLED";
            current.externalBusy = current.enabled ? externalBusy : false;
            current.externalBusyReason = current.enabled ? externalBusyReason : null;
            if (vramUsedMb !== null) current.vramUsedMb = vramUsedMb;
            if (vramFreeMb !== null) current.vramFreeMb = vramFreeMb;
            // Keep the last known versions when a poll fails, so a blip does not
            // regress the workspace to "managed".
            if (versions.comfy) current.comfyVersion = versions.comfy;
            if (versions.python) current.pythonVersion = versions.python;
            current.lastHealthCheck = new Date().toISOString();
            db.put("workers", current);
            if (current.enabled && state !== "OFFLINE" && prevExternal !== current.externalBusy) {
              audit(
                current.externalBusy ? "WORKER_EXTERNAL_BUSY" : "WORKER_EXTERNAL_CLEAR",
                {
                  targetId: current.id,
                  metadata: {
                    name: current.name,
                    reason: current.externalBusyReason,
                    vramUsedMb: current.vramUsedMb,
                    vramFreeMb: current.vramFreeMb,
                  },
                },
                db
              );
            }
          });
        })
    );
  }
  claim(): Job | undefined {
    return getDb().transaction(() => {
      if (!this.leader || this.stopping) return;
      const db = getDb();
      if (!db.sql.prepare("SELECT 1 FROM jobs WHERE status='QUEUED' LIMIT 1").get()) return undefined;
      const env = getEnv();
      const active = db.list("jobs", "status IN ('DISPATCHING','RUNNING')"),
        queue = fairQueuedJobs(db, env.MAX_ACTIVE_JOBS_PER_USER),
        workers = db.list("workers");
      for (const j of queue) {
        if (!activeMembership(db, j.userId, j.classId, j.enrollmentId, { allowPaused: true })) {
          j.status = "CANCELLED";
          j.error = "Enrollment or account no longer active";
          j.completedAt = new Date().toISOString();
          db.put("jobs", j);
          audit(
            "JOB_CANCELLED",
            {
              actorId: j.userId,
              classId: j.classId,
              targetId: j.id,
              metadata: { status: "CANCELLED", reason: "membership_inactive" },
            },
            db
          );
          continue;
        }
        if (active.filter((a) => a.userId === j.userId).length >= env.MAX_ACTIVE_JOBS_PER_USER) continue;
        const eligible = workers
          .filter(
            (w) =>
              w.enabled &&
              ["ONLINE", "BUSY"].includes(w.healthStatus) &&
              !w.externalBusy &&
              !this.releasingWorkers.has(w.id) &&
              active.filter((a) => a.workerId === w.id).length < w.maxConcurrentJobs &&
              j.requiredTags.every((t) => w.tags.includes(t))
          )
          .sort(
            (a, b) =>
              active.filter((x) => x.workerId === a.id).length - active.filter((x) => x.workerId === b.id).length ||
              a.lastAssignedAt - b.lastAssignedAt ||
              a.id.localeCompare(b.id)
          );
        const w = eligible[0];
        if (!w) continue;
        j.workerId = w.id;
        j.status = "DISPATCHING";
        j.startedAt = new Date().toISOString();
        j.leaseOwner = this.owner;
        w.lastAssignedAt = Date.now();
        db.put("workers", w);
        db.put("jobs", j);
        return j;
      }
    });
  }
  private requeueBeforeSend(jobId: string, reason: string, db = getDb()) {
    const curJob = db.get("jobs", jobId);
    if (!curJob || curJob.status !== "DISPATCHING") return;
    curJob.status = "QUEUED";
    curJob.workerId = null;
    curJob.startedAt = null;
    curJob.leaseOwner = null;
    db.put("jobs", curJob);
    audit(
      "JOB_REQUEUED",
      {
        actorId: curJob.userId,
        classId: curJob.classId,
        targetId: curJob.id,
        metadata: { reason },
      },
      db
    );
  }
  /**
   * Re-verify right before touching a worker's inputs or /prompt endpoint that
   * no external GPU process (e.g. VLLM::EngineCore) grabbed the card since the
   * last health poll. If occupied, mark externalBusy and re-queue the job cleanly.
   */
  private async verifyClearBeforeDispatch(job: Job, worker: Worker): Promise<boolean> {
    try {
      const [stats, queue] = await Promise.all([
        workerFetch(worker, "/system_stats", {}, 3000),
        workerFetch(worker, "/queue", {}, 3000),
      ]);
      if (!stats.ok || !queue.ok) throw new Error("Worker unreachable before dispatch");
      const statsBody = await stats.json();
      const queueBody = await queue.json();
      const db = getDb();
      const otherManaged = db
        .list("jobs", "worker_id=? AND status IN ('DISPATCHING','RUNNING')", [worker.id])
        .filter((j) => j.id !== job.id);
      const ids = new Set(otherManaged.map((j) => j.comfyPromptId));
      const evalResult = evaluateWorkerTelemetry(
        statsBody,
        queueBody,
        ids,
        otherManaged.length,
        this.releasingWorkers.has(worker.id)
      );
      if (!evalResult.externalBusy) return true;
      db.transaction(() => {
        const curWorker = db.get("workers", worker.id);
        if (curWorker) {
          const prevExternal = Boolean(curWorker.externalBusy);
          curWorker.externalBusy = true;
          curWorker.externalBusyReason = evalResult.externalBusyReason;
          curWorker.healthStatus = curWorker.enabled ? "BUSY" : "DISABLED";
          if (evalResult.vramUsedMb !== null) curWorker.vramUsedMb = evalResult.vramUsedMb;
          if (evalResult.vramFreeMb !== null) curWorker.vramFreeMb = evalResult.vramFreeMb;
          curWorker.lastHealthCheck = new Date().toISOString();
          db.put("workers", curWorker);
          if (!prevExternal) {
            audit(
              "WORKER_EXTERNAL_BUSY",
              {
                targetId: curWorker.id,
                metadata: {
                  name: curWorker.name,
                  reason: evalResult.externalBusyReason,
                  vramUsedMb: evalResult.vramUsedMb,
                  vramFreeMb: evalResult.vramFreeMb,
                },
              },
              db
            );
          }
        }
        this.requeueBeforeSend(job.id, "worker_external_busy", db);
      });
      return false;
    } catch {
      return false;
    }
  }
  private forwardWorkerEvent(job: Job, comfyPromptId: string, event: Record<string, any>) {
    if (event.data?.prompt_id !== comfyPromptId) return;
    if (event.type === "progress_state") {
      const rawNodes = event.data?.nodes;
      const nodes =
        rawNodes && typeof rawNodes === "object"
          ? Object.fromEntries(
              Object.entries(rawNodes).map(([k, v]) => [
                k,
                v && typeof v === "object" ? { ...(v as Record<string, unknown>), prompt_id: job.id } : v,
              ])
            )
          : {};
      this.notify(job, {
        type: "progress_state",
        data: { ...event.data, prompt_id: job.id, nodes },
      });
      return;
    }
    if (["execution_cached", "progress"].includes(event.type)) {
      this.notify(job, { type: event.type, data: { ...event.data, prompt_id: job.id } });
      return;
    }
    if (event.type === "executing" && event.data?.node !== null) {
      this.notify(job, { type: "executing", data: { ...event.data, prompt_id: job.id } });
    }
  }
  private async dispatch(job: Job) {
    const db = getDb(),
      worker = db.get("workers", job.workerId!)!;
    let sending = false;
    let upstream: WebSocket | undefined;
    const abortOfflineOrExternal = () => {
      db.transaction(() => {
        this.requeueBeforeSend(job.id, "worker_unreachable", db);
        const curWorker = db.get("workers", worker.id);
        if (curWorker && !curWorker.externalBusy) {
          curWorker.healthStatus = curWorker.enabled ? "OFFLINE" : "DISABLED";
          db.put("workers", curWorker);
        }
      });
    };
    try {
      const preCheckAt = Date.now();
      const clear = await this.verifyClearBeforeDispatch(job, worker);
      if (!clear) {
        abortOfflineOrExternal();
        return;
      }
      if (this.stopping || !this.leader) {
        db.transaction(() => this.requeueBeforeSend(job.id, "scheduler_stopped_or_lease_lost", db));
        return;
      }
      this.notify(job, {
        type: "execution_start",
        data: { prompt_id: job.id, timestamp: job.startedAt ? Date.parse(job.startedAt) : Date.now() },
      });
      await stageUploads(job, worker);
      if (this.stopping || !this.leader) {
        db.transaction(() => this.requeueBeforeSend(job.id, "scheduler_stopped_or_lease_lost", db));
        return;
      }
      if (!activeMembership(db, job.userId, job.classId, job.enrollmentId, { allowPaused: true })) {
        this.finish(job.id, "CANCELLED", "Enrollment revoked before dispatch");
        return;
      }
      const clientId = randomUUID();
      let comfyPromptId: string | null = null;
      const pendingEvents: Record<string, any>[] = [];
      upstream = new WebSocket(worker.baseUrl.replace(/^http/, "ws") + "/ws?clientId=" + clientId);
      upstream.on("error", () => {});
      upstream.on("message", (data, isBinary) => {
        if (isBinary) return; // Worker previews can be broadcast; do not expose them.
        try {
          const event = JSON.parse(data.toString());
          if (!comfyPromptId) {
            if (pendingEvents.length < 256) pendingEvents.push(event);
            return;
          }
          const current = db.get("jobs", job.id);
          if (!current) return;
          this.forwardWorkerEvent(current, comfyPromptId, event);
        } catch {
          /* Ignore malformed/unrelated events. */
        }
      });
      await Promise.race([
        new Promise<void>((resolve) => {
          upstream!.once("open", resolve);
          upstream!.once("error", () => resolve());
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
      if (Date.now() - preCheckAt > 150) {
        if (!(await this.verifyClearBeforeDispatch(job, worker))) {
          abortOfflineOrExternal();
          return;
        }
      }
      if (this.stopping || !this.leader) {
        db.transaction(() => this.requeueBeforeSend(job.id, "scheduler_stopped_or_lease_lost", db));
        return;
      }
      sending = true;
      const partialTargets = Array.isArray(job.extraData?.partialExecutionTargets)
        ? (job.extraData.partialExecutionTargets as string[])
        : undefined;
      const response = await workerFetch(worker, "/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: job.promptJson,
          client_id: clientId,
          extra_data: { extra_pnginfo: { workflow: job.workflowJson } },
          ...(partialTargets && partialTargets.length > 0 ? { partial_execution_targets: partialTargets } : {}),
        }),
      });
      if (!response.ok) {
        const errPayload = await response.json().catch(() => null);
        const detail = extractPromptRejectionReason(response.status, errPayload);
        this.finish(job.id, "FAILED", detail.message, detail.nodeId, detail.nodeType);
        await this.freeIfIdle(job.workerId!);
        return;
      }
      const result = (await response.json()) as { prompt_id?: string };
      if (!result.prompt_id) throw new Error("Worker response missing prompt ID");
      comfyPromptId = result.prompt_id;
      const current = db.transaction(() => {
        const j = db.get("jobs", job.id);
        if (!j) return null;
        j.comfyPromptId = comfyPromptId;
        j.status = "RUNNING";
        db.put("jobs", j);
        return j;
      });
      if (!current) return;
      for (const buffered of pendingEvents.splice(0)) {
        this.forwardWorkerEvent(current, comfyPromptId, buffered);
      }
      await this.monitor(job.id);
    } catch {
      this.finish(
        job.id,
        sending ? "LOST" : "FAILED",
        sending ? "Dispatch outcome unknown; job was not retried automatically" : "Input staging failed"
      );
      // A LOST dispatch may already be executing on the worker; freeing then
      // would evict a running job's models, so only free the certain failure.
      if (!sending && job.workerId) await this.freeIfIdle(job.workerId);
    } finally {
      upstream?.close();
    }
  }
  /**
   * Best-effort immediate VRAM release. ComfyUI keeps model weights in VRAM
   * after a job finishes; POST /free unloads them so the card drops back to
   * its ~300MiB CUDA context instead of holding tens of GB until the next
   * job. Skipped while any platform job still needs the worker, or if a fresh
   * telemetry check shows external GPU work (e.g. vLLM started mid-job).
   */
  private async freeIfIdle(workerId: string) {
    if (this.releasingWorkers.has(workerId)) return;
    const db = getDb();
    const worker = db.get("workers", workerId);
    if (!worker || !worker.enabled || worker.externalBusy) return;
    if (db.list("jobs", "worker_id=? AND status IN ('DISPATCHING','RUNNING')", [workerId]).length) return;
    this.releasingWorkers.add(workerId);
    try {
      const [stats, queue] = await Promise.all([
        workerFetch(worker, "/system_stats", {}, 3000),
        workerFetch(worker, "/queue", {}, 3000),
      ]);
      if (!stats.ok || !queue.ok) return;
      const statsBody = await stats.json();
      const queueBody = await queue.json();
      if (db.list("jobs", "worker_id=? AND status IN ('DISPATCHING','RUNNING')", [workerId]).length) return;
      const evalResult = evaluateWorkerTelemetry(statsBody, queueBody, new Set(), 0, true);
      if (evalResult.externalBusy || evalResult.workLength > 0) {
        if (evalResult.externalBusy) {
          db.transaction(() => {
            const cur = db.get("workers", workerId);
            if (!cur) return;
            const prev = Boolean(cur.externalBusy);
            cur.externalBusy = true;
            cur.externalBusyReason = evalResult.externalBusyReason;
            cur.healthStatus = cur.enabled ? "BUSY" : "DISABLED";
            if (evalResult.vramUsedMb !== null) cur.vramUsedMb = evalResult.vramUsedMb;
            if (evalResult.vramFreeMb !== null) cur.vramFreeMb = evalResult.vramFreeMb;
            cur.lastHealthCheck = new Date().toISOString();
            db.put("workers", cur);
            if (!prev) {
              audit(
                "WORKER_EXTERNAL_BUSY",
                {
                  targetId: cur.id,
                  metadata: {
                    name: cur.name,
                    reason: evalResult.externalBusyReason,
                    vramUsedMb: evalResult.vramUsedMb,
                    vramFreeMb: evalResult.vramFreeMb,
                  },
                },
                db
              );
            }
          });
        }
        return;
      }
      await workerFetch(
        worker,
        "/free",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unload_models: true, free_memory: true }),
        },
        10000
      );
    } catch {
      /* VRAM release is hygiene, never a job failure. The idle reaper repeats it. */
    } finally {
      this.releasingWorkers.delete(workerId);
    }
  }
  private finish(id: string, status: Job["status"], error: string | null = null, nodeId = "", nodeType = "") {
    const db = getDb();
    const job = db.transaction(() => {
      const j = db.get("jobs", id);
      if (!j) return null;
      j.status = status;
      if (status === "COMPLETED") j.archiveStatus = "ARCHIVING";
      j.error = error;
      j.completedAt = new Date().toISOString();
      j.runtimeMs = j.startedAt ? Date.now() - Date.parse(j.startedAt) : null;
      db.put("jobs", j);
      audit(
        "JOB_" + status,
        {
          actorId: j.userId,
          classId: j.classId,
          targetId: j.id,
          metadata: { status, ...(error ? { error } : {}) },
        },
        db
      );
      return j;
    });
    if (!job) return null;
    if (status !== "COMPLETED")
      this.notify(job, {
        type: "execution_error",
        data: {
          prompt_id: job.id,
          exception_message: error || status,
          exception_type: status,
          traceback: [],
          executed: [],
          node_id: nodeId,
          node_type: nodeType,
        },
      });
    return job;
  }
  private async monitor(id: string) {
    let cancelSent = false;
    while (!this.stopping && this.leader) {
      const db = getDb(),
        job = db.get("jobs", id);
      if (!job || job.status !== "RUNNING" || !job.workerId) return;
      const worker = db.get("workers", job.workerId);
      if (!worker) return;
      const revoked = !activeMembership(db, job.userId, job.classId, job.enrollmentId, { allowPaused: true });
      const timedOut = Date.now() - Date.parse(job.startedAt!) > getEnv().JOB_TIMEOUT_SECONDS * 1000;
      if ((job.cancelRequested || revoked || timedOut) && !cancelSent) {
        try {
          const q = await workerFetch(worker, "/queue", {}, 3000);
          const queue = (await q.json()) as any;
          if ((queue.queue_pending || []).some((v: any) => v[1] === job.comfyPromptId))
            await workerFetch(worker, "/queue", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ delete: [job.comfyPromptId] }),
            });
          // /interrupt is worker-global: only issue when this is the sole running prompt.
          if (queue.queue_running?.length === 1 && queue.queue_running[0][1] === job.comfyPromptId)
            await workerFetch(worker, "/interrupt", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
          cancelSent = true;
        } catch {
          /* Keep the slot reserved until terminal state is known. */
        }
      }
      try {
        const response = await workerFetch(worker, "/history/" + encodeURIComponent(job.comfyPromptId!), {}, 3000);
        if (response.ok) {
          const all = (await response.json()) as Record<string, any>,
            entry = all[job.comfyPromptId!];
          if (entry) {
            if (
              entry.status?.status_str === "error" ||
              entry.status?.messages?.some((v: any) => ["execution_error", "execution_interrupted"].includes(v[0]))
            ) {
              const cancelled = job.cancelRequested || revoked;
              const detail = cancelled
                ? { message: "Job cancelled", nodeId: "", nodeType: "" }
                : extractRuntimeErrorDetail(entry);
              this.finish(id, cancelled ? "CANCELLED" : "FAILED", detail.message, detail.nodeId, detail.nodeType);
              await this.freeIfIdle(job.workerId!);
              return;
            }
            if (entry.status?.completed === true || entry.status?.status_str === "success") {
              const complete = this.finish(id, "COMPLETED");
              if (!complete) return;
              // Free before archival: outputs download over HTTP and need no
              // models, so VRAM is released cleanly before the worker is eligible again.
              await this.freeIfIdle(worker.id);
              if (!db.get("jobs", id)) return;
              try {
                await archive(complete, worker, entry);
                const archived = db.get("jobs", id);
                if (archived) this.completed(archived);
              } catch {
                this.notify(complete, {
                  type: "execution_error",
                  data: {
                    prompt_id: id,
                    exception_message: "Generation completed but archival failed. See job audit.",
                    exception_type: "ArchiveError",
                    traceback: [],
                    executed: [],
                    node_id: "",
                    node_type: "",
                  },
                });
              }
              return;
            }
          }
        }
        if (cancelSent) {
          const r = await workerFetch(worker, "/queue", {}, 3000),
            q = (await r.json()) as any;
          if (![...(q.queue_running || []), ...(q.queue_pending || [])].some((v: any) => v[1] === job.comfyPromptId)) {
            this.finish(id, "CANCELLED", timedOut ? "Job timed out" : "Job cancelled");
            await this.freeIfIdle(job.workerId!);
            return;
          }
        }
      } catch {
        /* An offline worker can reconnect; do not resubmit its prompt. */
      }
      if (timedOut && Date.now() - Date.parse(job.startedAt!) > (getEnv().JOB_TIMEOUT_SECONDS + 60) * 1000) {
        this.finish(id, "LOST", "Worker did not confirm completion before timeout");
        if (job.workerId) await this.freeIfIdle(job.workerId);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  private completed(job: Job) {
    const meta = (job.history?.meta ?? {}) as Record<string, { display_node?: string } | undefined>;
    for (const [node, output] of Object.entries(job.history?.outputs || {})) {
      const displayNode = meta[node]?.display_node ?? node;
      this.notify(job, { type: "executed", data: { prompt_id: job.id, node, display_node: displayNode, output } });
    }
    this.notify(job, { type: "execution_success", data: { prompt_id: job.id, timestamp: Date.now() } });
    this.notify(job, { type: "executing", data: { prompt_id: job.id, node: null } });
  }
  private async recoverArchive(job: Job) {
    try {
      const worker = getDb().get("workers", job.workerId!)!,
        response = await workerFetch(worker, "/history/" + job.comfyPromptId),
        h = (await response.json()) as any;
      if (!h[job.comfyPromptId!]) throw new Error("History unavailable");
      await archive(job, worker, h[job.comfyPromptId!]);
      this.completed(getDb().get("jobs", job.id)!);
    } catch {
      getDb().transaction(() => {
        const current = getDb().get("jobs", job.id)!;
        current.archiveStatus = "FAILED";
        current.archiveError = "Archival recovery failed; retry from administrator job page";
        getDb().put("jobs", current);
      });
    }
  }
  private async retention() {
    const env = getEnv();
    if (env.AUDIT_RETENTION_ENABLED !== "true") return;
    for (const j of getDb().list("jobs", "status IN ('COMPLETED','FAILED','CANCELLED','LOST')")) {
      if (
        j.archiveStatus === "EXPIRED" ||
        !j.completedAt ||
        Date.parse(j.completedAt) > Date.now() - env.AUDIT_RETENTION_DAYS * 86400000
      )
        continue;
      await fsp.rm(archiveDirectory(j), { recursive: true, force: true });
      getDb().transaction(() => {
        const current = getDb().get("jobs", j.id)!;
        current.archiveStatus = "EXPIRED";
        getDb().put("jobs", current);
      });
    }
  }
}
