import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import fsp from "node:fs/promises";
import { getDb, activeMembership, audit, type Job, type Worker } from "@class-comfyui/database";
import { getEnv } from "@class-comfyui/config";
import { workerFetch, archive, archiveDirectory, stageUploads } from "./storage";
export type Notify = (job: Job, event: Record<string, any>) => void;
const activeStatuses = new Set(["DISPATCHING", "RUNNING"]);
export class Scheduler {
  readonly owner = randomUUID();
  private busy = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private monitors = new Set<string>();
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
        for (const job of getDb().list("jobs", "status='DISPATCHING'")) {
          if (job.leaseOwner !== this.owner) {
            job.status = "LOST";
            job.completedAt = new Date().toISOString();
            job.error = "Gateway stopped during dispatch; inspect worker before retrying";
            getDb().put("jobs", job);
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
            versions: { comfy?: string; python?: string } = {};
          if (w.enabled)
            try {
              const [stats, queue] = await Promise.all([
                workerFetch(w, "/system_stats", {}, 3000),
                workerFetch(w, "/queue", {}, 3000),
              ]);
              if (!stats.ok || !queue.ok) throw new Error();
              const sys = ((await stats.json()) as any)?.system;
              versions = { comfy: sys?.comfyui_version, python: sys?.python_version };
              const q = (await queue.json()) as any;
              const managed = getDb().list("jobs", "worker_id=? AND status IN ('DISPATCHING','RUNNING')", [w.id]);
              const ids = new Set(managed.map((j) => j.comfyPromptId));
              const work = [...(q.queue_running || []), ...(q.queue_pending || [])];
              externalBusy = work.some((v: any) => !ids.has(v[1]));
              state = work.length || managed.length ? "BUSY" : "ONLINE";
            } catch {
              state = "OFFLINE";
            }
          getDb().transaction(() => {
            const current = getDb().get("workers", w.id);
            if (!current) return;
            current.healthStatus = current.enabled ? state : "DISABLED";
            current.externalBusy = externalBusy;
            // Keep the last known versions when a poll fails, so a blip does not
            // regress the workspace to "managed".
            if (versions.comfy) current.comfyVersion = versions.comfy;
            if (versions.python) current.pythonVersion = versions.python;
            current.lastHealthCheck = new Date().toISOString();
            getDb().put("workers", current);
          });
        })
    );
  }
  claim(): Job | undefined {
    return getDb().transaction(() => {
      if (!this.leader || this.stopping) return;
      const db = getDb(),
        env = getEnv();
      const jobs = db.list("jobs"),
        active = jobs.filter((j) => activeStatuses.has(j.status));
      const lastRun = new Map<string, number>();
      for (const j of jobs) {
        if (j.startedAt) lastRun.set(j.userId, Math.max(lastRun.get(j.userId) || 0, Date.parse(j.startedAt)));
      }
      const queue = jobs
        .filter((j) => j.status === "QUEUED")
        .sort(
          (a, b) =>
            (lastRun.get(a.userId) || 0) - (lastRun.get(b.userId) || 0) || a.submittedAt.localeCompare(b.submittedAt)
        );
      for (const j of queue) {
        if (!activeMembership(db, j.userId, j.classId, j.enrollmentId)) {
          j.status = "CANCELLED";
          j.error = "Enrollment or account no longer active";
          j.completedAt = new Date().toISOString();
          db.put("jobs", j);
          continue;
        }
        if (active.filter((a) => a.userId === j.userId).length >= env.MAX_ACTIVE_JOBS_PER_USER) continue;
        const eligible = db
          .list("workers")
          .filter(
            (w) =>
              w.enabled &&
              ["ONLINE", "BUSY"].includes(w.healthStatus) &&
              !w.externalBusy &&
              active.filter((a) => a.workerId === w.id).length < w.maxConcurrentJobs &&
              j.requiredTags.every((t) => w.tags.includes(t))
          )
          .sort(
            (a, b) =>
              active.filter((j) => j.workerId === a.id).length - active.filter((j) => j.workerId === b.id).length ||
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
  private async dispatch(job: Job) {
    const db = getDb(),
      worker = db.get("workers", job.workerId!)!;
    let sending = false;
    let upstream: WebSocket | undefined;
    try {
      await stageUploads(job, worker);
      if (this.stopping || !this.leader) return;
      if (!activeMembership(db, job.userId, job.classId, job.enrollmentId)) {
        this.finish(job.id, "CANCELLED", "Enrollment revoked before dispatch");
        return;
      }
      const clientId = randomUUID();
      upstream = new WebSocket(worker.baseUrl.replace(/^http/, "ws") + "/ws?clientId=" + clientId);
      upstream.on("error", () => {});
      upstream.on("message", (data, isBinary) => {
        if (isBinary) return; // Worker previews can be broadcast; do not expose them.
        try {
          const event = JSON.parse(data.toString());
          const current = db.get("jobs", job.id);
          if (!current || event.data?.prompt_id !== current.comfyPromptId) return;
          if (["progress", "executing", "execution_start"].includes(event.type) && event.data?.node !== null)
            this.notify(current, { type: event.type, data: { ...event.data, prompt_id: current.id } });
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
      sending = true;
      const response = await workerFetch(worker, "/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: job.promptJson,
          client_id: clientId,
          extra_data: { extra_pnginfo: { workflow: job.workflowJson } },
        }),
      });
      if (!response.ok) {
        this.finish(job.id, "FAILED", `Worker rejected prompt (${response.status})`);
        return;
      }
      const result = (await response.json()) as { prompt_id?: string };
      if (!result.prompt_id) throw new Error("Worker response missing prompt ID");
      db.transaction(() => {
        const current = db.get("jobs", job.id)!;
        current.comfyPromptId = result.prompt_id!;
        current.status = "RUNNING";
        db.put("jobs", current);
      });
      await this.monitor(job.id);
    } catch {
      this.finish(
        job.id,
        sending ? "LOST" : "FAILED",
        sending ? "Dispatch outcome unknown; job was not retried automatically" : "Input staging failed"
      );
    } finally {
      upstream?.close();
    }
  }
  private finish(id: string, status: Job["status"], error: string | null = null) {
    const db = getDb();
    const job = db.transaction(() => {
      const j = db.get("jobs", id)!;
      j.status = status;
      j.error = error;
      j.completedAt = new Date().toISOString();
      j.runtimeMs = j.startedAt ? Date.now() - Date.parse(j.startedAt) : null;
      db.put("jobs", j);
      audit("JOB_" + status, { actorId: j.userId, classId: j.classId, targetId: j.id, metadata: { status } }, db);
      return j;
    });
    if (status !== "COMPLETED")
      this.notify(job, {
        type: "execution_error",
        data: {
          prompt_id: job.id,
          exception_message: error || status,
          exception_type: status,
          traceback: [],
          executed: [],
          node_id: "",
          node_type: "",
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
      const revoked = !activeMembership(db, job.userId, job.classId, job.enrollmentId);
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
              this.finish(
                id,
                job.cancelRequested || revoked ? "CANCELLED" : "FAILED",
                "Worker execution failed or interrupted"
              );
              return;
            }
            if (entry.status?.completed === true || entry.status?.status_str === "success") {
              const complete = this.finish(id, "COMPLETED");
              db.transaction(() => {
                const current = db.get("jobs", id)!;
                current.archiveStatus = "ARCHIVING";
                db.put("jobs", current);
              });
              try {
                await archive(complete, worker, entry);
                this.completed(db.get("jobs", id)!);
              } catch {
                this.notify(complete, {
                  type: "execution_error",
                  data: {
                    prompt_id: id,
                    exception_message: "Generation completed but archival failed. See job audit.",
                    exception_type: "ArchiveError",
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
            return;
          }
        }
      } catch {
        /* An offline worker can reconnect; do not resubmit its prompt. */
      }
      if (timedOut && Date.now() - Date.parse(job.startedAt!) > (getEnv().JOB_TIMEOUT_SECONDS + 60) * 1000) {
        this.finish(id, "LOST", "Worker did not confirm completion before timeout");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  private completed(job: Job) {
    for (const [node, output] of Object.entries(job.history?.outputs || {}))
      this.notify(job, { type: "executed", data: { prompt_id: job.id, node, output } });
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
