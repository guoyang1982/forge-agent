/** Extract workspace paths from backtick mentions like `src/app.ts`. */
export function extractMentionedPaths(message: string): string[] {
  const matches = message.matchAll(/`([^`\n]{1,400})`/g);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const raw = (match[1] || "").trim();
    if (!raw || raw.includes(" ")) continue;
    // Prefer path-like tokens (slash, or common extensions).
    if (!/[./\\]/.test(raw) && !/\.[A-Za-z0-9]{1,12}$/.test(raw)) continue;
    const normalized = raw.replace(/\\/g, "/");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= 20) break;
  }
  return out;
}

export function formatMentionToken(path: string): string {
  const cleaned = path.trim().replace(/\\/g, "/");
  return `\`${cleaned}\``;
}
