import { backup } from "node:sqlite";
import { getDb, closeDb } from "./index";
const target = process.argv[2];
if (!target) throw new Error("Usage: backup /absolute/path/backup.sqlite");
backup(getDb().sql, target)
  .then(() => {
    console.log("SQLite online backup complete");
    closeDb();
  })
  .catch(() => {
    console.error("Backup failed");
    closeDb();
    process.exitCode = 1;
  });
