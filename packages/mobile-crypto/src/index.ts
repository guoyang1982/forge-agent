import nacl from "tweetnacl";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";

export const MOBILE_CRYPTO_VERSION = 1 as const;
export const X25519_KEY_BYTES = 32;
export const SESSION_ID_BYTES = 32;
export const SECRETBOX_KEY_BYTES = 32;
export const SECRETBOX_NONCE_BYTES = 24;
export const MAX_DECRYPT_FAILURES = 5;

const FRAME_HEADER_BYTES = 43;
const FRAME_NONCE_SESSION_PREFIX_BYTES = 13;
const MAX_COUNTER = 0xffff_ffff_ffff_ffffn;
const textEncoder = new TextEncoder();

export type FrameDirection = "phone_to_host" | "host_to_phone";
export type FramePayloadKind = "text" | "binary";

export interface X25519KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface MobileHandshakeTranscript {
  protocolVersion: 1;
  phoneEphemeralPublicKey: string;
  hostE2eePublicKey: string;
  clientNonce: string;
  serverNonce: string;
  hostId: string;
  deviceId: string;
  relayOrigin: string;
  transport: "relay";
  selectedFraming: "secretbox-v1";
  capabilities: string[];
}

export interface MobileSessionKeys {
  phoneToHostKey: Uint8Array;
  hostToPhoneKey: Uint8Array;
  sessionId: Uint8Array;
}

export interface MobilePairingCredentials {
  deviceToken: string;
  resumeToken: string;
}

export function derivePairingCredentials(
  pairingSecret: string,
): MobilePairingCredentials {
  const secret = decodeCanonicalBase64Url(pairingSecret, 32);
  return {
    deviceToken: `device_${encodeBase64Url(
      hmac(sha256, secret, textEncoder.encode("forge-mobile-v1/device-token")),
    )}`,
    resumeToken: `resume_${encodeBase64Url(
      hmac(sha256, secret, textEncoder.encode("forge-mobile-v1/relay-resume")),
    )}`,
  };
}

export interface OpenedFrame {
  counter: bigint;
  direction: FrameDirection;
  payloadKind: FramePayloadKind;
  payload: Uint8Array;
}

export type FrameErrorCode =
  | "invalid_frame"
  | "authentication_failed"
  | "session_mismatch"
  | "direction_mismatch"
  | "payload_kind_mismatch"
  | "counter_mismatch"
  | "too_many_failures";

export class FrameOpenError extends Error {
  constructor(
    readonly code: FrameErrorCode,
    message: string,
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = "FrameOpenError";
  }
}

export function generateX25519KeyPair(
  randomBytes: (length: number) => Uint8Array = nacl.randomBytes,
): X25519KeyPair {
  const secretKey = Uint8Array.from(randomBytes(X25519_KEY_BYTES));
  assertLength("X25519 secret key", secretKey, X25519_KEY_BYTES);
  return {
    secretKey,
    publicKey: nacl.scalarMult.base(secretKey),
  };
}

export function deriveX25519SharedSecret(
  secretKey: Uint8Array,
  peerPublicKey: Uint8Array,
): Uint8Array {
  assertLength("X25519 secret key", secretKey, X25519_KEY_BYTES);
  assertLength("X25519 public key", peerPublicKey, X25519_KEY_BYTES);
  const shared = nacl.scalarMult(secretKey, peerPublicKey);
  if (shared.every((byte) => byte === 0)) {
    throw new Error("X25519 rejected a low-order peer public key");
  }
  return shared;
}

export function canonicalizeTranscript(
  transcript: MobileHandshakeTranscript,
): string {
  const normalized: MobileHandshakeTranscript = {
    ...transcript,
    capabilities: [...new Set(transcript.capabilities)].sort(),
  };
  return canonicalJson(normalized);
}

export function hashHandshakeTranscript(
  transcript: MobileHandshakeTranscript,
): Uint8Array {
  return sha256(textEncoder.encode(canonicalizeTranscript(transcript)));
}

export function deriveMobileSessionKeys(input: {
  sharedSecret: Uint8Array;
  clientNonce: Uint8Array;
  serverNonce: Uint8Array;
  transcriptHash: Uint8Array;
}): MobileSessionKeys {
  assertLength("shared secret", input.sharedSecret, X25519_KEY_BYTES);
  assertLength("client nonce", input.clientNonce, 32);
  assertLength("server nonce", input.serverNonce, 32);
  assertLength("transcript hash", input.transcriptHash, 32);

  const salt = sha256(
    concatBytes(
      textEncoder.encode("forge-mobile-v1/salt\0"),
      input.clientNonce,
      input.serverNonce,
    ),
  );
  const info = concatBytes(
    textEncoder.encode("forge-mobile-v1/session-keys\0"),
    input.transcriptHash,
  );
  const output = hkdf(sha256, input.sharedSecret, salt, info, 96);
  return {
    phoneToHostKey: output.slice(0, 32),
    hostToPhoneKey: output.slice(32, 64),
    sessionId: output.slice(64, 96),
  };
}

export function sealSecretboxFrame(input: {
  key: Uint8Array;
  sessionId: Uint8Array;
  direction: FrameDirection;
  payloadKind: FramePayloadKind;
  counter: bigint;
  payload: Uint8Array;
}): Uint8Array {
  assertLength("secretbox key", input.key, SECRETBOX_KEY_BYTES);
  assertLength("session id", input.sessionId, SESSION_ID_BYTES);
  assertCounter(input.counter);
  const nonce = buildNonce(
    input.sessionId,
    input.direction,
    input.payloadKind,
    input.counter,
  );
  const header = buildHeader(
    input.sessionId,
    input.direction,
    input.payloadKind,
    input.counter,
  );
  const box = nacl.secretbox(concatBytes(header, input.payload), nonce, input.key);
  return concatBytes(nonce, box);
}

export function openSecretboxFrame(input: {
  key: Uint8Array;
  sessionId: Uint8Array;
  direction: FrameDirection;
  expectedPayloadKind?: FramePayloadKind;
  expectedCounter: bigint;
  frame: Uint8Array;
}): OpenedFrame {
  assertLength("secretbox key", input.key, SECRETBOX_KEY_BYTES);
  assertLength("session id", input.sessionId, SESSION_ID_BYTES);
  assertCounter(input.expectedCounter);
  if (
    input.frame.length <
    SECRETBOX_NONCE_BYTES + nacl.secretbox.overheadLength + FRAME_HEADER_BYTES
  ) {
    throw new FrameOpenError("invalid_frame", "encrypted frame is too short", true);
  }

  const nonce = input.frame.slice(0, SECRETBOX_NONCE_BYTES);
  const box = input.frame.slice(SECRETBOX_NONCE_BYTES);
  const plaintext = nacl.secretbox.open(box, nonce, input.key);
  if (!plaintext) {
    throw new FrameOpenError(
      "authentication_failed",
      "encrypted frame authentication failed",
      false,
    );
  }
  if (plaintext.length < FRAME_HEADER_BYTES) {
    throw new FrameOpenError("invalid_frame", "decrypted frame is too short", true);
  }

  const version = plaintext[0];
  if (version !== MOBILE_CRYPTO_VERSION) {
    throw new FrameOpenError("invalid_frame", "unsupported frame version", true);
  }
  const sessionId = plaintext.slice(1, 33);
  if (!constantTimeEqual(sessionId, input.sessionId)) {
    throw new FrameOpenError("session_mismatch", "frame session mismatch", true);
  }
  const direction = decodeDirection(plaintext[33]!);
  if (direction !== input.direction) {
    throw new FrameOpenError(
      "direction_mismatch",
      "frame direction mismatch",
      true,
    );
  }
  const payloadKind = decodePayloadKind(plaintext[34]!);
  if (input.expectedPayloadKind && payloadKind !== input.expectedPayloadKind) {
    throw new FrameOpenError(
      "payload_kind_mismatch",
      "frame payload kind mismatch",
      true,
    );
  }
  const counter = readUint64(plaintext, 35);
  if (counter !== input.expectedCounter) {
    throw new FrameOpenError(
      "counter_mismatch",
      `expected frame counter ${input.expectedCounter}, received ${counter}`,
      true,
    );
  }
  const expectedNonce = buildNonce(
    input.sessionId,
    direction,
    payloadKind,
    counter,
  );
  if (!constantTimeEqual(nonce, expectedNonce)) {
    throw new FrameOpenError("invalid_frame", "frame nonce mismatch", true);
  }

  return {
    counter,
    direction,
    payloadKind,
    payload: plaintext.slice(FRAME_HEADER_BYTES),
  };
}

export class SecretboxFrameSealer {
  private nextCounter = 0n;

  constructor(
    private readonly key: Uint8Array,
    private readonly sessionId: Uint8Array,
    private readonly direction: FrameDirection,
  ) {}

  seal(payloadKind: FramePayloadKind, payload: Uint8Array): Uint8Array {
    if (this.nextCounter > MAX_COUNTER) throw new Error("frame counter exhausted");
    const frame = sealSecretboxFrame({
      key: this.key,
      sessionId: this.sessionId,
      direction: this.direction,
      payloadKind,
      counter: this.nextCounter,
      payload,
    });
    this.nextCounter += 1n;
    return frame;
  }
}

export class SecretboxFrameOpener {
  private expectedCounter = 0n;
  private consecutiveFailures = 0;

  constructor(
    private readonly key: Uint8Array,
    private readonly sessionId: Uint8Array,
    private readonly direction: FrameDirection,
  ) {}

  open(
    frame: Uint8Array,
    expectedPayloadKind?: FramePayloadKind,
  ): OpenedFrame {
    try {
      const opened = openSecretboxFrame({
        key: this.key,
        sessionId: this.sessionId,
        direction: this.direction,
        expectedPayloadKind,
        expectedCounter: this.expectedCounter,
        frame,
      });
      this.expectedCounter += 1n;
      this.consecutiveFailures = 0;
      return opened;
    } catch (error) {
      if (!(error instanceof FrameOpenError)) throw error;
      if (error.code !== "authentication_failed") throw error;
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= MAX_DECRYPT_FAILURES) {
        throw new FrameOpenError(
          "too_many_failures",
          "too many consecutive frame authentication failures",
          true,
        );
      }
      throw error;
    }
  }
}

function buildHeader(
  sessionId: Uint8Array,
  direction: FrameDirection,
  payloadKind: FramePayloadKind,
  counter: bigint,
): Uint8Array {
  const header = new Uint8Array(FRAME_HEADER_BYTES);
  header[0] = MOBILE_CRYPTO_VERSION;
  header.set(sessionId, 1);
  header[33] = encodeDirection(direction);
  header[34] = encodePayloadKind(payloadKind);
  writeUint64(header, 35, counter);
  return header;
}

function buildNonce(
  sessionId: Uint8Array,
  direction: FrameDirection,
  payloadKind: FramePayloadKind,
  counter: bigint,
): Uint8Array {
  const nonce = new Uint8Array(SECRETBOX_NONCE_BYTES);
  nonce.set(sessionId.slice(0, FRAME_NONCE_SESSION_PREFIX_BYTES), 0);
  nonce[13] = MOBILE_CRYPTO_VERSION;
  nonce[14] = encodeDirection(direction);
  nonce[15] = encodePayloadKind(payloadKind);
  writeUint64(nonce, 16, counter);
  return nonce;
}

function encodeDirection(direction: FrameDirection): number {
  return direction === "phone_to_host" ? 1 : 2;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCanonicalBase64Url(value: string, length: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url value");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("invalid base64url value");
  }
  const decoded = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (decoded.length !== length || encodeBase64Url(decoded) !== value) {
    throw new Error("invalid base64url value");
  }
  return decoded;
}

function decodeDirection(value: number): FrameDirection {
  if (value === 1) return "phone_to_host";
  if (value === 2) return "host_to_phone";
  throw new FrameOpenError("invalid_frame", "invalid frame direction", true);
}

function encodePayloadKind(kind: FramePayloadKind): number {
  return kind === "text" ? 1 : 2;
}

function decodePayloadKind(value: number): FramePayloadKind {
  if (value === 1) return "text";
  if (value === 2) return "binary";
  throw new FrameOpenError("invalid_frame", "invalid frame payload kind", true);
}

function writeUint64(target: Uint8Array, offset: number, value: bigint): void {
  assertCounter(value);
  let remaining = value;
  for (let index = 7; index >= 0; index -= 1) {
    target[offset + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function readUint64(source: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let index = 0; index < 8; index += 1) {
    result = (result << 8n) | BigInt(source[offset + index]!);
  }
  return result;
}

function assertCounter(counter: bigint): void {
  if (counter < 0n || counter > MAX_COUNTER) {
    throw new Error("frame counter must be an unsigned 64-bit integer");
  }
}

function assertLength(name: string, value: Uint8Array, length: number): void {
  if (value.length !== length) {
    throw new Error(`${name} must be ${length} bytes`);
  }
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}
