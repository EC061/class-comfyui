import { NextRequest } from "next/server";
import { getSessionUserIdFromCookie } from "./session";
import { store } from "./store";

export function currentUserId(req: NextRequest): string | null {
  return getSessionUserIdFromCookie(req.headers.get("cookie"));
}

export function currentUser(req: NextRequest) {
  const id = currentUserId(req);
  if (!id) return null;
  return store.users.get(id) ?? null;
}

export function isAdmin(req: NextRequest): boolean {
  const u = currentUser(req);
  return !!u && u.globalRole === "ADMIN" && u.status === "ACTIVE";
}
