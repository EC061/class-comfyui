// Register or update GPU workers from a manifest, without an admin browser session.
// Written for `scripts/setup-comfyui.sh`, which emits the manifest it consumes.
//
// Idempotent by baseUrl: re-running an unchanged manifest is a no-op, and a changed
// one updates in place, preserving each worker's id, health and assignment history.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { getDb, closeDb, audit } from "./index";
import type { Worker } from "./types";

const path = process.argv[2];
if (!path) {
  console.error("Usage: workers <manifest.json>");
  process.exit(2);
}

/** Mirrors the API's worker URL rule: a plain HTTP origin on the private lab network. */
function workerUrl(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    ["169.254.169.254", "metadata.google.internal"].includes(u.hostname)
  )
    throw new Error(`Worker URL must be a plain HTTP lab origin: ${value}`);
  return u.origin;
}

type Entry = {
  name: string;
  baseUrl: string;
  gpuName?: string;
  vramMb?: number;
  architecture?: string;
  tags?: string[];
  maxConcurrentJobs?: number;
  enabled?: boolean;
};

const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
if (!Array.isArray(raw)) throw new Error("Manifest must be a JSON array of workers");

const entries = raw.map((value, i): Entry => {
  const e = value as Entry;
  if (!e || typeof e.name !== "string" || !e.name.trim()) throw new Error(`Worker ${i}: name is required`);
  if (typeof e.baseUrl !== "string") throw new Error(`Worker ${i}: baseUrl is required`);
  const max = e.maxConcurrentJobs ?? 1;
  if (!Number.isInteger(max) || max < 1 || max > 16) throw new Error(`Worker ${i}: maxConcurrentJobs must be 1-16`);
  return { ...e, baseUrl: workerUrl(e.baseUrl), maxConcurrentJobs: max };
});

const seen = new Set<string>();
for (const e of entries) {
  if (seen.has(e.baseUrl)) throw new Error(`Manifest lists ${e.baseUrl} twice`);
  seen.add(e.baseUrl);
}

const db = getDb();
const summary = db.transaction(() => {
  const existing = new Map(db.list("workers").map((w) => [w.baseUrl, w]));
  const created: string[] = [];
  const updated: string[] = [];
  for (const e of entries) {
    const prior = existing.get(e.baseUrl);
    const worker: Worker = {
      // Health and scheduling state belong to the gateway, so an update never resets them.
      id: prior?.id ?? randomUUID(),
      lastHealthCheck: prior?.lastHealthCheck ?? null,
      healthStatus: prior?.healthStatus ?? "OFFLINE",
      lastAssignedAt: prior?.lastAssignedAt ?? 0,
      externalBusy: prior?.externalBusy ?? false,
      ...(prior?.nodeDefinitions ? { nodeDefinitions: prior.nodeDefinitions } : {}),
      name: e.name,
      baseUrl: e.baseUrl,
      enabled: e.enabled ?? true,
      gpuName: e.gpuName ?? "",
      vramMb: e.vramMb ?? 0,
      architecture: e.architecture ?? "",
      tags: e.tags ?? [],
      maxConcurrentJobs: e.maxConcurrentJobs!,
    };
    if (!worker.enabled) worker.healthStatus = "DISABLED";
    db.put("workers", worker);
    // actorId is null: provisioning is a host operation, not an admin's browser action.
    audit(prior ? "WORKER_UPDATED" : "WORKER_CREATED", { targetId: worker.id, metadata: { name: worker.name } }, db);
    (prior ? updated : created).push(`${worker.name} (${worker.baseUrl})`);
  }
  return { created, updated };
});

for (const w of summary.created) console.log(`created ${w}`);
for (const w of summary.updated) console.log(`updated ${w}`);
console.log(`${summary.created.length} created, ${summary.updated.length} updated`);
closeDb();
