import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/store";
import { isAdmin, currentUser } from "@/lib/auth-helpers";
import { requireOrigin } from "@/lib/origin";
import { generateSignupUrl, setSignupEnabled } from "@/lib/signup";
import { getEnv, appUrl } from "@class-comfyui/config";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const cls = store.classes.get(params.id);
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const tokens = store.signupTokens.filter((t) => t.classId === cls.id);
  const active = tokens.find((t) => t.enabled);
  const enrolled = [...store.enrollments.values()].filter((e) => e.classId === cls.id);
  return NextResponse.json({
    signupEnabled: cls.signupEnabled,
    hasActiveToken: !!active,
    // Plain URL not recoverable (only hash stored) — UI shows it right after generation/regeneration.
    version: cls.signupTokenVersion,
    registered: enrolled.filter((e) => e.userId && e.status === "ACTIVE").length,
    remaining: enrolled.filter((e) => !e.userId).length,
    tokenCreatedAt: active?.createdAt ?? null,
  });
}

// Regenerate: POST -> immediately invalidates previous URL
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const cls = store.classes.get(params.id);
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const u = currentUser(req);
  const { url, version } = generateSignupUrl(cls.id, u?.id ?? undefined);
  return NextResponse.json({ url, version, signupEnabled: true }, { status: 201 });
}

const PatchBody = z.object({ enabled: z.boolean() });

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const cls = store.classes.get(params.id);
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = PatchBody.parse(await req.json());
  const u = currentUser(req);
  setSignupEnabled(cls.id, body.enabled, u?.id ?? undefined);
  return NextResponse.json({ signupEnabled: cls.signupEnabled });
}
