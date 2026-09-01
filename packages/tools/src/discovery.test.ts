import { describe, expect, it } from "vitest";
import { ToolDiscovery } from "./discovery.js";

describe("ToolDiscovery", () => {
  it("returns summaries first and loads full tool schemas only for selected ids", () => {
    const discovery = toolDiscoveryFixture();
    const hits = discovery.search({ query: "publish content", limit: 5 });
    expect(hits[0]).not.toHaveProperty("inputSchema");
    expect(discovery.loadSchemas([hits[0]!.toolId])[0]).toHaveProperty("inputSchema");
  });

  it("filters tools by granted actions and allowed tool ids", () => {
    const discovery = toolDiscoveryFixture();
    expect(
      discovery.search({
        query: "publish",
        grantedActions: ["connector.publish"],
      }),
    ).toEqual([
      expect.objectContaining({ toolId: "connector.publish" }),
    ]);
    expect(
      discovery.search({
        query: "publish",
        grantedActions: ["connector.publish"],
        allowedToolIds: ["echo"],
      }),
    ).toEqual([]);
  });

  it("returns an empty list when nothing matches", () => {
    const discovery = toolDiscoveryFixture();
    expect(discovery.search({ query: "nonexistent-tool" })).toEqual([]);
  });

  it("records loaded schema versions in trace metadata", () => {
    const discovery = toolDiscoveryFixture();
    const hits = discovery.search({ query: "publish content", limit: 1 });
    const trace = discovery.buildTrace({ query: "publish content" }, [hits[0]!.toolId]);
    expect(trace.loadedSchemaVersions[hits[0]!.toolId]).toBe("v2");
  });
});

function toolDiscoveryFixture(): ToolDiscovery {
  return new ToolDiscovery([
    {
      toolId: "connector.publish",
      name: "connector.publish",
      description: "Publish content to an external channel",
      risk: "high",
      requiredGrantActions: ["connector.publish"],
      schemaVersion: "v2",
      inputSchema: {
        type: "object",
        properties: { channel: { type: "string" }, body: { type: "string" } },
      },
      keywords: ["publish", "content"],
    },
    {
      toolId: "echo",
      name: "echo",
      description: "Echo text back to the caller",
      risk: "low",
      requiredGrantActions: [],
      schemaVersion: "v1",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
      },
    },
  ]);
}
