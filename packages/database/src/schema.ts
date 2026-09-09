import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  uuid,
  jsonb,
  bigint,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// Users are global.
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(), // canonical lowercase
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    status: text("status").notNull().default("ACTIVE"), // ACTIVE | DISABLED
    globalRole: text("global_role").notNull().default("STUDENT"), // ADMIN | STUDENT (+ INSTRUCTOR/TA later)
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)]
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionTokenHash: text("session_token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)]
);

export const emailVerificationTokens = pgTable(
  "email_verification_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    purpose: text("purpose").notNull().default("LOGIN"), // LOGIN | SIGNUP | ADMIN_REGISTER
    classId: uuid("class_id"),
    enrollmentId: uuid("enrollment_id"),
    isAdmin: boolean("is_admin").default(false).notNull(),
    adminCodeVerified: boolean("admin_code_verified").default(false).notNull(),
    firstName: text("first_name").default(""),
    lastName: text("last_name").default(""),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("evt_email_idx").on(t.email), index("evt_expires_idx").on(t.expiresAt)]
);

export const classes = pgTable(
  "classes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    courseCode: text("course_code").notNull(),
    term: text("term").notNull(),
    description: text("description").default(""),
    slug: text("slug").notNull().unique(),
    active: boolean("active").default(true).notNull(),
    signupEnabled: boolean("signup_enabled").default(false).notNull(),
    signupTokenVersion: integer("signup_token_version").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("classes_slug_idx").on(t.slug), index("classes_active_idx").on(t.active)]
);

export const classEnrollments = pgTable(
  "class_enrollments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    rosterEmail: text("roster_email").notNull(),
    orgDefinedId: text("org_defined_id").notNull().default(""),
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    role: text("role").notNull().default("STUDENT"),
    status: text("status").notNull().default("INVITED"), // INVITED | ACTIVE | ARCHIVED
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("enrollment_class_email_unique").on(t.classId, t.rosterEmail),
    index("enrollment_class_idx").on(t.classId),
    index("enrollment_email_idx").on(t.rosterEmail),
    index("enrollment_orgid_idx").on(t.orgDefinedId),
    index("enrollment_user_idx").on(t.userId),
  ]
);

export const classSignupTokens = pgTable(
  "class_signup_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    version: integer("version").notNull().default(1),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("signup_class_idx").on(t.classId)]
);

export const rosterImports = pgTable("roster_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  classId: uuid("class_id")
    .notNull()
    .references(() => classes.id, { onDelete: "cascade" }),
  importedBy: uuid("imported_by").references(() => users.id, { onDelete: "set null" }),
  fileName: text("file_name").default(""),
  totalRows: integer("total_rows").default(0).notNull(),
  newCount: integer("new_count").default(0).notNull(),
  updatedCount: integer("updated_count").default(0).notNull(),
  invalidCount: integer("invalid_count").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const rosterImportRows = pgTable("roster_import_rows", {
  id: uuid("id").primaryKey().defaultRandom(),
  importId: uuid("import_id")
    .notNull()
    .references(() => rosterImports.id, { onDelete: "cascade" }),
  line: integer("line").default(0).notNull(),
  state: text("state").notNull(),
  email: text("email").default(""),
  orgDefinedId: text("org_defined_id").default(""),
  errors: jsonb("errors").default([]),
});

export const invitations = pgTable("invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  classId: uuid("class_id")
    .notNull()
    .references(() => classes.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  sentBy: uuid("sent_by").references(() => users.id, { onDelete: "set null" }),
  sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
});

export const workers = pgTable("workers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  baseUrl: text("base_url").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  gpuName: text("gpu_name").default(""),
  vramMb: integer("vram_mb").default(0).notNull(),
  architecture: text("architecture").default(""),
  tags: jsonb("tags").default([]),
  maxConcurrentJobs: integer("max_concurrent_jobs").default(1).notNull(),
  lastHealthCheck: timestamp("last_health_check", { withTimezone: true }),
  healthStatus: text("health_status").default("OFFLINE").notNull(), // ONLINE | BUSY | OFFLINE | DISABLED
  consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    enrollmentId: uuid("enrollment_id").references(() => classEnrollments.id, { onDelete: "set null" }),
    orgDefinedId: text("org_defined_id").default(""),
    workerId: uuid("worker_id").references(() => workers.id, { onDelete: "set null" }),
    comfyPromptId: text("comfy_prompt_id").default(""),
    status: text("status").notNull().default("QUEUED"),
    archiveStatus: text("archive_status").default("PENDING").notNull(), // PENDING | OK | FAILED
    submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    runtimeMs: integer("runtime_ms"),
    promptJson: jsonb("prompt_json"),
    workflowJson: jsonb("workflow_json"),
    error: text("error").default(""),
  },
  (t) => [
    index("jobs_user_idx").on(t.userId),
    index("jobs_class_idx").on(t.classId),
    index("jobs_status_idx").on(t.status),
    index("jobs_submitted_idx").on(t.submittedAt),
    index("jobs_worker_idx").on(t.workerId),
  ]
);

export const jobOutputs = pgTable("job_outputs", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").default("application/octet-stream").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).default(0).notNull(),
  sha256: text("sha256").default(""),
  storagePath: text("storage_path").notNull(),
  workerFileName: text("worker_file_name").default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const workspaceSessions = pgTable("workspace_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  classId: uuid("class_id")
    .notNull()
    .references(() => classes.id, { onDelete: "cascade" }),
  jti: text("jti").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(),
  actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  classId: uuid("class_id").references(() => classes.id, { onDelete: "set null" }),
  targetId: text("target_id").default(""),
  metadata: jsonb("metadata").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
