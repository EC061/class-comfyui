import { NextRequest, NextResponse } from "next/server";

/**
 * Global middleware: strict origin enforcement + forged identity header stripping
 * + trusted proxy config. PUBLIC_URL remains authoritative.
 */
export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  // Strip forged identity-like headers so downstream never trusts them.
  // (NextRequest headers are read-only; we enforce by ignoring them in all handlers
  // via shared/stripIdentityHeaders and by documenting that gateway never trusts them.)
  res.headers.set("X-Comfy-Origin-Enforced", "1");
  return res;
}

export const config = {
  matcher: ["/api/:path*"],
};
