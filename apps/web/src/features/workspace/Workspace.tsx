import { type AgentId, agentIds, agents, type RuntimeId } from "@auditiq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleAlert, Clock, Download, Ellipsis, MessageSquare, Play, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { TaskIcon } from "../../components/icons.tsx";
import { Button, Modal, SectionMessage } from "../../components/ui.tsx";
import { api, type ContractDetail, type PublishResult, type RunView, unwrap } from "../../lib/api.ts";
import { formatDate, formatNumber, formatUsd } from "../../lib/format.ts";
import { meQuery } from "../../lib/queries.ts";
import { agentName, jiraUrl, RunProgress } from "./parts.tsx";
import { type PresetId, presets, useWorkspace, type ViewId, viewIds, viewLabels } from "./state.tsx";
import { useRunEvents } from "./useRunEvents.ts";
import { AnalysisView } from "./views/AnalysisView.tsx";
import { ContractView } from "./views/ContractView.tsx";
import { FindingDetailView } from "./views/FindingDetailView.tsx";
import { FindingsTableView } from "./views/FindingsTableView.tsx";
import { OutlineView } from "./views/OutlineView.tsx";

const views: Record<ViewId, () => React.ReactNode> = {
  analysis: () => <AnalysisView />,
  table: () => <FindingsTableView />,
  detail: () => <FindingDetailView />,
  contract: () => <ContractView />,
  outline: () => <OutlineView />,
};

/** Default width of the left pane for each view, as a percentage. */
const leftSize: Record<ViewId, number> = { analysis: 50, table: 60, detail: 40, contract: 55, outline: 24 };

function facts(contract: ContractDetail): Array<[string, string]> {
  const parsed = agents.extraction.output.safeParse(contract.runs.extraction.output);
  if (!parsed.success) return [];
  const c = parsed.data.contract;
  const term =
    c.effectiveDate && c.endDate
      ? `${formatDate(c.effectiveDate)} to ${formatDate(c.endDate)}`
      : formatDate(c.effectiveDate);
  return (
    [
      ["Customer", c.customer],
      ["Term", term],
      ["Value", c.totalValue],
    ] as Array<[string, string]>
  ).filter(([, value]) => value);
}

function RunDetails({ run, onClose }: { run: RunView; onClose: () => void }) {
  const usage = run.usage;
  const rows: Array<[string, string]> = [
    ["Status", run.status],
    ["Runtime", `${run.runtime === "claude" ? "Claude" : "Codex"}, ${run.model}, ${run.effort} effort`],
    [
      "Signed in with",
      run.auth === "cli" ? "The server's CLI login" : run.auth === "api-key" ? "An API key" : "Unknown",
    ],
    ["Prompt", run.promptVersion],
    ["Started", run.startedAt ? new Date(run.startedAt).toLocaleString() : ""],
    ["Finished", run.finishedAt ? new Date(run.finishedAt).toLocaleString() : ""],
  ];
  if (usage) {
    rows.push(
      ["Input tokens", `${formatNumber(usage.inputTokens)} (${formatNumber(usage.cachedInputTokens)} cached)`],
      ["Output tokens", `${formatNumber(usage.outputTokens)} (${formatNumber(usage.reasoningTokens)} reasoning)`],
      [
        "Estimated cost",
        `${formatUsd(usage.costUsd)}${run.auth === "cli" && usage.costUsd !== null ? " at list price, billed to the login's plan" : ""}`,
      ],
    );
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`${agentName(run.agent)} run`}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2">
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-ink-2">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      {run.error && (
        <div className="mt-4">
          <SectionMessage tone="error">{run.error}</SectionMessage>
        </div>
      )}
    </Modal>
  );
}

function PublishDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { contract, checked, setChecked } = useWorkspace();
  const me = useQuery(meQuery);
  const queryClient = useQueryClient();
  const ids = contract.findings.filter((f) => checked.has(f.id) && f.eligible).map((f) => f.id);
  const [result, setResult] = useState<PublishResult | null>(null);
  const publish = useMutation({
    mutationFn: () =>
      unwrap(api.contracts[":id"].publish.$post({ param: { id: contract.id }, json: { findingIds: ids } })),
    onSuccess: async (data) => {
      setResult(data);
      setChecked(new Set(data.failed.map((f) => f.findingId)));
      await queryClient.invalidateQueries({ queryKey: ["contracts"] });
      await queryClient.invalidateQueries({ queryKey: ["findings"] });
    },
  });
  const close = () => {
    setResult(null);
    publish.reset();
    onClose();
  };
  const project = me.data?.jira?.projectKey;
  const titles = new Map(contract.findings.map((f) => [f.id, f.title]));

  return (
    <Modal
      open={open}
      onClose={close}
      title={result ? "Published to Jira" : `Publish ${ids.length} finding${ids.length === 1 ? "" : "s"}`}
      footer={
        result ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="subtle" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => publish.mutate()} disabled={publish.isPending || !ids.length}>
              {publish.isPending ? "Publishing" : "Publish"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="flex flex-col gap-3">
          {result.published.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {result.published.map((p) => (
                <div key={p.findingId} className="flex items-start gap-2">
                  <TaskIcon className="mt-0.5 size-4" />
                  <a
                    className="shrink-0 text-brand hover:underline"
                    href={jiraUrl(me.data?.jira?.siteUrl, p.issueKey)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {p.issueKey}
                  </a>
                  <span className="min-w-0 grow truncate">{titles.get(p.findingId)}</span>
                  <span className="shrink-0 text-xs text-ink-3">
                    {p.operation === "created" ? "created" : p.operation === "commented" ? "updated" : "already there"}
                  </span>
                </div>
              ))}
            </div>
          )}
          {result.failed.length > 0 && (
            <SectionMessage tone="error" title={`${result.failed.length} didn't publish`}>
              {result.failed[0]?.error} AuditIQ retries these automatically.
            </SectionMessage>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p>
            AuditIQ creates one issue per finding in <strong>{project}</strong>, or adds a note to the existing issue if
            the finding is already there. Each issue carries the required action and the quoted clauses. The contract
            itself stays in AuditIQ.
          </p>
          {publish.error && <SectionMessage tone="error">{publish.error.message}</SectionMessage>}
        </div>
      )}
    </Modal>
  );
}

function PaneHeader({ side }: { side: "left" | "right" }) {
  const { search, setSearch } = useWorkspace();
  const view = search[side] ?? (side === "left" ? "analysis" : "contract");
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
      <select
        aria-label={`${side === "left" ? "Left" : "Right"} pane view`}
        value={view}
        onChange={(event) => setSearch({ [side]: event.target.value as ViewId })}
        className="h-7 rounded bg-transparent pr-1 font-semibold hover:bg-neutral"
      >
        {viewIds.map((id) => (
          <option key={id} value={id}>
            {viewLabels[id]}
          </option>
        ))}
      </select>
      <div className="grow" />
      {view === "contract" && (
        <Button
          variant={search.comments ? "selected" : "subtle"}
          onClick={() => setSearch({ comments: !search.comments })}
          aria-pressed={Boolean(search.comments)}
        >
          <MessageSquare className="size-4" />
          Comments
        </Button>
      )}
    </div>
  );
}

function Panes({ runBanner }: { runBanner: React.ReactNode }) {
  const { search } = useWorkspace();
  const left = search.left ?? "analysis";
  const right = search.right ?? "contract";
  const layout = useDefaultLayout({ id: `workspace-${left}-${right}`, storage: localStorage });
  return (
    <>
      {left !== "analysis" && right !== "analysis" && runBanner && <div className="shrink-0">{runBanner}</div>}
      <Group
        orientation="horizontal"
        className="min-h-0 grow"
        defaultLayout={layout.defaultLayout ?? { left: leftSize[left], right: 100 - leftSize[left] }}
        onLayoutChanged={layout.onLayoutChanged}
      >
        <Panel id="left" minSize="280px" className="flex flex-col">
          <PaneHeader side="left" />
          {left === "analysis" && runBanner}
          {views[left]()}
        </Panel>
        <Separator className="w-px" />
        <Panel id="right" minSize="320px" className="flex flex-col">
          <PaneHeader side="right" />
          {right === "analysis" && runBanner}
          {views[right]()}
        </Panel>
      </Group>
    </>
  );
}

function RunButton({ agent, latest }: { agent: AgentId; latest: RunView | null }) {
  const { contract } = useWorkspace();
  const me = useQuery(meQuery);
  const queryClient = useQueryClient();
  const [runtime, setRuntime] = useState<RuntimeId | "">("");
  const run = useMutation({
    mutationFn: () =>
      unwrap(
        api.contracts[":id"].runs.$post({
          param: { id: contract.id },
          json: { agent, ...(runtime ? { runtime } : {}) },
        }),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["contracts", contract.id] }),
  });
  const dependency = agents[agent].dependsOn;
  const blocked = dependency && !contract.runs[dependency].output;
  const busy = latest?.status === "queued" || latest?.status === "running";
  const first = !latest || !contract.runs[agent].output;
  return (
    <div className="flex items-center gap-1">
      {me.data?.runtime.allowOverride && (
        <select
          aria-label="Runtime for this run"
          value={runtime}
          onChange={(event) => setRuntime(event.target.value as RuntimeId | "")}
          className="h-8 rounded bg-neutral px-1.5 text-ink-2 hover:bg-neutral-hover"
        >
          <option value="">Default runtime</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      )}
      <Button
        variant={first ? "primary" : "default"}
        disabled={Boolean(blocked) || busy || run.isPending}
        title={blocked ? `Run ${agents[dependency].label.toLowerCase()} first.` : undefined}
        onClick={() => run.mutate()}
      >
        {first ? <Play className="size-4" /> : <RefreshCw className="size-4" />}
        {first ? `Run ${agents[agent].label.toLowerCase()}` : "Rerun"}
      </Button>
      {run.error && (
        <span className="max-w-64 truncate text-danger" title={run.error.message}>
          {run.error.message}
        </span>
      )}
    </div>
  );
}

export function Workspace() {
  const { contract, step, search, setSearch, checked } = useWorkspace();
  const me = useQuery(meQuery);
  const latest = contract.runs[step].latest;
  const running = latest && (latest.status === "queued" || latest.status === "running") ? latest : null;
  const progress = useRunEvents(running?.id ?? null);
  const [publishing, setPublishing] = useState(false);
  const [details, setDetails] = useState(false);
  const [menu, setMenu] = useState(false);
  const cancel = useMutation({ mutationFn: (id: string) => unwrap(api.runs[":id"].cancel.$post({ param: { id } })) });

  const publishable = contract.findings.filter((f) => f.eligible && checked.has(f.id)).length;
  const activePreset = (Object.entries(presets) as Array<[PresetId, (typeof presets)[PresetId]]>).find(
    ([, p]) =>
      p.left === (search.left ?? "analysis") &&
      p.right === (search.right ?? "contract") &&
      p.comments === (search.comments ?? false),
  )?.[0];

  const runBanner =
    running && progress ? (
      contract.runs[step].output ? (
        <div className="shrink-0 border-b border-line px-4 py-2">
          <SectionMessage tone="info">
            {agentName(step)} is running again. These results update when it finishes.{" "}
            <button type="button" className="text-brand" onClick={() => cancel.mutate(running.id)}>
              Cancel
            </button>
          </SectionMessage>
        </div>
      ) : (
        <RunProgress progress={progress} agent={step} onCancel={() => cancel.mutate(running.id)} />
      )
    ) : latest?.status === "failed" ? (
      <div className="shrink-0 border-b border-line px-4 py-2">
        <SectionMessage tone="error" title={`${agentName(step)} failed`}>
          {latest.error}
        </SectionMessage>
      </div>
    ) : null;

  const title = contract.contractNumber ?? contract.filename;
  return (
    <div className="flex min-h-0 grow flex-col">
      <div className="shrink-0 px-6 pt-3.5">
        <div className="flex gap-1.5 text-ink-2">
          <Link to="/contracts" className="hover:underline">
            Contracts
          </Link>
          <span className="text-ink-4">/</span>
          <span className="truncate">{contract.customer ?? contract.filename}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <h1 className="min-w-0 grow truncate text-xl font-semibold leading-7">{title}</h1>
          <RunButton agent={step} latest={latest} />
          <div className="relative">
            <Button icon aria-label="More actions" onClick={() => setMenu((open) => !open)}>
              <Ellipsis className="size-4" />
            </Button>
            {menu && (
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                className="fixed inset-0 z-10 cursor-default"
                onClick={() => setMenu(false)}
              />
            )}
            {menu && (
              <div className="absolute right-0 top-9 z-20 w-56 rounded-md bg-white py-2 shadow-[0_8px_12px_rgba(30,31,33,0.15),0_0_1px_rgba(30,31,33,0.31)]">
                <a
                  href={`/api/contracts/${contract.id}/file`}
                  className="flex items-center gap-2 px-4 py-1.5 hover:bg-neutral"
                  onClick={() => setMenu(false)}
                >
                  <Download className="size-4 text-ink-2" />
                  Download contract
                </a>
                <button
                  type="button"
                  disabled={!latest}
                  className="flex w-full items-center gap-2 px-4 py-1.5 text-left hover:bg-neutral disabled:opacity-50"
                  onClick={() => {
                    setMenu(false);
                    setDetails(true);
                  }}
                >
                  <Clock className="size-4 text-ink-2" />
                  Run details
                </button>
              </div>
            )}
          </div>
          <Button
            variant="primary"
            disabled={!publishable || !me.data?.jira}
            title={me.data?.jira ? undefined : "Connect Jira in Settings to publish."}
            onClick={() => setPublishing(true)}
          >
            Publish {publishable || ""} to Jira
          </Button>
        </div>
        {facts(contract).length > 0 && (
          <div className="mt-0.5 flex min-w-0 gap-7">
            {facts(contract).map(([label, value]) => (
              <span key={label} className="min-w-0 max-w-[40%] shrink truncate whitespace-nowrap" title={value}>
                <span className="mr-1.5 text-ink-2">{label}</span>
                {value}
              </span>
            ))}
          </div>
        )}
        <div className="mt-3 flex items-end gap-6 border-b-2 border-line">
          {agentIds.map((agent) => {
            const run = contract.runs[agent].latest;
            return (
              <button
                key={agent}
                type="button"
                onClick={() => setSearch({ step: agent, section: undefined, finding: undefined })}
                className={`-mb-0.5 flex items-center gap-1.5 border-b-2 pb-2 pt-1 font-medium ${agent === step ? "border-brand text-brand" : "border-transparent text-ink-2 hover:text-ink"}`}
              >
                <span className="font-normal opacity-70">{agents[agent].code}</span>
                {agents[agent].label}
                {(run?.status === "queued" || run?.status === "running") && (
                  <Clock className="size-3.5" aria-label="Running" />
                )}
                {run?.status === "failed" && <CircleAlert className="size-3.5 text-danger" aria-label="Failed" />}
              </button>
            );
          })}
          <span
            className="-mb-0.5 border-b-2 border-transparent pb-2 pt-1 font-medium text-ink-4"
            title="The reporting agent isn't built yet."
          >
            <span className="mr-1.5 font-normal">AGT-003</span>
            Report
          </span>
          <div className="grow" />
          <fieldset className="m-0 mb-1.5 flex gap-1 border-0 p-0">
            <legend className="sr-only">Layout</legend>
            {(Object.entries(presets) as Array<[PresetId, (typeof presets)[PresetId]]>).map(([id, preset]) => (
              <Button
                key={id}
                variant={activePreset === id ? "selected" : "subtle"}
                className="h-7"
                onClick={() => setSearch({ left: preset.left, right: preset.right, comments: preset.comments })}
              >
                {preset.label}
              </Button>
            ))}
          </fieldset>
        </div>
      </div>
      <Panes runBanner={runBanner} />
      <PublishDialog open={publishing} onClose={() => setPublishing(false)} />
      {details && latest && <RunDetails run={latest} onClose={() => setDetails(false)} />}
    </div>
  );
}
