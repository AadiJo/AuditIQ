import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

// Boot configuration. Everything else (Jira, runtimes, watcher) lives in the settings table
// and is edited in the UI, so a fresh install only needs DATA_DIR to be writable.
const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATA_DIR: z.string().default(".data"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(5180),
  /** Public URL users open. Used for auth cookies and invite links. */
  BASE_URL: z.string().url().optional(),
  /** Encrypts stored secrets and signs sessions. Generated into DATA_DIR when unset. */
  AUDITIQ_SECRET: z.string().min(32).optional(),
  /** Fallback credentials when no CLI login exists on the host. */
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  /** Test only: serve recorded runtime output from this directory instead of calling a model. */
  AUDITIQ_REPLAY_DIR: z.string().optional(),
  /** Dev only: save every real runtime response to this directory as a replay fixture. */
  AUDITIQ_RECORD_DIR: z.string().optional(),
  JIRA_POLL_SECONDS: z.coerce.number().int().min(10).default(60),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(25),
  /** Directory with the built web app. Served when present. */
  WEB_DIST: z.string().optional(),
});

const parsed = Env.parse(process.env);
const dataDir = path.resolve(parsed.DATA_DIR);
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

function loadSecret(): string {
  if (parsed.AUDITIQ_SECRET) return parsed.AUDITIQ_SECRET;
  const file = path.join(dataDir, "secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const secret = randomBytes(32).toString("base64url");
  fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

export const env = {
  ...parsed,
  DATA_DIR: dataDir,
  BASE_URL: parsed.BASE_URL ?? `http://localhost:${parsed.PORT}`,
  AUDITIQ_SECRET: loadSecret(),
  isProduction: parsed.NODE_ENV === "production",
};

export const paths = {
  database: path.join(dataDir, "auditiq.sqlite"),
  files: path.join(dataDir, "files"),
  scratch: path.join(dataDir, "scratch"),
  codexHome: path.join(dataDir, "codex-home"),
  backups: path.join(dataDir, "backups"),
};
for (const dir of [paths.files, paths.scratch, paths.codexHome]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
