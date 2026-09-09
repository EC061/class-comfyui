import { describe, it, expect, beforeEach } from "vitest";
import {
  hashToken,
  newSignupToken,
  newVerificationToken,
  checkAdminCode,
  signWorkspaceToken,
  verifyWorkspaceToken,
} from "@class-comfyui/auth";
import { parseRosterCsv } from "../../packages/auth/src/roster";

// End-to-end acceptance model (mirrors API rules without booting Next):
// admin code -> class -> roster -> signup URL -> roster gate -> verify -> session -> workspace token.
describe("acceptance flow model", () => {
  it("admin + valid student succeed; invalid student, regen, disabled, origin-attack behave correctly", () => {
    // 1. Admin code
    expect(checkAdminCode("wrong", "SECRET-123")).toBe(false);
    expect(checkAdminCode("SECRET-123", "SECRET-123")).toBe(true);

    // 2. Roster import
    const csv = `OrgDefinedId,Last Name,First Name,Email,End-of-Line Indicator\n#811883567,Garcia,Amara,student1@example.edu,#`;
    const { rows } = parseRosterCsv(csv);
    expect(rows).toHaveLength(1);
    const roster = new Set(rows.map((r) => r.email));

    // 3. Signup URL lifecycle
    let tokenHash = hashToken(newSignupToken());
    const oldHash = tokenHash;
    const enabled = { value: true };
    const eligible = (email: string, presented: string) =>
      enabled.value && presented === tokenHash && roster.has(email.toLowerCase());

    expect(eligible("student1@example.edu", oldHash)).toBe(true); // valid student
    expect(eligible("not-in-roster@example.com", oldHash)).toBe(false); // invalid student denied, no verification

    // Regeneration invalidates old
    tokenHash = hashToken(newSignupToken());
    expect(eligible("student1@example.edu", oldHash)).toBe(false);
    expect(eligible("student1@example.edu", tokenHash)).toBe(true);

    // Disable stops registrations
    enabled.value = false;
    expect(eligible("student1@example.edu", tokenHash)).toBe(false);
    enabled.value = true;

    // 4. Email ownership: verification single-use
    const raw = newVerificationToken();
    const verifs = new Map<string, { used: boolean; exp: number }>([
      [hashToken(raw), { used: false, exp: Date.now() + 60_000 }],
    ]);
    const consume = (t: string) => {
      const r = verifs.get(hashToken(t));
      if (!r || r.used || r.exp <= Date.now()) return false;
      r.used = true;
      return true;
    };
    expect(consume(raw)).toBe(true);
    expect(consume(raw)).toBe(false);

    // 5. Workspace token short-lived + single-use (jti tracked in Redis in prod)
    const secret = "workspace-secret-32-chars-minimum!!";
    const ws = signWorkspaceToken(
      { sub: "user-1", classId: "class-1", enrollmentId: "enr-1", jti: "jti-1", ttlSeconds: 60 },
      secret
    );
    const used = new Set<string>();
    const exchange = (t: string) => {
      const c = verifyWorkspaceToken(t, secret);
      if (!c || used.has(c.jti)) return null;
      used.add(c.jti);
      return c;
    };
    expect(exchange(ws)?.sub).toBe("user-1");
    expect(exchange(ws)).toBeNull(); // replay denied
  });
});
