import { getDb } from "@class-comfyui/database";
import { GRANTS_PATH, GrantSchema, type Grants } from "@class-comfyui/shared";

/**
 * Effective grants for a workspace session:
 *  1. Administrators always have every starter workflow unlocked.
 *  2. An explicit per-enrollment `h3Video` boolean (set before or after signup) wins.
 *  3. Otherwise a class-wide `h3Video: true` enables H3 for every student in the class.
 *  4. Legacy per-user `__grants__` rows in `user_data` remain supported as a fallback.
 */
export function getGrants(userId: string, classId: string, enrollmentId?: string): Grants {
  const db = getDb(),
    u = db.get("users", userId),
    c = db.get("classes", classId);
  if (u?.globalRole === "ADMIN" || c?.system) return { h3Video: true };
  const e = enrollmentId
    ? db.get("enrollments", enrollmentId)
    : db.list("enrollments", "class_id=? AND user_id=?", [classId, userId]).find((v) => v.status !== "ARCHIVED");
  if (typeof e?.h3Video === "boolean") return { h3Video: e.h3Video };
  if (c?.h3Video) return { h3Video: true };
  const row = db.list("user_data", "user_id=? AND class_id=? AND path=?", [userId, classId, GRANTS_PATH])[0];
  if (!row?.content) return { h3Video: false };
  try {
    return GrantSchema.parse(JSON.parse(row.content));
  } catch {
    return { h3Video: false };
  }
}
