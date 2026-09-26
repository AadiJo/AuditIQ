import { topicLabels } from "@auditiq/shared";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { z } from "zod";
import { PriorityIcon } from "../../components/icons.tsx";
import { Button, EmptyState } from "../../components/ui.tsx";
import { JiraCell } from "../../features/workspace/parts.tsx";
import { FindingDetail } from "../../features/workspace/views/FindingDetailView.tsx";
import { findingsQuery } from "../../lib/queries.ts";

const Search_ = z.object({
  q: z.string().optional(),
  filter: z.enum(["all", "unpublished", "jira", "held"]).optional(),
  finding: z.string().optional(),
});

export const Route = createFileRoute("/_app/findings")({
  validateSearch: (search) => Search_.parse(search),
  component: FindingsPage,
});

const filters = { all: "All", unpublished: "Not in Jira", jira: "In Jira", held: "Held back" } as const;

/** Every finding across contracts, for triage. Same table and panel as a contract's Triage layout. */
function FindingsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const findings = useQuery(findingsQuery);
  const filter = search.filter ?? "all";
  const needle = search.q?.trim().toLowerCase() ?? "";
  const rows = (findings.data ?? []).filter((f) => {
    if (filter === "unpublished" && (f.jira || !f.eligible)) return false;
    if (filter === "jira" && !f.jira) return false;
    if (filter === "held" && f.eligible) return false;
    if (!needle) return true;
    return [f.title, f.affectedTerm, topicLabels[f.topic], f.contract.number, f.contract.customer, f.jira?.key].some(
      (v) => v?.toLowerCase().includes(needle),
    );
  });
  const selected = rows.find((f) => f.id === search.finding) ?? null;
  const set = (patch: z.infer<typeof Search_>) =>
    navigate({ search: (current) => ({ ...current, ...patch }), replace: true });

  return (
    <div className="flex min-h-0 grow flex-col">
      <div className="shrink-0 px-6 pb-3 pt-5">
        <h1 className="text-xl font-semibold">Findings</h1>
        <div className="mt-3 flex items-center gap-2">
          <label className="flex h-8 w-64 items-center gap-2 rounded border border-line-input px-2.5 text-ink-3 focus-within:border-brand">
            <Search className="size-4" />
            <input
              value={search.q ?? ""}
              onChange={(e) => set({ q: e.target.value || undefined })}
              placeholder="Search findings"
              className="h-full grow bg-transparent text-ink outline-none"
            />
          </label>
          {(Object.keys(filters) as Array<keyof typeof filters>).map((id) => (
            <Button
              key={id}
              variant={filter === id ? "selected" : "subtle"}
              onClick={() => set({ filter: id === "all" ? undefined : id })}
            >
              {filters[id]}
            </Button>
          ))}
          <span className="ml-auto text-ink-2">{rows.length} findings</span>
        </div>
      </div>
      {findings.data && rows.length === 0 ? (
        <EmptyState title="No findings here">Findings appear when a contract's analysis finishes.</EmptyState>
      ) : (
        <Group orientation="horizontal" className="min-h-0 grow border-t border-line">
          <Panel id="table" defaultSize={62} minSize="360px" className="flex flex-col">
            <div className="min-h-0 grow overflow-auto px-4">
              <table className="w-full table-fixed border-collapse">
                <thead>
                  <tr className="border-b-2 border-line text-left text-xs font-semibold text-ink-2">
                    <th className="w-8 px-1 py-2">P</th>
                    <th className="px-2 py-2">Summary</th>
                    <th className="w-[150px] px-2 py-2">Contract</th>
                    <th className="w-[230px] px-2 py-2">Jira</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((finding) => (
                    <tr
                      key={finding.id}
                      onClick={() => set({ finding: finding.id })}
                      className={`h-10 cursor-pointer border-b border-line ${selected?.id === finding.id ? "bg-selected" : "hover:bg-sunken"}`}
                    >
                      <td className="px-1">
                        <PriorityIcon severity={finding.severity} />
                      </td>
                      <td className="truncate px-2" title={finding.title}>
                        {finding.title}
                      </td>
                      <td className="truncate px-2 text-ink-2">
                        {finding.contract.number ?? finding.contract.filename}
                      </td>
                      <td className="px-2">
                        <JiraCell finding={finding} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <Separator className="w-px" />
          <Panel id="detail" minSize="320px" className="flex flex-col">
            {selected ? (
              <FindingDetail
                finding={selected}
                header={
                  <Link
                    to="/contracts/$contractId"
                    params={{ contractId: selected.documentId }}
                    search={{ finding: selected.id, clause: selected.citations[0]?.anchorId }}
                    className="mb-1 inline-block text-brand hover:underline"
                  >
                    Open in {selected.contract.number ?? selected.contract.filename}
                  </Link>
                }
              />
            ) : (
              <div className="px-6 py-12 text-center text-ink-2">Select a finding to see its details.</div>
            )}
          </Panel>
        </Group>
      )}
    </div>
  );
}
