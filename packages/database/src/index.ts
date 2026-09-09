export * from "./schema.js";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

const { Pool } = pg;

let pool: InstanceType<typeof Pool> | null = null;
let dbInstance: ReturnType<typeof drizzlePg<typeof schema>> | null = null;

export function getPool(databaseUrl: string) {
  if (!pool) {
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
  }
  return pool;
}

export function getDb(databaseUrl: string) {
  if (!dbInstance) {
    dbInstance = drizzlePg(getPool(databaseUrl), { schema });
  }
  return dbInstance;
}

export type Database = ReturnType<typeof getDb>;

/** Lazy DB accessor that throws a clear error when DATABASE_URL is placeholder. */
export function requireDb(): Database {
  const url = process.env.DATABASE_URL ?? "";
  if (!url || url.includes("CHANGE_ME")) {
    throw new Error("DATABASE_URL is not configured");
  }
  return getDb(url);
}
