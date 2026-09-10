import fsp from "node:fs/promises";
import path from "node:path";
import { getDb, audit, type ClassRow } from "@class-comfyui/database";
import { getEnv } from "@class-comfyui/config";
import { sanitizePathSegment } from "@class-comfyui/shared";

export interface PurgeResult {
  slug: string;
  rows: Record<string, number>;
  filesDeleted: number;
  directoriesDeleted: number;
  /** Paths the filesystem refused to release. The database rows are already gone. */
  failures: string[];
}

/** A class with work in flight cannot be deleted: the scheduler would race the purge. */
export class ActiveJobsError extends Error {
  constructor(readonly count: number) {
    super(`${count} job(s) are still queued, running or being archived. Cancel or wait for them, then delete.`);
  }
}

function under(base: string, candidate: string) {
  const root = path.resolve(base),
    target = path.resolve(candidate);
  return target !== root && target.startsWith(root + path.sep);
}

/**
 * Irreversibly removes a class: every class-scoped row, then every archived
 * output and staged input on disk.
 *
 * Rows go first, inside one transaction, so a crash can never leave the database
 * pointing at files that are already gone. Files are removed afterwards because
 * the repository forbids awaiting inside a write transaction; a filesystem
 * failure is therefore reported rather than rolled back.
 */
export async function purgeClass(classId: string, actorId: string): Promise<PurgeResult | null> {
  const db = getDb(),
    env = getEnv();
  const plan = db.transaction(() => {
    const cls: ClassRow | undefined = db.get("classes", classId);
    if (!cls) return null;
    // Archival streams output files in from the worker outside any transaction, so
    // a job still being archived would write files back after the purge.
    const active = db.list(
      "jobs",
      "class_id=? AND (status IN ('QUEUED','DISPATCHING','RUNNING') OR json_extract(data,'$.archiveStatus')='ARCHIVING')",
      [classId]
    );
    if (active.length) throw new ActiveJobsError(active.length);

    const files = new Set<string>();
    for (const o of db.list("outputs", "job_id IN (SELECT id FROM jobs WHERE class_id=?)", [classId]))
      files.add(o.storagePath);
    const uploads = db.list("uploads", "class_id=?", [classId]);
    for (const u of uploads) files.add(u.storagePath);

    const directories = new Set<string>();
    // Archive layout is AUDIT_DATA_DIR/<class slug>/<student id>/…; the slug is
    // immutable, and the class id is the fallback storage.ts uses without one.
    directories.add(path.resolve(env.AUDIT_DATA_DIR, sanitizePathSegment(cls.slug || classId)));
    directories.add(path.resolve(env.AUDIT_DATA_DIR, sanitizePathSegment(classId)));
    // Staged inputs are UPLOAD_DATA_DIR/<user id>/<class id>/…, so they are per
    // student and cannot be reached from the class directory alone.
    for (const userId of new Set([
      ...uploads.map((u) => u.userId),
      ...db
        .list("enrollments", "class_id=?", [classId])
        .map((e) => e.userId)
        .filter((v): v is string => !!v),
    ]))
      directories.add(path.resolve(env.UPLOAD_DATA_DIR, userId, classId));

    const rows: Record<string, number> = {
      outputs: db.deleteWhere("outputs", "job_id IN (SELECT id FROM jobs WHERE class_id=?)", [classId]),
      jobs: db.deleteWhere("jobs", "class_id=?", [classId]),
      user_data: db.deleteWhere("user_data", "class_id=?", [classId]),
      uploads: db.deleteWhere("uploads", "class_id=?", [classId]),
      invitations: db.deleteWhere("invitations", "class_id=?", [classId]),
      roster_import_rows: db.deleteWhere(
        "roster_import_rows",
        "import_id IN (SELECT id FROM roster_imports WHERE class_id=?)",
        [classId]
      ),
      roster_imports: db.deleteWhere("roster_imports", "class_id=?", [classId]),
      workspace_tickets: db.deleteWhere("workspace_tickets", "class_id=?", [classId]),
      signup_tokens: db.deleteWhere("signup_tokens", "class_id=?", [classId]),
      audits: db.deleteWhere("audits", "class_id=?", [classId]),
      // Neither table carries a class_id column; both hold one in their document.
      gateway_sessions: db.deleteWhere("gateway_sessions", "json_extract(data,'$.classId')=?", [classId]),
      verifications: db.deleteWhere("verifications", "json_extract(data,'$.classId')=?", [classId]),
      enrollments: db.deleteWhere("enrollments", "class_id=?", [classId]),
      classes: db.deleteWhere("classes", "id=?", [classId]),
    };
    // The class no longer exists, so this record cannot reference it: the deletion
    // itself is retained as the acting administrator's action, not class history.
    audit("CLASS_DELETED", {
      actorId,
      targetId: classId,
      metadata: { slug: cls.slug, name: cls.name, courseCode: cls.courseCode, term: cls.term, rows },
    });
    return { cls, rows, files: [...files], directories: [...directories] };
  });
  if (!plan) return null;

  const failures: string[] = [];
  let filesDeleted = 0,
    directoriesDeleted = 0;
  for (const file of plan.files) {
    if (!under(env.AUDIT_DATA_DIR, file) && !under(env.UPLOAD_DATA_DIR, file)) continue;
    try {
      await fsp.rm(file, { force: true });
      filesDeleted++;
    } catch {
      failures.push(file);
    }
  }
  for (const dir of plan.directories) {
    if (!under(env.AUDIT_DATA_DIR, dir) && !under(env.UPLOAD_DATA_DIR, dir)) continue;
    if (!(await fsp.stat(dir).catch(() => null))) continue;
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      directoriesDeleted++;
      // Leave no empty per-student upload directory behind. A non-empty parent
      // belongs to that student's other classes, so this failing is expected.
      // Never climb to a configured base directory: other classes still use it.
      const parent = path.dirname(dir);
      if (under(env.AUDIT_DATA_DIR, parent) || under(env.UPLOAD_DATA_DIR, parent))
        await fsp.rmdir(parent).catch(() => {});
    } catch {
      failures.push(dir);
    }
  }
  return { slug: plan.cls.slug, rows: plan.rows, filesDeleted, directoriesDeleted, failures };
}
