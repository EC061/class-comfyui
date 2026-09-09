import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { parseRosterCsv, reconcileRoster } from "@class-comfyui/auth";
import { store, audit } from "@/lib/store";
import { isAdmin, currentUser } from "@/lib/auth-helpers";
import { requireOrigin } from "@/lib/origin";

const Body = z.object({
  classId: z.string().min(1),
  csv: z.string().min(1).max(5_000_000),
  archiveMissing: z.boolean().optional().default(false),
  fileName: z.string().max(255).optional().default("roster.csv"),
});

export async function POST(req: NextRequest) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  const cls = store.classes.get(body.classId);
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });
  const { rows, errors } = parseRosterCsv(body.csv);
  if (errors.length > 0) return NextResponse.json({ error: errors[0] }, { status: 400 });

  // Transactional commit: validate everything first; abort on INVALID/DUPLICATE rows.
  const invalid = rows.filter((r) => !r.valid);
  if (invalid.length > 0) {
    return NextResponse.json(
      {
        error: `Roster has ${invalid.length} invalid row(s). Fix and retry. Nothing was committed.`,
        sample: invalid.slice(0, 5),
      },
      { status: 400 }
    );
  }
  const emails = new Set<string>();
  const ids = new Set<string>();
  for (const r of rows) {
    if (emails.has(r.email) || ids.has(r.orgDefinedId)) {
      return NextResponse.json(
        { error: "Duplicate email or student ID in file. Nothing was committed." },
        { status: 400 }
      );
    }
    emails.add(r.email);
    ids.add(r.orgDefinedId);
  }

  // Apply
  let created = 0,
    updated = 0;
  for (const r of rows) {
    const existing = [...store.enrollments.values()].find(
      (e) => e.classId === body.classId && (e.rosterEmail === r.email || e.orgDefinedId === r.orgDefinedId)
    );
    // Handle email change with same ID: update email key
    if (!existing) {
      store.enrollments.set(randomUUID(), {
        id: randomUUID(),
        classId: body.classId,
        userId: null,
        rosterEmail: r.email,
        orgDefinedId: r.orgDefinedId,
        firstName: r.firstName,
        lastName: r.lastName,
        role: "STUDENT",
        status: "INVITED",
      });
      created++;
    } else {
      const changed =
        existing.firstName !== r.firstName ||
        existing.lastName !== r.lastName ||
        existing.rosterEmail !== r.email ||
        existing.orgDefinedId !== r.orgDefinedId;
      existing.firstName = r.firstName;
      existing.lastName = r.lastName;
      existing.rosterEmail = r.email;
      existing.orgDefinedId = r.orgDefinedId;
      if (existing.status === "ARCHIVED") existing.status = "INVITED";
      if (changed) updated++;
    }
  }
  // Fix map keys that used random ids incorrectly: normalize ids
  // (we generated id twice above; repair by re-keying)
  const fixed = new Map<string, typeof store.enrollments extends Map<string, infer V> ? V : never>();
  for (const e of store.enrollments.values()) {
    fixed.set(e.id, e);
  }
  store.enrollments.clear();
  for (const [k, v] of fixed) store.enrollments.set(k, v);

  let archived = 0;
  if (body.archiveMissing) {
    for (const e of store.enrollments.values()) {
      if (e.classId !== body.classId || e.status === "ARCHIVED") continue;
      if (!emails.has(e.rosterEmail) && !ids.has(e.orgDefinedId)) {
        e.status = "ARCHIVED";
        archived++;
        audit("ENROLLMENT_ARCHIVED", {
          actorId: currentUser(req)?.id ?? null,
          classId: body.classId,
          targetId: e.id,
          metadata: {},
        });
      }
    }
  }

  const u = currentUser(req);
  audit("ROSTER_IMPORTED", {
    actorId: u?.id ?? null,
    classId: body.classId,
    targetId: body.classId,
    metadata: { total: rows.length, created, updated, archived, file: body.fileName },
  });
  return NextResponse.json({ ok: true, created, updated, archived, total: rows.length });
}
