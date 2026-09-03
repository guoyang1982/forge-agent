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
  executeDelayMs = 0;
  executeImpl?: (
    input: ApprovedConnectorAction,
    credential: ResolvedCredential,
  ) => Promise<AdapterResult>;

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
    if (this.executeImpl) {
      return this.executeImpl(input, credential);
    }
    if (this.executeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.executeDelayMs));
    }
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
