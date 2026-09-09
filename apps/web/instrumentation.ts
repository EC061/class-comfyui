export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateStartup } = await import("@class-comfyui/config");
    validateStartup();
    const { getDb } = await import("@class-comfyui/database");
    getDb();
  }
}
