import { describe, it, expect } from "vitest";
import { isAllowedBrowserOrigin, canonicalOrigin } from "@class-comfyui/config";

const PUBLIC_URL = "https://comfy-admin.example.edu";

describe("strict origin enforcement", () => {
  it("derives allowed origin from PUBLIC_URL", () => {
    expect(canonicalOrigin(PUBLIC_URL)).toBe("https://comfy-admin.example.edu");
  });

  it("accepts exact origin", () => {
    expect(
      isAllowedBrowserOrigin({
        publicUrl: PUBLIC_URL,
        originHeader: "https://comfy-admin.example.edu",
        hostHeader: "comfy-admin.example.edu",
      })
    ).toBe(true);
  });

  it.each([
    "https://evil.example.com",
    "http://comfy-admin.example.edu",
    "https://comfy-admin.example.edu.evil.com",
    "https://sub.comfy-admin.example.edu",
    "https://comfy-admin.example.edu:8443",
    "https://COMFY-ADMIN.EXAMPLE.EDU",
  ])("rejects %s", (origin) => {
    expect(
      isAllowedBrowserOrigin({ publicUrl: PUBLIC_URL, originHeader: origin, hostHeader: "comfy-admin.example.edu" })
    ).toBe(false);
  });

  it("does not use suffix or substring matching", () => {
    expect(
      isAllowedBrowserOrigin({
        publicUrl: PUBLIC_URL,
        originHeader: "https://notcomfy-admin.example.edu",
        hostHeader: "x",
      })
    ).toBe(false);
  });

  it("requires same-origin fetch metadata and referer when Origin absent", () => {
    expect(
      isAllowedBrowserOrigin({
        publicUrl: PUBLIC_URL,
        originHeader: null,
        hostHeader: "comfy-admin.example.edu",
        fetchSite: "same-origin",
        referer: PUBLIC_URL + "/dashboard",
      })
    ).toBe(true);
    expect(isAllowedBrowserOrigin({ publicUrl: PUBLIC_URL, originHeader: null, hostHeader: "evil.example.com" })).toBe(
      false
    );
  });
});
