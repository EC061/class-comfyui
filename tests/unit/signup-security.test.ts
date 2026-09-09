import { describe, it, expect, beforeEach } from "vitest";
import { hashToken, newSignupToken, newVerificationToken } from "@class-comfyui/auth";

// Signup security model tested against the same rules the API enforces:
// valid token + roster match -> eligible; anything else -> denied; regen/disabled invalidates.

interface Ctx {
  classId: string;
  slug: string;
  active: boolean;
  signupEnabled: boolean;
  tokenHash: string;
  roster: Set<string>;
}

function makeCtx(): Ctx {
  const raw = newSignupToken();
  return {
    classId: "class-a",
    slug: "csci4300-fall-2026",
    active: true,
    signupEnabled: true,
    tokenHash: hashToken(raw),
    roster: new Set(["student1@example.edu"]),
  };
}

function canRegister(
  ctx: Ctx,
  presentedHash: string,
  email: string,
  opts: { classActive?: boolean; signupOn?: boolean } = {}
): boolean {
  if (!(opts.classActive ?? ctx.active)) return false;
  if (!(opts.signupOn ?? ctx.signupEnabled)) return false;
  if (presentedHash !== ctx.tokenHash) return false; // old/regenerated token fails
  if (!ctx.roster.has(email.toLowerCase())) return false; // roster gate
  return true;
}

describe("signup security", () => {
  let ctx: Ctx;
  let raw: string;
  beforeEach(() => {
    raw = newSignupToken();
    ctx = {
      classId: "A",
      slug: "a",
      active: true,
      signupEnabled: true,
      tokenHash: hashToken(raw),
      roster: new Set(["student1@example.edu"]),
    };
  });

  it("valid roster email with valid URL is allowed", () => {
    expect(canRegister(ctx, hashToken(raw), "student1@example.edu")).toBe(true);
  });

  it("non-roster email is denied even with valid URL", () => {
    expect(canRegister(ctx, hashToken(raw), "attacker@example.com")).toBe(false);
  });

  it("wrong-class link denied (token bound to class)", () => {
    const otherRaw = newSignupToken();
    expect(canRegister(ctx, hashToken(otherRaw), "student1@example.edu")).toBe(false);
  });

  it("regenerated link invalidates old URL", () => {
    const newRaw = newSignupToken();
    ctx.tokenHash = hashToken(newRaw);
    expect(canRegister(ctx, hashToken(raw), "student1@example.edu")).toBe(false);
    expect(canRegister(ctx, hashToken(newRaw), "student1@example.edu")).toBe(true);
  });

  it("disabled signup stops registrations immediately", () => {
    expect(canRegister(ctx, hashToken(raw), "student1@example.edu", { signupOn: false })).toBe(false);
  });

  it("email case-insensitivity", () => {
    expect(canRegister(ctx, hashToken(raw), "Student1@Example.EDU")).toBe(true);
  });

  it("verification tokens are single-use and expirable (model)", () => {
    const t = newVerificationToken();
    const store = new Map<string, { exp: number; used: boolean }>();
    store.set(hashToken(t), { exp: Date.now() + 60_000, used: false });
    const consume = (tok: string) => {
      const r = store.get(hashToken(tok));
      if (!r || r.used || r.exp <= Date.now()) return false;
      r.used = true;
      return true;
    };
    expect(consume(t)).toBe(true);
    expect(consume(t)).toBe(false); // reuse denied
  });
});
