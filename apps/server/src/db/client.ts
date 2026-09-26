import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { paths } from "../env.ts";
import * as schema from "./schema.ts";

const sqlite = new Database(paths.database);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");
for (const file of [paths.database, `${paths.database}-wal`, `${paths.database}-shm`]) {
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
}

export const db = drizzle(sqlite, { schema, casing: "snake_case" });
export type Db = typeof db;
/** The raw handle, for online backups. */
export const sqliteHandle = sqlite;

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/** Applies pending migrations. Called once at boot before anything touches the database. */
export function migrateDatabase(): void {
  migrate(db, { migrationsFolder });
}

/** Runs `operation` in an immediate transaction. better-sqlite3 transactions are synchronous. */
export function transaction<T>(operation: (tx: Db) => T): T {
  return db.transaction((tx) => operation(tx as unknown as Db), { behavior: "immediate" });
}
