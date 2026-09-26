import type { RunEventEnvelope } from "@auditiq/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../db/client.ts";
import { runs } from "../db/schema.ts";
import { storedEvents, subscribe } from "../runs/events.ts";
import { cancelRun } from "../runs/runner.ts";
import { type AppEnv, badRequest, requireUser } from "./context.ts";
import { runView } from "./views.ts";

const terminal = new Set(["succeeded", "failed", "cancelled"]);

export const runRoutes = new Hono<AppEnv>()
  .use(requireUser)
  .get("/:id", (c) => {
    const run =
      db
        .select()
        .from(runs)
        .where(eq(runs.id, c.req.param("id")))
        .get() ?? badRequest("That run doesn't exist.", 404);
    return c.json({ ...runView(run), events: storedEvents(run.id) });
  })

  // Server-sent events. Replays everything after Last-Event-ID, then streams live events
  // until the run finishes.
  .get("/:id/events", (c) => {
    const run =
      db
        .select()
        .from(runs)
        .where(eq(runs.id, c.req.param("id")))
        .get() ?? badRequest("That run doesn't exist.", 404);
    const after = Number(c.req.header("Last-Event-ID") ?? c.req.query("after") ?? 0) || 0;
    return streamSSE(c, async (stream) => {
      const pending: RunEventEnvelope[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = subscribe(run.id, (envelope) => {
        pending.push(envelope);
        wake?.();
      });
      stream.onAbort(unsubscribe);

      let lastSeq = after;
      const send = async (envelope: RunEventEnvelope) => {
        if (envelope.seq <= lastSeq) return false;
        lastSeq = envelope.seq;
        await stream.writeSSE({ id: String(envelope.seq), event: envelope.event.type, data: JSON.stringify(envelope) });
        return envelope.event.type === "status" && terminal.has(envelope.event.status);
      };

      try {
        for (const envelope of storedEvents(run.id, after)) if (await send(envelope)) return;
        while (!stream.aborted) {
          const next = pending.shift();
          if (next) {
            if (await send(next)) return;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 15_000);
          });
          wake = null;
          if (!pending.length) await stream.writeSSE({ event: "ping", data: "" });
        }
      } finally {
        unsubscribe();
      }
    });
  })

  .post("/:id/cancel", (c) => {
    if (!cancelRun(c.req.param("id"), c.var.user.id)) badRequest("That run has already finished.", 409);
    return c.json({ ok: true });
  });
