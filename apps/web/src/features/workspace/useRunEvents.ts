import type { RunEventEnvelope, RunStatus, RunStep, Usage } from "@auditiq/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export type RunProgressState = {
  status: RunStatus;
  error: string | null;
  steps: Partial<Record<RunStep, { state: "active" | "done"; detail?: string }>>;
  outputChars: number;
  usage: Usage | null;
  startedAt: string | null;
};

const terminal: RunStatus[] = ["succeeded", "failed", "cancelled"];

/**
 * Follows a run over server-sent events. The server replays everything stored before
 * streaming live events, so this shows the same progress after a reload or on a teammate's
 * screen. When the run ends, contract and finding queries refresh.
 */
export function useRunEvents(runId: string | null): RunProgressState | null {
  const queryClient = useQueryClient();
  const [state, setState] = useState<RunProgressState | null>(null);

  useEffect(() => {
    if (!runId) {
      setState(null);
      return;
    }
    setState({ status: "queued", error: null, steps: {}, outputChars: 0, usage: null, startedAt: null });
    const source = new EventSource(`/api/runs/${runId}/events`);
    const apply = (message: MessageEvent<string>) => {
      const { event, at } = JSON.parse(message.data) as RunEventEnvelope;
      setState((current) => {
        const next = current ?? {
          status: "queued" as const,
          error: null,
          steps: {},
          outputChars: 0,
          usage: null,
          startedAt: null,
        };
        if (event.type === "status") {
          return {
            ...next,
            status: event.status,
            error: event.error ?? null,
            startedAt: event.status === "running" ? at : next.startedAt,
          };
        }
        if (event.type === "step") {
          return { ...next, steps: { ...next.steps, [event.step]: { state: event.state, detail: event.detail } } };
        }
        return { ...next, outputChars: event.outputChars, usage: event.usage ?? next.usage };
      });
      if (event.type === "status" && terminal.includes(event.status)) {
        source.close();
        void queryClient.invalidateQueries({ queryKey: ["contracts"] });
        void queryClient.invalidateQueries({ queryKey: ["findings"] });
      }
    };
    for (const type of ["status", "step", "progress"]) source.addEventListener(type, apply);
    return () => source.close();
  }, [runId, queryClient]);

  return runId ? state : null;
}
