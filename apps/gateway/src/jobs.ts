import express from "express";
import { getDb, type Job, type JobStatus, type Session } from "@class-comfyui/database";

// The frontend's Jobs panel polls GET /api/jobs on an interval and logs a hard
// error on any non-200, so an unanswered route is a permanent console-error loop
// (see the 1808-entry spam it produced). The worker's own /api/jobs cannot be
// proxied to answer it: it reads prompt_queue and history globally, which is the
// whole class's work, so every student would receive every other student's jobs.
// This answers from the gateway's own jobs table under the same
// `user_id AND class_id` scope as /queue and /history.

// ComfyUI's five statuses (comfy_execution/jobs.py, JobStatus.ALL). The gateway's
// own vocabulary is finer-grained, so several of ours collapse onto one of theirs:
// DISPATCHING is a job the scheduler has claimed but the worker has not confirmed,
// and LOST is one whose worker disappeared mid-run, which a student reads as a
// failure like any other.
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
const SORT_FIELDS = ["created_at", "execution_duration"];

function ownJobs(s: Session) {
  return getDb().list("jobs", "user_id=? AND class_id=?", [s.userId, s.classId!]);
}

// One job as the panel reads it. `status`, `workflow_id`, `created_at` and
// `execution_duration` are the names the worker's own code uses -- the last two
// are the only accepted `sort_by` values, and workflow_id is filtered by that key.
function serialize(j: Job) {
  const outputs = j.history?.outputs ?? {};
  return {
    // Both spellings of the identifier. The frontend keys rows by one of them and
    // emitting the extra key costs nothing.
    id: j.id,
    prompt_id: j.id,
    status: COMFY_STATUS[j.status],
    created_at: Date.parse(j.submittedAt),
    started_at: j.startedAt ? Date.parse(j.startedAt) : null,
    completed_at: j.completedAt ? Date.parse(j.completedAt) : null,
    // Seconds, matching the worker's own field, which is derived from execution
    // timestamps rather than a millisecond counter.
    execution_duration: j.runtimeMs === null ? null : j.runtimeMs / 1000,
    workflow_id: (j.extraData?.workflow_id as string | undefined) ?? null,
    outputs,
    // The student's own submitted graph, never the rewritten one the scheduler
    // sends to the worker.
    prompt: j.promptJson,
    error: j.error,
  };
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
    if (statusFilter) jobs = jobs.filter((j) => statusFilter!.includes(j.status));
    if (query.workflow_id) jobs = jobs.filter((j) => j.workflow_id === query.workflow_id);

    const key = sortBy === "created_at" ? "created_at" : "execution_duration";
    const direction = sortOrder === "asc" ? 1 : -1;
    // A job that has not run has no duration. Sorting by it must not interleave
    // those nulls with real durations, so they sort last in either direction.
    jobs.sort((a, b) => {
      const x = a[key],
        y = b[key];
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return (x - y) * direction;
    });

    const total = jobs.length;
    const page = limit === null ? jobs.slice(offset) : jobs.slice(offset, offset + limit);
    res.json({
      jobs: page,
      pagination: { offset, limit, total, has_more: offset + page.length < total },
    });
  });
}
