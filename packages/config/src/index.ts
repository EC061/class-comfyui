import { z } from "zod";

/**
 * Central environment parsing.
 * PUBLIC_URL is canonical and authoritative. Never trust Host/Origin for URL generation.
 */

const boolFromString = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PUBLIC_URL: z.string().url().default("http://localhost:8080"),
  COMFY_PUBLIC_URL: z.string().url().default("http://comfy.localhost:8080"),
  PORT: z.coerce.number().default(3000),
  GATEWAY_PORT: z.coerce.number().default(8081),
  DATABASE_URL: z.string().default("postgresql://comfy:CHANGE_ME@postgres:5432/comfy"),
  REDIS_URL: z.string().default("redis://redis:6379"),
  AUTH_SECRET: z.string().default("CHANGE_ME_AUTH_SECRET_32_CHARS_MIN__"),
  WORKSPACE_JWT_SECRET: z.string().default("CHANGE_ME_WORKSPACE_SECRET_32_MIN_"),
  ADMIN_REGISTRATION_CODE: z.string().default("CHANGE_ME"),
  SMTP_HOST: z.string().default("smtp.example.edu"),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASSWORD: z.string().default("CHANGE_ME"),
  SMTP_SECURE: z.string().default("false"),
  SMTP_FROM_NAME: z.string().default("ComfyUI Lab"),
  SMTP_FROM_EMAIL: z.string().email().default("noreply@example.edu"),
  AUDIT_DATA_DIR: z.string().default("/data/audit"),
  AUDIT_RETENTION_ENABLED: z.string().default("false"),
  AUDIT_RETENTION_DAYS: z.coerce.number().default(180),
  MAX_ACTIVE_JOBS_PER_USER: z.coerce.number().default(1),
  MAX_QUEUED_JOBS_PER_USER: z.coerce.number().default(3),
  SESSION_TTL_HOURS: z.coerce.number().default(24 * 7),
  VERIFICATION_TTL_MINUTES: z.coerce.number().default(15),
  WORKSPACE_TOKEN_TTL_SECONDS: z.coerce.number().default(60),
});

export type AppEnv = z.infer<typeof EnvSchema>;

let cached: AppEnv | null = null;

export function getEnv(overrides: Record<string, string | undefined> = {}): AppEnv {
  if (cached && Object.keys(overrides).length === 0) return cached;
  const merged: Record<string, unknown> = {};
  for (const key of Object.keys(EnvSchema.shape)) {
    const v =
      overrides[key] ??
      (typeof process !== "undefined" ? (process.env as Record<string, string | undefined>)[key] : undefined);
    if (v !== undefined) merged[key] = v;
  }
  // Include NODE_ENV explicitly
  if (process?.env?.NODE_ENV) merged["NODE_ENV"] = process.env.NODE_ENV;
  const parsed = EnvSchema.parse(merged);
  if (Object.keys(overrides).length === 0) cached = parsed;
  return parsed;
}

export function resetEnvCache() {
  cached = null;
}

/** Derive exact allowed origin from PUBLIC_URL. e.g. https://comfy-admin.example.edu */
export function canonicalOrigin(publicUrl: string): string {
  return new URL(publicUrl).origin;
}

/** Derive exact allowed origin for gateway from COMFY_PUBLIC_URL */
export function comfyCanonicalOrigin(comfyPublicUrl: string): string {
  return new URL(comfyPublicUrl).origin;
}

export function isHttpsPublicUrl(publicUrl: string): boolean {
  return new URL(publicUrl).protocol === "https:";
}

/**
 * Strict origin check for state-changing browser requests.
 * - If Origin header present: require exact match to expected origin.
 * - If Origin absent: fall back to strict Host validation against canonical host
 *   (only for same-site form/navigation semantics). Documented behavior:
 *   non-browser API clients without Origin AND without Host mismatch are allowed
 *   to proceed to auth checks; browser same-origin navigations carry Host which must match.
 * Returns true if allowed, false if must be rejected with 403.
 */
export function isAllowedBrowserOrigin(opts: {
  publicUrl: string;
  originHeader: string | null | undefined;
  hostHeader: string | null | undefined;
  forwardedHost?: string | null | undefined;
}): boolean {
  const expected = canonicalOrigin(opts.publicUrl);
  const expectedUrl = new URL(opts.publicUrl);
  if (opts.originHeader && opts.originHeader.trim() !== "") {
    // Exact comparison only. No suffix/substring matching.
    return opts.originHeader === expected;
  }
  // Origin absent: strict canonical-host validation.
  // Reject if Host header present and does not exactly equal canonical host (incl. port).
  if (opts.hostHeader) {
    const host = opts.hostHeader.split(",")[0].trim().split(":")[0].toLowerCase();
    // Compare host without port, plus port check
    const expectedHost = expectedUrl.hostname.toLowerCase();
    if (host !== expectedHost) return false;
    // If ports are explicit, require match of effective port
    const hostPort = opts.hostHeader.includes(":")
      ? opts.hostHeader.split(",")[0].trim().split(":").slice(1).join(":")
      : "";
    const expectedPort = expectedUrl.port || (expectedUrl.protocol === "https:" ? "443" : "80");
    // Only enforce when Host included a port explicitly
    if (hostPort) {
      const canonicalPort = expectedUrl.port || (expectedUrl.protocol === "https:" ? "443" : "80");
      // Normalize default ports
      if (
        hostPort !== canonicalPort &&
        !(hostPort === "443" && expectedPort === "443") &&
        !(hostPort === "80" && expectedPort === "80")
      ) {
        return false;
      }
    }
    return true;
  }
  // No Origin and no Host (e.g. server-to-server / tests): allow through to auth layer.
  return true;
}

/** Build canonical app URL from PUBLIC_URL, never from request headers. */
export function appUrl(publicUrl: string, path: string): string {
  const base = publicUrl.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

/** Build canonical comfy URL from COMFY_PUBLIC_URL */
export function comfyUrl(comfyPublicUrl: string, path: string): string {
  const base = comfyPublicUrl.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

export function smtpSecureFlag(v: string): boolean {
  return v === "true" || v === "1";
}

export { boolFromString };
