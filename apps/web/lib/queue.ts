/** Fair queue + worker selection logic (shared by web + gateway, unit-tested). */

export interface QueuedJob {
  id: string;
  userId: string;
  submittedAt: number;
}

export interface WorkerChoice {
  id: string;
  enabled: boolean;
  healthStatus: "ONLINE" | "BUSY" | "OFFLINE" | "DISABLED";
  currentLoad: number;
  maxConcurrentJobs: number;
  tags: string[];
}

/** Round-robin fair ordering: interleave per-user FIFO (Alice1,Bob1,Charlie1,Alice2,...). */
export function fairOrder(jobs: QueuedJob[]): QueuedJob[] {
  const byUser = new Map<string, QueuedJob[]>();
  for (const j of [...jobs].sort((a, b) => a.submittedAt - b.submittedAt)) {
    if (!byUser.has(j.userId)) byUser.set(j.userId, []);
    byUser.get(j.userId)!.push(j);
  }
  const out: QueuedJob[] = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const [, list] of [...byUser.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const head = list.shift();
      if (head) {
        out.push(head);
        progress = true;
      }
    }
  }
  return out;
}

let rrCursor = 0;
export function resetRoundRobin() {
  rrCursor = 0;
}

/** Worker selection: online+enabled+capacity, optional tag match, least loaded, round-robin tie-break. */
export function selectWorker(workers: WorkerChoice[], requiredTags: string[] = []): WorkerChoice | null {
  const eligible = workers.filter(
    (w) =>
      w.enabled &&
      (w.healthStatus === "ONLINE" || w.healthStatus === "BUSY") &&
      w.currentLoad < w.maxConcurrentJobs &&
      requiredTags.every((t) => w.tags.includes(t))
  );
  if (eligible.length === 0) return null;
  const minLoad = Math.min(...eligible.map((w) => w.currentLoad));
  const least = eligible.filter((w) => w.currentLoad === minLoad).sort((a, b) => (a.id < b.id ? -1 : 1));
  const pick = least[rrCursor % least.length];
  rrCursor += 1;
  return pick;
}

export function checkQuotas(
  active: number,
  queued: number,
  maxActive: number,
  maxQueued: number
): { ok: boolean; reason?: string } {
  if (active >= maxActive) return { ok: false, reason: `Active job limit reached (${maxActive})` };
  if (queued >= maxQueued) return { ok: false, reason: `Queued job limit reached (${maxQueued})` };
  return { ok: true };
}
