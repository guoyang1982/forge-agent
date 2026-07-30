/** Convert file:// / file:/ URIs from Android File.toURI() into native paths. */
export function toNativePath(uri: string): string {
  let path = uri.trim();
  if (path.startsWith("file://")) {
    path = path.slice("file://".length);
  } else if (path.startsWith("file:")) {
    path = path.slice("file:".length);
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep raw path
  }
  return path;
}
