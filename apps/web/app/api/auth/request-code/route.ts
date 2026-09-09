import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hashToken, newVerificationToken, checkAdminCode } from "@class-comfyui/auth";
import { canonicalEmail } from "@class-comfyui/shared";
import { getEnv } from "@class-comfyui/config";
import { store, audit } from "@/lib/store";
import { sendMail, verificationEmail, buildVerifyLink } from "@/lib/mailer";
import { requireOrigin } from "@/lib/origin";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { validateSignupToken } from "@/lib/signup";

const Body = z.object({
  email: z.string().min(3).max(320),
  classSlug: z.string().optional(),
  signupToken: z.string().optional(),
  isAdmin: z.boolean().optional().default(false),
  adminCode: z.string().optional().default(""),
  firstName: z.string().max(100).optional().default(""),
  lastName: z.string().max(100).optional().default(""),
});

export async function POST(req: NextRequest) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  const env = getEnv();
  const ip = clientIp(req.headers);
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const email = canonicalEmail(body.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }
  if (!checkRateLimit("login", `${ip}:${email}`, 10, 60_000)) {
    return NextResponse.json({ error: "Rate limited. Try again shortly." }, { status: 429 });
  }

  // Admin registration path
  if (body.isAdmin) {
    if (!checkRateLimit("admin-register", ip, 10, 60_000)) {
      return NextResponse.json({ error: "Rate limited" }, { status: 429 });
    }
    if (!checkAdminCode(body.adminCode, env.ADMIN_REGISTRATION_CODE)) {
      audit("ADMIN_REGISTER_ATTEMPT_FAILED", { metadata: { email } });
      return NextResponse.json({ error: "Incorrect admin registration code" }, { status: 403 });
    }
    const raw = newVerificationToken();
    store.verifications.set(hashToken(raw), {
      email,
      tokenHash: hashToken(raw),
      purpose: "ADMIN_REGISTER",
      classId: null,
      enrollmentId: null,
      isAdmin: true,
      adminCodeVerified: true,
      firstName: body.firstName,
      lastName: body.lastName,
      expiresAt: Date.now() + env.VERIFICATION_TTL_MINUTES * 60_000,
      consumedAt: null,
    });
    const link = buildVerifyLink(raw, email);
    await sendMail(verificationEmail(email, link));
    return NextResponse.json({
      ok: true,
      message: "Verification email sent",
      devLink: process.env.NODE_ENV === "production" ? undefined : link,
    });
  }

  // Student path: roster-restricted.
  // Two modes: class-scoped signup token, or direct email (preferred: activate all eligible memberships).
  let classId: string | null = null;
  if (body.classSlug && body.signupToken) {
    const v = validateSignupToken(body.classSlug, body.signupToken);
    if (!v.ok) return NextResponse.json({ error: v.reason ?? "Invalid signup link" }, { status: 403 });
    classId = v.classId!;
    // Roster gate: must have ACTIVE-eligible enrollment (INVITED or ACTIVE, not ARCHIVED) in this class
    const eligible = [...store.enrollments.values()].find(
      (e) => e.classId === classId && e.rosterEmail === email && e.status !== "ARCHIVED"
    );
    if (!eligible) {
      // Do NOT reveal roster. Generic denial, no verification sent.
      return NextResponse.json(
        { error: "This email is not eligible for this class. Contact your instructor." },
        { status: 403 }
      );
    }
    const cls = store.classes.get(classId);
    if (!cls || !cls.active) return NextResponse.json({ error: "Class is not active" }, { status: 403 });
  } else {
    // Direct registration: must appear in at least one active, signup-enabled class roster
    const eligible = [...store.enrollments.values()].filter((e) => {
      if (e.rosterEmail !== email || e.status === "ARCHIVED") return false;
      const c = store.classes.get(e.classId);
      return !!c && c.active && c.signupEnabled;
    });
    if (eligible.length === 0) {
      return NextResponse.json(
        { error: "No eligible class found for this email. Use your class signup link." },
        { status: 403 }
      );
    }
  }

  const raw = newVerificationToken();
  store.verifications.set(hashToken(raw), {
    email,
    tokenHash: hashToken(raw),
    purpose: "SIGNUP",
    classId,
    enrollmentId: null,
    isAdmin: false,
    adminCodeVerified: false,
    firstName: body.firstName,
    lastName: body.lastName,
    expiresAt: Date.now() + env.VERIFICATION_TTL_MINUTES * 60_000,
    consumedAt: null,
  });
  const link = buildVerifyLink(raw, email);
  await sendMail(verificationEmail(email, link));
  return NextResponse.json({
    ok: true,
    message: "Verification email sent",
    devLink: process.env.NODE_ENV === "production" ? undefined : link,
  });
}
