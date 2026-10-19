export type ForgeDeepLink =
  | { app: "workbench"; kind: "run" | "session"; id: string }
  | { app: "company"; kind: "home" }
  | { app: "company"; kind: "work"; id: string };

const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function parseForgeDeepLink(raw: string): ForgeDeepLink {
  if (typeof raw !== "string" || raw.includes("..")) {
    throw new Error("invalid deep link");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid deep link");
  }

  if (url.protocol !== "forge:") throw new Error("invalid deep link");
  if (url.username || url.password || url.port) throw new Error("invalid deep link");
  if (url.search || url.hash) throw new Error("invalid deep link");

  const host = url.hostname;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part.includes("\\") || part.includes("%"))) {
    throw new Error("invalid deep link");
  }

  if (host === "workbench") {
    if (parts.length !== 2) throw new Error("invalid deep link");
    const [kind, id] = parts;
    if ((kind !== "run" && kind !== "session") || !ID_PATTERN.test(id)) {
      throw new Error("invalid deep link");
    }
    return { app: "workbench", kind, id };
  }

  if (host === "company") {
    if (parts.length === 1 && parts[0] === "home") {
      return { app: "company", kind: "home" };
    }
    if (parts.length === 2 && parts[0] === "work" && ID_PATTERN.test(parts[1])) {
      return { app: "company", kind: "work", id: parts[1] };
    }
    throw new Error("invalid deep link");
  }

  throw new Error("invalid deep link");
}

export function serializeForgeDeepLink(link: ForgeDeepLink): string {
  if (link.app === "workbench") {
    return `forge://workbench/${link.kind}/${link.id}`;
  }
  if (link.kind === "home") {
    return "forge://company/home";
  }
  return `forge://company/work/${link.id}`;
}
