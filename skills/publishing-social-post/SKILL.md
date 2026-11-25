---
name: publishing-social-post
description: Publish an opaque payload through a connected account. Use when the user asks to publish or post through an account that is already connected.
---

1. Call `connector_list_publish_accounts`. If no account is connected, stop and ask for a connection. If more than one account is connected and the user did not choose one, ask which account to use and do not publish.
2. Call `connector_publish` with `connectorId`, `connectorAccountId`, `idempotencyKey`, and `payload`. Pass `payload` through unchanged.
3. Reuse the same idempotency key when retrying the same request.
4. Report a table with connector, account, status, and url or reason.
5. When status is `unknown`, do not publish again. Say the outcome is unknown.
