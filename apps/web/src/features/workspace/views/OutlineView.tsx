import { type Severity, severityRank } from "@auditiq/shared";
import { useMemo } from "react";
import { PriorityIcon } from "../../../components/icons.tsx";
import { PaneEmpty } from "../parts.tsx";
import { useWorkspace } from "../state.tsx";

/** The contract's articles and exhibits, with how many of this step's findings cite each. */
export function OutlineView() {
  const { document, findings, focusClause, focusedClause } = useWorkspace();

  const rows = useMemo(() => {
    if (!document) return [];
    // Map every clause to the article or exhibit it sits under.
    const top = new Map<string, string>();
    let current: string | null = null;
    for (const anchor of document.anchors) {
      if (anchor.depth === 0) current = anchor.id;
      if (current) top.set(anchor.id, current);
    }
    const stats = new Map<string, { count: number; severity: Severity }>();
    for (const finding of findings) {
      const topId = top.get(finding.citations[0]?.anchorId ?? "");
      if (!topId) continue;
      const entry = stats.get(topId) ?? { count: 0, severity: "low" as Severity };
      entry.count++;
      if (severityRank[finding.severity] > severityRank[entry.severity]) entry.severity = finding.severity;
      stats.set(topId, entry);
    }
    return document.anchors.filter((a) => a.depth === 0).map((anchor) => ({ anchor, stats: stats.get(anchor.id) }));
  }, [document, findings]);

  if (!document) return <PaneEmpty>Loading the contract.</PaneEmpty>;
  if (!rows.length) return <PaneEmpty>This contract has no numbered articles.</PaneEmpty>;
  return (
    <nav className="min-h-0 grow overflow-auto px-2 py-2" aria-label="Contract outline">
      {rows.map(({ anchor, stats }) => (
        <button
          key={anchor.id}
          type="button"
          onClick={() => focusClause(anchor.id)}
          className={`flex h-8 w-full items-center gap-2 rounded px-2 text-left ${focusedClause === anchor.id ? "bg-selected text-brand" : "text-ink-2 hover:bg-neutral"}`}
        >
          <span className="grow truncate">
            {anchor.id === "preamble"
              ? "Cover and recitals"
              : `${anchor.label}${anchor.title ? ` ${anchor.title}` : ""}`}
          </span>
          {stats && (
            <>
              <PriorityIcon severity={stats.severity} />
              <span className="text-xs">{stats.count}</span>
            </>
          )}
        </button>
      ))}
    </nav>
  );
}
