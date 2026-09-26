import { agents } from "@auditiq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CircleAlert, Clock, FileText, Search, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PriorityIcon } from "../../../components/icons.tsx";
import { Avatar, Button, EmptyState, SectionMessage } from "../../../components/ui.tsx";
import { api, type ContractList, unwrap } from "../../../lib/api.ts";
import { formatRelative } from "../../../lib/format.ts";
import { contractsQuery, meQuery } from "../../../lib/queries.ts";

export const Route = createFileRoute("/_app/contracts/")({ component: ContractsPage });

type Contract = ContractList[number];

/** Where a contract stands, in words. */
function status(contract: Contract): { text: string; tone: "default" | "running" | "failed" | "muted" } {
  const { extraction, accounting } = contract.runs;
  for (const [agent, run] of [
    ["accounting", accounting],
    ["extraction", extraction],
  ] as const) {
    if (run?.status === "running") return { text: `${agents[agent].label} running`, tone: "running" };
    if (run?.status === "queued") return { text: `${agents[agent].label} queued`, tone: "muted" };
  }
  if (accounting?.status === "failed") return { text: "Accounting review failed", tone: "failed" };
  if (extraction?.status === "failed") return { text: "Extraction failed", tone: "failed" };
  const total = contract.findings.high + contract.findings.medium + contract.findings.low;
  if (!extraction) return { text: "Not analyzed", tone: "muted" };
  if (total > 0 && contract.published === total) return { text: "All findings in Jira", tone: "default" };
  if (!accounting) return { text: "Extraction ready", tone: "default" };
  return { text: "Ready for review", tone: "default" };
}

function useUpload() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => unwrap(api.contracts.$post({ form: { file } })),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["contracts"] });
      navigate({ to: "/contracts/$contractId", params: { contractId: result.id } });
    },
  });
}

function ContractsPage() {
  const contracts = useQuery(contractsQuery);
  const me = useQuery(meQuery);
  const upload = useUpload();
  const input = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");
  const [dragging, setDragging] = useState(false);

  // Drop a file anywhere on the page to upload it.
  useEffect(() => {
    const over = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!event.relatedTarget) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer?.files[0];
      if (file) upload.mutate(file);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [upload.mutate]);

  const needle = filter.trim().toLowerCase();
  const rows = (contracts.data ?? []).filter(
    (c) =>
      !needle ||
      [c.contractNumber, c.customer, c.filename, c.uploadedBy].some((v) => v?.toLowerCase().includes(needle)),
  );

  return (
    <div className={`flex min-h-0 grow flex-col overflow-auto px-6 py-5 ${dragging ? "bg-selected" : ""}`}>
      <div className="flex items-center gap-2">
        <h1 className="grow text-xl font-semibold">Contracts</h1>
        <input
          ref={input}
          type="file"
          accept=".docx,.pdf"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload.mutate(file);
            event.target.value = "";
          }}
        />
        <Button variant="primary" onClick={() => input.current?.click()} disabled={upload.isPending}>
          <Upload className="size-4" />
          {upload.isPending ? "Uploading" : "Upload contract"}
        </Button>
      </div>

      {me.data && !me.data.jira && me.data.user.role === "admin" && (
        <div className="mt-4">
          <SectionMessage tone="info" title="Jira isn't connected yet">
            Findings stay in AuditIQ until you{" "}
            <Link to="/settings/jira" className="text-brand">
              connect a Jira project
            </Link>
            .
          </SectionMessage>
        </div>
      )}
      {upload.error && (
        <div className="mt-4">
          <SectionMessage tone="error">{upload.error.message}</SectionMessage>
        </div>
      )}

      <div className="mb-2 mt-4 flex items-center gap-2">
        <label className="flex h-8 w-64 items-center gap-2 rounded border border-line-input px-2.5 text-ink-3 focus-within:border-brand">
          <Search className="size-4" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter contracts"
            className="h-full grow bg-transparent text-ink outline-none"
          />
        </label>
      </div>

      {contracts.data && rows.length === 0 ? (
        <EmptyState title={contracts.data.length ? "No contracts match" : "No contracts yet"}>
          {contracts.data.length
            ? "Try a different filter."
            : "Upload a DOCX or PDF contract, or drop one anywhere on this page."}
        </EmptyState>
      ) : (
        <table className="w-full table-fixed border-collapse">
          <thead>
            <tr className="border-b-2 border-line text-left text-xs font-semibold text-ink-2">
              <th className="w-[200px] px-2 py-2">Contract</th>
              <th className="w-[190px] px-2 py-2">Customer</th>
              <th className="px-2 py-2">Status</th>
              <th className="w-[150px] px-2 py-2">Findings</th>
              <th className="w-[90px] px-2 py-2">In Jira</th>
              <th className="w-[170px] px-2 py-2">Uploaded by</th>
              <th className="w-[100px] px-2 py-2">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((contract) => {
              const s = status(contract);
              const total = contract.findings.high + contract.findings.medium + contract.findings.low;
              return (
                <tr key={contract.id} className="h-10 border-b border-line hover:bg-sunken">
                  <td className="truncate px-2">
                    <Link
                      to="/contracts/$contractId"
                      params={{ contractId: contract.id }}
                      className="flex items-center gap-1.5 font-semibold hover:text-brand"
                    >
                      <FileText className="size-4 shrink-0 text-ink-2" />
                      <span className="truncate">{contract.contractNumber ?? contract.filename}</span>
                    </Link>
                  </td>
                  <td className="truncate px-2">
                    {contract.customer ?? <span className="text-ink-3">Not extracted yet</span>}
                  </td>
                  <td className="truncate px-2">
                    <span
                      className={`inline-flex items-center gap-1.5 ${s.tone === "running" ? "text-brand" : s.tone === "failed" ? "text-danger" : s.tone === "muted" ? "text-ink-2" : ""}`}
                    >
                      {s.tone === "running" && <Clock className="size-4" />}
                      {s.tone === "failed" && <CircleAlert className="size-4" />}
                      {s.text}
                    </span>
                  </td>
                  <td className="px-2">
                    <span className="flex items-center gap-1">
                      {(["high", "medium", "low"] as const)
                        .filter((severity) => contract.findings[severity] > 0)
                        .map((severity) => (
                          <span key={severity} className="flex items-center">
                            <PriorityIcon severity={severity} />
                            {contract.findings[severity]}
                          </span>
                        ))}
                    </span>
                  </td>
                  <td className="px-2">{total ? `${contract.published} of ${total}` : ""}</td>
                  <td className="truncate px-2">
                    <span className="flex items-center gap-2">
                      <Avatar name={contract.uploadedBy} size="sm" />
                      <span className="truncate">{contract.uploadedBy}</span>
                    </span>
                  </td>
                  <td className="px-2 text-ink-2">
                    {formatRelative(
                      contract.runs.accounting?.finishedAt ??
                        contract.runs.extraction?.finishedAt ??
                        contract.createdAt,
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
