import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// scrypt is in the Node standard library, so password storage adds no dependency
// and no native build step. Parameters are stored with each hash, so raising the
// cost later re-verifies old passwords without invalidating them.
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;
const COST = { N: 32768, r: 8, p: 1 };
const KEY_BYTES = 64;
const SALT_BYTES = 16;
// scrypt needs 128*N*r bytes; Node's default 32 MB maxmem is below what N=32768 asks for.
const memory = (N: number, r: number) => 256 * N * r;

/** Never accept an unbounded work factor from stored data: it would be a memory DoS. */
function acceptableCost(N: number, r: number, p: number) {
  return (
    Number.isInteger(N) &&
    Number.isInteger(r) &&
    Number.isInteger(p) &&
    N >= 16384 &&
    N <= 262144 &&
    (N & (N - 1)) === 0 &&
    r >= 1 &&
    r <= 16 &&
    p >= 1 &&
    p <= 4
  );
}

/** `scrypt$N$r$p$salt$key`, all base64url. Safe to store and to log as a shape. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password.normalize("NFKC"), salt, KEY_BYTES, {
    ...COST,
    maxmem: memory(COST.N, COST.r),
  });
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Constant-time verification. An empty or malformed stored hash always fails. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = (stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]),
    r = Number(parts[2]),
    p = Number(parts[3]);
  if (!acceptableCost(N, r, p)) return false;
  const salt = Buffer.from(parts[4], "base64url"),
    expected = Buffer.from(parts[5], "base64url");
  if (salt.length < 8 || expected.length < 16) return false;
  const key = await scrypt(password.normalize("NFKC"), salt, expected.length, { N, r, p, maxmem: memory(N, r) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** True when an account exists but has no usable password (pre-password migration). */
export function hasPassword(stored: string | undefined | null): boolean {
  return typeof stored === "string" && stored.startsWith("scrypt$");
}
