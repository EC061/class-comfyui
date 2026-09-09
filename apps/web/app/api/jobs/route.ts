import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { currentUser } from "@/lib/auth-helpers";

export async function GET(req: NextRequest) {
  const user = currentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const classId = url.searchParams.get("classId");
  const mine = user.globalRole !== "ADMIN";
  let jobs = [...store.jobs.values()].sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
  if (mine) jobs = jobs.filter((j) => j.userId === user.id);
  if (classId) jobs = jobs.filter((j) => j.classId === classId);
  // Never leak worker base URLs: map workerId -> safe name only
  const shaped = jobs.slice(0, 200).map((j) => ({
    ...j,
    promptJson: user.globalRole === "ADMIN" ? j.promptJson : undefined,
    workerName: j.workerId ? (store.workers.get(j.workerId)?.name ?? null) : null,
  }));
  return NextResponse.json({ jobs: shaped });
}
