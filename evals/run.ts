import fs from "node:fs/promises";
import path from "node:path";
import { type AgentId, agents, type ExtractionOutput, type FindingDraft } from "@auditiq/shared";

// Scores the analysis agents against issues planted in the Northwind test contract.
//
//   pnpm eval            run both agents on every signed-in runtime (costs model usage)
//   pnpm eval --replay   score the recorded e2e fixtures instead, with no model calls
//
// Each run writes evals/reports/<timestamp>.json and .md. Recall is the share of planted
// issues some finding matched; citation validity is the share of findings whose quotes
// passed AuditIQ's mechanical check.

const root = path.resolve(import.meta.dirname, "..");
process.env.DATA_DIR ??= path.join(root, "evals/.data");
const { contractDocx } = await import("../e2e/fixtures/build.ts");
const { readDocx } = await import("../apps/server/src/documents/docx.ts");
const { anchorTexts, buildDocumentModel } = await import("../apps/server/src/documents/model.ts");
const { accountingPrompt, extractionPrompt, systemPrompt } = await import("../apps/server/src/agents/prompts.ts");
const { verifyCitations } = await import("../apps/server/src/findings/verify.ts");
const { runtimeSchema } = await import("../apps/server/src/runtimes/types.ts");

type Expected = { issues: Array<{ id: string; topics: string[]; clauses: string[] }> };
const expected = JSON.parse(await fs.readFile(path.join(root, "evals/northwind.expected.json"), "utf8")) as Expected;
const replay = process.argv.includes("--replay");

const docxPath = path.join(process.env.DATA_DIR, "northwind.docx");
await fs.mkdir(process.env.DATA_DIR, { recursive: true });
await fs.writeFile(docxPath, await contractDocx());
const model = buildDocumentModel("docx", await readDocx(docxPath));
const anchors = anchorTexts(model);

function score(findings: FindingDraft[]) {
  const checked = findings.map((finding) => ({ finding, verified: verifyCitations(finding.citations, anchors) }));
  const matched = expected.issues.map((issue) => {
    const hit = checked.find(
      ({ finding, verified }) =>
        issue.topics.includes(finding.topic) && verified.verified.some((c) => issue.clauses.includes(c.anchorId)),
    );
    return { issue: issue.id, matched: Boolean(hit), by: hit?.finding.title ?? null };
  });
  return {
    findings: findings.length,
    citationValidity:
      checked.filter((c) => c.verified.errors.length === 0 && c.finding.citations.length > 0).length /
      Math.max(1, findings.length),
    recall: matched.filter((m) => m.matched).length / expected.issues.length,
    missed: matched.filter((m) => !m.matched).map((m) => m.issue),
    matched,
  };
}

type Outcome = {
  runtime: string;
  agent: AgentId;
  ok: boolean;
  error?: string;
  usage?: unknown;
  seconds?: number;
  score?: ReturnType<typeof score>;
};
const outcomes: Outcome[] = [];

async function runAgents(
  label: string,
  run: (agent: AgentId, prompt: string) => Promise<{ output: unknown; usage: unknown }>,
) {
  let extraction: ExtractionOutput | null = null;
  for (const agent of ["extraction", "accounting"] as const) {
    const started = Date.now();
    try {
      if (agent === "accounting" && !extraction) throw new Error("Skipped: extraction failed.");
      const prompt =
        agent === "extraction"
          ? extractionPrompt("northwind.docx", model)
          : accountingPrompt("northwind.docx", model, extraction as ExtractionOutput);
      const result = await run(agent, prompt);
      const output = agents[agent].output.parse(result.output);
      if (agent === "extraction") extraction = output as ExtractionOutput;
      outcomes.push({
        runtime: label,
        agent,
        ok: true,
        usage: result.usage,
        seconds: (Date.now() - started) / 1000,
        score: score(output.findings),
      });
    } catch (error) {
      outcomes.push({ runtime: label, agent, ok: false, error: (error as Error).message.slice(0, 500) });
    }
  }
}

if (replay) {
  await runAgents("replay", async (agent) =>
    JSON.parse(await fs.readFile(path.join(root, `e2e/fixtures/replay/${agent}.json`), "utf8")),
  );
} else {
  const { ClaudeRuntime } = await import("../apps/server/src/runtimes/claude.ts");
  const { CodexRuntime } = await import("../apps/server/src/runtimes/codex/runtime.ts");
  const runtimes = [
    {
      runtime: new ClaudeRuntime(() => process.env.ANTHROPIC_API_KEY ?? null),
      model: process.env.EVAL_CLAUDE_MODEL ?? "claude-opus-5",
    },
    {
      runtime: new CodexRuntime(() => process.env.OPENAI_API_KEY ?? null),
      model: process.env.EVAL_CODEX_MODEL ?? "gpt-5.5",
    },
  ];
  for (const { runtime, model: modelName } of runtimes) {
    const status = await runtime.status();
    if (!status.ready) {
      outcomes.push({ runtime: runtime.id, agent: "extraction", ok: false, error: `Not run: ${status.detail}` });
      continue;
    }
    await runAgents(`${runtime.id}:${modelName}`, (agent, prompt) =>
      runtime.run({
        label: agent,
        system: systemPrompt,
        prompt,
        schema: runtimeSchema(agents[agent].output),
        model: modelName,
        effort: "medium",
        signal: AbortSignal.timeout(900_000),
      }),
    );
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportDir = path.join(root, "evals/reports");
await fs.mkdir(reportDir, { recursive: true });
await fs.writeFile(
  path.join(reportDir, `${stamp}.json`),
  `${JSON.stringify({ createdAt: new Date().toISOString(), replay, outcomes }, null, 2)}\n`,
);
const lines = [
  `# AuditIQ eval, ${new Date().toISOString()}`,
  "",
  `${expected.issues.length} planted issues in the Northwind contract.`,
  "",
  "| Runtime | Agent | Findings | Recall | Citation validity | Missed |",
  "| --- | --- | --- | --- | --- | --- |",
  ...outcomes.map((o) =>
    o.ok && o.score
      ? `| ${o.runtime} | ${o.agent} | ${o.score.findings} | ${(o.score.recall * 100).toFixed(0)}% | ${(o.score.citationValidity * 100).toFixed(0)}% | ${o.score.missed.join(", ") || "none"} |`
      : `| ${o.runtime} | ${o.agent} | | | | ${o.error} |`,
  ),
];
await fs.writeFile(path.join(reportDir, `${stamp}.md`), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
console.log(`\nReport: evals/reports/${stamp}.md`);
