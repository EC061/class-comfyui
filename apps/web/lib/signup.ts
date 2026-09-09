import { hashToken, newSignupToken } from "@class-comfyui/auth";
import { getEnv, appUrl } from "@class-comfyui/config";
import { getDb, audit } from "@class-comfyui/database";
import { randomUUID } from "node:crypto";
export function generateSignupUrl(classId: string, actorId?: string) {
  const db = getDb();
  return db.transaction(() => {
    const c = db.get("classes", classId);
    if (!c) throw new Error("Class not found");
    const raw = newSignupToken();
    for (const t of db.list("signup_tokens", "class_id=?", [classId])) db.delete("signup_tokens", t.id);
    c.signupTokenVersion++;
    c.signupEnabled = true;
    c.updatedAt = new Date().toISOString();
    db.put("classes", c);
    db.put("signup_tokens", {
      id: randomUUID(),
      classId,
      tokenHash: hashToken(raw),
      version: c.signupTokenVersion,
      enabled: true,
      createdAt: c.updatedAt,
    });
    audit(c.signupTokenVersion === 1 ? "CLASS_SIGNUP_ENABLED" : "CLASS_SIGNUP_REGENERATED", {
      actorId,
      classId,
      targetId: classId,
    });
    return { url: appUrl(getEnv().PUBLIC_URL, `/signup/${c.slug}/${raw}`), raw, version: c.signupTokenVersion };
  });
}
export function validateSignupToken(slug: string, raw: string) {
  const db = getDb(),
    c = db.list("classes", "slug=?", [slug])[0];
  if (!c?.active || !c.signupEnabled) return { ok: false, reason: "Invalid or disabled signup link" };
  const t = db.list("signup_tokens", "class_id=? AND token_hash=?", [c.id, hashToken(raw)])[0];
  return t?.enabled && t.version === c.signupTokenVersion
    ? { ok: true, classId: c.id, version: t.version }
    : { ok: false, reason: "Invalid or revoked signup link" };
}
export function setSignupEnabled(classId: string, enabled: boolean, actorId?: string) {
  const db = getDb();
  return db.transaction(() => {
    const c = db.get("classes", classId);
    if (!c) throw new Error("Class not found");
    c.signupEnabled = enabled;
    c.updatedAt = new Date().toISOString();
    db.put("classes", c);
    audit(enabled ? "CLASS_SIGNUP_ENABLED" : "CLASS_SIGNUP_DISABLED", { actorId, classId, targetId: classId });
    return c;
  });
}
