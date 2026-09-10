import express from "express";
import { getDb, type Job, type JobStatus, type Session } from "@class-comfyui/database";

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
  // panel reads the message, so give it one under the same key.
  if (!error && job.error) error = { exception_message: job.error };
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

function serialize(job: Job) {
  const created = Date.parse(job.submittedAt),
    workflowId = (job.extraData?.workflow_id ??
      (job.extraData?.extra_pnginfo as { workflow?: { id?: string } } | undefined)?.workflow?.id) as string | undefined;
  // A queued job has no execution timestamps and no outputs, exactly as the
  // worker's normalize_queue_item reports it.
  if (!["COMPLETED", "FAILED", "CANCELLED", "LOST"].includes(job.status))
    return prune({
      id: job.id,
      status: COMFY_STATUS[job.status],
      // Our queue tuples already use the submit time in ComfyUI's priority slot.
      priority: created,
      create_time: created,
      outputs_count: 0,
      previewable_outputs_count: 0,
      workflow_id: workflowId,
    });
  const { start, end, error } = execution(job),
    o = outputs(job);
  return prune({
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

    let jobs = ownJobs(res.locals.session as Session).map(serialize);
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
}
