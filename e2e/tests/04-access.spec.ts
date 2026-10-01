import { expect, test } from "@playwright/test";
import { ensureWorkspace, originHeaders, startRun, uploadContract, waitForRun } from "../helpers.ts";

// Roles and shared state: an invited reviewer can work on contracts but can't touch
// settings, and a run started by one person shows the same live progress to another.

const REVIEWER = { name: "Riley Reviewer", email: "riley@example.com", password: "another-good-password" };

test("an invited reviewer joins, sees shared runs, and can't reach settings", async ({ browser, request }) => {
  await ensureWorkspace(request);
  const invite = await request.post("/api/members/invites", {
    data: { email: REVIEWER.email, role: "reviewer" },
    headers: originHeaders,
  });
  expect(invite.ok(), await invite.text()).toBeTruthy();
  const { link } = (await invite.json()) as { link: string };

  // Knowing the invited address isn't enough: sign-up needs the invite link.
  const guessed = await request.post("/api/auth/sign-up/email", {
    data: { name: "Guesser", email: REVIEWER.email, password: "a-long-password" },
    headers: originHeaders,
  });
  expect(guessed.status()).toBe(403);

  // Sign-up without an invite is refused.
  const stranger = await request.post("/api/auth/sign-up/email", {
    data: { name: "Mallory", email: "mallory@example.com", password: "a-long-password" },
    headers: originHeaders,
  });
  expect(stranger.status()).toBe(403);

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(new URL(link).pathname);
  await expect(page.getByText("You were invited as a reviewer.")).toBeVisible();
  await page.getByLabel("Name").fill(REVIEWER.name);
  await page.getByLabel("Password").fill(REVIEWER.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/contracts$/);
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);

  // The owner starts a run; the reviewer watches it on their own screen.
  const id = await uploadContract(request, "shared-run");
  await waitForRun(request, id, "extraction");
  await startRun(request, id, "accounting");
  await page.goto(`/contracts/${id}?step=accounting`);
  await expect(page.getByText(/Accounting review \(AGT-002\) is (queued|running)/)).toBeVisible();
  await expect(page.getByText(/findings, \d+ in Jira/)).toBeVisible({ timeout: 30_000 });

  expect((await page.request.get("/api/settings/jira")).status()).toBe(403);
  await page.goto("/settings/jira");
  await expect(page).toHaveURL(/\/contracts$/);
  await context.close();
});
