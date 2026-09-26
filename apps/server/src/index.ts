import { serve } from "@hono/node-server";
import { app } from "./app.ts";
import { migrateDatabase } from "./db/client.ts";
import { env } from "./env.ts";
import { startJiraSync } from "./jira/service.ts";
import { resumeRuns } from "./runs/runner.ts";

migrateDatabase();
resumeRuns();
startJiraSync();

const server = serve({ fetch: app.fetch, hostname: env.HOST, port: env.PORT }, (info) => {
  console.log(`AuditIQ listening on http://${info.address}:${info.port} (data in ${env.DATA_DIR})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
