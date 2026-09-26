import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Usage } from "@auditiq/shared";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { sha256 } from "../../crypto.ts";
import { paths } from "../../env.ts";
import {
  type AgentRuntime,
  type RuntimeRequest,
  type RuntimeResult,
  type RuntimeStatus,
  RuntimeUnavailableError,
} from "../types.ts";
import { CodexAppServer } from "./client.ts";
import type { Account, Notifications, TokenUsageBreakdown } from "./protocol.ts";

// USD per million tokens, from https://openai.com/api/pricing/. Used for an estimate only;
// unknown models report no cost.
const pricing: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-5.5": { input: 5, cached: 0.5, output: 30 },
};

const triples: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

/** The codex binary pinned by the @openai/codex package, so protocol types match. */
function bundledBinary(): string {
  const key = `${process.platform}-${process.arch}`;
  const triple = triples[key];
  if (!triple) throw new RuntimeUnavailableError(`Codex doesn't ship a binary for ${key}.`);
  const require = createRequire(fileURLToPath(import.meta.resolve("@openai/codex/package.json")));
  const platformPackage = path.dirname(require.resolve(`@openai/codex-${key}/package.json`));
  return path.join(platformPackage, "vendor", triple, "bin", process.platform === "win32" ? "codex.exe" : "codex");
}

// Analysis runs need no tools, so every feature that can act or read outside the prompt is
// off. Runs also get a private CODEX_HOME, which keeps the host's AGENTS.md, MCP servers,
// hooks, and plugins out of AuditIQ prompts. Only the host's model provider carries over,
// because a CLI login is only useful together with the provider it authenticates against.
const isolatedConfig = {
  approval_policy: "never",
  sandbox_mode: "read-only",
  web_search: "disabled",
  features: {
    shell_tool: false,
    unified_exec: false,
    apps: false,
    plugins: false,
    browser_use: false,
    computer_use: false,
    in_app_browser: false,
    image_generation: false,
    view_image: false,
    multi_agent: false,
    memories: false,
  },
};

type HostProvider = { name: string; table: Record<string, unknown>; envKey: string | null };

/** The model provider the host's Codex is configured for, when it isn't OpenAI's default. */
function hostProvider(hostHome: string): HostProvider | null {
  try {
    const config = parseToml(fs.readFileSync(path.join(hostHome, "config.toml"), "utf8"));
    const name = config.model_provider;
    const providers = config.model_providers;
    if (typeof name !== "string" || !providers || typeof providers !== "object") return null;
    const table = (providers as Record<string, unknown>)[name];
    if (!table || typeof table !== "object") return null;
    const envKey = (table as { env_key?: unknown }).env_key;
    return { name, table: table as Record<string, unknown>, envKey: typeof envKey === "string" ? envKey : null };
  } catch {
    return null;
  }
}

type Connection = { server: CodexAppServer; auth: "cli" | "api-key"; account: Account | null };

export class CodexRuntime implements AgentRuntime {
  readonly id = "codex" as const;
  private statusCache: { at: number; status: RuntimeStatus } | null = null;

  private readonly apiKey: () => string | null;

  constructor(apiKey: () => string | null) {
    this.apiKey = apiKey;
  }

  private hostHome(): string {
    return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  }

  private prepareHome(name: "cli" | "api-key"): string {
    const home = path.join(paths.codexHome, name);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const provider = name === "cli" ? hostProvider(this.hostHome()) : null;
    const config = provider
      ? { ...isolatedConfig, model_provider: provider.name, model_providers: { [provider.name]: provider.table } }
      : isolatedConfig;
    fs.writeFileSync(
      path.join(home, "config.toml"),
      `# Written by AuditIQ before each run.\n${stringifyToml(config)}\n`,
      { mode: 0o600 },
    );
    if (name === "cli") {
      // Share the host login by linking its auth.json. Codex refreshes tokens in place, so
      // the host CLI and AuditIQ keep using the same credentials.
      const link = path.join(home, "auth.json");
      const target = path.join(this.hostHome(), "auth.json");
      if (fs.existsSync(target) && !fs.existsSync(link)) fs.symlinkSync(target, link);
    }
    return home;
  }

  /** Starts app-server. `providerKey` is the host provider's key variable, the one secret it may see. */
  private async spawn(home: string, providerKey: string | null = null): Promise<CodexAppServer> {
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
    // Codex authenticates through CODEX_HOME. Nothing else secret belongs in its environment.
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "AUDITIQ_SECRET"]) {
      if (key !== providerKey) delete env[key];
    }
    const server = new CodexAppServer(bundledBinary(), env);
    try {
      await server.initialize();
      return server;
    } catch (error) {
      server.close();
      throw error;
    }
  }

  /** Connects with the host login when one exists, otherwise with an OpenAI API key. */
  private async connect(): Promise<Connection> {
    const provider = hostProvider(this.hostHome());
    if (provider?.envKey && !process.env[provider.envKey]) {
      throw new RuntimeUnavailableError(
        `This server's Codex uses the "${provider.name}" provider, which reads ${provider.envKey}, but that variable isn't set for AuditIQ.`,
      );
    }
    if (provider || fs.existsSync(path.join(this.hostHome(), "auth.json"))) {
      const server = await this.spawn(this.prepareHome("cli"), provider?.envKey ?? null);
      try {
        const { account, requiresOpenaiAuth } = await server.request("account/read", {});
        if (account || !requiresOpenaiAuth) return { server, auth: "cli", account };
      } catch (error) {
        server.close();
        throw new RuntimeUnavailableError(`Codex couldn't use the login on this server: ${(error as Error).message}`);
      }
      server.close();
    }

    const apiKey = this.apiKey();
    if (!apiKey) {
      throw new RuntimeUnavailableError(
        "Codex isn't signed in. Run `codex login` on the server, or add an OpenAI API key in Settings.",
      );
    }
    const home = this.prepareHome("api-key");
    const marker = path.join(home, ".auditiq-key");
    const server = await this.spawn(home);
    let { account } = await server.request("account/read", {});
    const keyHash = sha256(apiKey);
    if (!account || !fs.existsSync(marker) || fs.readFileSync(marker, "utf8") !== keyHash) {
      await server.request("account/login/start", { type: "apiKey", apiKey });
      fs.writeFileSync(marker, keyHash, { mode: 0o600 });
      ({ account } = await server.request("account/read", {}));
    }
    if (!account) {
      server.close();
      throw new RuntimeUnavailableError("Codex rejected the OpenAI API key.");
    }
    return { server, auth: "api-key", account };
  }

  async status(): Promise<RuntimeStatus> {
    if (this.statusCache && Date.now() - this.statusCache.at < 60_000) return this.statusCache.status;
    let status: RuntimeStatus;
    try {
      const { server, auth, account } = await this.connect();
      server.close();
      status = {
        id: this.id,
        ready: true,
        auth,
        account: account?.type === "chatgpt" ? account.email : null,
        detail: auth === "cli" ? "Using the Codex login on this server." : "Using an OpenAI API key.",
      };
    } catch (error) {
      status = { id: this.id, ready: false, auth: null, account: null, detail: (error as Error).message };
    }
    this.statusCache = { at: Date.now(), status };
    return status;
  }

  async run(request: RuntimeRequest): Promise<RuntimeResult> {
    const { server, auth } = await this.connect();
    let outputChars = 0;
    let finalText = "";
    let streamedText = "";
    let usage: TokenUsageBreakdown | null = null;
    let threadId = "";
    let turnId = "";

    const toUsage = (u: TokenUsageBreakdown | null): Usage => {
      const price = pricing[request.model];
      const input = u?.inputTokens ?? 0;
      const cached = u?.cachedInputTokens ?? 0;
      const output = u?.outputTokens ?? 0;
      return {
        inputTokens: input,
        cachedInputTokens: cached,
        outputTokens: output,
        reasoningTokens: u?.reasoningOutputTokens ?? 0,
        costUsd:
          price && u
            ? ((input - cached) * price.input + cached * price.cached + output * price.output) / 1_000_000
            : null,
      };
    };

    try {
      const finished = new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          if (threadId && turnId) void server.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
          reject(new Error("The run was cancelled."));
        };
        if (request.signal.aborted) return onAbort();
        request.signal.addEventListener("abort", onAbort, { once: true });
        server.onExit = reject;

        server.onNotification = <M extends keyof Notifications>(method: M, raw: Notifications[M]) => {
          if (method === "item/agentMessage/delta") {
            const params = raw as Notifications["item/agentMessage/delta"];
            outputChars += params.delta.length;
            streamedText += params.delta;
            request.onProgress?.({ outputChars, usage: usage ? toUsage(usage) : null });
          } else if (method === "item/completed") {
            const { item } = raw as Notifications["item/completed"];
            if (item.type === "agentMessage" && typeof item.text === "string") finalText = item.text;
          } else if (method === "thread/tokenUsage/updated") {
            usage = (raw as Notifications["thread/tokenUsage/updated"]).tokenUsage.total;
            request.onProgress?.({ outputChars, usage: toUsage(usage) });
          } else if (method === "turn/completed") {
            const { turn } = raw as Notifications["turn/completed"];
            if (turn.status === "completed") resolve();
            else reject(new Error(turn.error?.message ?? `Codex ended the turn as ${turn.status}.`));
          } else if (method === "error") {
            const params = raw as Notifications["error"];
            if (!params.willRetry) reject(new Error(params.error.message));
          }
        };
      });

      const started = await server.request("thread/start", {
        model: request.model,
        cwd: paths.scratch,
        approvalPolicy: "never",
        sandbox: "read-only",
        developerInstructions: request.system,
        ephemeral: true,
      });
      threadId = started.thread.id;
      const turn = await server.request("turn/start", {
        threadId,
        input: [{ type: "text", text: request.prompt, text_elements: [] }],
        model: request.model,
        effort: request.effort,
        outputSchema: request.schema,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      });
      turnId = turn.turn.id;
      await finished;

      const text = finalText || streamedText;
      let output: unknown;
      try {
        output = JSON.parse(text);
      } catch {
        throw new Error("Codex did not return valid JSON.");
      }
      return { output, usage: toUsage(usage), auth };
    } catch (error) {
      const detail = server.lastStderr();
      throw error instanceof Error && detail && !request.signal.aborted
        ? new Error(`${error.message} (${detail})`, { cause: error })
        : error;
    } finally {
      server.close();
    }
  }
}
