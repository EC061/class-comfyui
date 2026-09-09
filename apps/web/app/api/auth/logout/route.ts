import { NextRequest, NextResponse } from "next/server";
import { destroySessionByCookie, clearSessionCookie } from "@/lib/session";
import { requireOrigin } from "@/lib/origin";

export async function POST(req: NextRequest) {
  const blocked = requireOrigin(req);
  if (blocked) return blocked;
  destroySessionByCookie(req.headers.get("cookie"));
  const res = NextResponse.json({ ok: true });
  res.headers.set("Set-Cookie", clearSessionCookie());
  return res;
}
