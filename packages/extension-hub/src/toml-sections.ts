/**
 * Minimal, controlled TOML *section* editor.
 *
 * This is NOT a general TOML parser. It only appends / replaces / removes whole
 * named table sections (e.g. `[marketplaces.forge-hub]`, `[plugins."x@forge-hub"]`)
 * that the hub itself writes, preserving all other file content verbatim. A
 * section spans from its header line up to (but excluding) the next line that
 * looks like a table header (`^\[...\]$`) or EOF.
 */

function isHeaderLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("[") && t.endsWith("]");
}

/** True if the exact table header is present. */
export function hasSection(text: string, header: string): boolean {
  return text.split("\n").some((l) => l.trim() === header.trim());
}

/**
 * Insert or replace a table section. `body` lines exclude the header itself.
 * Returns the updated text.
 */
export function upsertSection(text: string, header: string, body: string[]): string {
  const wanted = header.trim();
  const block = [wanted, ...body];
  const lines = text.length ? text.split("\n") : [];

  const start = lines.findIndex((l) => l.trim() === wanted);
  if (start === -1) {
    const out = [...lines];
    // Ensure a blank separator before the appended section.
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    if (out.length) out.push("");
    out.push(...block, "");
    return out.join("\n");
  }

  let end = start + 1;
  while (end < lines.length && !isHeaderLine(lines[end])) end++;
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
}

/** Remove a table section (header + body). Returns the updated text. */
export function removeSection(text: string, header: string): string {
  const wanted = header.trim();
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === wanted);
  if (start === -1) return text;

  let end = start + 1;
  while (end < lines.length && !isHeaderLine(lines[end])) end++;

  const before = lines.slice(0, start);
  const after = lines.slice(end);
  // Collapse a doubled blank line left at the seam.
  while (before.length && before[before.length - 1].trim() === "" && after.length && after[0].trim() === "") {
    after.shift();
  }
  return [...before, ...after].join("\n");
}
