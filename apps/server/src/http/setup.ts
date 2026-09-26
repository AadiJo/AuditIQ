import { and, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { hasUsers } from "../auth.ts";
import { db } from "../db/client.ts";
import { invites } from "../db/schema.ts";
import { getSetting } from "../settings.ts";
import { type AppEnv, requireUser } from "./context.ts";

export const setupRoutes = new Hono<AppEnv>()
  // Public: tells the sign-in page whether to show owner sign-up.
  .get("/state", (c) => c.json({ needsOwner: !hasUsers() }))
  // Public: the join page shows who an invite is for.
  .get("/invite/:id", (c) => {
    const invite = db
      .select({ email: invites.email, role: invites.role })
      .from(invites)
      .where(
        and(
          eq(invites.id, c.req.param("id")),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, new Date().toISOString()),
        ),
      )
      .get();
    return c.json({ invite: invite ?? null });
  })
  .get("/me", requireUser, (c) => {
    const jira = getSetting("jira");
    const runtime = getSetting("runtime");
    return c.json({
      user: {
        id: c.var.user.id,
        name: c.var.user.name,
        email: c.var.user.email,
        role: c.var.user.role as "admin" | "reviewer",
      },
      jira: jira.projectKey && jira.issueTypeId ? { siteUrl: jira.siteUrl, projectKey: jira.projectKey } : null,
      runtime: { default: runtime.default, allowOverride: runtime.allowOverride },
    });
  });
