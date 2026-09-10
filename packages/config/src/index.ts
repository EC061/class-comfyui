import { z } from "zod";
const canonical = z
  .string()
  .url()
  .refine((v) => {
    const u = new URL(v);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash
    );
  }, "Must be an HTTP(S) origin without path, credentials, query or fragment");
const positive = (n: number) => z.coerce.number().int().positive().default(n);
const EnvSchema = z.object({
  NODE_ENV: z.enum(["production", "development", "test"]).default("development"),
  PUBLIC_URL: canonical.default("http://localhost:8080"),
  COMFY_PUBLIC_URL: canonical.default("http://comfy.localhost:8090"),
  SQLITE_PATH: z.string().default("./data/lab.sqlite"),
  PORT: positive(3000),
  GATEWAY_PORT: positive(8081),
  AUTH_SECRET: z.string().default("development-only-auth-secret-32-chars"),
  WORKSPACE_JWT_SECRET: z.string().default("development-only-workspace-secret-32"),
  ADMIN_REGISTRATION_CODE: z.string().default("development-only-admin-code-32-chars"),
  SMTP_HOST: z.string().default("127.0.0.1"),
  SMTP_PORT: positive(1025),
  SMTP_USER: z.string().default(""),
  SMTP_PASSWORD: z.string().default(""),
  SMTP_SECURE: z.enum(["true", "false"]).default("false"),
  SMTP_FROM_NAME: z.string().default("ComfyUI Lab"),
  SMTP_FROM_EMAIL: z.string().email().default("noreply@example.edu"),
  AUDIT_DATA_DIR: z.string().default("./data/audit"),
  UPLOAD_DATA_DIR: z.string().default("./data/uploads"),
  AUDIT_RETENTION_ENABLED: z.enum(["true", "false"]).default("false"),
  AUDIT_RETENTION_DAYS: positive(180),
  MAX_ACTIVE_JOBS_PER_USER: positive(1),
  MAX_QUEUED_JOBS_PER_USER: positive(3),
  SESSION_TTL_HOURS: positive(168),
  VERIFICATION_TTL_MINUTES: positive(15),
  WORKSPACE_TOKEN_TTL_SECONDS: z.coerce.number().int().min(1).max(60).default(60),
  JOB_TIMEOUT_SECONDS: positive(7200),
  WORKER_REQUEST_TIMEOUT_MS: positive(30000),
  MAX_UPLOAD_MB: positive(100),
  MAX_ARCHIVE_MB: positive(20480),
  MAX_USER_STORAGE_MB: positive(2048),
});
export type AppEnv = z.infer<typeof EnvSchema>;
export function getEnv(overrides: Record<string, string | undefined> = {}): AppEnv {
  return EnvSchema.parse({ ...process.env, ...overrides });
}
export function validateStartup() {
  const env = getEnv();
  if (env.NODE_ENV === "production") {
    for (const k of ["AUTH_SECRET", "WORKSPACE_JWT_SECRET", "ADMIN_REGISTRATION_CODE"] as const)
      if (env[k].length < 32 || /CHANGE_ME|development-only/i.test(env[k]))
        throw new Error(`${k} must be a unique random secret of at least 32 characters`);
    if (env.PUBLIC_URL === env.COMFY_PUBLIC_URL) throw new Error("Management and gateway require separate origins");
    if (!env.SQLITE_PATH.startsWith("/")) throw new Error("Production SQLITE_PATH must be absolute");
  }
  return env;
}
export function resetEnvCache() {
  /* Configuration is read from the environment, never request headers. */
}
export function canonicalOrigin(url: string) {
  return new URL(url).origin;
}
export const comfyCanonicalOrigin = canonicalOrigin;
export function isHttpsPublicUrl(url: string) {
  return new URL(url).protocol === "https:";
}
export function isAllowedBrowserOrigin(opts: {
  publicUrl: string;
  originHeader: string | null | undefined;
  hostHeader: string | null | undefined;
  fetchSite?: string | null;
  referer?: string | null;
  forwardedHost?: string | null;
}) {
  const u = new URL(opts.publicUrl);
  if (opts.originHeader !== null && opts.originHeader !== undefined) return opts.originHeader === u.origin;
  // Only same-origin browser requests may fall back. Host alone is not CSRF protection.
  if (opts.hostHeader !== u.host || opts.fetchSite !== "same-origin" || !opts.referer) return false;
  try {
    return new URL(opts.referer).origin === u.origin;
  } catch {
    return false;
  }
}
export function appUrl(base: string, p: string) {
  if (!p.startsWith("/") || p.startsWith("//")) throw new Error("Expected absolute application path");
  return new URL(p, canonicalOrigin(base)).href;
}
export const comfyUrl = appUrl;
export function smtpSecureFlag(v: string) {
  return v === "true";
}
