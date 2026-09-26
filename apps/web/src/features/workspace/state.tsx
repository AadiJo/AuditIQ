import { type AgentId, AgentIdSchema, type DocumentModel } from "@auditiq/shared";
import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { z } from "zod";
import type { ContractDetail, Finding } from "../../lib/api.ts";

// Workspace state. Everything a link should reproduce (step, pane views, selected finding,
// focused clause) lives in the URL; the publish checklist is local to the page.

export const viewIds = ["analysis", "table", "detail", "contract", "outline"] as const;
export type ViewId = (typeof viewIds)[number];
export const viewLabels: Record<ViewId, string> = {
  analysis: "Analysis",
  table: "Findings table",
  detail: "Finding details",
  contract: "Contract",
  outline: "Outline",
};

export const WorkspaceSearch = z.object({
  step: AgentIdSchema.optional(),
  left: z.enum(viewIds).optional(),
  right: z.enum(viewIds).optional(),
  finding: z.string().optional(),
  clause: z.string().optional(),
  section: z.string().optional(),
  comments: z.boolean().optional(),
});
export type WorkspaceSearch = z.infer<typeof WorkspaceSearch>;

export const presets = {
  review: { label: "Review", left: "analysis", right: "contract", comments: false },
  read: { label: "Read", left: "outline", right: "contract", comments: true },
  triage: { label: "Triage", left: "table", right: "detail", comments: false },
} as const satisfies Record<string, { label: string; left: ViewId; right: ViewId; comments: boolean }>;
export type PresetId = keyof typeof presets;

type WorkspaceValue = {
  contract: ContractDetail;
  document: DocumentModel | undefined;
  step: AgentId;
  /** Findings the current step raised. */
  findings: Finding[];
  selectedFinding: Finding | null;
  focusedClause: string | null;
  search: WorkspaceSearch;
  setSearch: (patch: Partial<WorkspaceSearch>) => void;
  selectFinding: (finding: Finding | null) => void;
  focusClause: (anchorId: string) => void;
  checked: Set<string>;
  setChecked: (ids: Set<string>) => void;
};

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider.");
  return value;
}

export function WorkspaceProvider({
  contract,
  document,
  step,
  search,
  children,
}: {
  contract: ContractDetail;
  document: DocumentModel | undefined;
  step: AgentId;
  search: WorkspaceSearch;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const findings = useMemo(() => contract.findings.filter((f) => f.raisedBy.includes(step)), [contract.findings, step]);
  const selectedFinding = contract.findings.find((f) => f.id === search.finding) ?? null;

  // Unpublished, verified findings start out checked, since that's what "Publish" usually means.
  const [checkedState, setChecked] = useState<Set<string> | null>(null);
  const checked = useMemo(
    () => checkedState ?? new Set(contract.findings.filter((f) => f.eligible && !f.jira).map((f) => f.id)),
    [checkedState, contract.findings],
  );

  const setSearch = useCallback(
    (patch: Partial<WorkspaceSearch>) =>
      navigate({
        to: ".",
        search: (current: WorkspaceSearch) => ({ ...current, ...patch }),
        replace: true,
        resetScroll: false,
      }),
    [navigate],
  );

  const value: WorkspaceValue = {
    contract,
    document,
    step,
    findings,
    selectedFinding,
    focusedClause: search.clause ?? null,
    search,
    setSearch,
    selectFinding: (finding) =>
      setSearch({ finding: finding?.id, clause: finding?.citations[0]?.anchorId ?? search.clause }),
    focusClause: (anchorId) => setSearch({ clause: anchorId }),
    checked,
    setChecked,
  };
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
