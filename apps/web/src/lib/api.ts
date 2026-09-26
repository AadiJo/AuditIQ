import type { AppType } from "@auditiq/server/app";
import { type ClientResponse, hc, type InferResponseType } from "hono/client";

// Typed API client. Request and response types come straight from the server's routes,
// so a renamed field breaks the web build instead of failing at runtime.
export const api = hc<AppType>("/api", { init: { credentials: "same-origin" } });

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Awaits a client call and returns its JSON, or throws ApiError with the server's message. */
export async function unwrap<T>(request: Promise<ClientResponse<T>>): Promise<T> {
  const response = await request;
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new ApiError(response.status, body?.error ?? body?.message ?? `Request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

export type Me = InferResponseType<typeof api.setup.me.$get, 200>;
export type ContractList = InferResponseType<typeof api.contracts.$get, 200>["contracts"];
export type ContractDetail = InferResponseType<(typeof api.contracts)[":id"]["$get"], 200>;
export type Finding = ContractDetail["findings"][number];
export type FindingDetail = InferResponseType<(typeof api.findings)[":id"]["$get"], 200>;
export type RunView = NonNullable<ContractDetail["runs"]["extraction"]["latest"]>;
export type PublishResult = InferResponseType<(typeof api.contracts)[":id"]["publish"]["$post"], 200>;
