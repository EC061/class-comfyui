import { getEnv, isAllowedBrowserOrigin, canonicalOrigin } from "@class-comfyui/config";
export function originCheck(req: Request) {
  const env = getEnv();
  return {
    expected: canonicalOrigin(env.PUBLIC_URL),
    ok: isAllowedBrowserOrigin({
      publicUrl: env.PUBLIC_URL,
      originHeader: req.headers.get("origin"),
      hostHeader: req.headers.get("host"),
      fetchSite: req.headers.get("sec-fetch-site"),
      referer: req.headers.get("referer"),
    }),
  };
}
export function requireOrigin(req: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return null;
  return originCheck(req).ok ? null : Response.json({ error: "Origin check failed" }, { status: 403 });
}
