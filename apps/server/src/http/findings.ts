import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client.ts";
import { findingObservations, jiraLinks, runs, watcherDecisions } from "../db/schema.ts";
import { type AppEnv, badRequest, requireUser } from "./context.ts";
import { findingViews, jiraThread } from "./views.ts";

export const findingRoutes = new Hono<AppEnv>()
  .use(requireUser)
  .get("/", (c) => c.json({ findings: findingViews() }))
  .get("/:id", (c) => {
    const [finding] = findingViews({ ids: [c.req.param("id")] });
    if (!finding) badRequest("That finding doesn't exist.", 404);
    const observations = db
      .select({
        agent: findingObservations.agent,
        runId: findingObservations.runId,
        title: findingObservations.title,
        severity: findingObservations.severity,
        createdAt: findingObservations.createdAt,
        model: runs.model,
        runtime: runs.runtime,
      })
      .from(findingObservations)
      .innerJoin(runs, eq(runs.id, findingObservations.runId))
      .where(eq(findingObservations.findingId, finding.id))
      .orderBy(desc(findingObservations.createdAt))
      .all();
    const link = db.select().from(jiraLinks).where(eq(jiraLinks.findingId, finding.id)).get();
    const thread = link ? jiraThread(link.issueKey) : null;
    const decisions = link
      ? db
          .select()
          .from(watcherDecisions)
          .where(eq(watcherDecisions.issueKey, link.issueKey))
          .orderBy(desc(watcherDecisions.createdAt))
          .all()
      : [];
    return c.json({
      finding,
      observations,
      jira: thread && {
        key: thread.issueKey,
        status: thread.status,
        assignee: thread.assigneeName,
        comments: thread.comments,
        observedAt: thread.observedAt,
      },
      watcher: decisions.map((d) => ({
        id: d.id,
        status: d.status,
        policy: d.policy,
        reply: d.reply,
        confidence: d.confidence,
        createdAt: d.createdAt,
        executedAt: d.executedAt,
        lastError: d.lastError,
      })),
    });
  });
