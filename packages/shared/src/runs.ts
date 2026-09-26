import type { AgentId, RunStep } from "./agents.ts";

export type RuntimeId = "claude" | "codex";
export type Effort = "low" | "medium" | "high";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** How the runtime authenticated: the host's CLI login, or an API key. */
export type RuntimeAuth = "cli" | "api-key";

export type Usage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Null when the run billed a subscription or the model has no known price. */
  costUsd: number | null;
};

// Events a run emits while it executes. The server stores every event, and the run's SSE
// stream replays stored events before streaming live ones, so a reload shows the same view.
export type RunEvent =
  | { type: "status"; status: RunStatus; error?: string }
  | { type: "step"; step: RunStep; state: "active" | "done"; detail?: string }
  | { type: "progress"; outputChars: number; usage: Usage | null };

export type RunEventEnvelope = { seq: number; at: string; event: RunEvent };

export type RunSummary = {
  id: string;
  agent: AgentId;
  status: RunStatus;
  runtime: RuntimeId;
  model: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};
