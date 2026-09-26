import type { Anchor, AnchorScheme, Block, DocumentModel, Segment } from "@auditiq/shared";
import type { RawBlock } from "./docx.ts";

// Turns parsed blocks into a DocumentModel with citable clause anchors. A paragraph that
// opens with a clause number ("5.2.3", "Article 5", "Exhibit A", "A.1") starts a new anchor,
// and every following block belongs to it until the next one. Text before the first
// heading belongs to the "preamble" anchor, which covers cover pages and recitals.

type HeadingMatch = { id: string; label: string; depth: number; rest: string };

const romanValues: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
function roman(value: string): number {
  let total = 0;
  for (let i = 0; i < value.length; i++) {
    const current = romanValues[value[i] ?? ""] ?? 0;
    const next = romanValues[value[i + 1] ?? ""] ?? 0;
    total += current < next ? -current : current;
  }
  return total;
}

/** Recognizes a clause heading. `bold` lets "1. Definitions" count only when it's styled as one. */
export function matchHeading(text: string, bold: boolean): HeadingMatch | null {
  const t = text.replace(/\s+/g, " ").trim();
  let m = t.match(/^Article\s+(\d+|[IVXLC]+)\b[\s.:–—-]*(.*)$/i);
  if (m?.[1]) {
    const n = /^\d+$/.test(m[1]) ? m[1] : String(roman(m[1].toUpperCase()));
    return { id: `article-${n}`, label: `Article ${n}`, depth: 0, rest: m[2] ?? "" };
  }
  m = t.match(/^(Exhibit|Schedule|Appendix|Annex|Attachment)\s+([A-Z0-9]{1,3})\b[\s.:–—-]*(.*)$/i);
  if (m?.[1] && m[2]) {
    const kind = m[1].toLowerCase();
    return {
      id: `${kind}-${m[2].toLowerCase()}`,
      label: `${m[1][0]?.toUpperCase()}${kind.slice(1)} ${m[2].toUpperCase()}`,
      depth: 0,
      rest: m[3] ?? "",
    };
  }
  m = t.match(/^Section\s+(\d+(?:\.\d+)*)\.?\s+(.*)$/i);
  if (m?.[1]) return numbered(m[1], m[2] ?? "");
  m = t.match(/^([A-Z]\.\d+(?:\.\d+)*)\.?\s+(\S.*)$/);
  if (m?.[1]) return numbered(m[1], m[2] ?? "");
  m = t.match(/^(\d+(?:\.\d+)+)\.?\s+(\S.*)$/);
  if (m?.[1]) return numbered(m[1], m[2] ?? "");
  m = t.match(/^(\d+)\.\s+([A-Z].*)$/);
  if (m?.[1] && bold && t.length <= 120) return numbered(m[1], m[2] ?? "");
  return null;
}

function numbered(number: string, rest: string): HeadingMatch {
  return { id: `sec-${number}`, label: number, depth: number.split(".").length - 1, rest };
}

function blockText(block: RawBlock | Block): string {
  if (block.type === "p") return block.segments.map((s) => s.text).join("");
  return block.rows
    .map((row) =>
      row.cells.map((cell) => cell.lines.map((l) => l.segments.map((s) => s.text).join("")).join(" ")).join(" | "),
    )
    .join("\n");
}

function startsBold(segments: Segment[]): boolean {
  const first = segments.find((s) => s.text.trim());
  return Boolean(first?.bold);
}

function titleFrom(rest: string): string {
  const title = rest.replace(/^[\s.:–—-]+/, "").trim();
  return title.length > 80 ? `${title.slice(0, 77).trimEnd()}...` : title;
}

export function buildDocumentModel(format: DocumentModel["format"], raw: RawBlock[]): DocumentModel {
  const blocks: Block[] = [];
  const anchors: Anchor[] = [];
  const used = new Map<string, number>();

  for (const [index, block] of raw.entries()) {
    if (block.type === "table") {
      blocks.push(block);
      continue;
    }
    const heading = matchHeading(blockText(block), startsBold(block.segments));
    let anchorId: string | null = null;
    if (heading) {
      // Some contracts restart numbering inside exhibits. Keep ids unique so citations stay unambiguous.
      const seen = used.get(heading.id) ?? 0;
      used.set(heading.id, seen + 1);
      anchorId = seen === 0 ? heading.id : `${heading.id}~${seen + 1}`;
      let title = titleFrom(heading.rest);
      // "EXHIBIT A" is often followed by its title on the next line.
      const next = raw[index + 1];
      if (!title && heading.depth === 0 && next?.type === "p") {
        const nextText = blockText(next).trim();
        if (nextText.length <= 80 && !matchHeading(nextText, startsBold(next.segments))) title = titleFrom(nextText);
      }
      anchors.push({ id: anchorId, label: heading.label, title, depth: heading.depth });
    }
    blocks.push({ type: "p", segments: block.segments, align: block.align, anchorId });
  }

  const firstAnchor = blocks.findIndex((b) => b.type === "p" && b.anchorId);
  const hasPreamble =
    firstAnchor !== 0 && blocks.slice(0, firstAnchor === -1 ? undefined : firstAnchor).some((b) => blockText(b).trim());
  if (hasPreamble && anchors.length) anchors.unshift({ id: "preamble", label: "Preamble", title: "", depth: 0 });

  const scheme: AnchorScheme = anchors.length >= 3 ? "numbered-headings-v1" : "none";
  return { format, scheme, blocks, anchors: scheme === "none" ? [] : anchors };
}

/** Full text under each anchor. Citation checks and prompts both read from this. */
export function anchorTexts(model: DocumentModel): Map<string, string> {
  const texts = new Map<string, string>();
  if (model.scheme === "none") return texts;
  let current = model.anchors[0]?.id === "preamble" ? "preamble" : null;
  for (const block of model.blocks) {
    if (block.type === "p" && block.anchorId) current = block.anchorId;
    if (!current) continue;
    const text = blockText(block).trim();
    if (text) texts.set(current, `${texts.get(current) ?? ""}${texts.has(current) ? "\n" : ""}${text}`);
  }
  return texts;
}

/** The contract as the model sees it: every clause prefixed with its anchor id. */
export function anchoredText(model: DocumentModel): string {
  if (model.scheme === "none")
    return model.blocks
      .map(blockText)
      .filter((t) => t.trim())
      .join("\n");
  return [...anchorTexts(model)].map(([id, text]) => `[${id}]\n${text}`).join("\n\n");
}
