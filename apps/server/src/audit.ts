import { db } from "./db/client.ts";
import { auditEvents } from "./db/schema.ts";

/**
 * Appends an audit event. Every write to Jira, every publish, and every settings change
 * records one, with the acting user when a person caused it.
 */
export function audit(
  type: string,
  subject: { type: string; id: string },
  payload: Record<string, unknown> = {},
  actorId: string | null = null,
): void {
  db.insert(auditEvents).values({ type, actorId, subjectType: subject.type, subjectId: subject.id, payload }).run();
}
