import { randomUUID } from "node:crypto";
import { and, eq, inArray, lte, or } from "drizzle-orm";
import { audit } from "../audit.ts";
import { unseal } from "../crypto.ts";
import { db } from "../db/client.ts";
import { documents, findingObservations, findings, jiraLinks, outbox } from "../db/schema.ts";
import { env } from "../env.ts";
import { getSetting, type JiraSettings } from "../settings.ts";
import { findingDescription, reobservedComment } from "./adf.ts";
import { type Issue, JiraClient } from "./client.ts";

// Publishing goes through an outbox. Each finding gets one row per run, and every Jira
// write checks for an existing issue first (by the finding's label), so replays, retries,
// and restarts never create a second issue for the same finding.

export const MANAGED_LABEL = "auditiq";
const MAX_ATTEMPTS = 5;

export class JiraNotConfiguredError extends Error {
  constructor() {
    super("Connect Jira in Settings before publishing.");
  }
}

export function findingLabel(findingId: string): string {
  return `auditiq-fnd-${findingId.replace(/^FND-/, "").toLowerCase()}`;
}

export function findingIdFromLabels(labels: string[]): string | null {
  const label = labels.find((l) => l.startsWith("auditiq-fnd-"));
  return label ? `FND-${label.slice("auditiq-fnd-".length).toUpperCase()}` : null;
}

/** A client for the configured Jira project, or null when Jira isn't set up yet. */
export function configuredJira(): { client: JiraClient; settings: JiraSettings } | null {
  const settings = getSetting("jira");
  const token = settings.apiToken ? unseal(settings.apiToken) : null;
  if (!token || !settings.apiBaseUrl || !settings.projectKey || !settings.issueTypeId) return null;
  return { client: new JiraClient({ baseUrl: settings.apiBaseUrl, email: settings.email, token }), settings };
}

type Finding = typeof findings.$inferSelect;
type Job = typeof outbox.$inferSelect;
export type PublishOutcome = { findingId: string; issueKey: string; operation: "created" | "linked" | "commented" };

function linkIssue(
  findingId: string,
  issue: { id: string; key: string; fields?: Issue["fields"] },
  createdByRunId?: string,
) {
  const values = {
    ...(createdByRunId ? { createdByRunId } : {}),
    issueId: issue.id,
    issueKey: issue.key,
    status: issue.fields?.status?.name ?? null,
    statusCategory: (issue.fields?.status?.statusCategory?.key ?? null) as "new" | "indeterminate" | "done" | null,
    assigneeName: issue.fields?.assignee?.displayName ?? null,
    remoteUpdatedAt: issue.fields?.updated ?? null,
    drift: "in_sync" as const,
    reconciledAt: new Date().toISOString(),
  };
  db.insert(jiraLinks)
    .values({ findingId, ...values })
    .onConflictDoUpdate({ target: jiraLinks.findingId, set: values })
    .run();
}

async function upsertIssue(
  client: JiraClient,
  settings: JiraSettings,
  finding: Finding,
  job: Job,
): Promise<PublishOutcome> {
  const link = db.select().from(jiraLinks).where(eq(jiraLinks.findingId, finding.id)).get();
  let issue = link ? await client.issue(link.issueKey) : null;
  // A stored link only counts if the issue still carries this finding's label. Otherwise
  // the key may now belong to an unrelated issue (a different site, or a relabeled issue).
  if (issue && findingIdFromLabels(issue.fields.labels ?? []) !== finding.id) issue = null;
  if (!issue) {
    const label = findingLabel(finding.id);
    [issue = null] = await client.search(
      `project = "${settings.projectKey}" AND labels = "${label}" ORDER BY created ASC`,
      ["summary", "status", "labels", "assignee", "updated", "comment"],
      1,
    );
  }

  if (!issue) {
    const document = db.select().from(documents).where(eq(documents.id, finding.documentId)).get();
    const raisedBy = [
      ...new Set(
        db
          .select({ agent: findingObservations.agent })
          .from(findingObservations)
          .where(eq(findingObservations.findingId, finding.id))
          .all()
          .map((o) => o.agent),
      ),
    ];
    const priority = settings.priorities[finding.severity];
    const created = await client.createIssue({
      project: { key: settings.projectKey },
      issuetype: { id: settings.issueTypeId },
      summary: finding.title.slice(0, 250),
      labels: [MANAGED_LABEL, findingLabel(finding.id)],
      ...(priority ? { priority: { id: priority.id } } : {}),
      description: findingDescription({
        finding,
        contract: {
          number: document?.contractNumber ?? null,
          customer: document?.customer ?? null,
          filename: document?.filename ?? "contract",
        },
        raisedBy,
        appUrl: `${env.BASE_URL}/contracts/${finding.documentId}?finding=${finding.id}`,
      }),
    });
    linkIssue(finding.id, created, job.runId);
    audit(
      "jira.issue.created",
      { type: "finding", id: finding.id },
      { issueKey: created.key, runId: job.runId },
      job.createdBy,
    );
    return { findingId: finding.id, issueKey: created.key, operation: "created" };
  }

  linkIssue(finding.id, issue);
  const marker = `AuditIQ run ${job.runId}`;
  const noted =
    link?.createdByRunId === job.runId ||
    (issue.fields.comment?.comments ?? []).some((comment) => JSON.stringify(comment.body).includes(marker));
  if (!noted) {
    await client.addComment(issue.key, reobservedComment(finding, job.runId));
    audit(
      "jira.issue.commented",
      { type: "finding", id: finding.id },
      { issueKey: issue.key, runId: job.runId },
      job.createdBy,
    );
    return { findingId: finding.id, issueKey: issue.key, operation: "commented" };
  }
  return { findingId: finding.id, issueKey: issue.key, operation: "linked" };
}

function claim(where: ReturnType<typeof and>, limit: number): Job[] {
  const now = new Date().toISOString();
  return db.transaction((tx) => {
    const rows = tx
      .select()
      .from(outbox)
      .where(
        and(
          or(inArray(outbox.status, ["pending", "retry"]), eq(outbox.status, "processing")),
          lte(outbox.nextAttemptAt, now),
          where,
        ),
      )
      .orderBy(outbox.createdAt)
      .limit(limit)
      .all();
    // Claims last five minutes. A worker that dies mid-publish frees its jobs when the lease runs out.
    const lease = new Date(Date.now() + 5 * 60_000).toISOString();
    for (const row of rows)
      tx.update(outbox).set({ status: "processing", nextAttemptAt: lease }).where(eq(outbox.id, row.id)).run();
    return rows;
  });
}

// One publisher at a time in this process, so a user's publish and the background retry
// never work the same job concurrently. Leases cover a process that dies mid-publish.
let lock: Promise<unknown> = Promise.resolve();
function exclusively<T>(work: () => Promise<T>): Promise<T> {
  const next = lock.then(work, work);
  lock = next.catch(() => undefined);
  return next;
}

/** Extends a job's lease right before working on it. Returns false if the claim was lost. */
function renewLease(job: Job): boolean {
  const lease = new Date(Date.now() + 5 * 60_000).toISOString();
  return (
    db
      .update(outbox)
      .set({ nextAttemptAt: lease })
      .where(and(eq(outbox.id, job.id), eq(outbox.status, "processing")))
      .run().changes === 1
  );
}

async function process(jobs: Job[]) {
  const jira = configuredJira();
  const published: PublishOutcome[] = [];
  const failed: Array<{ findingId: string; error: string }> = [];
  for (const job of jobs) {
    if (!renewLease(job)) continue;
    const finding = db.select().from(findings).where(eq(findings.id, job.findingId)).get();
    try {
      if (!jira) throw new JiraNotConfiguredError();
      if (!finding?.eligible) {
        db.update(outbox)
          .set({
            status: "blocked",
            lastError: "The finding's quotes aren't verified.",
            completedAt: new Date().toISOString(),
          })
          .where(eq(outbox.id, job.id))
          .run();
        continue;
      }
      published.push(await upsertIssue(jira.client, jira.settings, finding, job));
      db.update(outbox)
        .set({ status: "complete", lastError: null, completedAt: new Date().toISOString() })
        .where(eq(outbox.id, job.id))
        .run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = job.attempts + 1;
      const delay = Math.min(60_000, 1000 * 2 ** (attempts - 1));
      db.update(outbox)
        .set({
          status: attempts >= MAX_ATTEMPTS ? "failed" : "retry",
          attempts,
          nextAttemptAt: new Date(Date.now() + delay).toISOString(),
          lastError: message.slice(0, 2000),
        })
        .where(eq(outbox.id, job.id))
        .run();
      audit("jira.publish.failed", { type: "finding", id: job.findingId }, { error: message, attempts }, job.createdBy);
      failed.push({ findingId: job.findingId, error: message });
    }
  }
  return { published, failed };
}

/**
 * Publishes findings from one contract. Only verified findings are queued; the rest come
 * back as blocked with their reasons. Queued work runs right away and retries later on failure.
 */
export async function publishFindings(documentId: string, findingIds: string[], actorId: string) {
  if (!configuredJira()) throw new JiraNotConfiguredError();
  const rows = findingIds.length
    ? db
        .select()
        .from(findings)
        .where(and(eq(findings.documentId, documentId), inArray(findings.id, findingIds)))
        .all()
    : [];
  const blocked = rows.filter((f) => !f.eligible).map((f) => ({ findingId: f.id, reasons: f.blockedReasons }));
  const eligible = rows.filter((f) => f.eligible);

  const now = new Date().toISOString();
  for (const finding of eligible) {
    db.insert(outbox)
      .values({
        id: randomUUID(),
        findingId: finding.id,
        runId: finding.latestRunId,
        dedupeKey: `upsert:${finding.id}:${finding.latestRunId}`,
        status: "pending",
        nextAttemptAt: now,
        createdBy: actorId,
      })
      .onConflictDoNothing()
      .run();
  }
  // Publishing is also how people retry: jobs waiting on backoff, or out of attempts, go now.
  const ids = eligible.map((f) => f.id);
  if (ids.length) {
    db.update(outbox)
      .set({ status: "pending", nextAttemptAt: now })
      .where(and(inArray(outbox.findingId, ids), eq(outbox.status, "retry")))
      .run();
    db.update(outbox)
      .set({ status: "pending", attempts: 0, nextAttemptAt: now })
      .where(and(inArray(outbox.findingId, ids), eq(outbox.status, "failed")))
      .run();
  }
  audit(
    "jira.publish.requested",
    { type: "document", id: documentId },
    { findings: eligible.map((f) => f.id), blocked: blocked.length },
    actorId,
  );

  const { published, failed } = ids.length
    ? await exclusively(() => process(claim(inArray(outbox.findingId, ids), ids.length * 2)))
    : { published: [], failed: [] };

  // A replay has nothing new to write. Report the existing links so the caller sees where each finding lives.
  const reported = new Set(published.map((p) => p.findingId));
  for (const finding of eligible) {
    if (reported.has(finding.id) || failed.some((f) => f.findingId === finding.id)) continue;
    const link = db.select().from(jiraLinks).where(eq(jiraLinks.findingId, finding.id)).get();
    if (link) published.push({ findingId: finding.id, issueKey: link.issueKey, operation: "linked" });
  }
  return { published, failed, blocked };
}

/** Background retry of queued publications. */
export async function processOutbox(): Promise<void> {
  if (!configuredJira()) return;
  await exclusively(() => process(claim(undefined, 50)));
}
