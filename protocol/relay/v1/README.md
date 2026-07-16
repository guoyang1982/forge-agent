# Forge Relay outer protocol v1

This directory is the language-neutral source of truth for the public Relay
HTTP/WebSocket control protocol. Relay payload forwarding remains opaque binary
data and the Relay must not parse the E2EE Mobile RPC carried inside it.

- `schemas/` contains strict JSON Schema contracts.
- `testdata/*.valid.jsonl` must be accepted by Go and TypeScript implementations.
- `testdata/*.invalid.jsonl` must be rejected by both implementations.
- `error-codes.json` defines stable, sanitized public error codes.

Changes are additive within v1. Removing fields, changing meanings, or tightening
previously accepted values requires a new protocol version.

## WebSocket authentication headers

- `/v1/host/control`: `Authorization: Bearer <short-lived-host-jwt>`.
- `/v1/host/data/:connId`: `Authorization: Bearer <single-use-conn-ticket>`.
- `/v1/connect/:hostId`: `Authorization: Bearer <invite-or-resume-token>` and
  `X-Forge-Credential-Kind: invite|resume`.
- Resume connections additionally send `X-Forge-Device-ID`; invite connections
  derive the device ID from the consumed invite and ignore client-supplied IDs.

Credentials must not appear in URLs, access logs, close reasons, or metrics.
Native clients may omit `Origin`; browser origins remain subject to the Relay's
same-host WebSocket origin check.
