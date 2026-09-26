import { type AgentId, agentIds, type Severity } from "@auditiq/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { documents, findingObservations, findings, jiraIssues, jiraLinks, runs, user } from "../db/schema.ts";

// Read models for the API. Routes return these shapes, and the web app's types come from
// them through Hono's RPC inference.

type RunRow = typeof runs.$inferSelect;

export function runView(run: RunRow) {
  return {
    id: run.id,
    agent: run.agent,
    status: run.status,
    runtime: run.runtime,
    model: run.model,
    effort: run.effort,
    auth: run.auth,
    promptVersion: run.promptVersion,
    error: run.error,
    usage: run.usage,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

/** Latest run per agent, newest first within each agent. */
export function latestRuns(documentId: string) {
  const rows = db.select().from(runs).where(eq(runs.documentId, documentId)).orderBy(desc(runs.createdAt)).all();
  return Object.fromEntries(
    agentIds.map((agent) => {
      const latest = rows.find((r) => r.agent === agent) ?? null;
      const succeeded = rows.find((r) => r.agent === agent && r.status === "succeeded") ?? null;
      return [
        agent,
        { latest: latest && runView(latest), output: succeeded?.output ?? null, outputRunId: succeeded?.id ?? null },
      ];
    }),
  ) as Record<AgentId, { latest: ReturnType<typeof runView> | null; output: unknown; outputRunId: string | null }>;
}

export function findingViews(where: { documentId?: string; ids?: string[] } = {}) {
  const rows = db
    .select({
      finding: findings,
      link: jiraLinks,
      contractNumber: documents.contractNumber,
      customer: documents.customer,
      filename: documents.filename,
    })
    .from(findings)
    .innerJoin(documents, eq(documents.id, findings.documentId))
    .leftJoin(jiraLinks, eq(jiraLinks.findingId, findings.id))
    .where(
      and(
        where.documentId ? eq(findings.documentId, where.documentId) : undefined,
        where.ids ? inArray(findings.id, where.ids) : undefined,
      ),
    )
    .orderBy(sql`case ${findings.severity} when 'high' then 0 when 'medium' then 1 else 2 end`, findings.firstSeenAt)
    .all();

  const observations = rows.length
    ? db
        .select({
          findingId: findingObservations.findingId,
          agent: findingObservations.agent,
          runId: findingObservations.runId,
        })
        .from(findingObservations)
        .where(
          inArray(
            findingObservations.findingId,
            rows.map((r) => r.finding.id),
          ),
        )
        .all()
    : [];

  return rows.map(({ finding, link, contractNumber, customer, filename }) => ({
    id: finding.id,
    documentId: finding.documentId,
    contract: { number: contractNumber, customer, filename },
    topic: finding.topic,
    severity: finding.severity,
    title: finding.title,
    affectedTerm: finding.affectedTerm,
    requiredAction: finding.requiredAction,
    rationale: finding.rationale,
    citations: finding.citations,
    eligible: finding.eligible,
    blockedReasons: finding.blockedReasons,
    raisedBy: [...new Set(observations.filter((o) => o.findingId === finding.id).map((o) => o.agent))],
    /** Runs that raised this finding. The workspace shows a step's findings from its latest run only. */
    observedIn: observations.filter((o) => o.findingId === finding.id).map((o) => o.runId),
    firstSeenAt: finding.firstSeenAt,
    lastSeenAt: finding.lastSeenAt,
    jira: link
      ? {
          key: link.issueKey,
          status: link.status,
          statusCategory: link.statusCategory,
          assignee: link.assigneeName,
          drift: link.drift,
        }
      : null,
  }));
}

export type FindingView = ReturnType<typeof findingViews>[number];

export function jiraThread(issueKey: string) {
  return db.select().from(jiraIssues).where(eq(jiraIssues.issueKey, issueKey)).get() ?? null;
}

export function contractListView() {
  const docs = db
    .select({ document: documents, uploader: user.name })
    .from(documents)
    .leftJoin(user, eq(user.id, documents.uploadedBy))
    .orderBy(desc(documents.createdAt))
    .all();
  const counts = db
    .select({
      documentId: findings.documentId,
      severity: findings.severity,
      total: sql<number>`count(*)`,
      published: sql<number>`count(${jiraLinks.issueKey})`,
    })
    .from(findings)
    .leftJoin(jiraLinks, eq(jiraLinks.findingId, findings.id))
    .groupBy(findings.documentId, findings.severity)
    .all();

  const runRows = db
    .select({
      documentId: runs.documentId,
      agent: runs.agent,
      status: runs.status,
      error: runs.error,
      finishedAt: runs.finishedAt,
    })
    .from(runs)
    .orderBy(desc(runs.createdAt))
    .all();

  return docs.map(({ document, uploader }) => {
    const mine = counts.filter((c) => c.documentId === document.id);
    const bySeverity = { high: 0, medium: 0, low: 0 } satisfies Record<Severity, number>;
    for (const c of mine) bySeverity[c.severity] = c.total;
    const latest = (agent: AgentId) => {
      const row = runRows.find((r) => r.documentId === document.id && r.agent === agent);
      return row ? { status: row.status, error: row.error, finishedAt: row.finishedAt } : null;
    };
    return {
      id: document.id,
      filename: document.filename,
      format: document.format,
      contractNumber: document.contractNumber,
      customer: document.customer,
      uploadedBy: uploader,
      createdAt: document.createdAt,
      findings: bySeverity,
      published: mine.reduce((n, c) => n + c.published, 0),
      runs: { extraction: latest("extraction"), accounting: latest("accounting") } satisfies Record<AgentId, unknown>,
    };
  });
}
