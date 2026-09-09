import { getSessionUserIdFromCookie } from "./session";
import { getDb } from "@class-comfyui/database";
export function currentUser(req: Request) {
  const id = getSessionUserIdFromCookie(req.headers.get("cookie"));
  return id ? (getDb().get("users", id) ?? null) : null;
}
export function currentUserId(req: Request) {
  return currentUser(req)?.id ?? null;
}
export function isAdmin(req: Request) {
  return currentUser(req)?.globalRole === "ADMIN";
}
