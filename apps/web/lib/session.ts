import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { hashToken, newSessionToken } from "@class-comfyui/auth";
import { getEnv, isHttpsPublicUrl } from "@class-comfyui/config";
import { store } from "./store";

export const SESSION_COOKIE = "comfy_session";

export function createSession(userId: string): { raw: string; expiresAt: number } {
  const env = getEnv();
  const raw = newSessionToken();
  const ttlMs = env.SESSION_TTL_HOURS * 3600 * 1000;
  const expiresAt = Date.now() + ttlMs;
  store.sessions.set(hashToken(raw), { userId, tokenHash: hashToken(raw), expiresAt });
  return { raw, expiresAt };
}

export function sessionCookieValue(raw: string, expiresAt: number): string {
  const env = getEnv();
  const secure = isHttpsPublicUrl(env.PUBLIC_URL);
  const exp = new Date(expiresAt).toUTCString();
  return `${SESSION_COOKIE}=${raw}; Path=/; HttpOnly; SameSite=Lax; Expires=${exp}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(): string {
  const env = getEnv();
  const secure = isHttpsPublicUrl(env.PUBLIC_URL);
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? "; Secure" : ""}`;
}

export function getSessionUserIdFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";").map((s) => s.trim());
  let raw: string | null = null;
  for (const p of parts) {
    if (p.startsWith(`${SESSION_COOKIE}=`)) raw = p.slice(SESSION_COOKIE.length + 1);
  }
  if (!raw) return null;
  const row = store.sessions.get(hashToken(raw));
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    store.sessions.delete(hashToken(raw));
    return null;
  }
  const user = store.users.get(row.userId);
  if (!user || user.status !== "ACTIVE") return null;
  return row.userId;
}

export function destroySessionByCookie(cookieHeader: string | null) {
  if (!cookieHeader) return;
  const parts = cookieHeader.split(";").map((s) => s.trim());
  for (const p of parts) {
    if (p.startsWith(`${SESSION_COOKIE}=`)) {
      const raw = p.slice(SESSION_COOKIE.length + 1);
      store.sessions.delete(hashToken(raw));
    }
  }
}

export { randomUUID };
