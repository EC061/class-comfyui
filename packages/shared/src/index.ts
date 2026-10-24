import { z } from "zod";

export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(320)).transform(canonicalEmail);

/**
 * University-issued addresses appear on rosters under the campus subdomain
 * (nc96132@uga.view.usg.edu) but resolve to the plain domain (nc96132@uga.edu).
 * Only this exact domain is rewritten; every other domain is left alone.
 */
const DOMAIN_ALIASES: Record<string, string> = { "uga.view.usg.edu": "uga.edu" };

export function canonicalEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at === -1) return trimmed;
  const alias = DOMAIN_ALIASES[trimmed.slice(at + 1)];
  return alias ? `${trimmed.slice(0, at + 1)}${alias}` : trimmed;
}

// Length is the only requirement that reliably adds entropy; composition rules
// push people toward predictable substitutions. Trimming is deliberately absent
// so a leading or trailing space stays part of the secret.
export const PasswordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(200, "Password must be at most 200 characters");

export const ClassCreateSchema = z.object({
  name: z.string().min(1).max(200),
  courseCode: z.string().min(1).max(50),
  term: z.string().min(1).max(50),
  description: z.string().max(2000).default(""),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be kebab-case"),
});

const WorkerFieldsSchema = z.object({
  name: z.string().min(1).max(100),
  baseUrl: z.url(),
  enabled: z.boolean(),
  gpuName: z.string().max(100),
  vramMb: z.coerce.number().int().nonnegative(),
  architecture: z.string().max(100),
  tags: z.array(z.string().max(50)),
  maxConcurrentJobs: z.coerce.number().int().min(1).max(16),
});

export const WorkerCreateSchema = WorkerFieldsSchema.extend({
  enabled: WorkerFieldsSchema.shape.enabled.default(true),
  gpuName: WorkerFieldsSchema.shape.gpuName.default(""),
  vramMb: WorkerFieldsSchema.shape.vramMb.default(0),
  architecture: WorkerFieldsSchema.shape.architecture.default(""),
  tags: WorkerFieldsSchema.shape.tags.default([]),
  maxConcurrentJobs: WorkerFieldsSchema.shape.maxConcurrentJobs.default(1),
});

/**
 * PATCH body: only the fields that were sent. Built from the default-free shape
 * because zod 4 applies `.default()` inside `.partial()`, which would reset every
 * omitted field (e.g. toggling `enabled` would wipe tags and concurrency).
 */
export const WorkerUpdateSchema = WorkerFieldsSchema.partial();

export const JobStatusSchema = z.enum(["QUEUED", "DISPATCHING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "LOST"]);

export type JobStatus = z.infer<typeof JobStatusSchema>;

/**
 * Per-student feature grants, stored as one JSON row per (user, class) in the
 * user_data table under this reserved path — never a visible file. Teachers
 * toggle them from the class roster; the gateway's seeder and template index
 * read them. Revoking hides the template and stops future seeding; files
 * already placed are left alone, never deleted out from under a student.
 */
export const GRANTS_PATH = "__grants__";

export const GrantSchema = z
  .object({
    /** Seed the MiniMax-H3 example workflow and show it in the template browser. */
    h3Video: z.boolean().default(false),
  })
  .catch({ h3Video: false });

export type Grants = z.infer<typeof GrantSchema>;

export const STRIPPED_IDENTITY_HEADERS = ["comfy-user", "x-user-id", "x-admin", "x-class-id", "x-role"] as const;

/** Remove forged identity-like headers from incoming requests (case-insensitive). */
export function stripIdentityHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const banned = new Set(STRIPPED_IDENTITY_HEADERS.map((h) => h.toLowerCase()));
  for (const [k, v] of Object.entries(headers)) {
    if (!banned.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** Sanitize a path segment for audit storage (no traversal, safe charset). */
export function sanitizePathSegment(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (cleaned === "") return "unknown";
  return cleaned.slice(0, 128);
}

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}
