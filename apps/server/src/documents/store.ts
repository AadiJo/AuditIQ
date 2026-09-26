import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DocumentModel } from "@auditiq/shared";
import { eq } from "drizzle-orm";
import { sha256 } from "../crypto.ts";
import { db } from "../db/client.ts";
import { documents } from "../db/schema.ts";
import { env, paths } from "../env.ts";
import { readDocx } from "./docx.ts";
import { buildDocumentModel } from "./model.ts";
import { readPdf } from "./pdf.ts";

export class UploadError extends Error {}

export function filePath(sha: string): string {
  return path.join(paths.files, sha);
}

/**
 * Stores an uploaded contract and parses it. Uploading the same bytes again returns the
 * existing document, since findings are keyed to the document's content hash.
 */
export async function storeUpload(file: File, userId: string) {
  const ext = path.extname(file.name).toLowerCase();
  const format: DocumentModel["format"] | null = ext === ".docx" ? "docx" : ext === ".pdf" ? "pdf" : null;
  if (!format) throw new UploadError("Upload a contract as a DOCX or PDF file.");
  if (file.size > env.MAX_UPLOAD_MB * 1024 * 1024)
    throw new UploadError(`Contracts must be under ${env.MAX_UPLOAD_MB} MB.`);

  const bytes = Buffer.from(await file.arrayBuffer());
  const sha = sha256(bytes);
  const existing = db.select().from(documents).where(eq(documents.sha256, sha)).get();
  if (existing) return { document: existing, created: false };

  const target = filePath(sha);
  await fs.writeFile(target, bytes, { mode: 0o600 });
  let model: DocumentModel;
  try {
    const raw = format === "docx" ? await readDocx(target) : await readPdf(target);
    model = buildDocumentModel(format, raw);
  } catch (error) {
    await fs.rm(target, { force: true });
    throw new UploadError(
      `AuditIQ couldn't read this ${format.toUpperCase()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!model.blocks.length) {
    await fs.rm(target, { force: true });
    throw new UploadError("This file has no readable text. Scanned PDFs need OCR before upload.");
  }

  const document = db
    .insert(documents)
    .values({
      id: randomUUID(),
      sha256: sha,
      filename: path.basename(file.name).slice(0, 200),
      format,
      byteSize: bytes.length,
      model,
      uploadedBy: userId,
    })
    .returning()
    .get();
  return { document, created: true };
}
