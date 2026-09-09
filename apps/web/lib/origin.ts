import { NextRequest, NextResponse } from "next/server";
import { getEnv, canonicalOrigin, isAllowedBrowserOrigin } from "@class-comfyui/config";

/**
 * Strict origin enforcement for state-changing /api/* requests.
 * - Exact match of Origin header against new URL(PUBLIC_URL).origin
 * - No wildcard, no suffix/substring matching, no Host reflection
 * - Fallback to strict canonical-host check when Origin absent
 */
export function originCheck(req: NextRequest): { ok: boolean; expected: string } {
  const env = getEnv();
  const expected = canonicalOrigin(env.PUBLIC_URL);
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  const ok = isAllowedBrowserOrigin({
    publicUrl: env.PUBLIC_URL,
    originHeader: origin,
    hostHeader: host,
  });
  return { ok, expected };
}

export function requireOrigin(req: NextRequest): NextResponse | null {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  const { ok, expected } = originCheck(req);
  if (!ok) {
    return NextResponse.json({ error: `Origin check failed. Expected ${expected}.` }, { status: 403 });
  }
  return null;
}

export function corsHeaders(publicUrl: string): Record<string, string> {
  // Only the canonical origin, never * with credentials.
  return {
    "Access-Control-Allow-Origin": canonicalOrigin(publicUrl),
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  };
}
