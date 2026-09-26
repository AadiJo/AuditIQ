import { randomUUID } from "node:crypto";
import { type AgentId, agents, type ExtractionOutput, type RunStep, type RuntimeId, type Usage } from "@auditiq/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { accountingPrompt, extractionPrompt, promptVersions, systemPrompt } from "../agents/prompts.ts";
import { audit } from "../audit.ts";
import { db, transaction } from "../db/client.ts";
import { documents, runs } from "../db/schema.ts";
import { anchorTexts } from "../documents/model.ts";
import { registerFindings } from "../findings/register.ts";
import { runtime, runtimeChoice } from "../runtimes/index.ts";
import { runtimeSchema } from "../runtimes/types.ts";
import { appendEvent } from "./events.ts";

// Runs execute in the background, a few at a time. A run's state lives in the database
// and its event log, never in the HTTP request that started it, so closing the tab or
// opening the run from another account shows the same progress.

const MAX_CONCURRENT_RUNS = 2;
const PROGRESS_INTERVAL_MS = 1000;

/** A problem starting a run that the user can fix, such as a missing prerequisite. */
export class RunError extends Error {}

type Run = typeof runs.$inferSelect;

const queue: string[] = [];
const controllers = new Map<string, AbortController>();
let active = 0;

export function latestRun(documentId: string, agent: AgentId, status?: Run["status"]): Run | undefined {
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.documentId, documentId), eq(runs.agent, agent), status ? eq(runs.status, status) : undefined))
    .orderBy(desc(runs.createdAt))
    .get();
}

export async function startRun(input: {
  documentId: string;
  agent: AgentId;
  runtime?: RuntimeId;
  userId: string;
}): Promise<Run> {
  const document = db.select().from(documents).where(eq(documents.id, input.documentId)).get();
  if (!document) throw new RunError("That contract doesn't exist.");

  const inFlight = db
    .select()
    .from(runs)
    .where(
      and(eq(runs.documentId, document.id), eq(runs.agent, input.agent), inArray(runs.status, ["queued", "running"])),
    )
    .get();
  if (inFlight) return inFlight;

  const agent = agents[input.agent];
  let parentRunId: string | null = null;
  if (agent.dependsOn) {
    const parent = latestRun(document.id, agent.dependsOn, "succeeded");
    if (!parent) throw new RunError(`Run ${agents[agent.dependsOn].label.toLowerCase()} first.`);
    parentRunId = parent.id;
  }

  const choice = runtimeChoice(input.runtime);
  const status = await choice.runtime.status();
  if (!status.ready) throw new RunError(status.detail);

  const run = db
    .insert(runs)
    .values({
      id: randomUUID(),
      documentId: document.id,
      agent: input.agent,
      parentRunId,
      runtime: choice.runtime.id,
      model: choice.model,
      effort: choice.effort,
      auth: status.auth,
      promptVersion: promptVersions[input.agent],
      status: "queued",
      createdBy: input.userId,
    })
    .returning()
    .get();
  appendEvent(run.id, { type: "status", status: "queued" });
  audit(
    "run.queued",
    { type: "run", id: run.id },
    { agent: input.agent, runtime: run.runtime, model: run.model },
    input.userId,
  );
  queue.push(run.id);
  pump();
  return run;
}

export function cancelRun(runId: string, userId: string): boolean {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run || (run.status !== "queued" && run.status !== "running")) return false;
  audit("run.cancelled", { type: "run", id: runId }, {}, userId);
  const controller = controllers.get(runId);
  if (controller) {
    controller.abort();
    return true;
  }
  const index = queue.indexOf(runId);
  if (index >= 0) queue.splice(index, 1);
  finish(runId, { status: "cancelled", error: "Cancelled before it started." });
  return true;
}

/** Called at boot. Queued runs start again; runs cut off mid-flight by a restart are marked failed. */
export function resumeRuns(): void {
  for (const run of db.select().from(runs).where(eq(runs.status, "running")).all()) {
    finish(run.id, { status: "failed", error: "The server restarted while this run was in progress. Run it again." });
  }
  for (const run of db.select().from(runs).where(eq(runs.status, "queued")).orderBy(runs.createdAt).all()) {
    queue.push(run.id);
  }
  pump();
}

function pump(): void {
  while (active < MAX_CONCURRENT_RUNS && queue.length) {
    const runId = queue.shift();
    if (!runId) break;
    active++;
    void execute(runId).finally(() => {
      active--;
      pump();
    });
  }
}

function finish(
  runId: string,
  result: { status: "succeeded" | "failed" | "cancelled"; error?: string; output?: unknown; usage?: Usage },
) {
  db.update(runs)
    .set({
      status: result.status,
      error: result.error ?? null,
      finishedAt: new Date().toISOString(),
      ...(result.output !== undefined ? { output: result.output } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    })
    .where(eq(runs.id, runId))
    .run();
  appendEvent(runId, { type: "status", status: result.status, ...(result.error ? { error: result.error } : {}) });
}

/** Drops anchor ids the model made up from display links. Findings get their own stricter check. */
function pruneAnchorIds(value: unknown, known: Set<string>): number {
  let dropped = 0;
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const ids = record.anchorIds;
    if (Array.isArray(ids)) {
      const kept = ids.filter((id): id is string => typeof id === "string" && known.has(id));
      dropped += ids.length - kept.length;
      record.anchorIds = kept;
    }
    Object.values(record).forEach(walk);
  };
  walk(value);
  return dropped;
}

function describeZodError(error: z.ZodError): string {
  const first = error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`);
  return `The model's output didn't match the expected format (${first.join("; ")}).`;
}

async function execute(runId: string): Promise<void> {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (run?.status !== "queued") return;
  const controller = new AbortController();
  controllers.set(runId, controller);
  const step = (name: RunStep, state: "active" | "done", detail?: string) =>
    appendEvent(runId, { type: "step", step: name, state, ...(detail ? { detail } : {}) });

  try {
    db.update(runs).set({ status: "running", startedAt: new Date().toISOString() }).where(eq(runs.id, runId)).run();
    appendEvent(runId, { type: "status", status: "running" });

    step("prepare", "active");
    const document = db.select().from(documents).where(eq(documents.id, run.documentId)).get();
    if (!document) throw new Error("The contract was deleted.");
    const anchors = anchorTexts(document.model);
    let prompt: string;
    let prepareDetail = `${anchors.size} clauses`;
    if (run.agent === "extraction") {
      prompt = extractionPrompt(document.filename, document.model);
    } else {
      const parent = run.parentRunId ? db.select().from(runs).where(eq(runs.id, run.parentRunId)).get() : undefined;
      const extraction = agents.extraction.output.safeParse(parent?.output);
      if (!extraction.success)
        throw new Error("The extraction this review depends on is missing or unreadable. Run extraction again.");
      prompt = accountingPrompt(document.filename, document.model, extraction.data);
      prepareDetail = `${extraction.data.terms.length + extraction.data.pricing.length} terms, ${extraction.data.findings.length} findings, ${anchors.size} clauses`;
    }
    step("prepare", "done", prepareDetail);

    step("model", "active");
    let lastProgressAt = 0;
    let outputChars = 0;
    const result = await runtime(run.runtime).run({
      label: run.agent,
      system: systemPrompt,
      prompt,
      schema: runtimeSchema(agents[run.agent].output),
      model: run.model,
      effort: run.effort,
      signal: controller.signal,
      onProgress: (progress) => {
        outputChars = progress.outputChars;
        if (Date.now() - lastProgressAt < PROGRESS_INTERVAL_MS) return;
        lastProgressAt = Date.now();
        appendEvent(runId, { type: "progress", ...progress });
      },
    });
    appendEvent(runId, { type: "progress", outputChars, usage: result.usage });
    step("model", "done");

    const parsed = agents[run.agent].output.safeParse(result.output);
    if (!parsed.success) throw new Error(describeZodError(parsed.error));
    const output = parsed.data;

    step("verify", "active");
    const dropped = pruneAnchorIds(output, new Set(anchors.keys()));
    const counts = transaction((tx) => {
      const registered = registerFindings(tx, {
        runId,
        agent: run.agent,
        documentId: document.id,
        documentSha: document.sha256,
        hasAnchors: document.model.scheme !== "none",
        anchors,
        drafts: output.findings,
      });
      if (run.agent === "extraction") {
        const contract = (output as ExtractionOutput).contract;
        tx.update(documents)
          .set({ contractNumber: contract.number || null, customer: contract.customer || null })
          .where(eq(documents.id, document.id))
          .run();
      }
      return registered;
    });
    const unmatched = counts.total - counts.eligible;
    step(
      "verify",
      "done",
      `${counts.eligible} of ${counts.total} findings verified${unmatched ? `, ${unmatched} held back` : ""}${dropped ? `, ${dropped} unknown clause links dropped` : ""}`,
    );

    step("save", "active");
    finish(runId, { status: "succeeded", output, usage: result.usage });
    step("save", "done");
    audit(
      "run.succeeded",
      { type: "run", id: runId },
      { findings: counts.total, eligible: counts.eligible, merged: counts.merged, usage: result.usage },
    );
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    finish(runId, { status: cancelled ? "cancelled" : "failed", error: cancelled ? "Cancelled." : message });
    if (!cancelled) console.error(`Run ${runId} failed:`, error);
  } finally {
    controllers.delete(runId);
  }
}
