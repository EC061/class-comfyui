import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { store, audit } from "@/lib/store";
import { isAdmin, currentUser } from "@/lib/auth-helpers";
import { requireOrigin } from "@/lib/origin";
import { WorkerCreateSchema } from "@class-comfyui/shared";

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  // Admin-only: includes baseUrl. Student APIs never return it.
  return NextResponse.json({ workers: [...store.workers.values()] });
}

export async function POST(req: NextRequest) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let parsed: z.infer<typeof WorkerCreateSchema>;
  try {
    parsed = WorkerCreateSchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: "Invalid worker payload", details: String(e) }, { status: 400 });
  }
  if ([...store.workers.values()].some((w) => w.name === parsed.name)) {
    return NextResponse.json({ error: "Worker name already exists" }, { status: 409 });
  }
  // SSRF guard: only allow http(s) to private/lab hosts, never cloud metadata
  try {
    const u = new URL(parsed.baseUrl);
    if (!["http:", "https:"].includes(u.protocol)) throw new Error("bad proto");
    if (["169.254.169.254", "metadata.google.internal"].includes(u.hostname)) throw new Error("blocked host");
  } catch {
    return NextResponse.json({ error: "Invalid baseUrl" }, { status: 400 });
  }
  const row = {
    id: randomUUID(),
    name: parsed.name,
    baseUrl: parsed.baseUrl,
    enabled: parsed.enabled,
    gpuName: parsed.gpuName ?? "",
    vramMb: parsed.vramMb ?? 0,
    architecture: parsed.architecture ?? "",
    tags: parsed.tags ?? [],
    maxConcurrentJobs: parsed.maxConcurrentJobs ?? 1,
    lastHealthCheck: null as string | null,
    healthStatus: "OFFLINE" as const,
  };
  store.workers.set(row.id, row);
  audit("WORKER_CREATED", { actorId: currentUser(req)?.id ?? null, targetId: row.id, metadata: { name: row.name } });
  return NextResponse.json({ worker: row }, { status: 201 });
}
