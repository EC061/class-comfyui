import { NextRequest, NextResponse } from "next/server";
import { store, audit } from "@/lib/store";
import { isAdmin, currentUser } from "@/lib/auth-helpers";
import { requireOrigin } from "@/lib/origin";
import { sendMail, signupInviteEmail } from "@/lib/mailer";
import { getEnv, appUrl } from "@class-comfyui/config";
import { hashToken } from "@class-comfyui/auth";

// NOTE: because only the signup token hash is stored, the server cannot re-render
// the original plain URL. The admin UI must keep the URL shown at generation time
// (or regenerate). For emailing, the admin posts the plain URL back; we verify it
// matches the stored hash before sending, so a stale/forged URL is rejected.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const cls = store.classes.get(params.id);
  if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let signupUrl: string | null = null;
  try {
    const j = await req.json();
    signupUrl = typeof j?.signupUrl === "string" ? j.signupUrl : null;
  } catch {
    signupUrl = null;
  }
  if (!signupUrl)
    return NextResponse.json({ error: "signupUrl (plain URL from Signup tab) is required" }, { status: 400 });
  // Verify the provided URL carries a currently-valid token for this class
  try {
    const u = new URL(signupUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const raw = parts[parts.length - 1] ?? "";
    const ok = store.signupTokens.some((t) => t.classId === cls.id && t.tokenHash === hashToken(raw) && t.enabled);
    if (!ok)
      return NextResponse.json(
        { error: "Provided signup URL is invalid or revoked. Regenerate and retry." },
        { status: 400 }
      );
  } catch {
    return NextResponse.json({ error: "Invalid signupUrl" }, { status: 400 });
  }
  const unregistered = [...store.enrollments.values()].filter(
    (e) => e.classId === cls.id && !e.userId && e.status !== "ARCHIVED"
  );
  const u = currentUser(req);
  let sent = 0;
  for (const e of unregistered) {
    await sendMail(signupInviteEmail(e.rosterEmail, `${cls.courseCode} — ${cls.term}`, signupUrl));
    sent++;
  }
  audit("INVITATIONS_SENT", { actorId: u?.id ?? null, classId: cls.id, targetId: cls.id, metadata: { count: sent } });
  return NextResponse.json({ ok: true, sent });
}
