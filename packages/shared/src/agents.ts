import { z } from "zod";
import { Severity, Topic } from "./topics.ts";

// Output contracts for the analysis agents. The server converts these to JSON Schema for
// the model runtime and parses every response with them, so a field added here is enforced
// end to end. Keep every property required (use empty strings or arrays instead of
// optional fields) because strict structured output rejects optional properties.

const AnchorIds = z
  .array(z.string())
  .describe("Clause anchor IDs from the provided contract that support this item. Use [] if none apply.");

export const Citation = z.object({
  anchorId: z.string().describe("An anchor ID from the provided contract, such as sec-5.2.3."),
  quote: z.string().describe("Verbatim text copied from that clause, at least 16 characters. Never paraphrase."),
});
export type Citation = z.infer<typeof Citation>;

export const FindingDraft = z.object({
  title: z.string().describe("One-line statement of the issue a reviewer must resolve."),
  severity: Severity,
  topic: Topic,
  affectedTerm: z.string().describe("The specific contract term involved, not a restatement of the title."),
  requiredAction: z.string().describe("What the reviewer has to do or decide."),
  rationale: z.string().describe("Why this matters under ASC 606, in two or three sentences."),
  citations: z
    .array(Citation)
    .describe("At least one verbatim quote. Quote the clause that raises the issue first, then supporting clauses."),
});
export type FindingDraft = z.infer<typeof FindingDraft>;

export const Term = z.object({
  label: z.string(),
  value: z.string(),
  anchorIds: AnchorIds,
});
export type Term = z.infer<typeof Term>;

export const ExtractionOutput = z.object({
  summary: z.string().describe("Three or four sentences a reviewer reads first."),
  contract: z.object({
    number: z.string().describe("Contract number, or an empty string if none is stated."),
    title: z.string(),
    vendor: z.string(),
    customer: z.string(),
    effectiveDate: z.string().describe("ISO date (YYYY-MM-DD), or an empty string."),
    endDate: z.string().describe("ISO date (YYYY-MM-DD), or an empty string."),
    totalValue: z.string().describe("Total contract value as written, for example '$552,000 plus usage fees'."),
  }),
  terms: z.array(Term).describe("Parties, dates, commitments, rights, payment terms, and similar facts."),
  scope: z.array(Term).describe("Products, modules, quantities, and services delivered."),
  pricing: z.array(Term).describe("Fees, billing cadence, discounts, credits, bonuses, and variable amounts."),
  obligations: z.array(
    z.object({
      name: z.string(),
      recognition: z.string().describe("Likely recognition pattern, for example 'Over time, ratably over 36 months'."),
      note: z.string().describe("Anything that could change the conclusion, or an empty string."),
      anchorIds: AnchorIds,
    }),
  ),
  findings: z.array(FindingDraft),
  gaps: z.array(z.string()).describe("Information a reviewer needs that the contract does not contain."),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutput>;

export const AccountingOutput = z.object({
  summary: z.string().describe("Three or four sentences a reviewer reads first."),
  obligations: z.array(
    z.object({
      name: z.string(),
      assessment: z.enum(["distinct", "combined", "needs_review"]),
      conclusion: z.string(),
      rationale: z.string(),
      anchorIds: AnchorIds,
    }),
  ),
  priceComponents: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["fixed", "variable", "material_right", "financing", "other"]),
      treatment: z.string(),
      anchorIds: AnchorIds,
    }),
  ),
  allocation: z.object({
    status: z.enum(["complete", "partial", "needs_input"]),
    summary: z.string(),
    reviewerInput: z.string().describe("What the reviewer must supply to finish allocation, or an empty string."),
  }),
  recognition: z.array(
    z.object({
      item: z.string(),
      pattern: z.enum(["over_time", "point_in_time", "as_usage_occurs", "deferred", "needs_review"]),
      conclusion: z.string(),
      rationale: z.string(),
      anchorIds: AnchorIds,
    }),
  ),
  findings: z.array(FindingDraft),
});
export type AccountingOutput = z.infer<typeof AccountingOutput>;

// Registry of agents in pipeline order. The web app builds its step tabs from this list,
// and `dependsOn` names the agent whose latest successful run feeds this one.
export const agents = {
  extraction: {
    code: "AGT-001",
    label: "Extraction",
    dependsOn: null,
    output: ExtractionOutput,
    steps: {
      prepare: "Read the contract",
      model: "Extracting terms and findings",
      verify: "Check every quote against the contract",
      save: "Save findings",
    },
  },
  accounting: {
    code: "AGT-002",
    label: "Accounting review",
    dependsOn: "extraction",
    output: AccountingOutput,
    steps: {
      prepare: "Read the extraction and the contract",
      model: "Drafting accounting conclusions",
      verify: "Check every quote against the contract",
      save: "Save findings",
    },
  },
} as const;

export type AgentId = keyof typeof agents;
export const agentIds = Object.keys(agents) as [AgentId, ...AgentId[]];
export const AgentIdSchema = z.enum(agentIds);
export type AgentOutput<A extends AgentId> = z.infer<(typeof agents)[A]["output"]>;
export type RunStep = keyof (typeof agents)[AgentId]["steps"];
export const runSteps: RunStep[] = ["prepare", "model", "verify", "save"];
