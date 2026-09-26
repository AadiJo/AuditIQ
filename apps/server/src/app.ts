import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { auth } from "./auth.ts";
import { env } from "./env.ts";
import { auditRoutes } from "./http/audit.ts";
import { contractRoutes } from "./http/contracts.ts";
import { findingRoutes } from "./http/findings.ts";
import { jiraRoutes } from "./http/jira.ts";
import { memberRoutes } from "./http/members.ts";
import { runRoutes } from "./http/runs.ts";
import { settingsRoutes } from "./http/settings.ts";
import { setupRoutes } from "./http/setup.ts";

const api = new Hono()
  .route("/setup", setupRoutes)
  .route("/contracts", contractRoutes)
  .route("/runs", runRoutes)
  .route("/findings", findingRoutes)
  .route("/jira", jiraRoutes)
  .route("/settings", settingsRoutes)
  .route("/members", memberRoutes)
  .route("/audit", auditRoutes);

export type AppType = typeof api;

export const app = new Hono();

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api", api);
app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));

// The built web app, when present. Any other path falls back to index.html for client routing.
const webDist = env.WEB_DIST ?? path.resolve(import.meta.dirname, "../../web/dist");
if (fs.existsSync(path.join(webDist, "index.html"))) {
  const root = path.relative(process.cwd(), webDist);
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "index.html" }));
}

app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  console.error(error);
  return c.json({ error: "Something went wrong on the server. Check the server log for details." }, 500);
});
