import { describe, expect, it } from "vitest";
import type { BindClient, McpToolCall, UpstreamMcpClient } from "../src/index.js";
import { BindGateError, createProxyCore } from "../src/index.js";

function makeUpstream(events: string[] = []): UpstreamMcpClient & { calls: McpToolCall[] } {
  const calls: McpToolCall[] = [];

  return {
    calls,
    async listTools() {
      events.push("upstream:list");
      return [{ name: "repo.search", description: "Search the repo" }];
    },
    async callTool(call) {
      events.push("upstream:call");
      calls.push(call);
      return { ok: true };
    }
  };
}

describe("createProxyCore", () => {
  it("mirrors upstream tools/list", async () => {
    const upstream = makeUpstream();
    const bindClient: BindClient = {
      async bind() {
        throw new Error("tools/list should not bind");
      }
    };

    const proxy = createProxyCore({ upstream, bindClient });

    await expect(proxy.listTools()).resolves.toEqual([
      { name: "repo.search", description: "Search the repo" }
    ]);
  });

  it("binds before forwarding an approved call and forwards the original call payload", async () => {
    const events: string[] = [];
    const upstream = makeUpstream(events);
    let boundPayload: Record<string, unknown> | undefined;
    const bindClient: BindClient = {
      async bind(request) {
        events.push("bind");
        expect(request.action_type).toBe("repo.search");
        expect(request.action_payload.tool_name).toBe("repo.search");
        boundPayload = request.action_payload;
        return { outcome: "APPROVED", receipt_id: "receipt_123", signature: "sig_123" };
      }
    };
    const proxy = createProxyCore({ upstream, bindClient });
    const call: McpToolCall = {
      toolName: "repo.search",
      arguments: { query: "bind gate" }
    };

    await expect(proxy.callTool(call)).resolves.toEqual({ ok: true });

    expect(events).toEqual(["bind", "upstream:call"]);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]).toBe(call);
    expect(upstream.calls[0]?.arguments).toBe(call.arguments);
    expect(boundPayload).toEqual({
      tool_name: upstream.calls[0]?.toolName,
      arguments: upstream.calls[0]?.arguments
    });
    expect(boundPayload?.arguments).toBe(upstream.calls[0]?.arguments);
  });

  it("holds escalated calls without forwarding", async () => {
    const upstream = makeUpstream();
    const bindClient: BindClient = {
      async bind() {
        return {
          outcome: "ESCALATED",
          receipt_id: "receipt_escalated",
          signature: "sig_escalated"
        };
      }
    };
    const proxy = createProxyCore({ upstream, bindClient });

    await expect(
      proxy.callTool({ toolName: "repo.write", arguments: { path: "README.md" } })
    ).rejects.toMatchObject({
      name: "BindGateError",
      decision: "HOLD_AWAIT_RESOLUTION"
    });
    expect(upstream.calls).toEqual([]);
  });

  it("fails closed on refused calls without forwarding", async () => {
    const upstream = makeUpstream();
    const bindClient: BindClient = {
      async bind() {
        return { outcome: "REFUSED", receipt_id: "receipt_refused", signature: "sig_refused" };
      }
    };
    const proxy = createProxyCore({ upstream, bindClient });

    await expect(
      proxy.callTool({ toolName: "repo.delete", arguments: { path: "README.md" } })
    ).rejects.toBeInstanceOf(BindGateError);
    expect(upstream.calls).toEqual([]);
  });

  it("fails closed on bind errors without forwarding", async () => {
    const upstream = makeUpstream();
    const bindClient: BindClient = {
      async bind() {
        throw new Error("network down");
      }
    };
    const proxy = createProxyCore({ upstream, bindClient });

    await expect(
      proxy.callTool({ toolName: "repo.write", arguments: { path: "README.md" } })
    ).rejects.toMatchObject({
      name: "BindGateError",
      decision: "FAIL_CLOSED"
    });
    expect(upstream.calls).toEqual([]);
  });
});
