import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { currentUser } from "@/lib/auth-helpers";

export async function GET(req: NextRequest) {
  const user = currentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const classId = url.searchParams.get("classId");
  const type = url.searchParams.get("type");
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  let events = [...store.audits];
  if (user.globalRole !== "ADMIN") {
    // Students see only events for their own classes/jobs (safe subset: their enrollments)
    const myClassIds = new Set(
      [...store.enrollments.values()].filter((e) => e.userId === user.id).map((e) => e.classId)
    );
    events = events.filter((e) => (e.classId && myClassIds.has(e.classId)) || e.actorId === user.id);
  }
  if (classId) events = events.filter((e) => e.classId === classId);
  if (type) events = events.filter((e) => e.type === type);
  if (q) events = events.filter((e) => JSON.stringify(e).toLowerCase().includes(q));
  return NextResponse.json({ events: events.slice(0, 300) });
}
