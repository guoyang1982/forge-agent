export interface GrepResult {
  matchCount: number;
  preview: string;
  raw: string;
}

/** Parse ripgrep --json stdout into match count + short preview. */
export function parseRgJson(stdout: string): GrepResult {
  const previewLines: string[] = [];
  let matchCount = 0;

  for (const line of stdout.split("\n").filter(Boolean)) {
    try {
      const row = JSON.parse(line) as {
        type?: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
        };
      };
      if (row.type !== "match") continue;
      matchCount++;
      if (previewLines.length < 8) {
        const path = row.data?.path?.text ?? "?";
        const ln = row.data?.line_number ?? 0;
        const text = (row.data?.lines?.text ?? "").trim().slice(0, 80);
        previewLines.push(`${path}:${ln}: ${text}`);
      }
    } catch {
      /* skip non-json lines */
    }
  }

  const preview =
    previewLines.length > 0
      ? previewLines.join("\n")
      : stdout.slice(0, 8000);

  return {
    matchCount,
    preview: preview.slice(0, 8000),
    raw: stdout.slice(0, 8000),
  };
}
