import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    env: { GATEWAY_RUN: "0", NODE_ENV: "test" },
  },
  resolve: {
    alias: {
      "@class-comfyui/database": new URL("./packages/database/src/index.ts", import.meta.url).pathname,
      "@class-comfyui/config": new URL("./packages/config/src/index.ts", import.meta.url).pathname,
      "@class-comfyui/shared": new URL("./packages/shared/src/index.ts", import.meta.url).pathname,
      "@class-comfyui/auth": new URL("./packages/auth/src/index.ts", import.meta.url).pathname,
    },
  },
});
