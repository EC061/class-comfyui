import { getDb } from "@class-comfyui/database";
import { createHash } from "node:crypto";
export function checkRateLimit(action: string, id: string, limit = 10, windowMs = 60000) {
  return getDb().rateLimit(
    createHash("sha256")
      .update(action + ":" + id)
      .digest("hex"),
    limit,
    windowMs
  );
}
// nginx overwrites X-Real-IP. Direct application ports must never be public.
export function clientIp(headers: Headers) {
  return headers.get("x-real-ip")?.slice(0, 64) || "direct";
}
