import type { ResolvedCredential } from "./types.js";

export interface CredentialProvider {
  resolve(ref: string): Promise<ResolvedCredential>;
}

export class InMemoryCredentialProvider implements CredentialProvider {
  constructor(private readonly secrets: Record<string, string>) {}

  async resolve(ref: string): Promise<ResolvedCredential> {
    const token = this.secrets[ref];
    if (!token) {
      throw new Error(`credential not found: ${ref}`);
    }
    return { ref, bytes: new TextEncoder().encode(token) };
  }
}

export function credentialSecretStrings(
  credential: ResolvedCredential,
): string[] {
  return [new TextDecoder().decode(credential.bytes)];
}

export function disposeCredential(credential: ResolvedCredential): void {
  credential.bytes.fill(0);
}

export function redactSecrets(
  value: string,
  secrets: string[] = [],
): string {
  let redacted = value;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

export function redactObject(
  input: Record<string, unknown>,
  secrets: string[] = [],
): Record<string, unknown> {
  const json = redactSecrets(JSON.stringify(input), secrets);
  return JSON.parse(json) as Record<string, unknown>;
}
