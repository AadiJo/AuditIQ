import { queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "./api.ts";

// Query definitions shared by routes and components. Keys are arrays so invalidating
// ["contracts"] refreshes the list and every open contract.

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: () => unwrap(api.setup.me.$get()),
  staleTime: 60_000,
  retry: false,
});

export const setupStateQuery = queryOptions({
  queryKey: ["setup-state"],
  queryFn: () => unwrap(api.setup.state.$get()),
});

export const contractsQuery = queryOptions({
  queryKey: ["contracts"],
  queryFn: async () => (await unwrap(api.contracts.$get())).contracts,
  refetchInterval: 15_000,
});

export const contractQuery = (id: string) =>
  queryOptions({
    queryKey: ["contracts", id],
    queryFn: () => unwrap(api.contracts[":id"].$get({ param: { id } })),
  });

/** The parsed page never changes after upload, so it's fetched once. */
export const documentQuery = (id: string) =>
  queryOptions({
    queryKey: ["documents", id],
    queryFn: () => unwrap(api.contracts[":id"].document.$get({ param: { id } })),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const findingsQuery = queryOptions({
  queryKey: ["findings"],
  queryFn: async () => (await unwrap(api.findings.$get())).findings,
  refetchInterval: 30_000,
});

export const findingQuery = (id: string) =>
  queryOptions({
    queryKey: ["findings", id],
    queryFn: () => unwrap(api.findings[":id"].$get({ param: { id } })),
  });

export const activityQuery = queryOptions({
  queryKey: ["jira-activity"],
  queryFn: () => unwrap(api.jira.activity.$get()),
  refetchInterval: 30_000,
});
