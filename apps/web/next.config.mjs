/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  transpilePackages: [
    "@class-comfyui/auth",
    "@class-comfyui/config",
    "@class-comfyui/shared",
    "@class-comfyui/database",
  ],
  experimental: {
    serverActions: { bodySizeLimit: "5mb" },
    // Resolve ESM-style `.js` relative imports to their `.ts` sources
    // inside workspace packages (gateway `tsc` requires explicit `.js`).
    extensionAlias: { ".js": [".ts", ".tsx"] },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
