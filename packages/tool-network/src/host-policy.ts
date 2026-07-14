const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1") return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  if (h.startsWith("fe80:")) return true;
  return false;
}

export function hostnameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true;

  const ipv4 = parseIpv4(host);
  if (ipv4) return isPrivateIpv4(ipv4);

  if (host.includes(":")) return isPrivateIpv6(host);

  return false;
}

export function hostMatchesAllowlist(
  hostname: string,
  allowedHosts: string[],
): boolean {
  if (!allowedHosts.length) return true;
  const host = hostname.toLowerCase();
  for (const entry of allowedHosts) {
    const rule = entry.trim().toLowerCase();
    if (!rule) continue;
    if (host === rule) return true;
    if (host.endsWith(`.${rule}`)) return true;
  }
  return false;
}

export function validateHttpUrl(url: string): { ok: true; hostname: string } | { ok: false; reason: string } {
  const hostname = hostnameFromUrl(url);
  if (!hostname) {
    return { ok: false, reason: "Only http(s) URLs are allowed" };
  }
  if (isBlockedHostname(hostname)) {
    return { ok: false, reason: `Blocked host: ${hostname}` };
  }
  return { ok: true, hostname };
}
