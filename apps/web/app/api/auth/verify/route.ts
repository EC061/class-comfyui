import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hashToken } from "@class-comfyui/auth";
import { canonicalEmail } from "@class-comfyui/shared";
import { store, audit } from "@/lib/store";
import { createSession, sessionCookieValue } from "@/lib/session";
import { requireOrigin } from "@/lib/origin";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { randomUUID } from "node:crypto";

const Body = z.object({
  email: z.string().min(3).max(320),
  token: z.string().min(10).max(200),
});

export async function POST(req: NextRequest) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  const ip = clientIp(req.headers);
  if (!checkRateLimit("verify", ip, 20, 60_000)) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  }
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const email = canonicalEmail(body.email);
  const h = hashToken(body.token);
  const row = store.verifications.get(h);
  if (!row || row.email !== email) {
    return NextResponse.json({ error: "Invalid or expired code" }, { status: 400 });
  }
  if (row.consumedAt) return NextResponse.json({ error: "Code already used" }, { status: 400 });
  if (row.expiresAt <= Date.now()) return NextResponse.json({ error: "Code expired" }, { status: 400 });
  row.consumedAt = Date.now();

  // Find or create global user (never duplicate)
  let user = store.usersByEmail.get(email);
  if (user && user.status === "DISABLED") {
    return NextResponse.json({ error: "Account disabled" }, { status: 403 });
  }
  if (!user) {
    user = {
      id: randomUUID(),
      email,
      firstName: row.firstName || "",
      lastName: row.lastName || "",
      emailVerifiedAt: new Date().toISOString(),
      status: "ACTIVE",
      globalRole: row.isAdmin ? "ADMIN" : "STUDENT",
      lastLoginAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    // Enrich names from roster if available
    const rosterMatch = [...store.enrollments.values()].find((e) => e.rosterEmail === email);
    if (rosterMatch) {
      if (!user.firstName) user.firstName = rosterMatch.firstName;
      if (!user.lastName) user.lastName = rosterMatch.lastName;
    }
    store.users.set(user.id, user);
    store.usersByEmail.set(email, user);
    if (row.isAdmin) audit("ADMIN_REGISTERED", { actorId: user.id, targetId: user.id, metadata: {} });
  } else {
    user.emailVerifiedAt = user.emailVerifiedAt ?? new Date().toISOString();
    user.lastLoginAt = new Date().toISOString();
    if (row.isAdmin && user.globalRole !== "ADMIN") {
      user.globalRole = "ADMIN";
      audit("ADMIN_REGISTERED", { actorId: user.id, targetId: user.id, metadata: {} });
    }
  }

  // Activate enrollments:
  if (row.classId) {
    const e = [...store.enrollments.values()].find(
      (x) => x.classId === row.classId && x.rosterEmail === email && x.status !== "ARCHIVED"
    );
    if (!e) return NextResponse.json({ error: "Enrollment no longer eligible" }, { status: 403 });
    e.userId = user.id;
    if (e.status === "INVITED") e.status = "ACTIVE";
  } else if (!row.isAdmin) {
    // Direct flow: activate all eligible memberships
    for (const e of store.enrollments.values()) {
      if (e.rosterEmail !== email || e.status !== "INVITED") continue;
      const c = store.classes.get(e.classId);
      if (c && c.active && c.signupEnabled) {
        e.userId = user.id;
        e.status = "ACTIVE";
      }
    }
  }

  const sess = createSession(user.id);
  const res = NextResponse.json({ ok: true, role: user.globalRole, userId: user.id });
  res.headers.set("Set-Cookie", sessionCookieValue(sess.raw, sess.expiresAt));
  return res;
}
