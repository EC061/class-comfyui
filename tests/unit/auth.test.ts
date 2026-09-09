import { describe, it, expect } from "vitest";
import {
  hashToken,
  randomToken,
  newSignupToken,
  signWorkspaceToken,
  verifyWorkspaceToken,
  checkAdminCode,
} from "@class-comfyui/auth";

describe("auth primitives", () => {
  it("tokens are random, hashed at rest, sufficient entropy", () => {
    const t = newSignupToken();
    const raw = Buffer.from(t, "base64url");
    expect(raw.length).toBeGreaterThanOrEqual(16); // >=128 bits
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(randomToken()).not.toBe(randomToken());
  });

  it("workspace tokens verify, expire, and reject tampering", () => {
    const secret = "test-secret-12345678901234567890";
    const tok = signWorkspaceToken({ sub: "u1", classId: "c1", enrollmentId: "e1", jti: "j1", ttlSeconds: 60 }, secret);
    expect(verifyWorkspaceToken(tok, secret)?.sub).toBe("u1");
    expect(verifyWorkspaceToken(tok + "x", secret)).toBeNull();
    expect(verifyWorkspaceToken(tok, "wrong-secret")).toBeNull();
    const expired = signWorkspaceToken(
      { sub: "u1", classId: "c1", enrollmentId: "e1", jti: "j2", ttlSeconds: -1 },
      secret
    );
    expect(verifyWorkspaceToken(expired, secret)).toBeNull();
  });

  it("admin code check is exact", () => {
    expect(checkAdminCode("correct-horse", "correct-horse")).toBe(true);
    expect(checkAdminCode("wrong", "correct-horse")).toBe(false);
    expect(checkAdminCode("", "correct-horse")).toBe(false);
  });
});
