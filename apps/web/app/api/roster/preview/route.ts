import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseRosterCsv, reconcileRoster } from "@class-comfyui/auth";
import { store } from "@/lib/store";
import { isAdmin } from "@/lib/auth-helpers";
import { requireOrigin } from "@/lib/origin";

const Body = z.object({
  classId: z.string().min(1),
  csv: z.string().min(1).max(5_000_000),
});

export async function POST(req: NextRequest) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid payload (classId, csv required)" }, { status: 400 });
  }
  const cls = store.classes.get(body.classId);
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });
  const { rows, errors } = parseRosterCsv(body.csv);
  if (errors.length > 0) return NextResponse.json({ error: errors[0], errors }, { status: 400 });
  const existing = [...store.enrollments.values()]
    .filter((e) => e.classId === body.classId && e.status !== "ARCHIVED")
    .map((e) => ({
      rosterEmail: e.rosterEmail,
      orgDefinedId: e.orgDefinedId,
      firstName: e.firstName,
      lastName: e.lastName,
    }));
  const preview = reconcileRoster(rows, existing);
  return NextResponse.json({
    preview: {
      totalRows: preview.totalRows,
      newCount: preview.newCount,
      unchangedCount: preview.unchangedCount,
      updatedCount: preview.updatedCount,
      invalidCount: preview.invalidCount,
      duplicateCount: preview.duplicateCount,
      missingCount: preview.missingCount,
      rows: preview.rows.slice(0, 500),
    },
  });
}
