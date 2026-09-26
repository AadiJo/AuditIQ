import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";
import { declineResponses, type Notifications, type Requests } from "./protocol.ts";

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void };
type NotificationHandler = <M extends keyof Notifications>(method: M, params: Notifications[M]) => void;

/**
 * Minimal JSON-RPC client for `codex app-server`. The app-server protocol streams agent
 * text deltas and token usage as they happen, which `codex exec` (and the Codex SDK built
 * on it) only reports at the end.
 */
export class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderr = "";
  private exited = false;
  onNotification: NotificationHandler | null = null;

  constructor(binary: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(binary, ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-8000);
    });
    this.child.once("exit", (code) => {
      this.exited = true;
      const error = new Error(`Codex exited unexpectedly (code ${code}). ${this.lastStderr()}`.trim());
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    readline
      .createInterface({ input: this.child.stdout, crlfDelay: Number.POSITIVE_INFINITY })
      .on("line", (line) => this.handleLine(line));
  }

  lastStderr(): string {
    return this.stderr.trim().split("\n").slice(-3).join(" ");
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "auditiq", title: "AuditIQ", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: "initialized" });
  }

  request<M extends keyof Requests>(method: M, params: Requests[M]["params"]): Promise<Requests[M]["result"]> {
    if (this.exited) return Promise.reject(new Error(`Codex is not running. ${this.lastStderr()}`.trim()));
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.write({ id, method, params });
    return promise as Promise<Requests[M]["result"]>;
  }

  close(): void {
    this.onNotification = null;
    if (!this.exited) this.child.kill();
  }

  private write(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      const decline = declineResponses[message.method];
      if (decline) this.write({ id: message.id, result: decline });
      else
        this.write({ id: message.id, error: { code: -32601, message: `AuditIQ does not handle ${message.method}.` } });
      return;
    }

    if (message.method) {
      (this.onNotification as ((method: string, params: unknown) => void) | null)?.(
        message.method,
        message.params ?? {},
      );
    }
  }
}
