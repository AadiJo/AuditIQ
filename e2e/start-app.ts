import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { APP, HOST, ports } from "./env.ts";

// Starts AuditIQ the way a deployment does (built web app, production mode) with a fresh
// data directory and the replay runtime. Replay fixtures are copied into the data
// directory so tests can add failure fixtures without touching the repository.

const root = path.resolve(import.meta.dirname, "..");
const data = path.join(root, "e2e/.artifacts/data");
const replay = path.join(data, "replay");

fs.rmSync(data, { recursive: true, force: true });
fs.mkdirSync(replay, { recursive: true });
for (const file of fs.readdirSync(path.join(root, "e2e/fixtures/replay"))) {
  fs.copyFileSync(path.join(root, "e2e/fixtures/replay", file), path.join(replay, file));
}

execFileSync("pnpm", ["--filter", "@auditiq/web", "build"], { cwd: root, stdio: "inherit" });

const child = spawn("node", ["apps/server/src/index.ts"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "test",
    DATA_DIR: data,
    PORT: String(ports.app),
    HOST,
    BASE_URL: APP,
    AUDITIQ_REPLAY_DIR: replay,
    JIRA_POLL_SECONDS: "3600",
  },
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
