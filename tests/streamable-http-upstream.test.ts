import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, describe, expect, it } from "vitest";

import type {
  BindClient,
  McpToolCall,
  StreamableHttpProxy,
  StreamableHttpUpstream,
  UpstreamMcpClient
} from "../src/index.js";
import {
  connectStreamableHttpUpstream,
  createMcpProxyServer,
  createProxyCore,
  serveStreamableHttpProxy
} from "../src/index.js";

describe("streamable HTTP upstream support", () => {
  let upstreamHttpServer: StreamableHttpProxy | undefined;
  let upstreamConnection: StreamableHttpUpstream | undefined;
  let proxyServer: Server | undefined;
  let proxyClient: Client | undefined;

  afterEach(async () => {
    await proxyClient?.close().catch(() => undefined);
    await proxyServer?.close().catch(() => undefined);
    await upstreamConnection?.close().catch(() => undefined);
    await upstreamHttpServer?.close().catch(() => undefined);
  });

  it("connects to a URL-based upstream and mirrors tools/list plus tools/call", async () => {
    const state = createReferenceUpstreamCore();
    upstreamHttpServer = await serveStreamableHttpProxy(state.upstream, {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      serverInfo: {
        name: "reference-http-upstream",
        version: "0.1.0"
      }
    });

    upstreamConnection = await connectStreamableHttpUpstream(upstreamHttpServer.url);

    await expect(upstreamConnection.client.listTools()).resolves.toEqual([
      {
        name: "echo",
        description: "Echo a string back",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string" }
          },
          required: ["message"]
        }
      },
      {
        name: "read_count",
        description: "Read the number of times echo has been called",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ]);

    await expect(
      upstreamConnection.client.callTool({
        toolName: "echo",
        arguments: { message: "hello over http" }
      })
    ).resolves.toEqual({
      content: [{ type: "text", text: "hello over http" }],
      structuredContent: {
        message: "hello over http",
        echoCallCount: 1
      }
    });

    expect(state.readEchoCallCount()).toBe(1);
  });

  it("binds then forwards through a URL-based upstream without mutating the forwarded payload", async () => {
    const state = createReferenceUpstreamCore();
    const forwardedCalls: McpToolCall[] = [];
    let boundActionType: string | undefined;
    let boundPayload: Record<string, unknown> | undefined;

    upstreamHttpServer = await serveStreamableHttpProxy(state.upstream, {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      serverInfo: {
        name: "reference-http-upstream",
        version: "0.1.0"
      }
    });

    upstreamConnection = await connectStreamableHttpUpstream(upstreamHttpServer.url);

    const proxy = createProxyCore({
      upstream: {
        async listTools() {
          return upstreamConnection!.client.listTools();
        },
        async callTool(call) {
          forwardedCalls.push(call);
          return upstreamConnection!.client.callTool(call);
        }
      },
      bindClient: {
        async bind(request) {
          boundActionType = request.action_type;
          expect(request.action_payload.tool_name).toBe("echo");
          boundPayload = request.action_payload;
          return {
            outcome: "APPROVED",
            receipt_id: "receipt_http_upstream",
            signature: "sig_http_upstream"
          };
        }
      } satisfies BindClient
    });

    proxyServer = createMcpProxyServer(proxy, {
      name: "lyhna-mcp-proxy-http-upstream-test",
      version: "0.1.0"
    });
    proxyClient = new Client({
      name: "lyhna-mcp-proxy-http-upstream-client",
      version: "0.1.0"
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([proxyServer.connect(serverTransport), proxyClient.connect(clientTransport)]);

    const originalArgs = { message: "proxied over url upstream" };

    await expect(
      proxyClient.callTool({
        name: "echo",
        arguments: originalArgs
      })
    ).resolves.toEqual({
      content: [{ type: "text", text: "proxied over url upstream" }],
      structuredContent: {
        message: "proxied over url upstream",
        echoCallCount: 1
      }
    });

    expect(boundActionType).toBe("echo");
    expect(forwardedCalls).toHaveLength(1);
    expect(forwardedCalls[0]).toEqual({
      toolName: "echo",
      arguments: originalArgs
    });
    expect(JSON.stringify(forwardedCalls[0]?.arguments)).toBe(JSON.stringify(originalArgs));
    expect(boundPayload).toEqual({
      tool_name: forwardedCalls[0]?.toolName,
      arguments: forwardedCalls[0]?.arguments
    });
    expect(boundPayload?.arguments).toBe(forwardedCalls[0]?.arguments);
  });
});

function createReferenceUpstreamCore(): {
  upstream: UpstreamMcpClient;
  readEchoCallCount(): number;
} {
  let echoCallCount = 0;

  return {
    upstream: {
      async listTools() {
        return [
          {
            name: "echo",
            description: "Echo a string back",
            inputSchema: {
              type: "object",
              properties: {
                message: { type: "string" }
              },
              required: ["message"]
            }
          },
          {
            name: "read_count",
            description: "Read the number of times echo has been called",
            inputSchema: {
              type: "object",
              properties: {}
            }
          }
        ];
      },

      async callTool(call) {
        if (call.toolName === "echo") {
          echoCallCount += 1;
          const message = String((call.arguments as { message?: unknown }).message ?? "");

          return {
            content: [{ type: "text", text: message }],
            structuredContent: {
              message,
              echoCallCount
            }
          };
        }

        if (call.toolName === "read_count") {
          return {
            structuredContent: {
              echoCallCount
            }
          };
        }

        throw new Error(`Unknown tool: ${call.toolName}`);
      }
    },

    readEchoCallCount() {
      return echoCallCount;
    }
  };
}
