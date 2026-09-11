import { getDb } from "@class-comfyui/database";
import { GRANTS_PATH, GrantSchema, type Grants } from "@class-comfyui/shared";

/** Grants for one student in one class. Absent or corrupt rows mean no grants. */
export function getGrants(userId: string, classId: string): Grants {
  const row = getDb().list("user_data", "user_id=? AND class_id=? AND path=?", [userId, classId, GRANTS_PATH])[0];
  if (!row?.content) return { h3Video: false };
  try {
    return GrantSchema.parse(JSON.parse(row.content));
  } catch {
    return { h3Video: false };
  }
}
