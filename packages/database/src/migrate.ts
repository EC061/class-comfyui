import { getDb, closeDb } from "./index";
getDb();
console.log("SQLite schema ready (WAL, foreign keys, FULL synchronous).");
closeDb();
