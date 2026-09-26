import fs from "node:fs/promises";
import path from "node:path";
import type { Effort, RuntimeId } from "@auditiq/shared";
import { unseal } from "../crypto.ts";
import { env } from "../env.ts";
import { getSetting } from "../settings.ts";
import { ClaudeRuntime } from "./claude.ts";
import { CodexRuntime } from "./codex/runtime.ts";
import { type ReplayFixture, ReplayRuntime } from "./replay.ts";
import type { AgentRuntime } from "./types.ts";

// Stored keys win over environment keys so an admin can change them without a restart.
function apiKey(id: RuntimeId): () => string | null {
  return () => {
    const stored = getSetting("runtime")[id].apiKey;
    const fromSettings = stored ? unseal(stored) : null;
    return fromSettings ?? (id === "claude" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY) ?? null;
  };
}

/** Wraps a runtime so each response is also saved as a replay fixture named after the run label. */
function recording(inner: AgentRuntime, dir: string): AgentRuntime {
  return {
    id: inner.id,
    status: () => inner.status(),
    async run(request) {
      const progress: ReplayFixture["progress"] = [];
      let last = Date.now();
      const result = await inner.run({
        ...request,
        onProgress: (p) => {
          progress.push({ delayMs: Math.min(Date.now() - last, 400), outputChars: p.outputChars });
          last = Date.now();
          request.onProgress?.(p);
        },
      });
      const fixture: ReplayFixture = {
        progress: progress.filter((_, i) => i % 5 === 0),
        output: result.output,
        usage: result.usage,
      };
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${request.label}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
      return result;
    },
  };
}

function build(): Record<RuntimeId, AgentRuntime> {
  if (env.AUDITIQ_REPLAY_DIR) {
    return {
      claude: new ReplayRuntime("claude", env.AUDITIQ_REPLAY_DIR),
      codex: new ReplayRuntime("codex", env.AUDITIQ_REPLAY_DIR),
    };
  }
  const real: Record<RuntimeId, AgentRuntime> = {
    claude: new ClaudeRuntime(apiKey("claude")),
    codex: new CodexRuntime(apiKey("codex")),
  };
  const dir = env.AUDITIQ_RECORD_DIR;
  return dir ? { claude: recording(real.claude, dir), codex: recording(real.codex, dir) } : real;
}

const runtimes = build();

export function runtime(id: RuntimeId): AgentRuntime {
  return runtimes[id];
}

export function allRuntimes(): AgentRuntime[] {
  return Object.values(runtimes);
}

/** Picks the runtime, model, and effort for a run: the admin's defaults unless an allowed override applies. */
export function runtimeChoice(override?: RuntimeId): { runtime: AgentRuntime; model: string; effort: Effort } {
  const settings = getSetting("runtime");
  const id = override && settings.allowOverride ? override : settings.default;
  return { runtime: runtimes[id], model: settings[id].model, effort: settings[id].effort };
}
