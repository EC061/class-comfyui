import express from "express";
import { getDb, audit, type Job, type JobStatus, type Session } from "@class-comfyui/database";

// The frontend's Jobs panel polls GET /api/jobs on an interval and logs a hard
// error on any non-200, so an unanswered route is a permanent console-error loop
// (1808 suppressed entries in one session). The worker's own /api/jobs cannot be
// proxied to answer it: it builds its list from prompt_queue and history, both
// worker-global, so every student would receive every other student's jobs. This
// answers from the gateway's jobs table under the same `user_id AND class_id`
// scope as /queue and /history, and mirrors the field names and query contract of
// comfy_execution/jobs.py so the panel needs no special-casing.

// ComfyUI's five statuses (JobStatus.ALL). Our vocabulary is finer-grained:
// DISPATCHING is a job the scheduler has claimed but the worker has not yet
// confirmed, and LOST is one whose worker vanished mid-run, which a student reads
// as a failure like any other. The worker likewise folds an interrupted execution
// into `cancelled` rather than reporting it as an error.
const COMFY_STATUS: Record<JobStatus, string> = {
  QUEUED: "pending",
  DISPATCHING: "in_progress",
  RUNNING: "in_progress",
  COMPLETED: "completed",
  FAILED: "failed",
  LOST: "failed",
  CANCELLED: "cancelled",
};
const ALL_STATUSES = ["pending", "in_progress", "completed", "failed", "cancelled"];
// `created_at` and `execution_duration` name sort behaviors, not fields: the
// worker sorts them by `create_time` and by the span between the execution
// timestamps. Neither field appears in the job itself.
const SORT_FIELDS = ["created_at", "execution_duration"];
// Only these can appear. `animated` is a boolean flag rather than a list of items,
// and the node allowlist has no 3D, text or latent save nodes, so the worker's
// 3D-filename-string and text-preview branches are unreachable in this lab.
const PREVIEWABLE = ["images", "gifs", "video", "videos", "audio"];

function ownJobs(s: Session) {
  return getDb().list("jobs", "user_id=? AND class_id=?", [s.userId, s.classId!]);
}

// The worker reads these out of the execution messages it recorded in history,
// which we store verbatim (storage.ts rewrites only output filenames). Reading
// the same source keeps the units identical instead of re-deriving them from our
// own columns; those are the fallback for a job that failed or was lost before
// the worker wrote any history.
function execution(job: Job) {
  let start: number | undefined, end: number | undefined, error: Record<string, unknown> | undefined;
  for (const entry of (job.history?.status?.messages ?? []) as unknown[]) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [name, data] = entry as [string, unknown];
    if (!data || typeof data !== "object") continue;
    const timestamp = (data as { timestamp?: number }).timestamp;
    if (name === "execution_start") start = timestamp;
    else if (["execution_success", "execution_error", "execution_interrupted"].includes(name)) {
      end = timestamp;
      if (name === "execution_error") error = data as Record<string, unknown>;
    }
  }
  if (start === undefined && job.startedAt) start = Date.parse(job.startedAt);
  if (end === undefined && job.completedAt) end = Date.parse(job.completedAt);
  // Our own failures carry a message rather than the worker's error dict. The
  // panel reads the message, so give it one under the same key with the
  // required ComfyUI ExecutionError schema fields.
  if (!error && job.error) {
    error = {
      node_id: "",
      node_type: "",
      exception_message: job.error,
      exception_type: job.status,
      traceback: [],
      executed: [],
    };
  } else if (error) {
    error = {
      ...error,
      node_id: typeof error.node_id === "string" ? error.node_id : String(error.node_id ?? ""),
      node_type: typeof error.node_type === "string" ? error.node_type : String(error.node_type ?? ""),
      exception_message:
        typeof error.exception_message === "string" ? error.exception_message : String(error.exception_message ?? ""),
      exception_type:
        typeof error.exception_type === "string" ? error.exception_type : String(error.exception_type ?? job.status),
      traceback: Array.isArray(error.traceback) ? error.traceback.map(String) : [],
      executed: Array.isArray(error.executed) ? error.executed.map(String) : [],
    };
  }
  return { start, end, error };
}

function outputs(job: Job) {
  let count = 0,
    previewable = 0,
    preview: Record<string, unknown> | undefined,
    fallback: Record<string, unknown> | undefined;
  for (const [nodeId, node] of Object.entries(job.history?.outputs ?? {})) {
    if (!node || typeof node !== "object") continue;
    for (const [mediaType, items] of Object.entries(node as Record<string, unknown>)) {
      if (mediaType === "animated" || !Array.isArray(items)) continue;
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        count++;
        if (!PREVIEWABLE.includes(mediaType)) continue;
        previewable++;
        const enriched = { ...(item as Record<string, unknown>), nodeId, mediaType };
        // A saved output outranks a temp preview, matching the worker's priority.
        if (!preview && (item as { type?: string }).type === "output") preview = enriched;
        else if (!fallback) fallback = enriched;
      }
    }
  }
  return { count, previewable, preview: preview ?? fallback };
}

// The worker's normalize_* helpers run their dicts through prune_dict, so a field
// it could not determine is absent rather than null. Matched here so the panel
// sees the same shape it would from a direct worker response.
function prune<T extends Record<string, unknown>>(job: T) {
  return Object.fromEntries(Object.entries(job).filter(([, v]) => v !== undefined && v !== null));
}

function serialize(job: Job, includeDetail = false): Record<string, unknown> {
  // The worker reads workflow_id from extra_data.extra_pnginfo.workflow.id. We
  // store that same object as workflowJson and keep extraData empty, so its id is
  // the identical value. create_time deliberately differs: the worker takes the
  // browser's extra_data.create_time, while submittedAt is server-set, so a
  // student cannot reorder their own job list by editing a request.
  const created = Date.parse(job.submittedAt),
    rawId = (job.workflowJson as { id?: unknown } | null)?.id,
    workflowId = typeof rawId === "string" ? rawId : undefined;
  // A queued or running job has no outputs yet, matching normalize_queue_item.
  // Running jobs include execution_start_time so active timers can render.
  if (!["COMPLETED", "FAILED", "CANCELLED", "LOST"].includes(job.status)) {
    const start = job.startedAt ? Date.parse(job.startedAt) : undefined;
    return prune({
      id: job.id,
      status: COMFY_STATUS[job.status],
      // Our queue tuples already use the submit time in ComfyUI's priority slot.
      priority: created,
      create_time: created,
      execution_start_time: start,
      outputs_count: 0,
      previewable_outputs_count: 0,
      workflow_id: workflowId,
    });
  }
  const { start, end, error } = execution(job),
    o = outputs(job);
  const base = prune({
    id: job.id,
    status: COMFY_STATUS[job.status],
    priority: created,
    create_time: created,
    execution_start_time: start,
    execution_end_time: end,
    execution_error: error,
    outputs_count: o.count,
    previewable_outputs_count: o.previewable,
    preview_output: o.preview,
    workflow_id: workflowId,
  });
  if (!includeDetail) return base;
  return {
    ...base,
    outputs: job.history?.outputs ?? {},
    execution_status: job.history?.status ?? {},
    execution_meta: job.history?.meta ?? {},
    workflow: {
      prompt: job.submittedPromptJson ?? job.promptJson,
      extra_data: {
        create_time: created,
        extra_pnginfo: job.workflowJson ? { workflow: job.workflowJson } : {},
      },
    },
  };
}

type Serialized = ReturnType<typeof serialize>;

// `created_at` sorts on create_time; `execution_duration` on the span between the
// execution timestamps, treating a job missing either one as zero rather than
// sorting it last. Both match apply_sorting().
function sortKey(job: Serialized, sortBy: string) {
  if (sortBy !== "execution_duration") return (job.create_time as number) ?? 0;
  const start = (job.execution_start_time as number) ?? 0,
    end = (job.execution_end_time as number) ?? 0;
  return end && start ? end - start : 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function cancelOwnedJob(s: Session, jobId: string): boolean {
  const db = getDb();
  return db.transaction(() => {
    const job = db.get("jobs", jobId);
    if (!job || job.userId !== s.userId || job.classId !== s.classId) return false;
    if (job.status === "QUEUED") {
      job.status = "CANCELLED";
      job.completedAt = new Date().toISOString();
      job.error = "Job cancelled";
      db.put("jobs", job);
      audit(
        "JOB_CANCELLED",
        { actorId: s.userId, classId: s.classId!, targetId: job.id, metadata: { status: "CANCELLED" } },
        db
      );
      return true;
    }
    if ((job.status === "DISPATCHING" || job.status === "RUNNING") && !job.cancelRequested) {
      job.cancelRequested = true;
      db.put("jobs", job);
      audit("JOB_CANCEL_REQUESTED", { actorId: s.userId, classId: s.classId!, targetId: job.id }, db);
      return true;
    }
    return job.status === "DISPATCHING" || job.status === "RUNNING";
  });
}

export function installJobs(app: express.Express) {
  app.get("/jobs", (req, res) => {
    const query = req.query as Record<string, string | undefined>;

    let statusFilter: string[] | undefined;
    if (query.status) {
      statusFilter = query.status
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
      const invalid = statusFilter.filter((v) => !ALL_STATUSES.includes(v));
      if (invalid.length) {
        res.status(400).json({
          error: `Invalid status value(s): ${invalid.join(", ")}. Valid values: ${ALL_STATUSES.join(", ")}`,
        });
        return;
      }
    }

    const sortBy = (query.sort_by ?? "created_at").toLowerCase();
    if (!SORT_FIELDS.includes(sortBy)) {
      res.status(400).json({ error: "sort_by must be 'created_at' or 'execution_duration'" });
      return;
    }
    const sortOrder = (query.sort_order ?? "desc").toLowerCase();
    if (!["asc", "desc"].includes(sortOrder)) {
      res.status(400).json({ error: "sort_order must be 'asc' or 'desc'" });
      return;
    }

    // An absent limit means unlimited, as on the worker. A present one must parse.
    let limit: number | null = null;
    if (query.limit !== undefined) {
      limit = Number(query.limit);
      if (!Number.isInteger(limit)) {
        res.status(400).json({ error: "limit must be an integer" });
        return;
      }
      if (limit <= 0) {
        res.status(400).json({ error: "limit must be a positive integer" });
        return;
      }
    }
    let offset = 0;
    if (query.offset !== undefined) {
      offset = Number(query.offset);
      if (!Number.isInteger(offset)) {
        res.status(400).json({ error: "offset must be an integer" });
        return;
      }
      // The worker clamps a negative offset instead of rejecting it.
      if (offset < 0) offset = 0;
    }

    let jobs = ownJobs(res.locals.session as Session).map((j) => serialize(j, false));
    if (statusFilter) jobs = jobs.filter((j) => statusFilter!.includes(j.status as string));
    if (query.workflow_id) jobs = jobs.filter((j) => j.workflow_id === query.workflow_id);

    const direction = sortOrder === "asc" ? 1 : -1;
    jobs.sort((a, b) => (sortKey(a, sortBy) - sortKey(b, sortBy)) * direction);

    const total = jobs.length,
      page = limit === null ? jobs.slice(offset) : jobs.slice(offset, offset + limit);
    res.json({
      jobs: page,
      pagination: { offset, limit, total, has_more: offset + page.length < total },
    });
  });

  app.post("/jobs/cancel", (req, res) => {
    const jobIds = req.body && typeof req.body === "object" ? (req.body as { job_ids?: unknown }).job_ids : undefined;
    if (!Array.isArray(jobIds)) {
      res.status(400).json({ error: "job_ids must be a list" });
      return;
    }
    const invalidIds = jobIds.filter((id) => typeof id !== "string" || !UUID_RE.test(id));
    if (invalidIds.length > 0) {
      res.status(400).json({
        error: "job_ids contains invalid id(s)",
        invalid_ids: invalidIds.map((id) => (typeof id === "string" ? id : String(id))),
      });
      return;
    }
    const s = res.locals.session as Session;
    let cancelled = false;
    for (const id of jobIds as string[]) {
      if (cancelOwnedJob(s, id)) cancelled = true;
    }
    res.json({ cancelled });
  });

  app.post("/jobs/:id/cancel", (req, res) => {
    const s = res.locals.session as Session,
      id = req.params.id,
      job = id ? getDb().get("jobs", id) : undefined;
    if (!job || job.userId !== s.userId || job.classId !== s.classId) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    const cancelled = cancelOwnedJob(s, id);
    res.json({ cancelled });
  });

  app.get("/jobs/:id", (req, res) => {
    const s = res.locals.session as Session,
      job = getDb().get("jobs", req.params.id);
    if (!job || job.userId !== s.userId || job.classId !== s.classId) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(serialize(job, true));
  });
}
