import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { env, paths } from "../src/env.ts";

// Online backup: a consistent SQLite snapshot plus the uploaded files, written to
// DATA_DIR/backups/<timestamp>. Safe to run while the server is up. Copy the folder
// somewhere else (another disk, encrypted storage) to survive losing the machine.

const destination = path.join(paths.backups, new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(destination, { recursive: true, mode: 0o700 });

const database = new Database(paths.database, { readonly: true, fileMustExist: true });
try {
  await database.backup(path.join(destination, "auditiq.sqlite"));
} finally {
  database.close();
}
await fs.cp(paths.files, path.join(destination, "files"), { recursive: true, preserveTimestamps: true });
await fs.writeFile(
  path.join(destination, "manifest.json"),
  `${JSON.stringify({ createdAt: new Date().toISOString(), dataDir: env.DATA_DIR, includes: ["auditiq.sqlite", "files"] }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(destination);
