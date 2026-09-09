import { hashToken, newSignupToken } from "@class-comfyui/auth";
import { getEnv, appUrl } from "@class-comfyui/config";
import { store, audit } from "./store";
import { randomUUID } from "node:crypto";

/** Generate (or regenerate) a class signup URL. Stores only the hash. Regeneration revokes old tokens. */
export function generateSignupUrl(classId: string, actorId?: string): { url: string; raw: string; version: number } {
  const env = getEnv();
  const cls = store.classes.get(classId);
  if (!cls) throw new Error("Class not found");
  const raw = newSignupToken();
  const version = cls.signupTokenVersion + 1;
  cls.signupTokenVersion = version;
  cls.signupEnabled = true;
  cls.updatedAt = new Date().toISOString();
  // Revoke previous
  for (const t of store.signupTokens) {
    if (t.classId === classId && t.enabled) {
      t.enabled = false;
      t.revokedAt = new Date().toISOString();
    }
  }
  store.signupTokens.push({
    classId,
    tokenHash: hashToken(raw),
    version,
    enabled: true,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  });
  const url = appUrl(env.PUBLIC_URL, `/signup/${cls.slug}/${raw}`);
  audit("CLASS_SIGNUP_REGENERATED", { actorId: actorId ?? null, classId, targetId: classId, metadata: { version } });
  return { url, raw, version };
}

export function getActiveSignupUrl(classId: string): string | null {
  // Plain token is NOT recoverable from DB (only hash stored).
  // We intentionally return null here; UI must use the just-generated URL or regenerate.
  // Documented secure behavior.
  return null;
}

/** Validate a presented signup token for a class slug. */
export function validateSignupToken(
  classSlug: string,
  rawToken: string
): { ok: boolean; classId?: string; reason?: string } {
  const cls = store.classesBySlug.get(classSlug);
  if (!cls) return { ok: false, reason: "Unknown class" };
  if (!cls.active) return { ok: false, reason: "Class is archived" };
  if (!cls.signupEnabled) return { ok: false, reason: "Signup is disabled" };
  const h = hashToken(rawToken);
  const found = store.signupTokens.find((t) => t.classId === cls.id && t.tokenHash === h && t.enabled);
  if (!found) return { ok: false, reason: "Invalid or revoked signup link" };
  return { ok: true, classId: cls.id };
}

export function setSignupEnabled(classId: string, enabled: boolean, actorId?: string) {
  const cls = store.classes.get(classId);
  if (!cls) throw new Error("Class not found");
  cls.signupEnabled = enabled;
  cls.updatedAt = new Date().toISOString();
  audit(enabled ? "CLASS_SIGNUP_ENABLED" : "CLASS_SIGNUP_DISABLED", {
    actorId: actorId ?? null,
    classId,
    targetId: classId,
  });
}
