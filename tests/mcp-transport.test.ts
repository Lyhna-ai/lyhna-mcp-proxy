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
