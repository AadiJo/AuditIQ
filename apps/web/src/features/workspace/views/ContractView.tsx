import type { Block, DocumentModel, Segment } from "@auditiq/shared";
import { agents } from "@auditiq/shared";
import { type CSSProperties, Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Logo, PriorityIcon } from "../../../components/icons.tsx";
import type { Finding } from "../../../lib/api.ts";
import { FindingBody, JiraCell, PaneEmpty } from "../parts.tsx";
import { useWorkspace } from "../state.tsx";

// The contract as a page. Quotes cited by findings get the inline-comment highlight, the
// selected finding's quotes stand out, and the page scrolls to whichever clause is in
// focus. With comments on, findings sit in the margin beside the clause they cite, the way
// Word shows review comments.

type Highlight = { quote: string; findingId: string };

/** Lowercased, whitespace-collapsed text plus a map from each position back to the original. */
function normalizeWithMap(text: string): { value: string; map: number[] } {
  let value = "";
  const map: number[] = [];
  let lastWasSpace = false;
  for (let i = 0; i < text.length; i++) {
    let ch = text[i] ?? "";
    if (/\s/.test(ch)) {
      if (lastWasSpace) continue;
      ch = " ";
      lastWasSpace = true;
    } else {
      lastWasSpace = false;
      ch = ch.replace(/[‘’]/, "'").replace(/[“”]/, '"').replace(/[–—]/, "-").toLowerCase();
    }
    value += ch;
    map.push(i);
  }
  return { value, map };
}

type Range = { start: number; end: number; findingId: string };

function findRanges(text: string, highlights: Highlight[]): Range[] {
  if (!highlights.length) return [];
  const { value, map } = normalizeWithMap(text);
  const ranges: Range[] = [];
  for (const highlight of highlights) {
    const needle = normalizeWithMap(highlight.quote.trim()).value;
    const at = needle.length >= 8 ? value.indexOf(needle) : -1;
    if (at < 0) continue;
    const start = map[at] ?? 0;
    const end = (map[at + needle.length - 1] ?? start) + 1;
    ranges.push({ start, end, findingId: highlight.findingId });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function segmentStyle(segment: Segment): CSSProperties {
  return {
    fontWeight: segment.bold ? 700 : undefined,
    fontStyle: segment.italic ? "italic" : undefined,
    color: segment.color && segment.color !== "000000" ? `#${segment.color}` : undefined,
  };
}

/** Renders segments, wrapping highlighted character ranges in <mark>. */
function Segments({
  segments,
  highlights,
  activeFinding,
}: {
  segments: Segment[];
  highlights: Highlight[];
  activeFinding: string | null;
}) {
  const text = segments.map((s) => s.text).join("");
  const ranges = findRanges(text, highlights);
  const pieces: React.ReactNode[] = [];
  let offset = 0;
  segments.forEach((segment, index) => {
    const segStart = offset;
    const segEnd = offset + segment.text.length;
    offset = segEnd;
    let cursor = segStart;
    const parts: React.ReactNode[] = [];
    for (const range of ranges) {
      if (range.end <= cursor || range.start >= segEnd) continue;
      const from = Math.max(range.start, cursor);
      const to = Math.min(range.end, segEnd);
      if (from > cursor) parts.push(segment.text.slice(cursor - segStart, from - segStart));
      parts.push(
        <mark
          key={`${range.findingId}-${from}`}
          className="quote"
          data-active={range.findingId === activeFinding ? "" : undefined}
        >
          {segment.text.slice(from - segStart, to - segStart)}
        </mark>,
      );
      cursor = to;
    }
    if (cursor < segEnd) parts.push(segment.text.slice(cursor - segStart));
    pieces.push(
      <span key={index} style={segmentStyle(segment)}>
        {parts}
      </span>,
    );
  });
  return <>{pieces}</>;
}

function BlockView({
  block,
  highlights,
  activeFinding,
}: {
  block: Block;
  highlights: Highlight[];
  activeFinding: string | null;
}) {
  if (block.type === "table") {
    return (
      <table className="my-2 w-full border-collapse text-[13px]">
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r}>
              {row.cells.map((cell, c) => (
                <td
                  key={c}
                  colSpan={cell.colSpan}
                  className="border border-line px-2 py-1 align-top"
                  style={cell.fill ? { backgroundColor: `#${cell.fill}` } : undefined}
                >
                  {cell.lines.map((line, l) => (
                    <p key={l} className="m-0">
                      <Segments segments={line.segments} highlights={highlights} activeFinding={activeFinding} />
                    </p>
                  ))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  const align =
    block.align === "center"
      ? "center"
      : block.align === "right"
        ? "right"
        : block.align === "both"
          ? "justify"
          : undefined;
  return (
    <p className="mb-2" style={align ? { textAlign: align } : undefined}>
      <Segments segments={block.segments} highlights={highlights} activeFinding={activeFinding} />
    </p>
  );
}

/** Groups blocks under the anchor that starts them, so each clause is one element to scroll to. */
function clauseGroups(model: DocumentModel): Array<{ anchorId: string | null; blocks: Block[] }> {
  const groups: Array<{ anchorId: string | null; blocks: Block[] }> = [];
  const preamble = model.anchors[0]?.id === "preamble" ? "preamble" : null;
  for (const block of model.blocks) {
    if (block.type === "p" && block.anchorId) groups.push({ anchorId: block.anchorId, blocks: [block] });
    else if (groups.length) groups[groups.length - 1]?.blocks.push(block);
    else groups.push({ anchorId: preamble, blocks: [block] });
  }
  return groups;
}

function MarginComment({ finding, active, onSelect }: { finding: Finding; active: boolean; onSelect: () => void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the card holds a Jira link, which can't nest inside <button>.
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => event.key === "Enter" && onSelect()}
      className={`flex cursor-pointer flex-col gap-2 rounded-md border bg-white p-3 ${active ? "border-brand shadow-[0_4px_8px_rgba(30,31,33,0.12)]" : "border-line hover:border-ink-4"}`}
    >
      <div className="flex items-center gap-2">
        <Logo className="size-5" />
        <div className="min-w-0 grow leading-4">
          <div className="font-semibold">AuditIQ</div>
          <div className="text-xs text-ink-2">{finding.raisedBy.map((agent) => agents[agent].label).join(" and ")}</div>
        </div>
        <PriorityIcon severity={finding.severity} />
      </div>
      <div className="font-semibold">{finding.title}</div>
      {active ? <FindingBody finding={finding} /> : null}
      <JiraCell finding={finding} />
    </div>
  );
}

export function ContractView() {
  const { document, contract, findings, selectedFinding, selectFinding, focusedClause, search } = useWorkspace();
  const comments = search.comments ?? false;
  const scroller = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const [positions, setPositions] = useState<Record<string, number>>({});

  // Highlights come from every finding on the contract, not just this step's.
  const highlightsByAnchor = useMemo(() => {
    const map = new Map<string, Highlight[]>();
    for (const finding of contract.findings) {
      for (const citation of finding.citations) {
        const list = map.get(citation.anchorId) ?? [];
        list.push({ quote: citation.quote, findingId: finding.id });
        map.set(citation.anchorId, list);
      }
    }
    return map;
  }, [contract.findings]);

  const groups = useMemo(() => (document ? clauseGroups(document) : []), [document]);
  const marginFindings = useMemo(() => findings.filter((f) => f.citations.length > 0), [findings]);

  // Scroll the focused clause into view whenever it changes, and once the page first renders.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `document` re-runs the scroll after the page loads.
  useLayoutEffect(() => {
    if (!focusedClause) return;
    scroller.current
      ?.querySelector(`[data-anchor="${CSS.escape(focusedClause)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [focusedClause, document]);

  // Place margin comments beside their primary clause, pushing down any that would overlap.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selected card expands, which moves the cards below it.
  useLayoutEffect(() => {
    if (!comments || !page.current) return;
    const measure = () => {
      const pageTop = page.current?.getBoundingClientRect().top ?? 0;
      const tops = marginFindings
        .map((finding) => {
          const anchor = page.current?.querySelector(
            `[data-anchor="${CSS.escape(finding.citations[0]?.anchorId ?? "")}"]`,
          );
          return { id: finding.id, top: anchor ? anchor.getBoundingClientRect().top - pageTop : 0 };
        })
        .sort((a, b) => a.top - b.top);
      const next: Record<string, number> = {};
      let floor = 0;
      for (const { id, top } of tops) {
        const y = Math.max(top, floor);
        next[id] = y;
        floor = y + (cardRefs.current.get(id)?.offsetHeight ?? 120) + 8;
      }
      setPositions((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(page.current);
    for (const card of cardRefs.current.values()) observer.observe(card);
    return () => observer.disconnect();
  }, [comments, marginFindings, selectedFinding?.id]);

  if (!document) return <PaneEmpty>Loading the contract.</PaneEmpty>;

  return (
    <div ref={scroller} data-comments={comments ? "" : undefined} className="min-h-0 grow overflow-auto bg-sunken">
      <div className="flex justify-center gap-5 px-5 py-5">
        <div
          ref={page}
          className="w-full max-w-[680px] shrink-0 bg-white px-12 py-10 font-serif text-[13.5px] leading-[21px] text-[#222] shadow-[0_1px_1px_rgba(30,31,33,0.25),0_0_1px_rgba(30,31,33,0.31)]"
        >
          {groups.map((group, index) => (
            <div
              key={`${group.anchorId ?? "lead"}-${index}`}
              data-anchor={group.anchorId ?? undefined}
              className={`-mx-3 rounded px-3 ${group.anchorId && group.anchorId === focusedClause ? "bg-[#f4f5f7]" : ""}`}
            >
              {group.blocks.map((block, blockIndex) => (
                <Fragment key={blockIndex}>
                  <BlockView
                    block={block}
                    highlights={group.anchorId ? (highlightsByAnchor.get(group.anchorId) ?? []) : []}
                    activeFinding={selectedFinding?.id ?? null}
                  />
                </Fragment>
              ))}
            </div>
          ))}
        </div>
        {comments && (
          <div className="relative w-[320px] shrink-0">
            {marginFindings.map((finding) => (
              <div
                key={finding.id}
                ref={(element) => {
                  if (element) cardRefs.current.set(finding.id, element);
                  else cardRefs.current.delete(finding.id);
                }}
                className="absolute left-0 right-0"
                style={{ top: positions[finding.id] ?? 0 }}
              >
                <MarginComment
                  finding={finding}
                  active={selectedFinding?.id === finding.id}
                  onSelect={() => selectFinding(selectedFinding?.id === finding.id ? null : finding)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      {document.scheme === "none" && (
        <div className="px-5 pb-5 text-center text-ink-2">
          AuditIQ found no numbered clauses in this document, so findings can't be checked against it and stay out of
          Jira.
        </div>
      )}
    </div>
  );
}
