import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { store, audit } from "@/lib/store";
import { isAdmin, currentUser } from "@/lib/auth-helpers";
import { requireOrigin } from "@/lib/origin";

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  let users = [...store.users.values()];
  if (q) users = users.filter((u) => `${u.email} ${u.firstName} ${u.lastName}`.toLowerCase().includes(q));
  return NextResponse.json({ users: users.slice(0, 500) });
}

const Patch = z.object({
  status: z.enum(["ACTIVE", "DISABLED"]),
  globalRole: z.enum(["ADMIN", "STUDENT", "INSTRUCTOR", "TA"]).optional(),
});

export async function PATCH(req: NextRequest) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const target = store.users.get(id);
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = Patch.parse(await req.json());
  const me = currentUser(req);
  if (body.status === "DISABLED" || body.globalRole !== undefined) {
    // Prevent disabling/demoting the final active administrator.
    const activeAdmins = [...store.users.values()].filter((u) => u.globalRole === "ADMIN" && u.status === "ACTIVE");
    const isLastAdmin = activeAdmins.length === 1 && activeAdmins[0].id === target.id;
    if (isLastAdmin && (body.status === "DISABLED" || (body.globalRole && body.globalRole !== "ADMIN"))) {
      return NextResponse.json({ error: "Cannot disable or demote the final active administrator" }, { status: 400 });
    }
    if (me?.id === target.id && body.status === "DISABLED") {
      return NextResponse.json({ error: "You cannot disable your own account" }, { status: 400 });
    }
  }
  if (body.status) target.status = body.status;
  if (body.globalRole) target.globalRole = body.globalRole;
  audit(body.status === "DISABLED" ? "USER_DISABLED" : "USER_ENABLED", {
    actorId: me?.id ?? null,
    targetId: target.id,
    metadata: { email: target.email },
  });
  return NextResponse.json({ user: target });
}
