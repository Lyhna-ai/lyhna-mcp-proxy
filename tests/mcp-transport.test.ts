import { describe, expect, it } from "vitest";
import type { McpToolCall, UpstreamMcpClient } from "../src/index.js";
import { createMcpRequestHandlers } from "../src/index.js";

describe("MCP SDK transport handlers", () => {
  it("mirrors tools/list through the proxy core", async () => {
    const core: UpstreamMcpClient = {
      async listTools() {
        return [
          {
            name: "repo.search",
            description: "Search the repo",
            inputSchema: { type: "object", properties: {} }
          }
        ];
      },
      async callTool() {
        throw new Error("not used");
      }
    };

    const handlers = createMcpRequestHandlers(core);

    await expect(handlers.listTools()).resolves.toEqual({
      tools: [
        {
          name: "repo.search",
          description: "Search the repo",
          inputSchema: { type: "object", properties: {} }
        }
      ]
    });
  });

  it("maps tools/call params to the core without mutating arguments", async () => {
    const calls: McpToolCall[] = [];
    const args = { query: "transport" };
    const core: UpstreamMcpClient = {
      async listTools() {
        return [];
      },
      async callTool(call) {
        calls.push(call);
        return { content: [{ type: "text", text: "ok" }] };
      }
    };

    const handlers = createMcpRequestHandlers(core);

    await expect(handlers.callTool({ name: "repo.search", arguments: args })).resolves.toEqual({
      content: [{ type: "text", text: "ok" }]
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ toolName: "repo.search", arguments: args });
    expect(calls[0]?.arguments).toBe(args);
  });

  it("uses an empty argument object when tools/call omits arguments", async () => {
    let observed: McpToolCall | undefined;
    const core: UpstreamMcpClient = {
      async listTools() {
        return [];
      },
      async callTool(call) {
        observed = call;
        return { content: [] };
      }
    };

    const handlers = createMcpRequestHandlers(core);

    await handlers.callTool({ name: "no_args" });
    expect(observed).toEqual({ toolName: "no_args", arguments: {} });
  });
});

import { createClaimRecorder } from "../src/claim-recorder.js";
import { RECORD_CLAIM_TOOL_NAME } from "../src/record-claim-tool.js";
import type { ClaimCapture } from "../src/transport/mcp-sdk.js";

describe("MCP transport — record_claim capture", () => {
  const baseCore = (calls: McpToolCall[]): UpstreamMcpClient => ({
    async listTools() {
      return [{ name: "repo.search", description: "Search the repo", inputSchema: { type: "object", properties: {} } }];
    },
    async callTool(call) {
      calls.push(call);
      return { content: [{ type: "text", text: "forwarded" }] };
    }
  });

  it("does not expose record_claim when capture is off (identical to before)", async () => {
    const handlers = createMcpRequestHandlers(baseCore([]));
    const { tools } = await handlers.listTools();
    expect(tools.some((t) => t.name === RECORD_CLAIM_TOOL_NAME)).toBe(false);
  });

  it("injects record_claim alongside upstream tools when capture is on", async () => {
    const capture: ClaimCapture = { claims: createClaimRecorder(), resolveLoopId: () => "L1" };
    const { tools } = await createMcpRequestHandlers(baseCore([]), capture).listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain(RECORD_CLAIM_TOOL_NAME);
    expect(names).toContain("repo.search");
  });

  it("records a record_claim call against the active loop and never forwards it upstream", async () => {
    const calls: McpToolCall[] = [];
    const claims = createClaimRecorder();
    const capture: ClaimCapture = { claims, resolveLoopId: () => "L1" };
    const result = await createMcpRequestHandlers(baseCore(calls), capture).callTool({
      name: RECORD_CLAIM_TOOL_NAME,
      arguments: { system: "gmail", action: "send", user_facing: true }
    });
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(0); // record_claim is handled by the proxy, never forwarded
    expect(claims.claimsForLoop("L1")).toHaveLength(1);
    expect(claims.claimsForLoop("L1")[0]).toMatchObject({ system: "gmail", action: "send" });
  });

  it("still forwards ordinary tool calls when capture is on", async () => {
    const calls: McpToolCall[] = [];
    const capture: ClaimCapture = { claims: createClaimRecorder(), resolveLoopId: () => "L1" };
    const result = await createMcpRequestHandlers(baseCore(calls), capture).callTool({ name: "repo.search", arguments: { q: "x" } });
    expect(result).toEqual({ content: [{ type: "text", text: "forwarded" }] });
    expect(calls).toEqual([{ toolName: "repo.search", arguments: { q: "x" } }]);
  });

  it("fails closed (isError) when record_claim is called with no open loop", async () => {
    const calls: McpToolCall[] = [];
    const claims = createClaimRecorder();
    const capture: ClaimCapture = { claims, resolveLoopId: () => undefined };
    const result = await createMcpRequestHandlers(baseCore(calls), capture).callTool({ name: RECORD_CLAIM_TOOL_NAME, arguments: { system: "gmail" } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(claims.knownLoopIds()).toEqual([]);
  });
});
