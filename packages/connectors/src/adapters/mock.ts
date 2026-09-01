import type {
  ApprovedConnectorAction,
  AdapterResult,
  ConnectorActionInput,
  ConnectorActionRecord,
  ConnectorAdapter,
  ConnectorProposalPreview,
  ResolvedCredential,
} from "../types.js";

export class MockConnectorAdapter implements ConnectorAdapter {
  readonly kind = "mock";
  executeCalls = 0;

  async propose(input: ConnectorActionInput): Promise<ConnectorProposalPreview> {
    return {
      action: input.action,
      summary: `mock ${input.action}`,
      risk: "low",
    };
  }

  async execute(
    input: ApprovedConnectorAction,
    credential: ResolvedCredential,
  ): Promise<AdapterResult> {
    this.executeCalls += 1;
    return {
      ok: true,
      externalId: `mock:${input.action}:${credential.ref}`,
      summary: `executed ${input.action}`,
    };
  }

  async reconcile(
    input: ConnectorActionRecord,
  ): Promise<AdapterResult | "unknown"> {
    if (input.state === "succeeded") {
      return { ok: true, summary: "already succeeded" };
    }
    return "unknown";
  }
}
