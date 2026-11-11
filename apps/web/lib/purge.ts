import fsp from "node:fs/promises";
import path from "node:path";
import { getDb, audit, type ClassRow, type Enrollment } from "@class-comfyui/database";
import { getEnv } from "@class-comfyui/config";
import { canonicalEmail, sanitizePathSegment } from "@class-comfyui/shared";

export interface PurgeResult {
  slug: string;
  rows: Record<string, number>;
  filesDeleted: number;
  directoriesDeleted: number;
  /** Paths the filesystem refused to release. The database rows are already gone. */
  failures: string[];
}

export interface EnrollmentPurgeResult {
  enrollmentId: string;
  rosterEmail: string;
  rows: Record<string, number>;
  filesDeleted: number;
  directoriesDeleted: number;
  failures: string[];
}

/** Work in flight cannot be deleted: the scheduler or archiver would race the purge. */
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

async function removeFilesAndDirs(
  files: string[],
  directories: string[],
  env: { AUDIT_DATA_DIR: string; UPLOAD_DATA_DIR: string },
  climbLevels = 1
) {
  const failures: string[] = [];
  let filesDeleted = 0,
    directoriesDeleted = 0;
  for (const file of files) {
    if (!under(env.AUDIT_DATA_DIR, file) && !under(env.UPLOAD_DATA_DIR, file)) continue;
    try {
      await fsp.rm(file, { force: true });
      filesDeleted++;
    } catch {
      failures.push(file);
    }
  }
  for (const dir of directories) {
    if (!under(env.AUDIT_DATA_DIR, dir) && !under(env.UPLOAD_DATA_DIR, dir)) continue;
    if (!(await fsp.stat(dir).catch(() => null))) continue;
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      directoriesDeleted++;
      let parent = path.dirname(dir);
      for (let i = 0; i < climbLevels; i++) {
        if (!under(env.AUDIT_DATA_DIR, parent) && !under(env.UPLOAD_DATA_DIR, parent)) break;
        const removed = await fsp
          .rmdir(parent)
          .then(() => true)
          .catch(() => false);
        if (!removed) break;
        parent = path.dirname(parent);
      }
    } catch {
      failures.push(dir);
    }
  }
  return { filesDeleted, directoriesDeleted, failures };
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
    if (!cls || cls.system) return null;
    // Archival streams output files in from the worker outside any transaction, so
    // a job still being archived would write files back after the purge.
    const active = db.list(
      "jobs",
      "class_id=? AND (status IN ('QUEUED','DISPATCHING','RUNNING') OR (status='COMPLETED' AND json_extract(data,'$.archiveStatus') IN ('PENDING','ARCHIVING')) OR json_extract(data,'$.archiveStatus')='ARCHIVING')",
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

  const { filesDeleted, directoriesDeleted, failures } = await removeFilesAndDirs(plan.files, plan.directories, env, 1);
  return { slug: plan.cls.slug, rows: plan.rows, filesDeleted, directoriesDeleted, failures };
}

/**
 * Removes a single student enrollment from a class along with any jobs, outputs,
 * staged inputs, saved workflows, invitations, and workspace sessions belonging to
 * that student in that class. The student's global user account (if registered)
 * survives so other classes and audit actor foreign keys remain intact.
 */
export async function purgeEnrollment(
  classId: string,
  enrollmentId: string,
  actorId: string
): Promise<EnrollmentPurgeResult | null> {
  const db = getDb(),
    env = getEnv();
  const plan = db.transaction(() => {
    const actor = db.get("users", actorId);
    if (actor?.globalRole !== "ADMIN" || actor.status !== "ACTIVE") return "FORBIDDEN" as const;
    const cls: ClassRow | undefined = db.get("classes", classId);
    if (!cls || cls.system) return null;
    const e: Enrollment | undefined = db.get("enrollments", enrollmentId);
    if (!e || e.classId !== classId || e.role === "ADMIN") return null;

    const active = db.list(
      "jobs",
      "enrollment_id=? AND (status IN ('QUEUED','DISPATCHING','RUNNING') OR (status='COMPLETED' AND json_extract(data,'$.archiveStatus') IN ('PENDING','ARCHIVING')) OR json_extract(data,'$.archiveStatus')='ARCHIVING')",
      [enrollmentId]
    );
    if (active.length) throw new ActiveJobsError(active.length);

    const files = new Set<string>();
    const directories = new Set<string>();
    const jobs = db.list("jobs", "enrollment_id=?", [enrollmentId]);
    for (const o of db.list("outputs", "job_id IN (SELECT id FROM jobs WHERE enrollment_id=?)", [enrollmentId])) {
      files.add(o.storagePath);
    }
    for (const j of jobs) {
      const date = new Date(j.submittedAt);
      directories.add(
        path.resolve(
          env.AUDIT_DATA_DIR,
          sanitizePathSegment(cls.slug || j.classId),
          sanitizePathSegment(j.orgDefinedId || j.userId),
          String(date.getUTCFullYear()),
          String(date.getUTCMonth() + 1).padStart(2, "0"),
          String(date.getUTCDate()).padStart(2, "0"),
          j.id
        )
      );
    }

    // Include both the currently linked userId and any userId from historical jobs on
    // this enrollment (e.g. if a roster re-import previously changed the row's email),
    // excluding any user who still holds another enrollment in this class.
    const purgeableUserIds = [
      ...new Set([e.userId, ...jobs.map((j) => j.userId)].filter((v): v is string => !!v)),
    ].filter(
      (uid) => !db.list("enrollments", "class_id=? AND user_id=?", [classId, uid]).some((v) => v.id !== enrollmentId)
    );

    for (const uid of purgeableUserIds) {
      for (const u of db.list("uploads", "user_id=? AND class_id=?", [uid, classId])) {
        files.add(u.storagePath);
      }
      directories.add(path.resolve(env.UPLOAD_DATA_DIR, uid, classId));
    }

    let verificationsDeleted = 0;
    const targetEmail = canonicalEmail(e.rosterEmail);
    for (const v of db.list("verifications", "json_extract(data,'$.classId')=?", [classId])) {
      if (v.enrollmentIds.includes(enrollmentId) || canonicalEmail(v.email) === targetEmail) {
        db.delete("verifications", v.id);
        verificationsDeleted++;
      }
    }

    let userDataDeleted = 0;
    let uploadsDeleted = 0;
    for (const uid of purgeableUserIds) {
      userDataDeleted += db.deleteWhere("user_data", "user_id=? AND class_id=?", [uid, classId]);
      uploadsDeleted += db.deleteWhere("uploads", "user_id=? AND class_id=?", [uid, classId]);
    }

    const invitationsDeleted = db.deleteWhere("invitations", "class_id=? AND lower(json_extract(data,'$.email'))=?", [
      classId,
      targetEmail,
    ]);

    const rows: Record<string, number> = {
      outputs: db.deleteWhere("outputs", "job_id IN (SELECT id FROM jobs WHERE enrollment_id=?)", [enrollmentId]),
      jobs: db.deleteWhere("jobs", "enrollment_id=?", [enrollmentId]),
      user_data: userDataDeleted,
      uploads: uploadsDeleted,
      invitations: invitationsDeleted,
      gateway_sessions: db.deleteWhere("gateway_sessions", "json_extract(data,'$.enrollmentId')=?", [enrollmentId]),
      workspace_tickets: db.deleteWhere("workspace_tickets", "json_extract(data,'$.enrollmentId')=?", [enrollmentId]),
      verifications: verificationsDeleted,
      enrollments: db.deleteWhere("enrollments", "id=?", [enrollmentId]),
    };

    audit("ENROLLMENT_DELETED", {
      actorId,
      classId,
      targetId: enrollmentId,
      metadata: {
        rosterEmail: e.rosterEmail,
        orgDefinedId: e.orgDefinedId,
        userId: e.userId,
        rows,
      },
    });

    return { e, rows, files: [...files], directories: [...directories] };
  });

  if (plan === "FORBIDDEN") throw new Error("FORBIDDEN");
  if (!plan) return null;

  const { filesDeleted, directoriesDeleted, failures } = await removeFilesAndDirs(plan.files, plan.directories, env, 5);
  return {
    enrollmentId: plan.e.id,
    rosterEmail: plan.e.rosterEmail,
    rows: plan.rows,
    filesDeleted,
    directoriesDeleted,
    failures,
  };
}
