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

describe("MCP transport — record_claim name collision with an upstream tool", () => {
  const upstreamWithRecordClaim = (calls: McpToolCall[]): UpstreamMcpClient => ({
    async listTools() {
      return [{ name: RECORD_CLAIM_TOOL_NAME, description: "upstream's own record_claim", inputSchema: { type: "object", properties: {} } }];
    },
    async callTool(call) {
      calls.push(call);
      return { content: [{ type: "text", text: "upstream-handled" }] };
    }
  });

  it("does not inject a duplicate when the upstream already advertises record_claim", async () => {
    const capture: ClaimCapture = { claims: createClaimRecorder(), resolveLoopId: () => "L1" };
    const { tools } = await createMcpRequestHandlers(upstreamWithRecordClaim([]), capture).listTools();
    expect(tools.filter((t) => t.name === RECORD_CLAIM_TOOL_NAME)).toHaveLength(1);
  });

  it("forwards record_claim to the upstream (does not hijack) when the upstream owns the name", async () => {
    const calls: McpToolCall[] = [];
    const claims = createClaimRecorder();
    const capture: ClaimCapture = { claims, resolveLoopId: () => "L1" };
    const handlers = createMcpRequestHandlers(upstreamWithRecordClaim(calls), capture);
    await handlers.listTools(); // establish the collision decision
    const result = await handlers.callTool({ name: RECORD_CLAIM_TOOL_NAME, arguments: { system: "gmail" } });
    expect(result).toEqual({ content: [{ type: "text", text: "upstream-handled" }] });
    expect(calls).toHaveLength(1); // mirrored to upstream
    expect(claims.knownLoopIds()).toEqual([]); // not recorded locally
  });
});

describe("MCP transport — record_claim ownership is re-checked, never stale", () => {
  it("stops shadowing once a long-lived upstream starts advertising its own record_claim", async () => {
    let upstreamOwns = false;
    const calls: McpToolCall[] = [];
    const claims = createClaimRecorder();
    const core: UpstreamMcpClient = {
      async listTools() {
        return upstreamOwns
          ? [{ name: RECORD_CLAIM_TOOL_NAME, description: "upstream", inputSchema: { type: "object", properties: {} } }]
          : [{ name: "repo.search", description: "", inputSchema: { type: "object", properties: {} } }];
      },
      async callTool(call) {
        calls.push(call);
        return { content: [{ type: "text", text: "upstream-handled" }] };
      }
    };
    const handlers = createMcpRequestHandlers(core, { claims, resolveLoopId: () => "L1" });

    // Initially the upstream has no record_claim → injected + handled locally.
    expect((await handlers.listTools()).tools.map((t) => t.name)).toContain(RECORD_CLAIM_TOOL_NAME);
    await handlers.callTool({ name: RECORD_CLAIM_TOOL_NAME, arguments: { system: "gmail" } });
    expect(claims.claimsForLoop("L1")).toHaveLength(1);
    expect(calls).toHaveLength(0);

    // The upstream now advertises its own record_claim → proxy must stop injecting/shadowing.
    upstreamOwns = true;
    expect((await handlers.listTools()).tools.filter((t) => t.name === RECORD_CLAIM_TOOL_NAME)).toHaveLength(1);
    await handlers.callTool({ name: RECORD_CLAIM_TOOL_NAME, arguments: { system: "gmail" } });
    expect(calls).toHaveLength(1); // now forwarded to upstream
    expect(claims.claimsForLoop("L1")).toHaveLength(1); // not recorded again locally
  });
});
