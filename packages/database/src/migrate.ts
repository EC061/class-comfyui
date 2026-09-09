import { sql } from "drizzle-orm";
import { getPool } from "./index.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL required");
  const pool = getPool(databaseUrl);
  // Simple idempotent DDL (kept in code so `migrate` command works without drizzle-kit output).
  // For production, drizzle-kit migrations under ./drizzle are preferred; this ensures deploy works.
  const ddlPath = path.join(__dirname, "ddl.sql");
  let ddl = "";
  if (fs.existsSync(ddlPath)) {
    ddl = fs.readFileSync(ddlPath, "utf8");
  } else {
    ddl = await import("./ddl-inline.js").then((m) => m.DDL).catch(() => "");
  }
  if (!ddl) {
    console.log("No DDL found; running drizzle-kit push is recommended. Creating minimal tables via raw SQL...");
  }
  if (ddl) {
    await pool.query(ddl);
    console.log("Migration applied.");
  }
  await pool.end();
}

migrate().catch((e) => {
  console.error(e);
  process.exit(1);
});
