import type { AgentId, FindingDraft } from "@auditiq/shared";
import { severityRank } from "@auditiq/shared";
import { eq } from "drizzle-orm";
import { sha256 } from "../crypto.ts";
import type { Db } from "../db/client.ts";
import { findingObservations, findings } from "../db/schema.ts";
import { normalizeForMatch, verifyCitations } from "./verify.ts";

/**
 * A finding's identity: the document version, its ASC 606 topic, and its primary clause
 * (the first verified quote, which agents are told to cite first). Reruns that reword the
 * issue or add supporting quotes, and the same issue raised by both agents, land on the
 * same row. Findings without a verified quote fall back to the affected term and stay local.
 */
export function findingIdentity(documentSha: string, draft: FindingDraft, primaryAnchor: string | null): string {
  const parts = primaryAnchor
    ? ["auditiq-finding-v3", documentSha, draft.topic, primaryAnchor]
    : ["auditiq-finding-v3-unanchored", documentSha, draft.topic, normalizeForMatch(draft.affectedTerm)];
  return sha256(parts.join("\n"));
}

export type RegisterInput = {
  runId: string;
  agent: AgentId;
  documentId: string;
  documentSha: string;
  hasAnchors: boolean;
  anchors: Map<string, string>;
  drafts: FindingDraft[];
};

/** Records a run's findings inside the caller's transaction. Returns counts for the run log. */
export function registerFindings(tx: Db, input: RegisterInput): { total: number; eligible: number; merged: number } {
  let eligible = 0;
  let merged = 0;

  input.drafts.forEach((draft, itemIndex) => {
    const { verified, errors } = verifyCitations(draft.citations, input.anchors);
    const blockedReasons = [
      ...(input.hasAnchors
        ? []
        : ["AuditIQ couldn't find numbered clauses in this document, so quotes can't be checked."]),
      ...(draft.citations.length ? [] : ["The finding has no quotes from the contract."]),
      ...(draft.affectedTerm.trim() ? [] : ["The finding doesn't name the contract term it concerns."]),
      ...errors,
    ];
    const isEligible = blockedReasons.length === 0;
    if (isEligible) eligible++;

    const identity = findingIdentity(input.documentSha, draft, isEligible ? (verified[0]?.anchorId ?? null) : null);
    const existing = tx.select().from(findings).where(eq(findings.identity, identity)).get();
    const now = new Date().toISOString();
    let findingId: string;

    if (existing) {
      merged++;
      findingId = existing.id;
      // The latest wording wins, but severity only rises. A second agent calling it minor
      // shouldn't quietly downgrade an issue someone already flagged as high.
      const severity =
        severityRank[draft.severity] > severityRank[existing.severity] ? draft.severity : existing.severity;
      tx.update(findings)
        .set({
          severity,
          title: draft.title,
          requiredAction: draft.requiredAction,
          rationale: draft.rationale,
          affectedTerm: draft.affectedTerm,
          citations: verified.length ? verified : existing.citations,
          eligible: existing.eligible || isEligible,
          blockedReasons: existing.eligible || isEligible ? [] : blockedReasons,
          latestRunId: input.runId,
          lastSeenAt: now,
        })
        .where(eq(findings.id, existing.id))
        .run();
    } else {
      findingId = `FND-${identity.slice(0, 12).toUpperCase()}`;
      tx.insert(findings)
        .values({
          id: findingId,
          identity,
          documentId: input.documentId,
          topic: draft.topic,
          severity: draft.severity,
          title: draft.title,
          affectedTerm: draft.affectedTerm,
          requiredAction: draft.requiredAction,
          rationale: draft.rationale,
          citations: verified,
          eligible: isEligible,
          blockedReasons,
          latestRunId: input.runId,
        })
        .run();
    }

    tx.insert(findingObservations)
      .values({
        findingId,
        runId: input.runId,
        agent: input.agent,
        itemIndex,
        severity: draft.severity,
        title: draft.title,
      })
      .onConflictDoNothing()
      .run();
  });

  return { total: input.drafts.length, eligible, merged };
}
