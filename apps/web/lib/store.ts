import { randomUUID } from "node:crypto";

// Central in-memory store (used for dev/test/build and as fallback).
// Production uses PostgreSQL when DATABASE_URL is a real URL and reachable.
// The repository ships Drizzle schema + DDL (packages/database) as source of truth;
// this store mirrors those entities so the app boots without a DB for build/tests
// and transparently persists to Postgres when available via lib/db-pg.ts helpers.

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  emailVerifiedAt: string | null;
  status: "ACTIVE" | "DISABLED";
  globalRole: "ADMIN" | "STUDENT" | "INSTRUCTOR" | "TA";
  lastLoginAt: string | null;
  createdAt: string;
}

export interface ClassRow {
  id: string;
  name: string;
  courseCode: string;
  term: string;
  description: string;
  slug: string;
  active: boolean;
  signupEnabled: boolean;
  signupTokenVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface Enrollment {
  id: string;
  classId: string;
  userId: string | null;
  rosterEmail: string;
  orgDefinedId: string;
  firstName: string;
  lastName: string;
  role: string;
  status: "INVITED" | "ACTIVE" | "ARCHIVED";
}

export interface SignupTokenRow {
  classId: string;
  tokenHash: string;
  version: number;
  enabled: boolean;
  createdAt: string;
  revokedAt: string | null;
}

export interface VerificationRow {
  email: string;
  tokenHash: string;
  purpose: string;
  classId: string | null;
  enrollmentId: string | null;
  isAdmin: boolean;
  adminCodeVerified: boolean;
  firstName: string;
  lastName: string;
  expiresAt: number;
  consumedAt: number | null;
}

export interface SessionRow {
  userId: string;
  tokenHash: string;
  expiresAt: number;
}

export interface WorkerRow {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  gpuName: string;
  vramMb: number;
  architecture: string;
  tags: string[];
  maxConcurrentJobs: number;
  lastHealthCheck: string | null;
  healthStatus: "ONLINE" | "BUSY" | "OFFLINE" | "DISABLED";
}

export interface JobRow {
  id: string;
  classId: string;
  userId: string;
  enrollmentId: string | null;
  orgDefinedId: string;
  workerId: string | null;
  comfyPromptId: string;
  status: string;
  archiveStatus: string;
  submittedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  promptJson: unknown;
  error: string;
  outputs: Array<{ fileName: string; mimeType: string; sizeBytes: number; sha256: string; storagePath: string }>;
}

export interface AuditRow {
  id: string;
  type: string;
  actorId: string | null;
  classId: string | null;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

const nowIso = () => new Date().toISOString();

class Store {
  users = new Map<string, User>();
  usersByEmail = new Map<string, User>();
  classes = new Map<string, ClassRow>();
  classesBySlug = new Map<string, ClassRow>();
  enrollments = new Map<string, Enrollment>();
  signupTokens: SignupTokenRow[] = [];
  verifications = new Map<string, VerificationRow>(); // by tokenHash
  sessions = new Map<string, SessionRow>(); // by tokenHash
  workers = new Map<string, WorkerRow>();
  jobs = new Map<string, JobRow>();
  audits: AuditRow[] = [];
  workspaceJtis = new Map<string, number>(); // jti -> exp
  seeded = false;

  reset() {
    this.users.clear();
    this.usersByEmail.clear();
    this.classes.clear();
    this.classesBySlug.clear();
    this.enrollments.clear();
    this.signupTokens = [];
    this.verifications.clear();
    this.sessions.clear();
    this.workers.clear();
    this.jobs.clear();
    this.audits = [];
    this.workspaceJtis.clear();
    this.seeded = false;
  }

  seed() {
    if (this.seeded) return;
    this.seeded = true;
    const admin: User = {
      id: randomUUID(),
      email: "admin@example.edu",
      firstName: "Admin",
      lastName: "User",
      emailVerifiedAt: nowIso(),
      status: "ACTIVE",
      globalRole: "ADMIN",
      lastLoginAt: null,
      createdAt: nowIso(),
    };
    this.users.set(admin.id, admin);
    this.usersByEmail.set(admin.email, admin);
    const cls: ClassRow = {
      id: randomUUID(),
      name: "Web Programming",
      courseCode: "CSCI 4300",
      term: "Fall 2026",
      description: "Seed class (fabricated data)",
      slug: "csci4300-fall-2026",
      active: true,
      signupEnabled: false,
      signupTokenVersion: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.classes.set(cls.id, cls);
    this.classesBySlug.set(cls.slug, cls);
    const seedStudents = [
      { org: "100000001", last: "Garcia", first: "Amara", email: "student1@example.edu" },
      { org: "100000002", last: "Chen", first: "Liam", email: "student2@example.edu" },
      { org: "100000003", last: "Okafor", first: "Maya", email: "student3@example.edu" },
    ];
    for (const s of seedStudents) {
      const e: Enrollment = {
        id: randomUUID(),
        classId: cls.id,
        userId: null,
        rosterEmail: s.email,
        orgDefinedId: s.org,
        firstName: s.first,
        lastName: s.last,
        role: "STUDENT",
        status: "INVITED",
      };
      this.enrollments.set(e.id, e);
    }
    this.workers.set("mock", {
      id: randomUUID(),
      name: "mock-4090",
      baseUrl: "http://mock-comfy:8188",
      enabled: true,
      gpuName: "Mock RTX 4090",
      vramMb: 24576,
      architecture: "ada",
      tags: ["4090", "24gb"],
      maxConcurrentJobs: 1,
      lastHealthCheck: null,
      healthStatus: "OFFLINE",
    });
  }
}

export const store = new Store();

// Ensure seed in non-production by default (build/tests). Production seeds nothing automatically.
if (process.env.NODE_ENV !== "production") {
  store.seed();
}

export function audit(
  type: string,
  opts: { actorId?: string | null; classId?: string | null; targetId?: string; metadata?: Record<string, unknown> } = {}
) {
  const row: AuditRow = {
    id: randomUUID(),
    type,
    actorId: opts.actorId ?? null,
    classId: opts.classId ?? null,
    targetId: opts.targetId ?? "",
    metadata: sanitizeMeta(opts.metadata ?? {}),
    createdAt: nowIso(),
  };
  store.audits.unshift(row);
  return row;
}

const SECRET_KEYS = new Set([
  "password",
  "secret",
  "adminCode",
  "admin_code",
  "token",
  "signupToken",
  "baseUrl",
  "base_url",
  "smtp",
  "code",
]);
export function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    const lk = k.toLowerCase();
    let secret = false;
    for (const s of SECRET_KEYS) {
      if (lk.includes(s)) {
        secret = true;
        break;
      }
    }
    out[k] = secret ? "[REDACTED]" : v;
  }
  return out;
}
