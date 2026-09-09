import { z } from "zod";

export const EmailSchema = z.string().trim().toLowerCase().pipe(z.string().email().max(320));

export function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

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

export const WorkerCreateSchema = z.object({
  name: z.string().min(1).max(100),
  baseUrl: z.string().url(),
  enabled: z.boolean().default(true),
  gpuName: z.string().max(100).default(""),
  vramMb: z.coerce.number().int().nonnegative().default(0),
  architecture: z.string().max(100).default(""),
  tags: z.array(z.string().max(50)).default([]),
  maxConcurrentJobs: z.coerce.number().int().min(1).max(16).default(1),
});

export const JobStatusSchema = z.enum(["QUEUED", "DISPATCHING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "LOST"]);

export type JobStatus = z.infer<typeof JobStatusSchema>;

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
  let cleaned = input
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
