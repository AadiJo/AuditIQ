import fs from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import type { Cell, Segment } from "@auditiq/shared";

// Dependency-free DOCX reader. A .docx is a ZIP archive whose body lives in
// word/document.xml. We read the ZIP central directory (it always carries real sizes and
// offsets, unlike local headers), inflate that one entry, parse the XML into a small tree,
// and walk the body into paragraphs and tables. Bold, italic, color, size, alignment, and
// cell shading survive so the contract page reads like the original.

/** A paragraph or table in document order, before clause anchors are assigned. */
export type RawBlock =
  | { type: "p"; segments: Segment[]; align?: string }
  | { type: "table"; rows: { cells: Cell[] }[] };

/* -------------------------------- ZIP plumbing -------------------------------- */

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CDH_SIG = 0x02014b50;

function findEocd(buf: Buffer): number {
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) return i;
  }
  throw new Error("Not a valid ZIP/DOCX file (no end-of-central-directory record).");
}

function readZipEntry(buf: Buffer, wantName: string): Buffer | null {
  const eocd = findEocd(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(p) !== ZIP_CDH_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== wantName) continue;

    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    return method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
  }
  return null;
}

/* ------------------------------- tiny XML DOM ------------------------------- */

type XmlNode = {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text?: string;
};

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

// Minimal but correct recursive-descent parser for the well-formed XML that Word emits.
function parseXml(s: string): XmlNode {
  let i = 0;
  const isNameEnd = (c: string | undefined) =>
    c === " " || c === "\t" || c === "\n" || c === "\r" || c === "/" || c === ">";

  function parseNodes(): XmlNode[] {
    const nodes: XmlNode[] = [];
    while (i < s.length) {
      if (s[i] === "<") {
        if (s.startsWith("</", i)) return nodes; // closing tag belongs to caller
        if (s.startsWith("<?", i)) {
          i = s.indexOf("?>", i) + 2;
          continue;
        }
        if (s.startsWith("<!--", i)) {
          i = s.indexOf("-->", i) + 3;
          continue;
        }
        if (s.startsWith("<!", i)) {
          i = s.indexOf(">", i) + 1;
          continue;
        }
        nodes.push(parseElement());
      } else {
        let j = s.indexOf("<", i);
        if (j < 0) j = s.length;
        const text = s.slice(i, j);
        i = j;
        if (text) nodes.push({ tag: "#text", attrs: {}, children: [], text: decodeEntities(text) });
      }
    }
    return nodes;
  }

  function parseElement(): XmlNode {
    i++; // skip '<'
    let j = i;
    while (j < s.length && !isNameEnd(s[j])) j++;
    const tag = s.slice(i, j);
    i = j;
    const attrs: Record<string, string> = {};

    while (i < s.length && s[i] !== ">" && s[i] !== "/") {
      if (/\s/.test(s[i] ?? "")) {
        i++;
        continue;
      }
      let k = i;
      while (k < s.length && s[k] !== "=" && !isNameEnd(s[k])) k++;
      const name = s.slice(i, k);
      i = k;
      while (i < s.length && /\s/.test(s[i] ?? "")) i++;
      let val = "";
      if (s[i] === "=") {
        i++;
        while (i < s.length && /\s/.test(s[i] ?? "")) i++;
        const quote = s[i] ?? '"';
        i++;
        const end = s.indexOf(quote, i);
        val = s.slice(i, end);
        i = end + 1;
      }
      attrs[name] = decodeEntities(val);
    }

    if (s[i] === "/") {
      i += 2; // skip '/>'
      return { tag, attrs, children: [] };
    }
    i++; // skip '>'
    const children = parseNodes();
    if (s.startsWith("</", i)) i = s.indexOf(">", i) + 1; // skip closing tag
    return { tag, attrs, children };
  }

  return { tag: "#root", attrs: {}, children: parseNodes() };
}

/* ------------------------------ DOCX -> blocks ------------------------------ */

function child(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find((c) => c.tag === tag);
}
function children(node: XmlNode, tag: string): XmlNode[] {
  return node.children.filter((c) => c.tag === tag);
}
function isOn(node: XmlNode | undefined): boolean {
  if (!node) return false;
  const v = node.attrs["w:val"];
  return v !== "0" && v !== "false" && v !== "none";
}
function hex(value: string | undefined): string | undefined {
  return value && /^[0-9a-fA-F]{6}$/.test(value) ? value : undefined;
}

function collectRuns(node: XmlNode, acc: XmlNode[]) {
  for (const c of node.children) {
    if (c.tag === "w:r") acc.push(c);
    else if (c.children.length) collectRuns(c, acc); // descend into w:hyperlink, w:ins, etc.
  }
}

function runText(run: XmlNode): string {
  let out = "";
  for (const c of run.children) {
    if (c.tag === "w:t") out += c.children.map((t) => t.text ?? "").join("");
    else if (c.tag === "w:tab") out += " ";
    else if (c.tag === "w:br" || c.tag === "w:cr") out += "\n";
  }
  return out;
}

function runSegment(run: XmlNode): Segment | null {
  const text = runText(run);
  if (!text) return null;
  const rPr = child(run, "w:rPr");
  const segment: Segment = { text };
  if (rPr) {
    if (isOn(child(rPr, "w:b"))) segment.bold = true;
    if (isOn(child(rPr, "w:i"))) segment.italic = true;
    const color = hex(child(rPr, "w:color")?.attrs["w:val"]);
    if (color) segment.color = color;
    const sz = child(rPr, "w:sz")?.attrs["w:val"];
    if (sz && /^\d+$/.test(sz)) segment.size = Number(sz) / 2; // half-points to points
  }
  return segment;
}

function paragraphSegments(p: XmlNode): Segment[] {
  const runs: XmlNode[] = [];
  collectRuns(p, runs);
  return runs.map(runSegment).filter((s): s is Segment => s !== null);
}

function paragraphAlign(p: XmlNode): string | undefined {
  const pPr = child(p, "w:pPr");
  return pPr ? child(pPr, "w:jc")?.attrs["w:val"] : undefined;
}

function buildTable(tbl: XmlNode): RawBlock {
  const rows = children(tbl, "w:tr").map((tr) => ({
    cells: children(tr, "w:tc").map((tc): Cell => {
      const tcPr = child(tc, "w:tcPr");
      const span = tcPr ? child(tcPr, "w:gridSpan")?.attrs["w:val"] : undefined;
      const cell: Cell = {
        lines: children(tc, "w:p")
          .map((p) => ({ segments: paragraphSegments(p), align: paragraphAlign(p) }))
          .filter((line) => line.segments.length > 0),
      };
      const fill = hex(tcPr ? child(tcPr, "w:shd")?.attrs["w:fill"] : undefined);
      if (fill) cell.fill = fill;
      if (span && /^\d+$/.test(span)) cell.colSpan = Number(span);
      return cell;
    }),
  }));
  return { type: "table", rows };
}

/** Parses a DOCX file into blocks. Throws when the file is not a readable DOCX. */
export async function readDocx(filePath: string): Promise<RawBlock[]> {
  const buf = await fs.readFile(filePath);
  const xml = readZipEntry(buf, "word/document.xml");
  if (!xml) throw new Error("This DOCX file has no document body.");

  const document = child(parseXml(xml.toString("utf8")), "w:document");
  const body = document ? child(document, "w:body") : undefined;
  if (!body) throw new Error("This DOCX file has no document body.");

  const blocks: RawBlock[] = [];
  for (const node of body.children) {
    if (node.tag === "w:p") {
      const segments = paragraphSegments(node);
      if (segments.length) blocks.push({ type: "p", segments, align: paragraphAlign(node) });
    } else if (node.tag === "w:tbl") {
      blocks.push(buildTable(node));
    }
  }
  return blocks;
}
