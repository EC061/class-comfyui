import { describe, it, expect } from "vitest";
import { sanitizePathSegment, stripIdentityHeaders } from "@class-comfyui/shared";

describe("security helpers", () => {
  it("strips forged identity headers", () => {
    const out = stripIdentityHeaders({
      "Content-Type": "application/json",
      "X-User-Id": "attacker",
      "comfy-user": "x",
      "X-ADMIN": "true",
      "x-class-id": "y",
      "X-Role": "ADMIN",
    });
    expect(out).toEqual({ "Content-Type": "application/json" });
  });

  it("sanitizes audit path segments (no traversal, no names as identity)", () => {
    expect(sanitizePathSegment("../../etc")).not.toContain("..");
    expect(sanitizePathSegment("John Doe")).toBe("john-doe");
    expect(sanitizePathSegment("..")).toBe("unknown");
  });
});
