export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; language: string; code: string }
  | { kind: "quote"; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] };

export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const language = fence[1] || "";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", language, code: body.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]!.length as 1 | 2 | 3,
        text: heading[2]!.trim(),
      });
      index += 1;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      const parts: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const match = current.match(/^>\s?(.*)$/);
        if (!match) break;
        parts.push(match[1] ?? "");
        index += 1;
      }
      blocks.push({ kind: "quote", text: parts.join(" ").trim() });
      continue;
    }

    if (isTableHeaderRow(line) && isTableSeparator(lines[index + 1] ?? "")) {
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (!current.trim() || !current.includes("|")) break;
        if (isTableSeparator(current)) {
          index += 1;
          continue;
        }
        rows.push(splitTableRow(current));
        index += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const items: string[] = [];
      const isOrdered = Boolean(ordered);
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const match = isOrdered
          ? current.match(/^\d+[.)]\s+(.+)$/)
          : current.match(/^[-*]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]!.trim());
        index += 1;
      }
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (!current.trim()) break;
      if (/^```/.test(current) || /^#{1,3}\s+/.test(current)
        || /^>\s?/.test(current)
        || /^[-*]\s+/.test(current) || /^\d+[.)]\s+/.test(current)
        || (isTableHeaderRow(current) && isTableSeparator(lines[index + 1] ?? ""))) {
        break;
      }
      paragraph.push(current.trim());
      index += 1;
    }
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    }
  }

  return blocks.length ? blocks : [{ kind: "paragraph", text: source }];
}

function isTableHeaderRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && splitTableRow(trimmed).length >= 2;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") && !trimmed.includes("-")) return false;
  const cells = splitTableRow(trimmed);
  if (cells.length < 2) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}
