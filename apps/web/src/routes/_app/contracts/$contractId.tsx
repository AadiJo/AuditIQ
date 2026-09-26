import { type AgentId, agentIds } from "@auditiq/shared";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SectionMessage } from "../../../components/ui.tsx";
import { WorkspaceProvider, WorkspaceSearch } from "../../../features/workspace/state.tsx";
import { Workspace } from "../../../features/workspace/Workspace.tsx";
import type { ContractDetail } from "../../../lib/api.ts";
import { contractQuery, documentQuery } from "../../../lib/queries.ts";

export const Route = createFileRoute("/_app/contracts/$contractId")({
  validateSearch: (search) => WorkspaceSearch.parse(search),
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(documentQuery(params.contractId));
    return context.queryClient.ensureQueryData(contractQuery(params.contractId));
  },
  component: ContractPage,
  errorComponent: ({ error }) => (
    <div className="p-6">
      <SectionMessage tone="error" title="This contract couldn't be opened">
        {error instanceof Error ? error.message : String(error)}
      </SectionMessage>
    </div>
  ),
});

/** The furthest step that has results, so a contract opens where the work is. */
function defaultStep(contract: ContractDetail): AgentId {
  return (
    [...agentIds].reverse().find((agent) => contract.runs[agent].output || contract.runs[agent].latest) ?? "extraction"
  );
}

function ContractPage() {
  const { contractId } = Route.useParams();
  const search = Route.useSearch();
  const contract = useQuery({
    ...contractQuery(contractId),
    // While any step is running, refresh so tab badges and findings stay current.
    refetchInterval: (query) => {
      const runs = query.state.data?.runs;
      return runs && Object.values(runs).some((r) => r.latest?.status === "queued" || r.latest?.status === "running")
        ? 5_000
        : false;
    },
  });
  const document = useQuery(documentQuery(contractId));
  if (!contract.data) return null;
  return (
    <WorkspaceProvider
      contract={contract.data}
      document={document.data}
      step={search.step ?? defaultStep(contract.data)}
      search={search}
    >
      <Workspace />
    </WorkspaceProvider>
  );
}
