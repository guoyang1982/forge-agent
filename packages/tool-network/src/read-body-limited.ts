export async function readBodyLimited(
  res: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    const truncated = buf.byteLength > maxBytes;
    const slice = truncated ? buf.slice(0, maxBytes) : buf;
    return { bytes: new Uint8Array(slice), truncated };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > maxBytes) {
      const room = maxBytes - total;
      if (room > 0) {
        chunks.push(value.slice(0, room));
        total += room;
      }
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: merged, truncated };
}

export async function readBodyLimitedText(
  res: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const { bytes, truncated } = await readBodyLimited(res, maxBytes, signal);
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    truncated,
  };
}
