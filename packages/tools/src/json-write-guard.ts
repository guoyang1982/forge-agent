const JSON_LIKE = /\.(json|excalidraw)$/i;

export function validateJsonLikeWrite(
  path: string,
  content: string,
): { ok: true } | { ok: false; error: string; hint: string } {
  if (!JSON_LIKE.test(path)) return { ok: true };
  const trimmed = content.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "Refusing empty JSON document",
      hint:
        "Output exactly one valid JSON object/array. For .excalidraw use write_file with overwrite:true and a single document only.",
    };
  }
  try {
    JSON.parse(trimmed);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const duplicateHint =
      /unexpected token|unexpected non-whitespace|after json/i.test(msg)
        ? " Content may be duplicated (two JSON documents concatenated) or have extra `}`."
        : "";
    return {
      ok: false,
      error: `Invalid JSON for ${path}: ${msg}${duplicateHint}`,
      hint:
        "Regenerate ONE clean document only. Do not append to read_file output. " +
        "Use write_file(path, content, overwrite:true) with the full file body — never two root objects.",
    };
  }
}
