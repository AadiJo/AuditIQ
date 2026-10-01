import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.ts";
import { seal, unseal } from "../crypto.ts";
import { db } from "../db/client.ts";
import { jiraIssues, jiraLinks } from "../db/schema.ts";
import { JiraClient, JiraError, resolveConnection } from "../jira/client.ts";
import { allRuntimes } from "../runtimes/index.ts";
import { getSetting, setSetting, updateSetting } from "../settings.ts";
import { type AppEnv, badRequest, requireAdmin, requireUser, validate } from "./context.ts";

// Admin settings. Secrets are write-only: the API accepts new values and returns only the
// last four characters of what's stored.

function connectedClient(): JiraClient {
  const jira = getSetting("jira");
  const token = jira.apiToken ? unseal(jira.apiToken) : null;
  if (!token || !jira.apiBaseUrl) badRequest("Connect to Jira first.", 409);
  return new JiraClient({ baseUrl: jira.apiBaseUrl, email: jira.email, token });
}

async function jiraCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof JiraError) badRequest(error.message);
    throw error;
  }
}

function jiraView() {
  const jira = getSetting("jira");
  return {
    siteUrl: jira.siteUrl,
    email: jira.email,
    tokenHint: jira.apiToken?.hint ?? null,
    tokenReadable: jira.apiToken ? unseal(jira.apiToken) !== null : null,
    displayName: jira.displayName,
    accountId: jira.accountId,
    projectKey: jira.projectKey,
    projectName: jira.projectName,
    issueTypeId: jira.issueTypeId,
    issueTypeName: jira.issueTypeName,
    priorities: jira.priorities,
  };
}

const Priority = z.object({ id: z.string(), name: z.string() }).nullable();
const RuntimeConfig = z.object({ model: z.string().min(1), effort: z.enum(["low", "medium", "high"]) });

export const settingsRoutes = new Hono<AppEnv>()
  .use(requireUser, requireAdmin)
  .get("/jira", (c) => c.json(jiraView()))

  // Checks the credentials against Jira before saving anything.
  .put(
    "/jira/connection",
    validate(
      "json",
      z.object({ siteUrl: z.string().min(1), email: z.string().email(), apiToken: z.string().min(1).optional() }),
    ),
    async (c) => {
      const body = c.req.valid("json");
      const current = getSetting("jira");
      const siteUrl = body.siteUrl.trim().replace(/\/+$/, "");
      const siteChanged = siteUrl !== current.siteUrl;
      // The stored token is only ever sent back to the site and account it was entered for,
      // so it can't be redirected to another server by editing the URL.
      if (!body.apiToken && (siteChanged || body.email !== current.email)) {
        badRequest("Enter the API token again when you change the site or email.");
      }
      const token = body.apiToken ?? (current.apiToken ? unseal(current.apiToken) : null);
      if (!token) badRequest("Enter an API token.");
      const { baseUrl, me } = await jiraCall(() => resolveConnection(siteUrl, body.email, token));
      if (siteChanged) {
        // Issue keys from the old site mean nothing on the new one.
        db.delete(jiraLinks).run();
        db.delete(jiraIssues).run();
        updateSetting("poll", (poll) => ({ ...poll, watermark: null }));
      }
      setSetting("jira", {
        ...current,
        siteUrl,
        email: body.email,
        apiToken: body.apiToken ? seal(body.apiToken) : current.apiToken,
        apiBaseUrl: baseUrl,
        accountId: me.accountId,
        displayName: me.displayName,
        ...(siteChanged
          ? {
              projectKey: "",
              projectName: "",
              issueTypeId: "",
              issueTypeName: "",
              priorities: { high: null, medium: null, low: null },
            }
          : {}),
      });
      audit(
        "settings.jira.connected",
        { type: "settings", id: "jira" },
        { siteUrl: body.siteUrl, account: me.displayName },
        c.var.user.id,
      );
      return c.json(jiraView());
    },
  )
  .get("/jira/projects", async (c) => c.json({ projects: await jiraCall(() => connectedClient().projects()) }))
  .get("/jira/issue-types", validate("query", z.object({ project: z.string().min(1) })), async (c) =>
    c.json({ issueTypes: await jiraCall(() => connectedClient().issueTypes(c.req.valid("query").project)) }),
  )
  .get("/jira/priorities", async (c) => c.json({ priorities: await jiraCall(() => connectedClient().priorities()) }))
  .put(
    "/jira/project",
    validate(
      "json",
      z.object({
        projectKey: z.string().min(1),
        projectName: z.string(),
        issueTypeId: z.string().min(1),
        issueTypeName: z.string(),
        priorities: z.object({ high: Priority, medium: Priority, low: Priority }),
      }),
    ),
    (c) => {
      const body = c.req.valid("json");
      updateSetting("jira", (current) => ({ ...current, ...body }));
      // A new project starts polling from scratch.
      updateSetting("poll", (current) => ({ ...current, watermark: null }));
      audit("settings.jira.project", { type: "settings", id: "jira" }, body, c.var.user.id);
      return c.json(jiraView());
    },
  )

  .get("/runtime", async (c) => {
    const settings = getSetting("runtime");
    const statuses = await Promise.all(allRuntimes().map((runtime) => runtime.status()));
    return c.json({
      default: settings.default,
      allowOverride: settings.allowOverride,
      claude: {
        model: settings.claude.model,
        effort: settings.claude.effort,
        keyHint: settings.claude.apiKey?.hint ?? null,
      },
      codex: {
        model: settings.codex.model,
        effort: settings.codex.effort,
        keyHint: settings.codex.apiKey?.hint ?? null,
      },
      statuses,
    });
  })
  .put(
    "/runtime",
    validate(
      "json",
      z.object({
        default: z.enum(["claude", "codex"]),
        allowOverride: z.boolean(),
        claude: RuntimeConfig,
        codex: RuntimeConfig,
      }),
    ),
    (c) => {
      const body = c.req.valid("json");
      updateSetting("runtime", (current) => ({
        ...body,
        claude: { ...body.claude, apiKey: current.claude.apiKey },
        codex: { ...body.codex, apiKey: current.codex.apiKey },
      }));
      audit("settings.runtime", { type: "settings", id: "runtime" }, body, c.var.user.id);
      return c.json({ ok: true });
    },
  )
  .put("/runtime/:id/key", validate("json", z.object({ apiKey: z.string().min(8).nullable() })), (c) => {
    const id = z.enum(["claude", "codex"]).parse(c.req.param("id"));
    const { apiKey } = c.req.valid("json");
    updateSetting("runtime", (current) => ({
      ...current,
      [id]: { ...current[id], apiKey: apiKey ? seal(apiKey) : null },
    }));
    audit(
      "settings.runtime.key",
      { type: "settings", id: `runtime.${id}` },
      { cleared: apiKey === null },
      c.var.user.id,
    );
    return c.json({ ok: true });
  })

  .get("/watcher", (c) => c.json(getSetting("watcher")))
  .put("/watcher", validate("json", z.object({ mode: z.enum(["off", "shadow", "assist"]) })), (c) => {
    const body = setSetting("watcher", c.req.valid("json"));
    audit("settings.watcher", { type: "settings", id: "watcher" }, body, c.var.user.id);
    return c.json(body);
  });
