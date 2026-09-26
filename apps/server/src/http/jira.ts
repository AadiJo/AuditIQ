import { desc } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client.ts";
import { jiraChanges, outbox, watcherDecisions } from "../db/schema.ts";
import { poll } from "../jira/poller.ts";
import { configuredJira } from "../jira/publisher.ts";
import { postPendingReplies } from "../jira/watcher.ts";
import { getSetting } from "../settings.ts";
import { type AppEnv, badRequest, requireAdmin, requireUser } from "./context.ts";

export const jiraRoutes = new Hono<AppEnv>()
  .use(requireUser)
  // What changed in Jira and what the watcher did about it, newest first.
  .get("/activity", (c) => {
    const jira = getSetting("jira");
    return c.json({
      configured: Boolean(configuredJira()),
      siteUrl: jira.siteUrl,
      projectKey: jira.projectKey,
      watcherMode: getSetting("watcher").mode,
      poll: getSetting("poll"),
      changes: db.select().from(jiraChanges).orderBy(desc(jiraChanges.observedAt)).limit(100).all(),
      decisions: db.select().from(watcherDecisions).orderBy(desc(watcherDecisions.createdAt)).limit(100).all(),
      failedPublishes: db
        .select()
        .from(outbox)
        .orderBy(desc(outbox.createdAt))
        .limit(100)
        .all()
        .filter((j) => j.status === "failed" || j.status === "retry"),
    });
  })
  .post("/poll", requireAdmin, async (c) => {
    const running = poll();
    if (!running) badRequest("Connect Jira in Settings first.", 409);
    const result = await running;
    await postPendingReplies();
    return c.json(result);
  });
