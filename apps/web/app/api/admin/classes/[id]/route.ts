import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { store, audit } from "@/lib/store";
import { isAdmin, currentUser } from "@/lib/auth-helpers";
import { requireOrigin } from "@/lib/origin";

const Patch = z.object({
  name: z.string().min(1).max(200).optional(),
  courseCode: z.string().min(1).max(50).optional(),
  term: z.string().min(1).max(50).optional(),
  description: z.string().max(2000).optional(),
  active: z.boolean().optional(),
});

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const cls = store.classes.get(params.id);
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const enrollments = [...store.enrollments.values()].filter((e) => e.classId === cls.id);
  const jobs = [...store.jobs.values()].filter((j) => j.classId === cls.id).slice(0, 100);
  return NextResponse.json({ class: cls, enrollments, jobs });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const cls = store.classes.get(params.id);
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = Patch.parse(await req.json());
  Object.assign(cls, body, { updatedAt: new Date().toISOString() });
  const u = currentUser(req);
  audit(body.active === false ? "CLASS_ARCHIVED" : "CLASS_UPDATED", {
    actorId: u?.id ?? null,
    classId: cls.id,
    targetId: cls.id,
    metadata: { slug: cls.slug },
  });
  return NextResponse.json({ class: cls });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const cls = store.classes.get(params.id);
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });
  cls.active = false;
  cls.updatedAt = new Date().toISOString();
  const u = currentUser(req);
  audit("CLASS_ARCHIVED", { actorId: u?.id ?? null, classId: cls.id, targetId: cls.id, metadata: {} });
  return NextResponse.json({ ok: true });
}
