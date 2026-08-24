import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@forge/protocol";
import { permissionService } from "./permission-service.js";
import { createMcpServerRequestHandler } from "./mcp-permission.js";

describe("MCP elicitation permission bridge", () => {
  it("auto-accepts scoped app access when Forge app permissions are allow", async () => {
    const events: AgentEvent[] = [];
    const handler = createMcpServerRequestHandler(
      (event) => events.push(event),
      "session-auto-allow",
      undefined,
      { enabled: true, open: "allow", control: "allow" },
    );

    await expect(
      handler({
        id: "computer-use-read",
        method: "elicitation/create",
        params: { _meta: { permissionScope: "apps.control" } },
      }),
    ).resolves.toEqual({ action: "accept", content: {} });
    expect(events).toEqual([]);
  });

  it("auto-declines scoped app access when Forge app permissions are disabled", async () => {
    const events: AgentEvent[] = [];
    const handler = createMcpServerRequestHandler(
      (event) => events.push(event),
      "session-auto-deny",
      undefined,
      { enabled: false, open: "allow", control: "allow" },
    );

    await expect(
      handler({
        id: "computer-use-click",
        method: "elicitation/create",
        params: { _meta: { permissionScope: "apps.control" } },
      }),
    ).resolves.toEqual({ action: "decline" });
    expect(events).toEqual([]);
  });

  it("emits an MCP permission card and returns accept after approval", async () => {
    const events: AgentEvent[] = [];
    const handler = createMcpServerRequestHandler(
      (event) => {
        events.push(event);
        if (event.type === "permission_request") {
          setTimeout(() => permissionService.respond(event.id, true), 0);
        }
      },
      "session-1",
    );

    await expect(
      handler({
        id: "server-request-1",
        method: "elicitation/create",
        params: {
          message: "Allow ChatGPT to use Google Chrome?",
          _meta: { riskLevel: "high", subtitle: "Monitor app access." },
          requestedSchema: { type: "object", properties: {} },
        },
      }),
    ).resolves.toEqual({ action: "accept", content: {} });

    expect(events[0]).toMatchObject({
      type: "permission_request",
      sessionId: "session-1",
      kind: "mcp",
      summary: "Allow ChatGPT to use Google Chrome?",
      detail: { riskLevel: "high", subtitle: "Monitor app access." },
    });
  });

  it("returns decline after an explicit denial", async () => {
    const handler = createMcpServerRequestHandler(
      (event) => {
        if (event.type === "permission_request") {
          setTimeout(() => permissionService.respond(event.id, false), 0);
        }
      },
      "session-2",
    );

    await expect(
      handler({
        id: 2,
        method: "elicitation/create",
        params: { message: "Allow app access?" },
      }),
    ).resolves.toEqual({ action: "decline" });
  });
});
