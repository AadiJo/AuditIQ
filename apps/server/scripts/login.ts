import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Signs the bundled Claude or Codex CLI in on this machine, so AuditIQ can use that login
// instead of an API key. In Docker, HOME points at the data volume, so the login survives
// container restarts.
//
//   pnpm cli-login claude
//   pnpm cli-login codex

const which = process.argv[2];

function claudeBinary(): string {
  const require = createRequire(fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk")));
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const name of [base, `${base}-musl`]) {
    try {
      return path.join(path.dirname(require.resolve(`${name}/package.json`)), "claude");
    } catch {
      // Try the next libc variant.
    }
  }
  throw new Error("The Claude binary for this platform isn't installed.");
}

function codexBinary(): string {
  const triples: Record<string, string> = {
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
  };
  const key = `${process.platform}-${process.arch}`;
  const require = createRequire(fileURLToPath(import.meta.resolve("@openai/codex/package.json")));
  const dir = path.dirname(require.resolve(`@openai/codex-${key}/package.json`));
  return path.join(dir, "vendor", triples[key] ?? "", "bin", "codex");
}

const command =
  which === "claude"
    ? { bin: claudeBinary(), args: ["auth", "login"] }
    : which === "codex"
      ? { bin: codexBinary(), args: ["login", "--device-auth"] }
      : null;
if (!command) {
  console.error("Usage: login claude | login codex");
  process.exit(1);
}
const result = spawnSync(command.bin, command.args, { stdio: "inherit" });
process.exit(result.status ?? 1);
