import { createHash, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalEmail } from "@class-comfyui/shared";

/** SHA-256 hex of a token for storage (tokens stored hashed at rest). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Cryptographically random token, url-safe base64 (default 32 bytes = 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Signup tokens: at least 128 bits (16 bytes). We use 24 bytes (192 bits). */
export function newSignupToken(): string {
  return randomToken(24);
}

/** Email verification code: 6-digit numeric + random token for magic link. */
export function newVerificationToken(): string {
  return randomToken(32);
}

export function newSessionToken(): string {
  return randomToken(32);
}

export function newWorkspaceJti(): string {
  return randomToken(16);
}

export function constantTimeEqualHex(aHex: string, bHex: string): boolean {
  try {
    const a = Buffer.from(aHex, "hex");
    const b = Buffer.from(bHex, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---- Minimal HS256 JWT for workspace tokens (no external dep) ----

function b64urlEncode(input: Buffer | string): string {
  return Buffer.from(input as never).toString("base64url");
}
function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

export interface WorkspaceClaims {
  sub: string; // userId
  classId: string;
  enrollmentId: string;
  jti: string;
  iat: number;
  exp: number;
  iss: string;
}

export function signWorkspaceToken(
  claims: Omit<WorkspaceClaims, "iat" | "exp" | "iss"> & { ttlSeconds: number },
  secret: string
): string {
  const now = Math.floor(Date.now() / 1000);
  const { ttlSeconds, ...rest } = claims;
  const full: WorkspaceClaims = {
    ...rest,
    iat: now,
    exp: now + ttlSeconds,
    iss: "class-comfyui",
  };
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64urlEncode(JSON.stringify(full));
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

export function verifyWorkspaceToken(token: string, secret: string): WorkspaceClaims | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
    const a = Buffer.from(s);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(b64urlDecode(p).toString("utf8")) as WorkspaceClaims;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) return null;
    if (payload.iss !== "class-comfyui") return null;
    if (!payload.sub || !payload.classId || !payload.jti) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- Admin registration code check (constant-time, never logged/stored) ----
export function checkAdminCode(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // still do a dummy compare to avoid length oracle timing differences
    const dummy = createHmac("sha256", "dummy").update(provided).digest();
    const dummy2 = createHmac("sha256", "dummy").update(expected).digest();
    try {
      timingSafeEqual(dummy, dummy2);
    } catch {
      /* ignore */
    }
    return false;
  }
  return timingSafeEqual(a, b);
}

// ---- Simple in-memory rate limiter (production uses Redis wrapper in web/lib) ----
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimitCheck(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  const cur = buckets.get(key);
  if (!cur || now >= cur.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, resetMs: windowMs };
  }
  if (cur.count >= limit) {
    return { allowed: false, remaining: 0, resetMs: cur.resetAt - now };
  }
  cur.count += 1;
  return { allowed: true, remaining: limit - cur.count, resetMs: cur.resetAt - now };
}

export function resetRateLimits() {
  buckets.clear();
}

export { canonicalEmail };
export * from "./roster";
