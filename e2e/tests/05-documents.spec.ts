import { expect, test } from "@playwright/test";
import { buildFixtures, zip } from "../fixtures/build.ts";
import {
  ensureWorkspace,
  getContract,
  originHeaders,
  removeReplay,
  setReplay,
  uploadContract,
  waitForRun,
} from "../helpers.ts";

// Documents and failures: PDFs get the same clause anchors as DOCX files, unsupported
// files are refused with a clear message, and a failed run says what went wrong.

test("a PDF contract gets clause anchors and verified findings", async ({ page }, testInfo) => {
  await ensureWorkspace(page.request);
  const { pdf } = await buildFixtures(testInfo.outputPath("fixtures"));
  await page.goto("/contracts");
  await page.locator("input[type=file]").setInputFiles(pdf);
  await expect(page).toHaveURL(/\/contracts\/[0-9a-f-]+/);
  const id = page.url().split("/contracts/")[1]?.split("?")[0] ?? "";
  await waitForRun(page.request, id, "extraction");

  const contract = await getContract(page.request, id);
  expect(contract.findings.filter((f) => f.eligible).length).toBe(18);
  await page.getByRole("button", { name: "Read" }).click();
  await expect(page.getByRole("button", { name: /Article 7 Renewal/ })).toBeVisible();
  await page.getByRole("button", { name: /Article 7 Renewal/ }).click();
  await expect(page.getByText("7.2 Renewal Price.")).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("pdf-read.png") });
});

test("unsupported files are refused", async ({ request }) => {
  await ensureWorkspace(request);
  const response = await request.post("/api/contracts", {
    headers: originHeaders,
    multipart: { file: { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") } },
  });
  expect(response.status()).toBe(400);
  expect(((await response.json()) as { error: string }).error).toBe("Upload a contract as a DOCX or PDF file.");
});

test("a malformed DOCX is refused right away", async ({ request }) => {
  await ensureWorkspace(request);
  // An unterminated XML declaration used to send the parser into an endless loop.
  const hostile = zip([{ name: "word/document.xml", data: Buffer.from("<?a<?") }]);
  const started = Date.now();
  const response = await request.post("/api/contracts", {
    headers: originHeaders,
    multipart: { file: { name: "hostile.docx", mimeType: "application/octet-stream", buffer: hostile } },
  });
  expect(response.status()).toBe(400);
  expect(((await response.json()) as { error: string }).error).toContain("malformed");
  expect(Date.now() - started).toBeLessThan(2000);
  expect((await request.get("/api/setup/state")).ok()).toBeTruthy();
});

test("a failed run explains itself", async ({ page }) => {
  await ensureWorkspace(page.request);
  await setReplay("extraction.fail.json", {
    error: "The model's output didn't match the expected format (summary: Required).",
  });
  try {
    const id = await uploadContract(page.request, "failing");
    expect((await waitForRun(page.request, id, "extraction")).status).toBe("failed");
    await page.goto(`/contracts/${id}`);
    await expect(page.getByText("Extraction failed")).toBeVisible();
    await expect(page.getByText(/didn't match the expected format/)).toBeVisible();
    await page.goto("/contracts");
    await expect(
      page.getByRole("row").filter({ hasText: "northwind-failing.docx" }).getByText("Extraction failed"),
    ).toBeVisible();
  } finally {
    await removeReplay("extraction.fail.json");
  }
});
