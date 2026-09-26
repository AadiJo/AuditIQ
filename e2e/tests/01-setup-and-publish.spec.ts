import path from "node:path";
import { expect, test } from "@playwright/test";
import { buildFixtures } from "../fixtures/build.ts";
import {
  attachJiraState,
  getContract,
  JIRA,
  jiraState,
  OWNER,
  originHeaders,
  publish,
  startRun,
  waitForRun,
} from "../helpers.ts";

// The first-run path, end to end: owner sign-up, the setup wizard against the fake Jira,
// uploading a contract, both analysis steps, and publishing. Later steps rely on earlier
// ones, so this file runs in order.

test.describe.configure({ mode: "serial" });

let contractId = "";

test("owner signs up and connects Jira in the setup wizard", async ({ page }) => {
  await page.goto("/contracts");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Create the owner account" })).toBeVisible();
  await page.getByLabel("Name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByText("Set up AuditIQ, step 1 of 2")).toBeVisible();
  await page.getByLabel("Site URL").fill(JIRA.siteUrl);
  await page.getByLabel("Email").fill(JIRA.email);
  await page.getByLabel("API token").fill(JIRA.token);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText(/^Connected to .*:5199 as AuditIQ Service\.$/)).toBeVisible();

  await page.getByLabel("Project").selectOption("AISBX");
  await page.getByLabel("Issue type").selectOption("10001");
  // The priority mapping pre-fills Jira's High, Medium, and Low.
  await expect(page.locator("select").nth(2)).toHaveValue("2");
  await page.getByRole("button", { name: "Save and continue" }).click();

  await expect(page.getByText("Set up AuditIQ, step 2 of 2")).toBeVisible();
  await expect(page.getByText("API key, replay").first()).toBeVisible();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/contracts$/);
  await expect(page.getByText("Jira isn't connected yet")).toHaveCount(0);
});

test("uploading a contract runs extraction and shows verified findings", async ({ page }, testInfo) => {
  const { docx } = await buildFixtures(testInfo.outputPath("fixtures"));
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/contracts$/);

  await page.locator("input[type=file]").setInputFiles(docx);
  await expect(page).toHaveURL(/\/contracts\/[0-9a-f-]+/);
  contractId = page.url().split("/contracts/")[1]?.split("?")[0] ?? "";

  // Progress streams from the server while the run replays.
  await expect(page.getByText(/Extraction is (queued|running)/)).toBeVisible();
  await expect(page.getByText("Extracting terms and findings")).toBeVisible();
  await expect(page.getByText(/19 findings, 0 in Jira, 1 held back/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "NW-2026-0187" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("extraction.png") });

  // The held-back finding explains itself and can't be selected for publishing.
  const heldBack = page.getByRole("button", { name: /Held back/ }).first();
  await heldBack.click();
  await expect(page.getByText("Held back from Jira")).toBeVisible();
  await expect(page.getByText(/doesn't match the text of clause/)).toBeVisible();
});

test("the accounting review merges repeated issues into existing findings", async ({ page }) => {
  await page.request.post("/api/auth/sign-in/email", { data: OWNER, headers: originHeaders });
  await page.goto(`/contracts/${contractId}`);
  await page.getByRole("button", { name: "Accounting review", exact: true }).click();
  await page.getByRole("button", { name: "Run accounting review" }).click();
  await expect(page.getByText("Drafting accounting conclusions")).toBeVisible();
  await waitForRun(page.request, contractId, "accounting");

  const contract = await getContract(page.request, contractId);
  // Extraction raised 19 findings. The review raised 20, and all but one landed on an existing finding.
  expect(contract.findings).toHaveLength(20);
  await expect(page.getByText(/20 findings, 0 in Jira, 1 held back/)).toBeVisible();
});

test("publishing creates one Jira issue per verified finding", async ({ page }, testInfo) => {
  await page.request.post("/api/auth/sign-in/email", { data: OWNER, headers: originHeaders });
  await page.goto(`/contracts/${contractId}`);
  await page.getByRole("button", { name: "Publish 19 to Jira" }).click();
  await expect(page.getByText(/AuditIQ creates one issue per finding in AISBX/)).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Published to Jira" })).toBeVisible();
  await expect(page.getByRole("dialog").getByText("created", { exact: true })).toHaveCount(19);
  await page.screenshot({ path: testInfo.outputPath("published.png") });

  const jira = await jiraState();
  await attachJiraState(testInfo);
  expect(jira.issues).toHaveLength(19);
  const contract = await getContract(page.request, contractId);
  const priorityFor = { high: "2", medium: "3", low: "4" } as Record<string, string>;
  for (const finding of contract.findings.filter((f) => f.eligible)) {
    const issue = jira.issues.find((i) => i.fields.labels.includes(`auditiq-fnd-${finding.id.slice(4).toLowerCase()}`));
    expect(issue, finding.title).toBeTruthy();
    expect(issue?.fields.labels).toContain("auditiq");
    expect(issue?.fields.priority?.id).toBe(priorityFor[finding.severity]);
    expect(issue?.fields.summary).toBe(finding.title);
  }
  // The held-back finding never reaches Jira.
  const held = contract.findings.find((f) => !f.eligible);
  expect(jira.issues.some((i) => i.fields.summary === held?.title)).toBe(false);

  await page.keyboard.press("Escape");
  await expect(page.getByText(/20 findings, 19 in Jira, 1 held back/)).toBeVisible();
});

test("publishing again changes nothing in Jira", async ({ request }, testInfo) => {
  await request.post("/api/auth/sign-in/email", { data: OWNER, headers: originHeaders });
  const before = await jiraState();
  const contract = await getContract(request, contractId);
  const result = await publish(
    request,
    contractId,
    contract.findings.map((f) => f.id),
  );
  expect(result.published.every((p) => p.operation === "linked")).toBe(true);
  expect(result.published).toHaveLength(19);
  expect(result.blocked).toHaveLength(1);
  const after = await jiraState();
  await attachJiraState(testInfo);
  expect(after.issues).toHaveLength(before.issues.length);
  expect(after.requests.filter((r) => r.method === "POST" && r.path === "/rest/api/3/issue")).toHaveLength(19);
});

test("a rerun adds a note to existing issues instead of creating new ones", async ({ request }, testInfo) => {
  await request.post("/api/auth/sign-in/email", { data: OWNER, headers: originHeaders });
  await startRun(request, contractId, "extraction");
  expect((await waitForRun(request, contractId, "extraction")).status).toBe("succeeded");

  const contract = await getContract(request, contractId);
  expect(contract.findings).toHaveLength(20);
  const extractionFindings = contract.findings.filter((f) => f.eligible).map((f) => f.id);
  const result = await publish(request, contractId, extractionFindings);
  const jira = await jiraState();
  await attachJiraState(testInfo);
  expect(jira.issues).toHaveLength(19);
  expect(result.published.filter((p) => p.operation === "commented").length).toBeGreaterThan(0);
  expect(result.published.every((p) => p.operation !== "created")).toBe(true);
  const noted = jira.issues.filter((i) =>
    i.fields.comment.comments.some((c) => JSON.stringify(c.body).includes("raised this finding again")),
  );
  expect(noted.length).toBe(result.published.filter((p) => p.operation === "commented").length);
});

test.afterAll(async () => {
  // Keep the built fixtures next to the report for anyone checking the run.
  await buildFixtures(path.resolve(import.meta.dirname, "../.artifacts/fixtures"));
});
