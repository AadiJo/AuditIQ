import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeId } from "@auditiq/shared";
import type { AgentRuntime, RuntimeRequest, RuntimeResult, RuntimeStatus } from "./types.ts";

/** A recorded runtime response, captured from a real run with `pnpm record`. */
export type ReplayFixture = {
  /** Progress callbacks to replay, with the delay before each one. */
  progress: Array<{ delayMs: number; outputChars: number }>;
  output: unknown;
  usage: RuntimeResult["usage"];
};

/**
 * Test-only runtime. It serves `<label>.json` from AUDITIQ_REPLAY_DIR, so end-to-end tests
 * exercise the real server, database, and UI without calling a model. A fixture named
 * `<label>.fail.json` containing `{ "error": "..." }` makes the run fail instead.
 */
export class ReplayRuntime implements AgentRuntime {
  readonly id: RuntimeId;
  private readonly dir: string;

  constructor(id: RuntimeId, dir: string) {
    this.id = id;
    this.dir = dir;
  }

  async status(): Promise<RuntimeStatus> {
    return {
      id: this.id,
      ready: true,
      auth: "api-key",
      account: "replay",
      detail: `Replaying fixtures from ${this.dir}.`,
    };
  }

  async run(request: RuntimeRequest): Promise<RuntimeResult> {
    const failure = path.join(this.dir, `${request.label}.fail.json`);
    const failing = await fs.readFile(failure, "utf8").catch(() => null);
    if (failing) throw new Error((JSON.parse(failing) as { error: string }).error);

    const fixture = JSON.parse(
      await fs.readFile(path.join(this.dir, `${request.label}.json`), "utf8"),
    ) as ReplayFixture;
    for (const step of fixture.progress) {
      await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      if (request.signal.aborted) throw new Error("The run was cancelled.");
      request.onProgress?.({ outputChars: step.outputChars, usage: null });
    }
    return { output: fixture.output, usage: fixture.usage, auth: "api-key" };
  }
}
