import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Tables, Audit, User } from "./types";
export * from "./types";

export const SCHEMA_VERSION = 2;

// Typed repositories use JSON documents with relational generated columns. All
// identities, foreign keys, uniqueness and hot lookup indexes are enforced by SQLite.
const definitions: Record<keyof Tables, string> = {
  users: `email TEXT GENERATED ALWAYS AS (json_extract(data,'$.email')) STORED COLLATE NOCASE NOT NULL UNIQUE`,
  classes: `slug TEXT GENERATED ALWAYS AS (json_extract(data,'$.slug')) STORED NOT NULL UNIQUE`,
  enrollments: `class_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.classId')) STORED NOT NULL REFERENCES classes(id), user_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.userId')) STORED REFERENCES users(id), email TEXT GENERATED ALWAYS AS (json_extract(data,'$.rosterEmail')) STORED COLLATE NOCASE NOT NULL, org_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.orgDefinedId')) STORED NOT NULL, UNIQUE(class_id,email), UNIQUE(class_id,org_id)`,
  signup_tokens: `class_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.classId')) STORED NOT NULL REFERENCES classes(id), token_hash TEXT GENERATED ALWAYS AS (json_extract(data,'$.tokenHash')) STORED UNIQUE`,
  verifications: `email TEXT GENERATED ALWAYS AS (json_extract(data,'$.email')) STORED COLLATE NOCASE`,
  sessions: `user_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.userId')) STORED NOT NULL REFERENCES users(id)`,
  gateway_sessions: `user_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.userId')) STORED NOT NULL REFERENCES users(id)`,
  workspace_tickets: `user_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.userId')) STORED NOT NULL REFERENCES users(id), class_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.classId')) STORED NOT NULL REFERENCES classes(id)`,
  workers: `name TEXT GENERATED ALWAYS AS (json_extract(data,'$.name')) STORED NOT NULL UNIQUE, base_url TEXT GENERATED ALWAYS AS (json_extract(data,'$.baseUrl')) STORED NOT NULL UNIQUE`,
  jobs: `user_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.userId')) STORED NOT NULL REFERENCES users(id), class_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.classId')) STORED NOT NULL REFERENCES classes(id), enrollment_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.enrollmentId')) STORED NOT NULL REFERENCES enrollments(id), worker_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.workerId')) STORED REFERENCES workers(id), status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED NOT NULL CHECK(status IN ('QUEUED','DISPATCHING','RUNNING','COMPLETED','FAILED','CANCELLED','LOST')), submitted_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.submittedAt')) STORED NOT NULL`,
  outputs: `job_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.jobId')) STORED NOT NULL REFERENCES jobs(id)`,
  audits: `actor_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.actorId')) STORED REFERENCES users(id), class_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.classId')) STORED REFERENCES classes(id)`,
  roster_imports: `class_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.classId')) STORED NOT NULL REFERENCES classes(id)`,
  roster_import_rows: `import_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.importId')) STORED NOT NULL REFERENCES roster_imports(id)`,
  invitations: `class_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.classId')) STORED NOT NULL REFERENCES classes(id)`,
  uploads: `user_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.userId')) STORED NOT NULL REFERENCES users(id), class_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.classId')) STORED NOT NULL REFERENCES classes(id), filename TEXT GENERATED ALWAYS AS (json_extract(data,'$.filename')) STORED UNIQUE`,
  user_data: `user_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.userId')) STORED NOT NULL REFERENCES users(id), class_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.classId')) STORED NOT NULL REFERENCES classes(id), path TEXT GENERATED ALWAYS AS (json_extract(data,'$.path')) STORED NOT NULL, UNIQUE(user_id,class_id,path)`,
};
export class LabDatabase {
  readonly sql: DatabaseSync;
  constructor(readonly filename: string) {
    if (filename !== ":memory:") mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
    this.sql = new DatabaseSync(filename);
    this.sql.exec(
      "PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;"
    );
    this.transaction(() => {
      const version = (this.sql.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version > SCHEMA_VERSION) throw new Error("Database schema is newer than this application");
      if (version === 0) {
        for (const [table, cols] of Object.entries(definitions))
          this.sql.exec(
            `CREATE TABLE ${table}(id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL CHECK(json_valid(data) AND json_extract(data,'$.id')=id), ${cols})`
          );
        this.sql.exec(
          `CREATE INDEX jobs_user ON jobs(user_id,submitted_at); CREATE INDEX jobs_class ON jobs(class_id,submitted_at); CREATE INDEX jobs_status ON jobs(status,submitted_at); CREATE INDEX jobs_submitted ON jobs(submitted_at); CREATE INDEX jobs_worker ON jobs(worker_id,status); CREATE INDEX outputs_job ON outputs(job_id); CREATE INDEX enrollment_email ON enrollments(email); CREATE INDEX enrollment_user ON enrollments(user_id); CREATE INDEX signup_class ON signup_tokens(class_id); CREATE INDEX audits_class ON audits(class_id); CREATE TABLE rate_limits(id TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL); CREATE TABLE leases(id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL); PRAGMA user_version=${SCHEMA_VERSION};`
        );
      } else if (version === 1) {
        // v1 authenticated by emailed one-time link and stored no password. Accounts
        // survive with an empty hash: they cannot sign in until their owner sets a
        // password through the emailed reset link. Outstanding v1 challenges use a
        // retired shape and are short-lived, so they are dropped rather than mapped.
        this.sql.exec(
          `UPDATE users SET data=json_set(data,'$.passwordHash',''); DELETE FROM verifications; PRAGMA user_version=${SCHEMA_VERSION};`
        );
      }
    });
  }
  transaction<T>(fn: () => T): T {
    if (this.sql.isTransaction) return fn();
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error("Never await inside a database transaction");
      this.sql.exec("COMMIT");
      return result;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
  }
  get<K extends keyof Tables>(table: K, id: string): Tables[K] | undefined {
    const row = this.sql.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Tables[K]) : undefined;
  }
  list<K extends keyof Tables>(table: K, where = "1", params: (string | number | null)[] = []): Tables[K][] {
    return (this.sql.prepare(`SELECT data FROM ${table} WHERE ${where}`).all(...params) as { data: string }[]).map(
      (r) => JSON.parse(r.data) as Tables[K]
    );
  }
  put<K extends keyof Tables>(table: K, row: Tables[K]): Tables[K] {
    this.sql
      .prepare(`INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`)
      .run(row.id, JSON.stringify(row));
    return row;
  }
  delete<K extends keyof Tables>(table: K, id: string) {
    this.sql.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
  }
  /** Bulk delete for cascades. Returns the number of rows removed. */
  deleteWhere<K extends keyof Tables>(table: K, where: string, params: (string | number | null)[] = []): number {
    return Number(this.sql.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params).changes);
  }
  userByEmail(email: string): User | undefined {
    return this.list("users", "email=?", [email.trim().toLowerCase()])[0];
  }
  rateLimit(id: string, limit: number, windowMs: number): boolean {
    return this.transaction(() => {
      const now = Date.now();
      this.sql.prepare("DELETE FROM rate_limits WHERE expires_at<=?").run(now);
      const row = this.sql.prepare("SELECT count FROM rate_limits WHERE id=?").get(id) as { count: number } | undefined;
      if (row && row.count >= limit) return false;
      this.sql
        .prepare("INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1")
        .run(id, now + windowMs);
      return true;
    });
  }
  acquireLease(id: string, owner: string, ttl: number): boolean {
    return this.transaction(() => {
      const current = this.sql.prepare("SELECT owner,expires_at FROM leases WHERE id=?").get(id) as
        { owner: string; expires_at: number } | undefined;
      if (current && current.owner !== owner && current.expires_at > Date.now()) return false;
      this.sql
        .prepare(
          "INSERT INTO leases VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at"
        )
        .run(id, owner, Date.now() + ttl);
      return true;
    });
  }
  close() {
    this.sql.close();
  }
}
let instance: LabDatabase | undefined;
export function getDb() {
  return (instance ??= new LabDatabase(process.env.SQLITE_PATH || path.resolve("data/lab.sqlite")));
}
export function closeDb() {
  instance?.close();
  instance = undefined;
}
export function audit(type: string, options: Partial<Omit<Audit, "id" | "type" | "createdAt">> = {}, db = getDb()) {
  const row: Audit = {
    id: randomUUID(),
    type,
    actorId: options.actorId ?? null,
    classId: options.classId ?? null,
    targetId: options.targetId ?? "",
    metadata: redact(options.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date().toISOString(),
  };
  db.put("audits", row);
  return row;
}
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /password|secret|token|authorization|cookie|baseurl|admincode/i.test(k) ? "[REDACTED]" : redact(v),
      ])
    );
  return value;
}
export function activeMembership(db: LabDatabase, userId: string, classId: string, enrollmentId?: string) {
  const u = db.get("users", userId),
    c = db.get("classes", classId);
  if (!u || u.status !== "ACTIVE" || !c?.active) return undefined;
  return db
    .list("enrollments", "class_id=? AND user_id=?", [classId, userId])
    .find((e) => e.status === "ACTIVE" && (!enrollmentId || e.id === enrollmentId));
}
