import fs from "node:fs/promises";
import path from "node:path";
import { type APIRequestContext, expect, type TestInfo } from "@playwright/test";
import { contractDocx } from "./fixtures/build.ts";

// Shared setup for the end-to-end suite. Tests drive the UI for the behavior they check
// and use these API helpers for everything else, so each test stays about one thing.

import { APP, JIRA_URL } from "./env.ts";

export { APP, JIRA_URL };
export const OWNER = { name: "Olivia Owner", email: "owner@example.com", password: "correct-horse-battery" };
export const JIRA = { siteUrl: JIRA_URL, email: "auditiq-bot@example.com", token: "fake-jira-token" };
const replayDir = path.resolve(import.meta.dirname, ".artifacts/data/replay");
const origin = { Origin: APP };

type FakeIssue = {
  key: string;
  fields: {
    summary: string;
    labels: string[];
    priority: { id: string } | null;
    status: { name: string };
    comment: { comments: Array<{ author: { accountId: string; displayName: string }; body: unknown }> };
  };
};
export type JiraState = { issues: FakeIssue[]; requests: Array<{ method: string; path: string; status: number }> };

export async function jiraControl(route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${JIRA_URL}/__control/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json();
}

export const jiraState = () => jiraControl("state") as Promise<JiraState>;

/** Attaches the fake Jira's contents to the test report, so a reviewer can see exactly what AuditIQ wrote. */
export async function attachJiraState(testInfo: TestInfo, name = "jira-state") {
  await testInfo.attach(name, { body: JSON.stringify(await jiraState(), null, 2), contentType: "application/json" });
}

export async function signIn(request: APIRequestContext, user: { email: string; password: string } = OWNER) {
  const response = await request.post("/api/auth/sign-in/email", { data: user, headers: origin });
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** Makes sure the owner exists, is signed in on `request`, and Jira is connected to the fake. */
export async function ensureWorkspace(request: APIRequestContext) {
  const state = (await (await request.get("/api/setup/state")).json()) as { needsOwner: boolean };
  if (state.needsOwner) {
    const response = await request.post("/api/auth/sign-up/email", { data: OWNER, headers: origin });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  await signIn(request);
  const me = (await (await request.get("/api/setup/me")).json()) as { jira: unknown };
  if (!me.jira) {
    const connect = await request.put("/api/settings/jira/connection", {
      data: { siteUrl: JIRA.siteUrl, email: JIRA.email, apiToken: JIRA.token },
      headers: origin,
    });
    expect(connect.ok(), await connect.text()).toBeTruthy();
    const project = await request.put("/api/settings/jira/project", {
      headers: origin,
      data: {
        projectKey: "AISBX",
        projectName: "AuditIQ Sandbox",
        issueTypeId: "10001",
        issueTypeName: "Task",
        priorities: {
          high: { id: "2", name: "High" },
          medium: { id: "3", name: "Medium" },
          low: { id: "4", name: "Low" },
        },
      },
    });
    expect(project.ok(), await project.text()).toBeTruthy();
  }
}

/** Uploads a byte-unique copy of the test contract. Upload starts extraction on its own. */
export async function uploadContract(request: APIRequestContext, tag: string): Promise<string> {
  const response = await request.post("/api/contracts", {
    headers: origin,
    multipart: {
      file: { name: `northwind-${tag}.docx`, mimeType: "application/octet-stream", buffer: await contractDocx(tag) },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { id: string }).id;
}

type Contract = {
  runs: Record<string, { latest: { id: string; status: string; error: string | null } | null }>;
  findings: Array<{
    id: string;
    eligible: boolean;
    severity: string;
    title: string;
    citations: Array<{ anchorId: string }>;
    jira: { key: string } | null;
  }>;
};

export async function getContract(request: APIRequestContext, id: string): Promise<Contract> {
  return (await (await request.get(`/api/contracts/${id}`)).json()) as Contract;
}

/** Waits for the latest run of `agent` to finish and returns its final state. */
export async function waitForRun(request: APIRequestContext, contractId: string, agent: "extraction" | "accounting") {
  let latest: Contract["runs"][string]["latest"] = null;
  await expect
    .poll(
      async () => {
        latest = (await getContract(request, contractId)).runs[agent]?.latest ?? null;
        return latest?.status;
      },
      { timeout: 30_000 },
    )
    .toMatch(/succeeded|failed|cancelled/);
  return latest as unknown as { id: string; status: string; error: string | null };
}

export async function startRun(request: APIRequestContext, contractId: string, agent: "extraction" | "accounting") {
  const response = await request.post(`/api/contracts/${contractId}/runs`, { data: { agent }, headers: origin });
  expect(response.ok(), await response.text()).toBeTruthy();
}

export async function publish(request: APIRequestContext, contractId: string, findingIds: string[]) {
  const response = await request.post(`/api/contracts/${contractId}/publish`, {
    data: { findingIds },
    headers: origin,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as {
    published: Array<{ findingId: string; issueKey: string; operation: string }>;
    failed: Array<{ findingId: string; error: string }>;
    blocked: Array<{ findingId: string }>;
  };
}

/** Writes a replay fixture into the running server's replay directory. */
export async function setReplay(name: string, content: unknown) {
  await fs.writeFile(path.join(replayDir, name), JSON.stringify(content));
}

export async function removeReplay(name: string) {
  await fs.rm(path.join(replayDir, name), { force: true });
}

export const originHeaders = origin;
