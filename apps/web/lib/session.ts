import { getEnv, isHttpsPublicUrl } from "@class-comfyui/config";
import { hashSessionToken, newSessionToken } from "@class-comfyui/auth";
import { getDb } from "@class-comfyui/database";
export const SESSION_COOKIE = "comfy_session";
export function cookieToken(header: string | null, name = SESSION_COOKIE) {
  return (
    header
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(name + "="))
      ?.slice(name.length + 1) ?? null
  );
}
export function createSession(userId: string) {
  const raw = newSessionToken(),
    expiresAt = Date.now() + getEnv().SESSION_TTL_HOURS * 3600000;
  getDb().put("sessions", { id: hashSessionToken(raw, getEnv().AUTH_SECRET), userId, expiresAt });
  return { raw, expiresAt };
}
export function sessionCookieValue(raw: string, expiresAt: number) {
  return `${SESSION_COOKIE}=${raw}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${isHttpsPublicUrl(getEnv().PUBLIC_URL) ? "; Secure" : ""}`;
}
export function clearSessionCookie() {
  return sessionCookieValue("", 0);
}
export function getSessionUserIdFromCookie(header: string | null) {
  const token = cookieToken(header);
  if (!token) return null;
  const db = getDb(),
    s = db.get("sessions", hashSessionToken(token, getEnv().AUTH_SECRET));
  if (!s || s.expiresAt <= Date.now()) return null;
  const user = db.get("users", s.userId);
  return user?.status === "ACTIVE" ? user.id : null;
}
export function destroySessionByCookie(header: string | null) {
  const raw = cookieToken(header);
  if (!raw) return;
  const db = getDb(),
    session = db.get("sessions", hashSessionToken(raw, getEnv().AUTH_SECRET));
  db.transaction(() => {
    db.delete("sessions", hashSessionToken(raw, getEnv().AUTH_SECRET));
    if (session) {
      for (const s of db.list("gateway_sessions", "user_id=?", [session.userId])) db.delete("gateway_sessions", s.id);
      for (const t of db.list("workspace_tickets", "user_id=?", [session.userId])) db.delete("workspace_tickets", t.id);
    }
  });
}
