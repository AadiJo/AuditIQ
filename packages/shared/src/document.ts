// The parsed form of an uploaded contract. The server builds it once at upload time;
// the web app renders it as a page and the agents read it as anchored text.

export type Segment = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Hex color without the leading '#'. */
  color?: string;
  /** Font size in points. */
  size?: number;
};

export type Line = { segments: Segment[]; align?: string };

export type Cell = { fill?: string; colSpan?: number; lines: Line[] };

export type Block =
  | { type: "p"; segments: Segment[]; align?: string; anchorId: string | null }
  | { type: "table"; rows: { cells: Cell[] }[] };

/** One citable clause. `depth` 0 is an article or exhibit, deeper numbers are subsections. */
export type Anchor = { id: string; label: string; title: string; depth: number };

export type AnchorScheme = "numbered-headings-v1" | "none";

export type DocumentModel = {
  format: "docx" | "pdf";
  scheme: AnchorScheme;
  blocks: Block[];
  anchors: Anchor[];
};

/** Human label for an anchor id: "sec-5.2.3" -> "5.2.3", "article-5" -> "Article 5". */
export function anchorLabel(id: string): string {
  if (id.startsWith("sec-")) return id.slice(4);
  if (id.startsWith("article-")) return `Article ${id.slice(8)}`;
  if (id.startsWith("exhibit-")) return `Exhibit ${id.slice(8).toUpperCase()}`;
  return id;
}

/** "Section 5.2.3" for numbered clauses. Articles, exhibits, and the preamble already name themselves. */
export function clauseName(id: string): string {
  if (id === "preamble") return "Preamble";
  return id.startsWith("sec-") ? `Section ${anchorLabel(id)}` : anchorLabel(id);
}
