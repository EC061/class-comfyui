import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { store, audit } from "@/lib/store";
import { isAdmin, currentUser } from "@/lib/auth-helpers";
import { requireOrigin } from "@/lib/origin";

const Patch = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().url().optional(),
  gpuName: z.string().max(100).optional(),
  vramMb: z.coerce.number().int().nonnegative().optional(),
  maxConcurrentJobs: z.coerce.number().int().min(1).max(16).optional(),
  tags: z.array(z.string().max(50)).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const w = store.workers.get(params.id);
  if (!w) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = Patch.parse(await req.json());
  Object.assign(w, body);
  if (body.enabled === false) w.healthStatus = "DISABLED";
  else if (w.healthStatus === "DISABLED" && body.enabled === true) w.healthStatus = "OFFLINE";
  audit(body.enabled === false ? "WORKER_DISABLED" : "WORKER_UPDATED", {
    actorId: currentUser(req)?.id ?? null,
    targetId: w.id,
    metadata: { name: w.name },
  });
  return NextResponse.json({ worker: w });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const w = store.workers.get(params.id);
  if (!w) return NextResponse.json({ error: "Not found" }, { status: 404 });
  w.enabled = false;
  w.healthStatus = "DISABLED";
  audit("WORKER_DISABLED", { actorId: currentUser(req)?.id ?? null, targetId: w.id, metadata: { name: w.name } });
  return NextResponse.json({ ok: true });
}
