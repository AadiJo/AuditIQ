import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeAuth, Usage } from "@auditiq/shared";
import { paths } from "../env.ts";
import {
  type AgentRuntime,
  type RuntimeRequest,
  type RuntimeResult,
  type RuntimeStatus,
  RuntimeUnavailableError,
} from "./types.ts";

const exec = promisify(execFile);

/** The Claude Code binary the Agent SDK ships for this platform. Status checks use the same binary runs do. */
function bundledBinary(): string | null {
  try {
    const sdkEntry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
    const require = createRequire(sdkEntry);
    const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    for (const name of [base, `${base}-musl`]) {
      try {
        const dir = path.dirname(require.resolve(`${name}/package.json`));
        return path.join(dir, process.platform === "win32" ? "claude.exe" : "claude");
      } catch {
        // Try the next libc variant.
      }
    }
  } catch {
    // Fall through to null: the SDK will locate its own binary at run time.
  }
  return null;
}

type Auth = { mode: "cli"; account: string | null } | { mode: "api-key"; apiKey: string };

/**
 * Runs analyses through the Claude Agent SDK with every tool disabled, no host settings,
 * and an empty working directory, so the model only sees the prompt AuditIQ builds.
 * Auth prefers the host's `claude` login and falls back to an Anthropic API key.
 */
export class ClaudeRuntime implements AgentRuntime {
  readonly id = "claude" as const;
  private readonly binary = bundledBinary();

  private readonly apiKey: () => string | null;

  constructor(apiKey: () => string | null) {
    this.apiKey = apiKey;
  }

  private async cliLogin(): Promise<{ loggedIn: boolean; account: string | null }> {
    if (!this.binary) return { loggedIn: false, account: null };
    const env = { ...process.env };
    // An API key in the environment makes Claude Code report and use the key instead of the login.
    delete env.ANTHROPIC_API_KEY;
    try {
      const { stdout } = await exec(this.binary, ["auth", "status", "--json"], { env, timeout: 15_000 });
      const status = JSON.parse(stdout) as { loggedIn?: boolean; email?: string; authMethod?: string };
      return { loggedIn: status.loggedIn === true, account: status.email ?? status.authMethod ?? null };
    } catch {
      return { loggedIn: false, account: null };
    }
  }

  private async resolveAuth(): Promise<Auth> {
    const cli = await this.cliLogin();
    if (cli.loggedIn) return { mode: "cli", account: cli.account };
    const apiKey = this.apiKey();
    if (apiKey) return { mode: "api-key", apiKey };
    throw new RuntimeUnavailableError(
      "Claude isn't signed in. Run `claude login` on the server, or add an Anthropic API key in Settings.",
    );
  }

  async status(): Promise<RuntimeStatus> {
    try {
      const auth = await this.resolveAuth();
      return {
        id: this.id,
        ready: true,
        auth: auth.mode,
        account: auth.mode === "cli" ? auth.account : null,
        detail: auth.mode === "cli" ? "Using the Claude login on this server." : "Using an Anthropic API key.",
      };
    } catch (error) {
      return { id: this.id, ready: false, auth: null, account: null, detail: (error as Error).message };
    }
  }

  async run(request: RuntimeRequest): Promise<RuntimeResult> {
    const auth = await this.resolveAuth();
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "auditiq/0.1" };
    if (auth.mode === "cli") delete env.ANTHROPIC_API_KEY;
    else env.ANTHROPIC_API_KEY = auth.apiKey;

    const abortController = new AbortController();
    const abort = () => abortController.abort();
    request.signal.addEventListener("abort", abort, { once: true });

    let outputChars = 0;
    const live: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: null };
    let stderr = "";

    try {
      const messages = query({
        prompt: request.prompt,
        options: {
          model: request.model,
          effort: request.effort,
          systemPrompt: request.system,
          outputFormat: { type: "json_schema", schema: request.schema },
          tools: [],
          skills: [],
          settingSources: [],
          strictMcpConfig: true,
          permissionMode: "dontAsk",
          persistSession: false,
          includePartialMessages: true,
          maxTurns: 4,
          cwd: paths.scratch,
          env,
          abortController,
          ...(this.binary ? { pathToClaudeCodeExecutable: this.binary } : {}),
          stderr: (chunk) => {
            stderr = `${stderr}${chunk}`.slice(-4000);
          },
        },
      });

      for await (const message of messages) {
        if (message.type === "stream_event") {
          const event = message.event;
          if (event.type === "message_start") {
            const u = event.message.usage;
            live.inputTokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            live.cachedInputTokens = u.cache_read_input_tokens ?? 0;
          } else if (event.type === "message_delta") {
            live.outputTokens = event.usage.output_tokens;
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") outputChars += event.delta.text.length;
            else if (event.delta.type === "input_json_delta") outputChars += event.delta.partial_json.length;
            else continue;
          } else {
            continue;
          }
          request.onProgress?.({ outputChars, usage: { ...live } });
          continue;
        }

        if (message.type !== "result") continue;
        if (message.subtype !== "success") {
          throw new Error(`Claude stopped early (${message.subtype}): ${message.errors.join(" ") || "no details"}`);
        }
        if (message.is_error) throw new Error(`Claude returned an error: ${message.result}`);

        const usage: Usage = {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          costUsd: message.total_cost_usd,
        };
        for (const model of Object.values(message.modelUsage)) {
          usage.inputTokens += model.inputTokens + model.cacheReadInputTokens + model.cacheCreationInputTokens;
          usage.cachedInputTokens += model.cacheReadInputTokens;
          usage.outputTokens += model.outputTokens;
          usage.reasoningTokens += model.thinkingTokens ?? 0;
        }
        const output = message.structured_output ?? JSON.parse(message.result);
        return { output, usage, auth: auth.mode satisfies RuntimeAuth };
      }
      throw new Error("Claude ended without a result.");
    } catch (error) {
      if (request.signal.aborted) throw new Error("The run was cancelled.");
      const detail = stderr.trim() ? ` (${stderr.trim().split("\n").slice(-3).join(" ")})` : "";
      throw error instanceof Error ? new Error(`${error.message}${detail}`, { cause: error }) : error;
    } finally {
      request.signal.removeEventListener("abort", abort);
    }
  }
}
