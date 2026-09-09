import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { store, audit } from "@/lib/store";
import { isAdmin } from "@/lib/auth-helpers";
import { requireOrigin } from "@/lib/origin";
import { ClassCreateSchema } from "@class-comfyui/shared";

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const classes = [...store.classes.values()].map((c) => ({
    ...c,
    enrolled: [...store.enrollments.values()].filter((e) => e.classId === c.id).length,
    registered: [...store.enrollments.values()].filter((e) => e.classId === c.id && e.status === "ACTIVE" && e.userId)
      .length,
  }));
  return NextResponse.json({ classes });
}

export async function POST(req: NextRequest) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: unknown;
  try {
    body = ClassCreateSchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: "Invalid class payload", details: String(e) }, { status: 400 });
  }
  const b = body as z.infer<typeof ClassCreateSchema>;
  if (store.classesBySlug.has(b.slug)) return NextResponse.json({ error: "Slug already exists" }, { status: 409 });
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    name: b.name,
    courseCode: b.courseCode,
    term: b.term,
    description: b.description ?? "",
    slug: b.slug,
    active: true,
    signupEnabled: false,
    signupTokenVersion: 0,
    createdAt: now,
    updatedAt: now,
  };
  store.classes.set(row.id, row);
  store.classesBySlug.set(row.slug, row);
  const { currentUser } = await import("@/lib/auth-helpers");
  const u = currentUser(req);
  audit("CLASS_CREATED", { actorId: u?.id ?? null, classId: row.id, targetId: row.id, metadata: { slug: row.slug } });
  return NextResponse.json({ class: row }, { status: 201 });
}
