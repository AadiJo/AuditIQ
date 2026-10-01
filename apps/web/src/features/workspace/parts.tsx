import { type AgentId, agents, anchorLabel, clauseName, runSteps, topicLabels } from "@auditiq/shared";
import { useQuery } from "@tanstack/react-query";
import { Circle, CircleCheck, CircleDot, ExternalLink, TriangleAlert } from "lucide-react";
import { PriorityIcon, TaskIcon } from "../../components/icons.tsx";
import { Avatar, Button, Checkbox, Lozenge, SectionMessage } from "../../components/ui.tsx";
import type { Finding } from "../../lib/api.ts";
import { formatNumber, formatRelative } from "../../lib/format.ts";
import { findingQuery, meQuery } from "../../lib/queries.ts";
import { useWorkspace } from "./state.tsx";
import type { RunProgressState } from "./useRunEvents.ts";

/** "Extraction (AGT-001)": the step's name plus the agent code from the AuditIQ concept doc. */
export function agentName(agent: AgentId): string {
  return `${agents[agent].label} (${agents[agent].code})`;
}

export function jiraUrl(siteUrl: string | undefined, key: string): string {
  return siteUrl ? `${siteUrl}/browse/${key}` : "#";
}

/** Clickable clause references. Clicking one scrolls the contract to it. */
export function ClauseChips({ anchorIds }: { anchorIds: string[] }) {
  const { focusClause, focusedClause } = useWorkspace();
  const unique = [...new Set(anchorIds)];
  if (!unique.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {unique.map((id) => (
        <button
          key={id}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            focusClause(id);
          }}
          className={`rounded px-1 text-xs hover:bg-neutral-hover ${focusedClause === id ? "bg-selected text-brand" : "bg-neutral text-ink-2"}`}
        >
          {anchorLabel(id)}
        </button>
      ))}
    </span>
  );
}

export function JiraCell({ finding }: { finding: Finding }) {
  const me = useQuery(meQuery);
  if (!finding.jira) {
    return <span className="text-xs text-ink-3">{finding.eligible ? "Not in Jira" : "Held back"}</span>;
  }
  return (
    <span className="flex items-center gap-2">
      <TaskIcon />
      <a
        href={jiraUrl(me.data?.jira?.siteUrl, finding.jira.key)}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
        className="text-brand hover:underline"
      >
        {finding.jira.key}
      </a>
      <Lozenge status={finding.jira.status ?? "Open"} category={finding.jira.statusCategory} />
      <Avatar name={finding.jira.assignee} size="sm" />
    </span>
  );
}

export function sectionsOf(finding: Finding): string {
  const ids = [...new Set(finding.citations.map((c) => c.anchorId))];
  if (!ids.length) return topicLabels[finding.topic];
  const labels = ids.map(anchorLabel);
  return `${topicLabels[finding.topic]}, section${ids.length > 1 ? "s" : ""} ${labels.slice(0, -1).join(", ")}${ids.length > 1 ? " and " : ""}${labels.at(-1)}`;
}

/** The Jira comment thread for a published finding, pulled in by the poller. */
export function JiraThread({ findingId }: { findingId: string }) {
  const detail = useQuery(findingQuery(findingId));
  const comments = detail.data?.jira?.comments ?? [];
  if (!detail.data?.jira) return null;
  if (!comments.length) return <div className="text-ink-3">No comments in Jira yet.</div>;
  return (
    <div className="flex flex-col gap-3">
      {comments.slice(-4).map((comment) => (
        <div key={comment.id} className="flex gap-2">
          <Avatar name={comment.authorName} size="sm" />
          <div className="min-w-0">
            <div>
              <span className="font-semibold">{comment.authorName}</span>{" "}
              <span className="text-xs text-ink-3">{formatRelative(comment.created)}</span>
            </div>
            <div className="whitespace-pre-wrap break-words">{comment.body}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Everything about one finding: action, rationale, the quoted clauses, and the Jira thread. */
export function FindingBody({ finding }: { finding: Finding }) {
  return (
    <div className="flex flex-col gap-3">
      {!finding.eligible && (
        <SectionMessage tone="warning" title="Held back from Jira">
          {finding.blockedReasons.join(" ")}
        </SectionMessage>
      )}
      <div>
        <div className="text-xs font-semibold text-ink-2">Required action</div>
        <div>{finding.requiredAction}</div>
      </div>
      <div>
        <div className="text-xs font-semibold text-ink-2">Why it matters</div>
        <div>{finding.rationale}</div>
      </div>
      {finding.citations.map((citation) => (
        <div key={citation.quoteHash} className="border-l-2 border-line pl-3.5">
          <div className="mb-0.5 flex items-center gap-1.5">
            <span className="grow font-semibold">{clauseName(citation.anchorId)}</span>
            <CircleCheck className="size-4 text-ok" />
            <span className="text-xs text-ok">Matches the contract</span>
          </div>
          <div className="font-serif text-[13.5px] leading-[21px]">"{citation.quote}"</div>
        </div>
      ))}
      {finding.jira && (
        <div>
          <div className="mb-1 text-xs font-semibold text-ink-2">Jira comments</div>
          <JiraThread findingId={finding.id} />
        </div>
      )}
    </div>
  );
}

/** One row in the findings list. Selecting it expands the details in place. */
export function FindingRow({ finding }: { finding: Finding }) {
  const { selectedFinding, selectFinding, checked, setChecked } = useWorkspace();
  const selected = selectedFinding?.id === finding.id;
  return (
    <div
      className={`border-b border-line ${selected ? "bg-selected shadow-[inset_3px_0_0_var(--color-brand)]" : "hover:bg-sunken"}`}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: the row holds a checkbox and a link, which can't nest inside <button>. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={selected}
        onClick={() => selectFinding(selected ? null : finding)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            selectFinding(selected ? null : finding);
          }
        }}
        className="flex cursor-pointer items-start gap-2.5 px-4 py-2.5"
      >
        <span className="pt-0.5">
          <Checkbox
            label={`Select ${finding.title}`}
            checked={checked.has(finding.id)}
            disabled={!finding.eligible}
            onChange={(on) => {
              const next = new Set(checked);
              if (on) next.add(finding.id);
              else next.delete(finding.id);
              setChecked(next);
            }}
          />
        </span>
        <span className="pt-0.5">
          <PriorityIcon severity={finding.severity} />
        </span>
        <div className="min-w-0 grow">
          <div className={`${selected ? "font-semibold" : ""}`}>
            {!finding.eligible && (
              <TriangleAlert className="mr-1 inline size-3.5 -translate-y-px text-warn" aria-label="Held back" />
            )}
            {finding.title}
          </div>
          <div className="text-xs text-ink-2">{sectionsOf(finding)}</div>
        </div>
        <div className="flex w-[210px] shrink-0 justify-end pt-px">
          <JiraCell finding={finding} />
        </div>
      </div>
      {selected && (
        <div className="px-4 pb-4 pl-[58px]">
          <FindingBody finding={finding} />
        </div>
      )}
    </div>
  );
}

/** What a run is doing right now, step by step. Nothing animates; the current step just changes. */
export function RunProgress({
  progress,
  agent,
  onCancel,
}: {
  progress: RunProgressState;
  agent: keyof typeof agents;
  onCancel: () => void;
}) {
  const steps = agents[agent].steps;
  const current = runSteps.find((step) => progress.steps[step]?.state === "active");
  return (
    <div className="px-6 py-5">
      <SectionMessage
        tone="info"
        title={`${agentName(agent)} is ${progress.status === "queued" ? "queued" : "running"}`}
      >
        It keeps going if you leave this page, and anyone who opens this contract sees the same progress.
      </SectionMessage>
      <div className="mt-3">
        {runSteps.map((step) => {
          const info = progress.steps[step];
          const done = info?.state === "done";
          const active = step === current;
          return (
            <div
              key={step}
              className={`flex items-center gap-3 border-b border-line py-2.5 ${!done && !active ? "text-ink-3" : ""}`}
            >
              {done ? (
                <CircleCheck className="size-4 text-ok" />
              ) : active ? (
                <CircleDot className="size-4 text-brand" />
              ) : (
                <Circle className="size-4" />
              )}
              <span className={`grow ${active ? "font-semibold" : ""}`}>{steps[step]}</span>
              <span className="text-ink-2">
                {info?.detail ??
                  (active && step === "model" && progress.outputChars
                    ? `${formatNumber(Math.round(progress.outputChars / 4))} tokens written`
                    : "")}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex gap-2">
        <Button onClick={onCancel}>Cancel run</Button>
      </div>
    </div>
  );
}

export function PaneEmpty({ children }: { children: React.ReactNode }) {
  return <div className="px-6 py-12 text-center text-ink-2">{children}</div>;
}

export { ExternalLink };
