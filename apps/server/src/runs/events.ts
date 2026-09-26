import { EventEmitter } from "node:events";
import type { RunEvent, RunEventEnvelope } from "@auditiq/shared";
import { and, asc, eq, gt, max } from "drizzle-orm";
import { db } from "../db/client.ts";
import { runEvents } from "../db/schema.ts";

// Run events are stored and broadcast. The SSE route replays stored events from the
// client's last seen sequence number, then streams new ones, so reconnects lose nothing.

const bus = new EventEmitter();
bus.setMaxListeners(0);
const nextSeq = new Map<string, number>();

export function appendEvent(runId: string, event: RunEvent): RunEventEnvelope {
  let seq = nextSeq.get(runId);
  if (seq === undefined) {
    seq =
      (db
        .select({ seq: max(runEvents.seq) })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .get()?.seq ?? 0) + 1;
  }
  nextSeq.set(runId, seq + 1);
  const row = db.insert(runEvents).values({ runId, seq, event }).returning().get();
  const envelope: RunEventEnvelope = { seq, at: row.createdAt, event };
  bus.emit(runId, envelope);
  if (event.type === "status" && event.status !== "queued" && event.status !== "running") nextSeq.delete(runId);
  return envelope;
}

export function storedEvents(runId: string, afterSeq = 0): RunEventEnvelope[] {
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
    .orderBy(asc(runEvents.seq))
    .all()
    .map((row) => ({ seq: row.seq, at: row.createdAt, event: row.event }));
}

/** Subscribes to live events for a run. Returns the unsubscribe function. */
export function subscribe(runId: string, listener: (envelope: RunEventEnvelope) => void): () => void {
  bus.on(runId, listener);
  return () => bus.off(runId, listener);
}
