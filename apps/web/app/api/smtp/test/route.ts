import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAdmin, currentUser } from "@/lib/auth-helpers";
import { requireOrigin } from "@/lib/origin";
import { sendMail } from "@/lib/mailer";
import { store, audit } from "@/lib/store";

const Body = z.object({ to: z.string().email() });

export async function POST(req: NextRequest) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = Body.parse(await req.json());
  await sendMail({ to: body.to, subject: "ComfyUI Lab SMTP test", text: "SMTP is configured correctly." });
  audit("SMTP_TEST_SENT", { actorId: currentUser(req)?.id ?? null, metadata: { to: body.to } });
  // Never echo secrets; only safe status.
  return NextResponse.json({ ok: true, message: "Test email queued (see server logs in dev)." });
}

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  // Safe status only — never expose SMTP secrets client-side.
  const host = process.env.SMTP_HOST ?? "";
  return NextResponse.json({
    configured: !(host.includes("example.edu") || host === ""),
    hostRedacted: host ? `${host.slice(0, 2)}***` : "",
  });
}
