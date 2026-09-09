import { NextRequest, NextResponse } from "next/server";
export function proxy(req: NextRequest) {
  const headers = new Headers(req.headers);
  for (const name of ["comfy-user", "x-user-id", "x-admin", "x-class-id", "x-role"]) headers.delete(name);
  return NextResponse.next({ request: { headers } });
}
export const config = { matcher: ["/api/:path*"] };
