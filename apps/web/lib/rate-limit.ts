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
// The remote reverse proxy sets X-Real-IP to the real client address and, using
// proxy_set_header, replaces any value a client sent. Nothing else in the path
// rewrites it, so the published ports must be firewalled to the frpc host only:
// anything that can reach them directly can forge this header and evade limits.
export function clientIp(headers: Headers) {
  return headers.get("x-real-ip")?.slice(0, 64) || "direct";
}
