import { defineConfig } from "@playwright/test";
import { APP, JIRA_URL, ports } from "./e2e/env.ts";

// End-to-end tests run the real server and web app against a fake Jira and recorded model
// output. Every run leaves an HTML report with traces and screenshots in e2e/.artifacts,
// plus a JSON dump of what the fake Jira received for each test.

export default defineConfig({
  testDir: "e2e/tests",
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { outputFolder: "e2e/.artifacts/report", open: "never" }]],
  outputDir: "e2e/.artifacts/results",
  use: {
    baseURL: APP,
    viewport: { width: 1440, height: 900 },
    trace: "on",
    screenshot: "on",
  },
  webServer: [
    {
      command: `node e2e/fake-jira.ts ${ports.jira}`,
      url: `${JIRA_URL}/__control/state`,
      reuseExistingServer: false,
    },
    {
      command: "node e2e/start-app.ts",
      url: `${APP}/api/setup/state`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: "pipe",
    },
  ],
});
