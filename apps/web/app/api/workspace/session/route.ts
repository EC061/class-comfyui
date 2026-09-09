import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { signWorkspaceToken } from "@class-comfyui/auth";
import { getEnv, comfyUrl } from "@class-comfyui/config";
import { store } from "@/lib/store";
import { currentUser } from "@/lib/auth-helpers";
import { requireOrigin } from "@/lib/origin";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

const Body = z.object({ classId: z.string().min(1) });

export async function POST(req: NextRequest) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  const user = currentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkRateLimit("workspace", `${clientIp(req.headers)}:${user.id}`, 20, 60_000)) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  }
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "classId required" }, { status: 400 });
  }
  const cls = store.classes.get(body.classId);
  if (!cls || !cls.active) return NextResponse.json({ error: "Class not active" }, { status: 403 });
  const enrollment = [...store.enrollments.values()].find(
    (e) => e.classId === body.classId && (e.userId === user.id || e.rosterEmail === user.email) && e.status === "ACTIVE"
  );
  if (!enrollment) return NextResponse.json({ error: "No active enrollment" }, { status: 403 });

  const env = getEnv();
  const jti = randomUUID();
  const token = signWorkspaceToken(
    { sub: user.id, classId: cls.id, enrollmentId: enrollment.id, jti, ttlSeconds: env.WORKSPACE_TOKEN_TTL_SECONDS },
    env.WORKSPACE_JWT_SECRET
  );
  store.workspaceJtis.set(jti, Date.now() + env.WORKSPACE_TOKEN_TTL_SECONDS * 1000);
  const redirect = comfyUrl(env.COMFY_PUBLIC_URL, `/auth/exchange?token=${encodeURIComponent(token)}`);
  return NextResponse.json({ url: redirect });
}
