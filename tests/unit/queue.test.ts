import { describe, it, expect } from "vitest";
import { fairOrder, selectWorker, checkQuotas, resetRoundRobin } from "../../apps/web/lib/queue";

describe("fair scheduling", () => {
  it("interleaves users (Alice1,Bob1,Charlie1,Alice2...)", () => {
    const jobs = [
      { id: "a1", userId: "alice", submittedAt: 1 },
      { id: "a2", userId: "alice", submittedAt: 2 },
      { id: "b1", userId: "bob", submittedAt: 3 },
      { id: "c1", userId: "charlie", submittedAt: 4 },
      { id: "b2", userId: "bob", submittedAt: 5 },
    ];
    expect(fairOrder(jobs).map((j) => j.id)).toEqual(["a1", "b1", "c1", "a2", "b2"]);
  });

  it("selects least-loaded online worker with round-robin tie-break", () => {
    resetRoundRobin();
    const w = (
      id: string,
      load: number,
      status: "ONLINE" | "BUSY" | "OFFLINE" | "DISABLED" = "ONLINE",
      enabled = true
    ) => ({
      id,
      enabled,
      healthStatus: status,
      currentLoad: load,
      maxConcurrentJobs: 1,
      tags: [] as string[],
    });
    const workers = [w("a", 0), w("b", 0)];
    expect(selectWorker(workers)?.id).toBe("a");
    expect(selectWorker(workers)?.id).toBe("b");
    expect(selectWorker([w("a", 1), w("b", 0)])?.id).toBe("b");
    expect(selectWorker([w("a", 0, "OFFLINE"), w("b", 0, "OFFLINE")])).toBeNull();
    expect(selectWorker([w("a", 0, "ONLINE", false)])).toBeNull();
  });

  it("respects capability tags", () => {
    const workers = [
      { id: "a", enabled: true, healthStatus: "ONLINE" as const, currentLoad: 0, maxConcurrentJobs: 1, tags: ["flux"] },
      { id: "b", enabled: true, healthStatus: "ONLINE" as const, currentLoad: 0, maxConcurrentJobs: 1, tags: ["sdxl"] },
    ];
    expect(selectWorker(workers, ["flux"])?.id).toBe("a");
    expect(selectWorker(workers, ["video"])).toBeNull();
  });

  it("enforces per-user quotas", () => {
    expect(checkQuotas(1, 0, 1, 3).ok).toBe(false);
    expect(checkQuotas(0, 3, 1, 3).ok).toBe(false);
    expect(checkQuotas(0, 2, 1, 3).ok).toBe(true);
  });
});
