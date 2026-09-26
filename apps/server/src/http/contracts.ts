import fs from "node:fs/promises";
import { AgentIdSchema } from "@auditiq/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { db } from "../db/client.ts";
import { documents } from "../db/schema.ts";
import { filePath, storeUpload, UploadError } from "../documents/store.ts";
import { env } from "../env.ts";
import { JiraNotConfiguredError, publishFindings } from "../jira/publisher.ts";
import { RunError, startRun } from "../runs/runner.ts";
import { type AppEnv, badRequest, requireUser, validate } from "./context.ts";
import { contractListView, findingViews, latestRuns, runView } from "./views.ts";

function getDocument(id: string) {
  return (
    db.select().from(documents).where(eq(documents.id, id)).get() ?? badRequest("That contract doesn't exist.", 404)
  );
}

export const contractRoutes = new Hono<AppEnv>()
  .use(requireUser)
  .get("/", (c) => c.json({ contracts: contractListView() }))

  // Upload a contract and start extraction right away. Re-uploading the same file opens the
  // existing contract instead of creating a duplicate.
  .post(
    "/",
    // Stop oversized uploads while they stream in, before they're buffered in memory.
    bodyLimit({
      maxSize: (env.MAX_UPLOAD_MB + 1) * 1024 * 1024,
      onError: (c) => c.json({ error: `Contracts must be under ${env.MAX_UPLOAD_MB} MB.` }, 413),
    }),
    async (c) => {
      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) badRequest("Attach a DOCX or PDF file.");
      let result: Awaited<ReturnType<typeof storeUpload>>;
      try {
        result = await storeUpload(file, c.var.user.id);
      } catch (error) {
        if (error instanceof UploadError) badRequest(error.message);
        throw error;
      }
      let runError: string | null = null;
      if (result.created) {
        try {
          await startRun({ documentId: result.document.id, agent: "extraction", userId: c.var.user.id });
        } catch (error) {
          if (!(error instanceof RunError)) throw error;
          runError = error.message;
        }
      }
      return c.json({ id: result.document.id, created: result.created, runError });
    },
  )

  .get("/:id", (c) => {
    const document = getDocument(c.req.param("id"));
    return c.json({
      id: document.id,
      filename: document.filename,
      format: document.format,
      sha256: document.sha256,
      contractNumber: document.contractNumber,
      customer: document.customer,
      createdAt: document.createdAt,
      scheme: document.model.scheme,
      anchors: document.model.anchors,
      runs: latestRuns(document.id),
      findings: findingViews({ documentId: document.id }),
    });
  })

  // The parsed page, fetched separately because it's the largest part of a contract.
  .get("/:id/document", (c) => {
    const document = getDocument(c.req.param("id"));
    return c.json(document.model);
  })

  .get("/:id/file", async (c) => {
    const document = getDocument(c.req.param("id"));
    const bytes = await fs.readFile(filePath(document.sha256));
    const type =
      document.format === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    return c.body(bytes, 200, {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="${document.filename.replace(/[^\w.\- ]+/g, "_")}"`,
    });
  })

  .post(
    "/:id/runs",
    validate("json", z.object({ agent: AgentIdSchema, runtime: z.enum(["claude", "codex"]).optional() })),
    async (c) => {
      const { agent, runtime } = c.req.valid("json");
      try {
        const run = await startRun({ documentId: c.req.param("id"), agent, runtime, userId: c.var.user.id });
        return c.json(runView(run));
      } catch (error) {
        if (error instanceof RunError) badRequest(error.message);
        throw error;
      }
    },
  )

  // Publish findings to Jira. Unverified findings come back as blocked with reasons.
  .post("/:id/publish", validate("json", z.object({ findingIds: z.array(z.string()).min(1).max(200) })), async (c) => {
    const document = getDocument(c.req.param("id"));
    try {
      return c.json(await publishFindings(document.id, c.req.valid("json").findingIds, c.var.user.id));
    } catch (error) {
      if (error instanceof JiraNotConfiguredError) badRequest(error.message, 409);
      throw error;
    }
  });
