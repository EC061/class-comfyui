import { NextRequest, NextResponse } from "next/server";
import { STRIPPED_IDENTITY_HEADERS } from "@class-comfyui/shared";

const SESSION_COOKIE = "comfy_session";

/**
 * Two jobs: drop forged identity headers before anything reads them, and turn
 * obviously unauthenticated page requests around without rendering.
 *
 * The cookie check here is a shortcut, not the authorization boundary — a cookie's
 * presence proves nothing. Every guarded page re-checks the session and the role
 * on the server, and the API checks both again on every request.
 */
export function proxy(req: NextRequest) {
  const headers = new Headers(req.headers);
  for (const name of STRIPPED_IDENTITY_HEADERS) headers.delete(name);
  const isApi = req.nextUrl.pathname.startsWith("/api");
  if (!isApi && !req.cookies.get(SESSION_COOKIE)) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/api/:path*", "/admin/:path*", "/jobs/:path*"] };
