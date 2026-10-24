import { describe, it, expect } from "vitest";
import {
  EmailSchema,
  PasswordSchema,
  ClassCreateSchema,
  WorkerCreateSchema,
  WorkerUpdateSchema,
  GrantSchema,
} from "@class-comfyui/shared";
import { getEnv } from "@class-comfyui/config";

describe("shared schemas", () => {
  it("normalizes and canonicalizes email addresses", () => {
    expect(EmailSchema.parse("  Student@UGA.View.USG.edu ")).toBe("student@uga.edu");
    expect(EmailSchema.parse("a+b@sub.example.edu")).toBe("a+b@sub.example.edu");
    for (const bad of ["", "a@b", ".a@b.co", "a..b@b.co", "a.@b.co", "a b@c.co", "a@[1.2.3.4]", "ü@b.co"])
      expect(EmailSchema.safeParse(bad).success, bad).toBe(false);
    expect(EmailSchema.safeParse(`${"a".repeat(310)}@example.edu`).success).toBe(false);
  });

  it("keeps the custom password messages and does not trim", () => {
    const r = PasswordSchema.safeParse("short");
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toBe("Password must be at least 12 characters");
    expect(PasswordSchema.safeParse("x".repeat(201)).error?.issues[0].message).toBe(
      "Password must be at most 200 characters"
    );
    expect(PasswordSchema.parse(" twelve chars ")).toBe(" twelve chars ");
  });

  it("applies class defaults and the kebab-case slug rule", () => {
    expect(ClassCreateSchema.parse({ name: "N", courseCode: "C", term: "T", slug: "a-b" }).description).toBe("");
    expect(
      ClassCreateSchema.safeParse({ name: "N", courseCode: "C", term: "T", slug: "A_B" }).error?.issues[0].message
    ).toBe("slug must be kebab-case");
  });

  it("fills worker defaults on create but never on update", () => {
    expect(WorkerCreateSchema.parse({ name: "GPU", baseUrl: "http://w:8188", vramMb: "12" })).toEqual({
      name: "GPU",
      baseUrl: "http://w:8188",
      enabled: true,
      gpuName: "",
      vramMb: 12,
      architecture: "",
      tags: [],
      maxConcurrentJobs: 1,
    });
    expect(WorkerUpdateSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(WorkerUpdateSchema.parse({})).toEqual({});
    expect(WorkerUpdateSchema.safeParse({ maxConcurrentJobs: 17 }).success).toBe(false);
    expect(WorkerUpdateSchema.safeParse({ baseUrl: "not a url" }).success).toBe(false);
  });

  it("falls back to no grants for malformed grant rows", () => {
    expect(GrantSchema.parse({})).toEqual({ h3Video: false });
    expect(GrantSchema.parse({ h3Video: true })).toEqual({ h3Video: true });
    expect(GrantSchema.parse({ h3Video: "yes" })).toEqual({ h3Video: false });
    expect(GrantSchema.parse(null)).toEqual({ h3Video: false });
  });
});

describe("environment schema", () => {
  const clean = {
    PUBLIC_URL: undefined,
    COMFY_PUBLIC_URL: undefined,
    SMTP_PORT: undefined,
    SMTP_FROM_EMAIL: undefined,
  };

  it("applies defaults for unset variables", () => {
    const env = getEnv(clean);
    expect(env.PUBLIC_URL).toBe("http://localhost:8080");
    expect(env.COMFY_PUBLIC_URL).toBe("http://comfy.localhost:8090");
    expect(env.SMTP_PORT).toBe(1025);
    expect(env.SMTP_FROM_EMAIL).toBe("noreply@example.edu");
  });

  it("coerces numbers and rejects non-positive values", () => {
    expect(getEnv({ ...clean, SMTP_PORT: "2525" }).SMTP_PORT).toBe(2525);
    expect(() => getEnv({ ...clean, SMTP_PORT: "0" })).toThrow();
    expect(() => getEnv({ ...clean, SMTP_PORT: "abc" })).toThrow();
    expect(() => getEnv({ ...clean, WORKSPACE_TOKEN_TTL_SECONDS: "61" })).toThrow();
  });

  it("accepts only bare HTTP(S) origins for public URLs", () => {
    expect(getEnv({ ...clean, PUBLIC_URL: "https://lab.example.edu/" }).PUBLIC_URL).toBe("https://lab.example.edu/");
    for (const bad of [
      "https://lab.example.edu/path",
      "https://u:p@lab.example.edu/",
      "https://lab.example.edu/?q=1",
      "ftp://lab.example.edu/",
      "not a url",
    ])
      expect(() => getEnv({ ...clean, PUBLIC_URL: bad }), bad).toThrow();
    expect(() => getEnv({ ...clean, SMTP_FROM_EMAIL: "nope" })).toThrow();
  });
});
