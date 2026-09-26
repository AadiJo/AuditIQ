// The slice of the `codex app-server` JSON-RPC protocol AuditIQ uses, copied from the
// types `codex app-server generate-ts` emits for the pinned @openai/codex version. When you
// upgrade @openai/codex, regenerate into a temp directory and compare these shapes.

export type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type Account =
  | { type: "apiKey" }
  | { type: "chatgpt"; email: string | null; planType: string }
  | { type: "amazonBedrock"; usesCodexManagedCredentials: boolean };

export type TurnError = { message: string; additionalDetails: string | null };

export type ThreadItem = { type: string; id: string; text?: string };

export type Notifications = {
  "item/agentMessage/delta": { threadId: string; turnId: string; itemId: string; delta: string };
  "item/started": { item: ThreadItem; threadId: string; turnId: string };
  "item/completed": { item: ThreadItem; threadId: string; turnId: string };
  "thread/tokenUsage/updated": {
    threadId: string;
    turnId: string;
    tokenUsage: { total: TokenUsageBreakdown; last: TokenUsageBreakdown };
  };
  "turn/completed": {
    threadId: string;
    turn: { id: string; status: "completed" | "interrupted" | "failed" | "inProgress"; error: TurnError | null };
  };
  error: { error: TurnError; willRetry: boolean; threadId: string; turnId: string };
};

export type Requests = {
  initialize: {
    params: {
      clientInfo: { name: string; title: string | null; version: string };
      capabilities: { experimentalApi: boolean } | null;
    };
    result: unknown;
  };
  "account/read": {
    params: { refreshToken?: boolean };
    result: { account: Account | null; requiresOpenaiAuth: boolean };
  };
  "account/login/start": { params: { type: "apiKey"; apiKey: string }; result: unknown };
  "thread/start": {
    params: {
      model?: string;
      cwd?: string;
      approvalPolicy?: "never";
      sandbox?: "read-only";
      developerInstructions?: string;
      ephemeral?: boolean;
    };
    result: { thread: { id: string } };
  };
  "turn/start": {
    params: {
      threadId: string;
      input: Array<{ type: "text"; text: string; text_elements: [] }>;
      model?: string;
      effort?: "low" | "medium" | "high";
      outputSchema?: unknown;
      sandboxPolicy?: { type: "readOnly"; networkAccess: boolean };
    };
    result: { turn: { id: string } };
  };
  "turn/interrupt": { params: { threadId: string; turnId: string }; result: unknown };
};

/** Requests the server sends to us. Every approval is declined; AuditIQ runs are read-only. */
export const declineResponses: Record<string, unknown> = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  execCommandApproval: { decision: { denied: { rejection: "AuditIQ analysis runs cannot execute commands." } } },
  applyPatchApproval: { decision: { denied: { rejection: "AuditIQ analysis runs cannot edit files." } } },
};
