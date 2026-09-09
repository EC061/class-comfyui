import { rateLimitCheck } from "@class-comfyui/auth";

// Thin wrapper so API routes share limits. Production may back this with Redis
// (REDIS_URL) for distributed limiting; in-memory here is safe for single-instance
// and tests. Keys are namespaced per action + identifier.

export function checkRateLimit(action: string, id: string, limit = 10, windowMs = 60_000): boolean {
  const res = rateLimitCheck(`${action}:${id}`, limit, windowMs);
  return res.allowed;
}

// Client IP extraction that does NOT trust identity headers; only uses
// standard proxy headers for rate-limit keying (never for auth).
export function clientIp(headers: Headers, fallback = "unknown"): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim().slice(0, 64);
  return fallback;
}
