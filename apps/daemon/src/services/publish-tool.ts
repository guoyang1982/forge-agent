import type { SubjectRef } from "@forge/protocol";
import type { Database } from "@forge/store";
import type { ToolRegistry } from "@forge/tools";
import {
  listPublishAccounts,
  type PublishRequest,
  type SocialPublishService,
} from "@forge/connectors";

export interface PublishRuntime {
  service: SocialPublishService;
  subject: SubjectRef;
  db: Database;
}

export function attachPublishTool(
  registry: ToolRegistry,
  runtime: { publish?: PublishRuntime },
): void {
  const publish = runtime.publish;
  if (!publish) return;

  registry.register(
    {
      name: "connector_list_publish_accounts",
      description:
        "List connected accounts that declare publish. Returns connector id, account id, and name only.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    async () => {
      const accounts = listPublishAccounts(publish.db, publish.subject);
      return JSON.stringify({ ok: true, accounts });
    },
  );

  registry.register(
    {
      name: "connector_publish",
      description:
        "Publish an opaque payload through one connected account. The payload is forwarded unchanged.",
      parameters: {
        type: "object",
        properties: {
          connectorId: { type: "string" },
          connectorAccountId: { type: "string" },
          idempotencyKey: { type: "string" },
          payload: { type: "object" },
        },
        required: ["connectorId", "connectorAccountId", "idempotencyKey", "payload"],
      },
    },
    async (args) => {
      if (!isPayload(args.payload)) {
        return JSON.stringify({
          ok: false,
          status: "invalid_request",
          reason: "payload_must_be_object",
        });
      }
      const request: PublishRequest = {
        connectorId: String(args.connectorId ?? ""),
        connectorAccountId: String(args.connectorAccountId ?? ""),
        idempotencyKey: String(args.idempotencyKey ?? ""),
        payload: args.payload,
      };
      const published = await publish.service.publish(request, publish.subject);
      return JSON.stringify({ ok: published.status === "succeeded", ...published });
    },
  );
}

function isPayload(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
