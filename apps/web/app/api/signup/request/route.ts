import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hashToken, newVerificationToken } from "@class-comfyui/auth";
import { canonicalEmail } from "@class-comfyui/shared";
import { getEnv } from "@class-comfyui/config";
import { store } from "@/lib/store";
import { sendMail, verificationEmail, buildVerifyLink } from "@/lib/mailer";
import { requireOrigin } from "@/lib/origin";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { validateSignupToken } from "@/lib/signup";

const Body = z.object({
  email: z.string().min(3).max(320),
  classSlug: z.string().min(1),
  signupToken: z.string().min(8),
  firstName: z.string().max(100).optional().default(""),
  lastName: z.string().max(100).optional().default(""),
});

export async function POST(req: NextRequest) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  const env = getEnv();
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const ip = clientIp(req.headers);
  if (!checkRateLimit("signup", `${ip}:${body.classSlug}`, 10, 60_000)) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  }
  const email = canonicalEmail(body.email);
  const v = validateSignupToken(body.classSlug, body.signupToken);
  if (!v.ok) return NextResponse.json({ error: v.reason ?? "Invalid signup link" }, { status: 403 });
  const eligible = [...store.enrollments.values()].find(
    (e) => e.classId === v.classId && e.rosterEmail === email && e.status !== "ARCHIVED"
  );
  if (!eligible) return NextResponse.json({ error: "This email is not eligible for this class." }, { status: 403 });
  const raw = newVerificationToken();
  store.verifications.set(hashToken(raw), {
    email,
    tokenHash: hashToken(raw),
    purpose: "SIGNUP",
    classId: v.classId!,
    enrollmentId: eligible.id,
    isAdmin: false,
    adminCodeVerified: false,
    firstName: body.firstName,
    lastName: body.lastName,
    expiresAt: Date.now() + env.VERIFICATION_TTL_MINUTES * 60_000,
    consumedAt: null,
  });
  await sendMail(verificationEmail(email, buildVerifyLink(raw, email)));
  return NextResponse.json({
    ok: true,
    message: "Check your email for a verification link.",
    devLink: process.env.NODE_ENV === "production" ? undefined : buildVerifyLink(raw, email),
  });
}
