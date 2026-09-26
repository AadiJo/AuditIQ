import { asc } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client.ts";
import {
  auditEvents,
  findingObservations,
  findings,
  jiraChanges,
  jiraLinks,
  outbox,
  runs,
  watcherDecisions,
} from "../db/schema.ts";
import { type AppEnv, requireAdmin, requireUser } from "./context.ts";

export const auditRoutes = new Hono<AppEnv>()
  .use(requireUser, requireAdmin)
  // Everything an auditor needs to reconstruct what AuditIQ did. Secrets and sessions are excluded.
  .get("/export", (c) => {
    const generatedAt = new Date().toISOString();
    c.header(
      "Content-Disposition",
      `attachment; filename="auditiq-audit-${generatedAt.slice(0, 19).replace(/:/g, "-")}.json"`,
    );
    return c.json({
      generatedAt,
      runs: db.select().from(runs).orderBy(asc(runs.createdAt)).all(),
      findings: db.select().from(findings).orderBy(asc(findings.firstSeenAt)).all(),
      findingObservations: db.select().from(findingObservations).all(),
      jiraLinks: db.select().from(jiraLinks).all(),
      outbox: db.select().from(outbox).all(),
      jiraChanges: db.select().from(jiraChanges).all(),
      watcherDecisions: db.select().from(watcherDecisions).all(),
      auditEvents: db.select().from(auditEvents).orderBy(asc(auditEvents.id)).all(),
    });
  });
