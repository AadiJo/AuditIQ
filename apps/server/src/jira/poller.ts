import { eq } from "drizzle-orm";
import { audit } from "../audit.ts";
import { db } from "../db/client.ts";
import { findings, type JiraCommentSnapshot, jiraChanges, jiraIssues, jiraLinks } from "../db/schema.ts";
import { getSetting, updateSetting } from "../settings.ts";
import { adfToText } from "./adf.ts";
import { type Issue, issueFields, type JiraClient } from "./client.ts";
import { configuredJira, findingIdFromLabels, MANAGED_LABEL } from "./publisher.ts";
import { considerComment } from "./watcher.ts";

// Pulls changes to AuditIQ-managed issues. Each poll searches from a stored watermark minus
// an overlap window, and every issue update and comment is recorded once by its Jira id,
// so overlapping polls and restarts don't double-process anything. Polling needs no
// public URL, which keeps self-hosting behind a firewall simple.

const OVERLAP_MS = 5 * 60_000;
let polling: Promise<PollResult> | null = null;

export type PollResult = { issues: number; changes: number; decisions: number };

/**
 * A relative JQL window ("-17m") covering everything since `since`. Jira evaluates relative
 * dates against its own clock, so neither server clocks nor the account's time zone matter.
 */
function jqlSince(since: string): string {
  return `-${Math.ceil((Date.now() - new Date(since).getTime()) / 60_000) + 1}m`;
}

function snapshotComments(issue: Issue): JiraCommentSnapshot[] {
  return (issue.fields.comment?.comments ?? []).map((c) => ({
    id: c.id,
    authorAccountId: c.author?.accountId ?? null,
    authorName: c.author?.displayName ?? "Unknown",
    body: adfToText(c.body).trim(),
    created: c.created,
  }));
}

async function pollOnce(client: JiraClient, projectKey: string, accountId: string): Promise<PollResult> {
  const startedAt = new Date().toISOString();
  const state = getSetting("poll");
  const since = state.watermark ? new Date(new Date(state.watermark).getTime() - OVERLAP_MS).toISOString() : null;
  const jql = `project = "${projectKey}" AND labels = "${MANAGED_LABEL}"${since ? ` AND updated >= "${jqlSince(since)}"` : ""} ORDER BY updated ASC`;

  let changes = 0;
  let decisions = 0;
  const issues = await client.search(jql, issueFields);
  for (const found of issues) {
    let issue = found;
    const total = issue.fields.comment?.total ?? 0;
    if (total > (issue.fields.comment?.comments.length ?? 0)) {
      issue = { ...issue, fields: { ...issue.fields, comment: { comments: await client.comments(issue.key), total } } };
    }
    const labels = issue.fields.labels ?? [];
    const comments = snapshotComments(issue);
    const findingId = findingIdFromLabels(labels);
    const known = findingId
      ? db.select({ id: findings.id }).from(findings).where(eq(findings.id, findingId)).get()
      : undefined;
    const remoteUpdatedAt = issue.fields.updated ?? startedAt;

    const snapshot = {
      issueId: issue.id,
      findingId: known?.id ?? null,
      summary: issue.fields.summary ?? "",
      status: issue.fields.status?.name ?? "Unknown",
      statusCategory: issue.fields.status?.statusCategory?.key ?? "undefined",
      assigneeName: issue.fields.assignee?.displayName ?? null,
      labels,
      comments,
      remoteUpdatedAt,
      observedAt: startedAt,
    };
    db.insert(jiraIssues)
      .values({ issueKey: issue.key, ...snapshot })
      .onConflictDoUpdate({ target: jiraIssues.issueKey, set: snapshot })
      .run();

    if (known) {
      db.update(jiraLinks)
        .set({
          status: snapshot.status,
          statusCategory: snapshot.statusCategory as "new" | "indeterminate" | "done",
          assigneeName: snapshot.assigneeName,
          remoteUpdatedAt,
          drift: "in_sync",
        })
        .where(eq(jiraLinks.findingId, known.id))
        .run();
    }

    const issueChange = db
      .insert(jiraChanges)
      .values({
        changeKey: `issue:${issue.id}:${remoteUpdatedAt}`,
        issueKey: issue.key,
        kind: "issue",
        changedAt: remoteUpdatedAt,
        payload: { status: snapshot.status, assignee: snapshot.assigneeName },
      })
      .onConflictDoNothing()
      .run();
    changes += issueChange.changes;

    for (const comment of comments) {
      const changeKey = `comment:${issue.id}:${comment.id}`;
      const inserted = db
        .insert(jiraChanges)
        .values({ changeKey, issueKey: issue.key, kind: "comment", changedAt: comment.created, payload: comment })
        .onConflictDoNothing()
        .run();
      changes += inserted.changes;
      if (await considerComment(issue.key, comment, changeKey, accountId)) decisions++;
    }
  }

  updateSetting("poll", (current) => ({ ...current, watermark: startedAt, lastSuccessAt: startedAt, lastError: null }));
  if (changes || decisions)
    audit("jira.poll", { type: "jira_project", id: projectKey }, { issues: issues.length, changes, decisions });
  return { issues: issues.length, changes, decisions };
}

/** Polls once. Concurrent callers share the in-flight poll instead of starting another. */
export function poll(): Promise<PollResult> | null {
  const jira = configuredJira();
  if (!jira) return null;
  polling ??= pollOnce(jira.client, jira.settings.projectKey, jira.settings.accountId)
    .catch((error: Error) => {
      updateSetting("poll", (current) => ({ ...current, lastError: error.message.slice(0, 1000) }));
      throw error;
    })
    .finally(() => {
      polling = null;
    });
  return polling;
}

/** Marks links whose issue was deleted, moved, or stripped of AuditIQ labels. */
export async function reconcile(): Promise<{ checked: number; drifted: number }> {
  const jira = configuredJira();
  if (!jira) return { checked: 0, drifted: 0 };
  let drifted = 0;
  const links = db.select().from(jiraLinks).all();
  for (const link of links) {
    const issue = await jira.client.issue(link.issueKey);
    const drift = !issue
      ? "missing"
      : findingIdFromLabels(issue.fields.labels ?? []) === link.findingId
        ? "in_sync"
        : "unmanaged";
    if (drift !== "in_sync") drifted++;
    db.update(jiraLinks)
      .set({ drift, reconciledAt: new Date().toISOString() })
      .where(eq(jiraLinks.findingId, link.findingId))
      .run();
  }
  updateSetting("poll", (current) => ({ ...current, lastReconcileAt: new Date().toISOString() }));
  return { checked: links.length, drifted };
}
