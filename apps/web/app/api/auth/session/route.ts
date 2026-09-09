import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth-helpers";
import { store } from "@/lib/store";

export async function GET(req: NextRequest) {
  const u = currentUser(req);
  if (!u) return NextResponse.json({ user: null }, { status: 200 });
  const enrollments = [...store.enrollments.values()]
    .filter((e) => e.userId === u.id || e.rosterEmail === u.email)
    .map((e) => {
      const c = store.classes.get(e.classId);
      return {
        id: e.id,
        classId: e.classId,
        classSlug: c?.slug ?? "",
        className: c?.name ?? "",
        courseCode: c?.courseCode ?? "",
        term: c?.term ?? "",
        status: e.status,
        role: e.role,
      };
    });
  return NextResponse.json({
    user: {
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      globalRole: u.globalRole,
      status: u.status,
    },
    enrollments,
  });
}
