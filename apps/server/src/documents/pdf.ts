import fs from "node:fs/promises";
import { getDocumentProxy } from "unpdf";
import type { RawBlock } from "./docx.ts";
import { matchHeading } from "./model.ts";

// Reads the text layer of a PDF into paragraphs. pdf.js returns positioned text runs, so we
// rebuild lines from end-of-line markers and start a new paragraph on a clause heading or a
// vertical gap. Scanned PDFs have no text layer and come back empty, which leaves the
// document without anchors and keeps its findings local.

type TextItem = { str: string; transform: number[]; hasEOL?: boolean };

export async function readPdf(filePath: string): Promise<RawBlock[]> {
  const pdf = await getDocumentProxy(new Uint8Array(await fs.readFile(filePath)));
  const blocks: RawBlock[] = [];
  let paragraph = "";
  const flush = () => {
    const text = paragraph.replace(/\s+/g, " ").trim();
    if (text) blocks.push({ type: "p", segments: [{ text }] });
    paragraph = "";
  };
  // A line ending in a hyphen continues the same word ("Go-" + "Live"), so no space goes between.
  const append = (line: string) => {
    paragraph = !paragraph ? line : paragraph.endsWith("-") ? `${paragraph}${line}` : `${paragraph} ${line}`;
  };

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    let line = "";
    let lineY: number | null = null;
    let lineHeight = 10;
    let previousY: number | null = null;

    const endLine = () => {
      const text = line.trim();
      line = "";
      if (!text) return;
      const gap = previousY !== null && lineY !== null ? Math.abs(previousY - lineY) : 0;
      if (matchHeading(text, false) || gap > lineHeight * 1.8) flush();
      append(text);
      previousY = lineY;
    };

    for (const raw of content.items) {
      if (!("str" in raw)) continue;
      const item = raw as TextItem;
      const y = item.transform[5] ?? 0;
      if (lineY !== null && Math.abs(y - lineY) > 2) endLine();
      if (!line) lineY = y;
      lineHeight = Math.abs(item.transform[3] ?? lineHeight) || lineHeight;
      line += item.str;
      if (item.hasEOL) endLine();
    }
    endLine();
  }
  flush();
  return blocks;
}
