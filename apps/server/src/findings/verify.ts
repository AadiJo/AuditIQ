import type { Citation } from "@auditiq/shared";
import { sha256 } from "../crypto.ts";
import type { VerifiedCitation } from "../db/schema.ts";

// Mechanical citation check. A quote counts only if, after normalizing quotes, dashes,
// whitespace, and case, it appears inside the text of the clause it claims. Anything else
// keeps the finding out of Jira with a reason the reviewer can read.

export const MIN_QUOTE_CHARS = 16;

// Table cells reach the model joined with " | ", so quotes from tables carry pipes; PDFs
// have none. Pipes count as whitespace, and a hyphen left dangling by a PDF line break
// ("Go- Live") rejoins its word.
export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .replace(/(\p{L})- (\p{L})/gu, "$1-$2")
    .trim()
    .toLowerCase();
}

function checkCitation(anchorId: string, quote: string, normalized: string, clause: string | undefined): string | null {
  if (!anchorId || !quote) return "is missing a clause or a quote.";
  if (normalized.length < MIN_QUOTE_CHARS) return "is too short to check.";
  if (clause === undefined) return `points to a clause that doesn't exist (${anchorId}).`;
  if (!normalizeForMatch(clause).includes(normalized)) return `doesn't match the text of clause ${anchorId}.`;
  return null;
}

export function verifyCitations(
  claims: Citation[],
  anchors: Map<string, string>,
): { verified: VerifiedCitation[]; errors: string[] } {
  const verified: VerifiedCitation[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  claims.forEach((claim, index) => {
    const anchorId = claim.anchorId.trim();
    const quote = claim.quote.replace(/\s+/g, " ").trim();
    const normalized = normalizeForMatch(quote);
    const problem = checkCitation(anchorId, quote, normalized, anchors.get(anchorId));
    if (problem) {
      errors.push(`Citation ${index + 1} ${problem}`);
      return;
    }
    const quoteHash = sha256(normalized);
    if (seen.has(`${anchorId}:${quoteHash}`)) return;
    seen.add(`${anchorId}:${quoteHash}`);
    verified.push({ anchorId, quote, quoteHash });
  });

  return { verified, errors };
}
