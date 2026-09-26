import fs from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";
import { chromium } from "@playwright/test";

// Builds the test contract as DOCX and PDF from northwind-msa.md, so the repository holds
// readable source instead of binaries. Tests call buildFixtures() from global setup; run
// this file directly to rebuild by hand.
//
// Markdown subset: "# " title, "## " article heading, "| a | b |" table rows, and
// paragraphs whose leading "1.2 Title." becomes a bold run.

type Block =
  | { kind: "title" | "heading" | "text"; text: string }
  | { kind: "clause"; lead: string; text: string }
  | { kind: "table"; rows: string[][] };

function parse(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("| ")) {
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      const last = blocks.at(-1);
      if (last?.kind === "table") last.rows.push(cells);
      else blocks.push({ kind: "table", rows: [cells] });
      continue;
    }
    if (trimmed.startsWith("## ")) blocks.push({ kind: "heading", text: trimmed.slice(3) });
    else if (trimmed.startsWith("# ")) blocks.push({ kind: "title", text: trimmed.slice(2) });
    else {
      const clause = trimmed.match(/^((?:\d+|[A-Z])\.\d+ [^.]+\.)\s(.*)$/);
      if (clause?.[1] && clause[2]) blocks.push({ kind: "clause", lead: clause[1], text: clause[2] });
      else blocks.push({ kind: "text", text: trimmed });
    }
  }
  return blocks;
}

const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function unreachable(value: never): never {
  throw new Error(`Unhandled block: ${JSON.stringify(value)}`);
}

function run(text: string, options: { bold?: boolean; size?: number } = {}): string {
  const props = `${options.bold ? "<w:b/>" : ""}${options.size ? `<w:sz w:val="${options.size * 2}"/>` : ""}`;
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function paragraph(runs: string, align?: string): string {
  return `<w:p>${align ? `<w:pPr><w:jc w:val="${align}"/></w:pPr>` : ""}${runs}</w:p>`;
}

function documentXml(blocks: Block[]): string {
  const body = blocks
    .map((block) => {
      switch (block.kind) {
        case "title":
          return paragraph(run(block.text, { bold: true, size: 16 }), "center");
        case "heading":
          return paragraph(run(block.text, { bold: true, size: 13 }));
        case "clause":
          return paragraph(`${run(block.lead, { bold: true })}${run(` ${block.text}`)}`, "both");
        case "text":
          return paragraph(run(block.text));
        case "table":
          return `<w:tbl>${block.rows
            .map(
              (row, rowIndex) =>
                `<w:tr>${row
                  .map(
                    (cell) =>
                      `<w:tc>${rowIndex === 0 ? '<w:tcPr><w:shd w:val="clear" w:fill="E7EEF7"/></w:tcPr>' : ""}${paragraph(run(cell, { bold: rowIndex === 0 }))}</w:tc>`,
                  )
                  .join("")}</w:tr>`,
            )
            .join("")}</w:tbl>`;
        default:
          return unreachable(block);
      }
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

/** A store-only ZIP archive. Enough for a DOCX; Word and AuditIQ both read uncompressed entries. */
function zip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, file.data);
    centrals.push(central, name);
    offset += local.length + name.length + file.data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function docx(blocks: Block[], tag?: string): Buffer {
  return zip([
    // A tag entry changes the file's bytes without changing its text, so tests can upload
    // the same contract as a separate document.
    ...(tag ? [{ name: "docProps/auditiq-test.xml", data: Buffer.from(`<tag>${escapeXml(tag)}</tag>`) }] : []),
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
    },
    { name: "word/document.xml", data: Buffer.from(documentXml(blocks)) },
  ]);
}

function html(blocks: Block[]): string {
  const body = blocks
    .map((block) => {
      switch (block.kind) {
        case "title":
          return `<h1>${escapeXml(block.text)}</h1>`;
        case "heading":
          return `<h2>${escapeXml(block.text)}</h2>`;
        case "clause":
          return `<p><b>${escapeXml(block.lead)}</b> ${escapeXml(block.text)}</p>`;
        case "text":
          return `<p>${escapeXml(block.text)}</p>`;
        case "table":
          return `<table>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeXml(cell)}</td>`).join("")}</tr>`).join("")}</table>`;
        default:
          return unreachable(block);
      }
    })
    .join("\n");
  return `<!doctype html><html><head><style>body{font:11pt Georgia,serif;margin:0}h1{font-size:15pt;text-align:center}h2{font-size:12pt;margin-top:18pt}p{margin:0 0 8pt}table{border-collapse:collapse;margin:8pt 0}td{border:1px solid #999;padding:3pt 6pt}</style></head><body>${body}</body></html>`;
}

async function contractBlocks(): Promise<Block[]> {
  return parse(await fs.readFile(path.join(import.meta.dirname, "northwind-msa.md"), "utf8"));
}

/** The test contract as DOCX bytes. Different tags give different bytes with identical text. */
export async function contractDocx(tag?: string): Promise<Buffer> {
  return docx(await contractBlocks(), tag);
}

/** Writes northwind-msa.docx and northwind-msa.pdf into `outDir` and returns their paths. */
export async function buildFixtures(outDir: string): Promise<{ docx: string; pdf: string }> {
  const blocks = await contractBlocks();
  await fs.mkdir(outDir, { recursive: true });
  const docxPath = path.join(outDir, "northwind-msa.docx");
  const pdfPath = path.join(outDir, "northwind-msa.pdf");
  await fs.writeFile(docxPath, docx(blocks));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html(blocks));
    await page.pdf({
      path: pdfPath,
      format: "Letter",
      margin: { top: "1in", bottom: "1in", left: "1in", right: "1in" },
    });
  } finally {
    await browser.close();
  }
  return { docx: docxPath, pdf: pdfPath };
}

if (import.meta.main) {
  console.log(await buildFixtures(process.argv[2] ?? path.join(import.meta.dirname, "..", ".artifacts", "fixtures")));
}
