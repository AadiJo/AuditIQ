import type {
  AgentId,
  Citation,
  DocumentModel,
  Effort,
  RunEvent,
  RunStatus,
  RuntimeAuth,
  RuntimeId,
  Severity,
  Topic,
  Usage,
} from "@auditiq/shared";
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Timestamps on AuditIQ tables are ISO strings so rows serialize straight to JSON.
// The better-auth tables use Date columns because the auth adapter writes Date objects.
const now = () => text().notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

/* ------------------------------- better-auth ------------------------------- */

export type Role = "admin" | "reviewer";

export const user = sqliteTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer({ mode: "boolean" }).notNull().default(false),
  image: text(),
  role: text().$type<Role>().notNull().default("reviewer"),
  createdAt: integer({ mode: "timestamp_ms" }).notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
});

export const session = sqliteTable("session", {
  id: text().primaryKey(),
  expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
  token: text().notNull().unique(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
  ipAddress: text(),
  userAgent: text(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
  id: text().primaryKey(),
  accountId: text().notNull(),
  providerId: text().notNull(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text(),
  refreshToken: text(),
  idToken: text(),
  accessTokenExpiresAt: integer({ mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer({ mode: "timestamp_ms" }),
  scope: text(),
  password: text(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
});

export const verification = sqliteTable("verification", {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
  createdAt: integer({ mode: "timestamp_ms" }),
  updatedAt: integer({ mode: "timestamp_ms" }),
});

/** Admins invite reviewers by email. Sign-up is only allowed for the first user or an open invite. */
export const invites = sqliteTable("invites", {
  id: text().primaryKey(),
  email: text().notNull(),
  role: text().$type<Role>().notNull(),
  createdBy: text().notNull(),
  createdAt: now(),
  expiresAt: text().notNull(),
  acceptedAt: text(),
});

/* -------------------------------- documents -------------------------------- */

/** An uploaded contract. Identical bytes map to one row, keyed by content hash. */
export const documents = sqliteTable("documents", {
  id: text().primaryKey(),
  sha256: text().notNull().unique(),
  filename: text().notNull(),
  format: text().$type<DocumentModel["format"]>().notNull(),
  byteSize: integer().notNull(),
  model: text({ mode: "json" }).$type<DocumentModel>().notNull(),
  // Filled from the latest extraction so lists can show them without parsing run output.
  contractNumber: text(),
  customer: text(),
  uploadedBy: text().notNull(),
  createdAt: now(),
});

/* ---------------------------------- runs ----------------------------------- */

export const runs = sqliteTable(
  "runs",
  {
    id: text().primaryKey(),
    documentId: text()
      .notNull()
      .references(() => documents.id),
    agent: text().$type<AgentId>().notNull(),
    parentRunId: text(),
    runtime: text().$type<RuntimeId>().notNull(),
    model: text().notNull(),
    effort: text().$type<Effort>().notNull(),
    auth: text().$type<RuntimeAuth>(),
    promptVersion: text().notNull(),
    status: text().$type<RunStatus>().notNull(),
    error: text(),
    output: text({ mode: "json" }),
    usage: text({ mode: "json" }).$type<Usage>(),
    createdBy: text().notNull(),
    createdAt: now(),
    startedAt: text(),
    finishedAt: text(),
  },
  (t) => [index("runs_document_idx").on(t.documentId, t.agent, t.createdAt)],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    runId: text()
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    event: text({ mode: "json" }).$type<RunEvent>().notNull(),
    createdAt: now(),
  },
  (t) => [uniqueIndex("run_events_seq_idx").on(t.runId, t.seq)],
);

/* -------------------------------- findings --------------------------------- */

export type VerifiedCitation = Citation & { quoteHash: string };

/**
 * A durable finding. Identity is the document version, the ASC 606 topic, and the primary
 * cited clause, so the same issue raised by several agents or reruns is one row.
 */
export const findings = sqliteTable(
  "findings",
  {
    id: text().primaryKey(),
    identity: text().notNull().unique(),
    documentId: text()
      .notNull()
      .references(() => documents.id),
    topic: text().$type<Topic>().notNull(),
    severity: text().$type<Severity>().notNull(),
    title: text().notNull(),
    affectedTerm: text().notNull(),
    requiredAction: text().notNull(),
    rationale: text().notNull(),
    citations: text({ mode: "json" }).$type<VerifiedCitation[]>().notNull(),
    eligible: integer({ mode: "boolean" }).notNull(),
    blockedReasons: text({ mode: "json" }).$type<string[]>().notNull(),
    latestRunId: text().notNull(),
    firstSeenAt: now(),
    lastSeenAt: now(),
  },
  (t) => [index("findings_document_idx").on(t.documentId)],
);

/** One agent run raising one finding. The same finding can have many observations. */
export const findingObservations = sqliteTable(
  "finding_observations",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    findingId: text()
      .notNull()
      .references(() => findings.id),
    runId: text()
      .notNull()
      .references(() => runs.id),
    agent: text().$type<AgentId>().notNull(),
    itemIndex: integer().notNull(),
    severity: text().$type<Severity>().notNull(),
    title: text().notNull(),
    createdAt: now(),
  },
  (t) => [uniqueIndex("observations_run_item_idx").on(t.runId, t.itemIndex)],
);

/* ---------------------------------- Jira ----------------------------------- */

export const jiraLinks = sqliteTable("jira_links", {
  findingId: text()
    .primaryKey()
    .references(() => findings.id),
  issueId: text().notNull(),
  issueKey: text().notNull().unique(),
  status: text(),
  statusCategory: text().$type<"new" | "indeterminate" | "done">(),
  assigneeName: text(),
  remoteUpdatedAt: text(),
  drift: text().$type<"in_sync" | "missing" | "unmanaged">().notNull().default("in_sync"),
  /** The run whose publish created the issue. Later runs add a comment instead. */
  createdByRunId: text(),
  linkedAt: now(),
  reconciledAt: text(),
});

/** Publication queue. One row per finding per run, so replaying a publish never duplicates. */
export const outbox = sqliteTable(
  "outbox",
  {
    id: text().primaryKey(),
    findingId: text()
      .notNull()
      .references(() => findings.id),
    runId: text().notNull(),
    dedupeKey: text().notNull().unique(),
    status: text().$type<"pending" | "processing" | "retry" | "complete" | "failed" | "blocked">().notNull(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: text().notNull(),
    lastError: text(),
    createdBy: text().notNull(),
    createdAt: now(),
    completedAt: text(),
  },
  (t) => [index("outbox_pending_idx").on(t.status, t.nextAttemptAt)],
);

export type JiraCommentSnapshot = {
  id: string;
  authorAccountId: string | null;
  authorName: string;
  body: string;
  /** Account ids of people @mentioned in the comment. */
  mentions: string[];
  created: string;
};

/** The latest copy of each managed issue, including comments, as seen by the poller. */
export const jiraIssues = sqliteTable("jira_issues", {
  issueKey: text().primaryKey(),
  issueId: text().notNull(),
  findingId: text(),
  summary: text().notNull(),
  status: text().notNull(),
  statusCategory: text().notNull(),
  assigneeName: text(),
  labels: text({ mode: "json" }).$type<string[]>().notNull(),
  comments: text({ mode: "json" }).$type<JiraCommentSnapshot[]>().notNull(),
  remoteUpdatedAt: text().notNull(),
  observedAt: now(),
});

/** Every issue update and comment the poller has seen, deduplicated by Jira ids. */
export const jiraChanges = sqliteTable("jira_changes", {
  changeKey: text().primaryKey(),
  issueKey: text().notNull(),
  kind: text().$type<"issue" | "comment">().notNull(),
  payload: text({ mode: "json" }).notNull(),
  changedAt: text().notNull(),
  observedAt: now(),
});

export type WatcherStatus = "shadow" | "rejected" | "pending" | "processing" | "retry" | "complete" | "failed";

export const watcherDecisions = sqliteTable(
  "watcher_decisions",
  {
    id: text().primaryKey(),
    changeKey: text()
      .notNull()
      .unique()
      .references(() => jiraChanges.changeKey),
    issueKey: text().notNull(),
    decision: text({ mode: "json" }).notNull(),
    reply: text(),
    confidence: real().notNull(),
    policy: text().notNull(),
    status: text().$type<WatcherStatus>().notNull(),
    actionMarker: text().notNull().unique(),
    model: text().notNull(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: text(),
    lastError: text(),
    executedAt: text(),
    createdAt: now(),
  },
  (t) => [index("watcher_pending_idx").on(t.status, t.nextAttemptAt)],
);

/* --------------------------------- system ---------------------------------- */

export const settings = sqliteTable("settings", {
  key: text().primaryKey(),
  value: text({ mode: "json" }).notNull(),
  updatedAt: now(),
});

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    type: text().notNull(),
    actorId: text(),
    subjectType: text().notNull(),
    subjectId: text().notNull(),
    payload: text({ mode: "json" }).notNull(),
    createdAt: now(),
  },
  (t) => [index("audit_subject_idx").on(t.subjectType, t.subjectId)],
);
