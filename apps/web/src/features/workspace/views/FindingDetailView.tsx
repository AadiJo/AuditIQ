import { topicLabels } from "@auditiq/shared";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { PriorityIcon, priorityLabels, TaskIcon } from "../../../components/icons.tsx";
import { Avatar, Lozenge } from "../../../components/ui.tsx";
import type { Finding } from "../../../lib/api.ts";
import { formatRelative } from "../../../lib/format.ts";
import { findingQuery, meQuery } from "../../../lib/queries.ts";
import { agentName, FindingBody, jiraUrl, PaneEmpty } from "../parts.tsx";
import { useWorkspace } from "../state.tsx";

/** The selected finding in the workspace. */
export function FindingDetailView() {
  const { selectedFinding } = useWorkspace();
  if (!selectedFinding) return <PaneEmpty>Select a finding to see its details.</PaneEmpty>;
  return <FindingDetail finding={selectedFinding} />;
}

/** A finding in full, laid out like Jira's issue panel. Also used on the Findings page. */
export function FindingDetail({ finding, header }: { finding: Finding; header?: ReactNode }) {
  const me = useQuery(meQuery);
  const detail = useQuery(findingQuery(finding.id));

  return (
    <div className="min-h-0 grow overflow-auto px-5 pb-6">
      <div className="flex h-12 items-center gap-1.5">
        {finding.jira ? (
          <>
            <TaskIcon />
            <a
              href={jiraUrl(me.data?.jira?.siteUrl, finding.jira.key)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-ink-2 hover:text-brand"
            >
              {finding.jira.key}
              <ExternalLink className="size-3.5" />
            </a>
          </>
        ) : (
          <span className="text-ink-2">{finding.id}</span>
        )}
      </div>
      {header}
      <h2 className="text-lg font-semibold leading-6">{finding.title}</h2>
      {finding.jira && (
        <div className="mt-3">
          <Lozenge status={finding.jira.status ?? "Open"} category={finding.jira.statusCategory} />
        </div>
      )}
      <dl className="mt-4 grid grid-cols-[120px_1fr] items-center gap-x-3 gap-y-2.5">
        <dt className="text-ink-2">Priority</dt>
        <dd className="flex items-center gap-1.5">
          <PriorityIcon severity={finding.severity} />
          {priorityLabels[finding.severity]}
        </dd>
        {finding.jira && (
          <>
            <dt className="text-ink-2">Assignee</dt>
            <dd className="flex items-center gap-2">
              <Avatar name={finding.jira.assignee} size="sm" />
              {finding.jira.assignee ?? "Unassigned"}
            </dd>
          </>
        )}
        <dt className="text-ink-2">Topic</dt>
        <dd>{topicLabels[finding.topic]}</dd>
        <dt className="text-ink-2">Contract term</dt>
        <dd>{finding.affectedTerm}</dd>
        <dt className="text-ink-2">Raised by</dt>
        <dd>{finding.raisedBy.map(agentName).join(" and ")}</dd>
      </dl>
      <div className="mt-5">
        <FindingBody finding={finding} />
      </div>
      {detail.data && detail.data.watcher.length > 0 && (
        <div className="mt-5">
          <div className="mb-1 text-xs font-semibold text-ink-2">Watcher decisions</div>
          {detail.data.watcher.map((decision) => (
            <div key={decision.id} className="border-b border-line py-2">
              <div className="text-xs text-ink-3">
                {formatRelative(decision.createdAt)}, {decision.status}
              </div>
              <div className="text-ink-2">{decision.policy}</div>
              {decision.reply && <div className="mt-1">{decision.reply}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
