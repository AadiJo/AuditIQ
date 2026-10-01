import { agents, clauseName, topicLabels } from "@auditiq/shared";
import type { findings } from "../db/schema.ts";

// Atlassian Document Format builders for what AuditIQ writes to Jira, plus a reader that
// flattens comment bodies to text for the watcher.

type Node = Record<string, unknown>;
type Finding = typeof findings.$inferSelect;

const text = (value: string, marks?: Node[]): Node => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const bold = (value: string) => text(value, [{ type: "strong" }]);
const link = (value: string, href: string) => text(value, [{ type: "link", attrs: { href } }]);
const paragraph = (...content: Node[]): Node => ({ type: "paragraph", content });
const heading = (level: number, value: string): Node => ({ type: "heading", attrs: { level }, content: [text(value)] });
const quote = (value: string): Node => ({ type: "blockquote", content: [paragraph(text(value))] });
const doc = (content: Node[]) => ({ type: "doc", version: 1, content });

export type FindingContext = {
  finding: Finding;
  contract: { number: string | null; customer: string | null; filename: string };
  raisedBy: Array<keyof typeof agents>;
  appUrl: string;
};

/** The issue description. Contains the finding and its evidence, never the source document. */
export function findingDescription({ finding, contract, raisedBy, appUrl }: FindingContext) {
  return doc([
    paragraph(text(finding.rationale)),
    heading(3, "Required action"),
    paragraph(text(finding.requiredAction)),
    heading(3, "Evidence"),
    paragraph(bold("Contract term: "), text(finding.affectedTerm)),
    ...finding.citations.flatMap((citation) => [paragraph(bold(clauseName(citation.anchorId))), quote(citation.quote)]),
    heading(3, "Source"),
    paragraph(
      text(`${contract.number ?? contract.filename}${contract.customer ? `, ${contract.customer}` : ""}. `),
      text(
        `${topicLabels[finding.topic]}. Raised by ${raisedBy.map((agent) => agents[agent].label.toLowerCase()).join(" and ")}. `,
      ),
      link("Open in AuditIQ", appUrl),
    ),
    paragraph(
      text(`AuditIQ finding ${finding.id}. AuditIQ suggests; a person decides severity, ownership, and resolution.`),
    ),
  ]);
}

/** Posted when a later run observes a finding that already has an issue. */
export function reobservedComment(finding: Finding, runId: string) {
  return doc([
    paragraph(text(`AuditIQ run ${runId} raised this finding again.`)),
    paragraph(bold("Required action now: "), text(finding.requiredAction)),
  ]);
}

export function watcherReply(input: { reply: string; clauses: string[]; marker: string }) {
  return doc([
    ...input.reply
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => paragraph(text(line))),
    paragraph(
      text(`Based on ${input.clauses.map(clauseName).join(", ")}. A person decides the outcome.`, [{ type: "em" }]),
    ),
    paragraph(text(`AuditIQ reply ${input.marker}`, [{ type: "code" }])),
  ]);
}

/** Account ids of everyone @mentioned in an ADF document. */
export function mentionedAccountIds(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const n = node as { type?: string; attrs?: { id?: string }; content?: unknown[] };
  const own = n.type === "mention" && n.attrs?.id ? [n.attrs.id] : [];
  return [...own, ...(n.content ?? []).flatMap(mentionedAccountIds)];
}

/** Flattens an ADF document to plain text. Mentions keep their display text, like "@AuditIQ". */
export function adfToText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; attrs?: { text?: string }; content?: unknown[] };
  if (n.type === "text") return n.text ?? "";
  if (n.type === "mention") return n.attrs?.text ?? "";
  if (n.type === "hardBreak") return "\n";
  const inner = (n.content ?? []).map(adfToText).join("");
  return n.type === "paragraph" || n.type === "heading" || n.type === "listItem" ? `${inner}\n` : inner;
}
