import type { Effort, RuntimeAuth, RuntimeId, Usage } from "@auditiq/shared";
import { z } from "zod";

// The contract every model runtime implements. Agents never talk to Claude or Codex
// directly; they hand a prompt and a JSON Schema to a runtime and get parsed JSON back.

export type RuntimeRequest = {
  /** What is running ("extraction", "watcher"). Used in logs and to pick replay fixtures. */
  label: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  model: string;
  effort: Effort;
  signal: AbortSignal;
  /** Called as output streams in. Runtimes throttle nothing; the caller decides how often to store. */
  onProgress?: (progress: { outputChars: number; usage: Usage | null }) => void;
};

export type RuntimeResult = {
  /** The model's JSON output, not yet validated against the agent's schema. */
  output: unknown;
  usage: Usage;
  auth: RuntimeAuth;
};

export type RuntimeStatus = {
  id: RuntimeId;
  ready: boolean;
  auth: RuntimeAuth | null;
  /** Who the runtime is signed in as, when the provider says. */
  account: string | null;
  detail: string;
};

export interface AgentRuntime {
  readonly id: RuntimeId;
  status(): Promise<RuntimeStatus>;
  run(request: RuntimeRequest): Promise<RuntimeResult>;
}

/** Thrown when the runtime has no usable login or key. Shown to users as-is. */
export class RuntimeUnavailableError extends Error {}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: null,
});

/** JSON Schema for a runtime. The `$schema` URL is dropped because Claude Code's validator can't resolve it. */
export function runtimeSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "output" });
  return rest;
}
