import { expect, test } from "@playwright/test";
import {
  attachJiraState,
  ensureWorkspace,
  getContract,
  jiraControl,
  jiraState,
  publish,
  uploadContract,
  waitForRun,
} from "../helpers.ts";

// Jira is a remote system that fails. These tests break it on purpose and check that
// AuditIQ retries, waits when told to, and never creates a duplicate along the way.

test("transient errors on reads are retried within one publish", async ({ request }, testInfo) => {
  await ensureWorkspace(request);
  const id = await uploadContract(request, "retry-500");
  await waitForRun(request, id, "extraction");
  const finding = (await getContract(request, id)).findings.find((f) => f.eligible);
  if (!finding) throw new Error("fixture has no verified finding");

  await jiraControl("fail", { method: "POST", pathPrefix: "/rest/api/3/search/jql", status: 503, times: 2 });
  const result = await publish(request, id, [finding.id]);
  expect(result.failed).toHaveLength(0);
  expect(result.published[0]?.operation).toBe("created");

  const jira = await jiraState();
  await attachJiraState(testInfo);
  const searches = jira.requests.filter((r) => r.path === "/rest/api/3/search/jql");
  expect(searches.slice(-3).map((r) => r.status)).toEqual([503, 503, 200]);
});

test("a failed create isn't retried blindly, so it never duplicates", async ({ request }, testInfo) => {
  await ensureWorkspace(request);
  const id = await uploadContract(request, "create-503");
  await waitForRun(request, id, "extraction");
  const finding = (await getContract(request, id)).findings.find((f) => f.eligible);
  if (!finding) throw new Error("fixture has no verified finding");
  const label = `auditiq-fnd-${finding.id.slice(4).toLowerCase()}`;

  // Jira may have written the issue before answering 503, so AuditIQ doesn't resend the create
  // in the same call. The next attempt looks the finding up by label first.
  await jiraControl("fail", { method: "POST", pathPrefix: "/rest/api/3/issue", status: 503, times: 1 });
  const first = await publish(request, id, [finding.id]);
  expect(first.failed).toHaveLength(1);
  const second = await publish(request, id, [finding.id]);
  expect(second.published[0]?.operation).toBe("created");
  const jira = await jiraState();
  await attachJiraState(testInfo);
  expect(jira.issues.filter((i) => i.fields.labels.includes(label))).toHaveLength(1);
});

test("publishing again revives a publish that ran out of attempts", async ({ request }) => {
  await ensureWorkspace(request);
  const id = await uploadContract(request, "exhausted");
  await waitForRun(request, id, "extraction");
  const finding = (await getContract(request, id)).findings.find((f) => f.eligible);
  if (!finding) throw new Error("fixture has no verified finding");

  await jiraControl("fail", { method: "POST", pathPrefix: "/rest/api/3/issue", status: 500, times: 5 });
  for (let attempt = 1; attempt <= 5; attempt++) {
    expect((await publish(request, id, [finding.id])).failed).toHaveLength(1);
  }
  const activity = (await (await request.get("/api/jira/activity")).json()) as {
    failedPublishes: Array<{ findingId: string; status: string }>;
  };
  expect(activity.failedPublishes.find((j) => j.findingId === finding.id)?.status).toBe("failed");

  const revived = await publish(request, id, [finding.id]);
  expect(revived.published[0]?.operation).toBe("created");
});

test("a rate-limited publish waits for Retry-After", async ({ request }) => {
  await ensureWorkspace(request);
  const id = await uploadContract(request, "retry-429");
  await waitForRun(request, id, "extraction");
  const finding = (await getContract(request, id)).findings.find((f) => f.eligible);
  if (!finding) throw new Error("fixture has no verified finding");

  await jiraControl("fail", {
    method: "POST",
    pathPrefix: "/rest/api/3/search/jql",
    status: 429,
    times: 1,
    retryAfter: 2,
  });
  const started = Date.now();
  const result = await publish(request, id, [finding.id]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
  expect(result.published[0]?.operation).toBe("created");
});

test("a publish that keeps failing is queued and succeeds on retry", async ({ page }, testInfo) => {
  await ensureWorkspace(page.request);
  const id = await uploadContract(page.request, "retry-outbox");
  await waitForRun(page.request, id, "extraction");
  const finding = (await getContract(page.request, id)).findings.find((f) => f.eligible);
  if (!finding) throw new Error("fixture has no verified finding");
  const issuesBefore = (await jiraState()).issues.length;

  await jiraControl("fail", { method: "POST", pathPrefix: "/rest/api/3/issue", status: 500, times: 1 });
  const first = await publish(page.request, id, [finding.id]);
  expect(first.failed).toHaveLength(1);
  expect(first.failed[0]?.error).toContain("Jira returned 500");

  // The failure shows up where admins look for it.
  await page.goto("/jira");
  await expect(page.getByText("Publishes waiting on a retry")).toBeVisible();
  await expect(page.getByText(new RegExp(`${finding.id}`))).toBeVisible();

  // After the backoff, publishing again picks up the queued job and succeeds.
  await page.waitForTimeout(1500);
  const second = await publish(page.request, id, [finding.id]);
  expect(second.failed).toHaveLength(0);
  expect(second.published[0]?.operation).toBe("created");
  const jira = await jiraState();
  await attachJiraState(testInfo);
  expect(jira.issues.length).toBe(issuesBefore + 1);
});
