import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BindClient, BindOutcome, StdioUpstream } from "../src/index.js";
import { connectStdioUpstream, createMcpProxyServer, createProxyCore } from "../src/index.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/reference-upstream-mcp-server.ts", import.meta.url)
);
const tsxCliPath = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

describe("stdio upstream MCP proxy e2e", () => {
  let upstream: StdioUpstream;
  let proxyServer: Server;
  let proxyClient: Client;

  async function startProxy(bindClient: BindClient): Promise<void> {
    upstream = await connectStdioUpstream({
      command: process.execPath,
      args: [tsxCliPath, fixturePath],
      cwd: process.cwd(),
      stderr: "pipe"
    });

    const core = createProxyCore({
      upstream: upstream.client,
      bindClient
    });
    proxyServer = createMcpProxyServer(core, {
      name: "lyhna-mcp-proxy-e2e",
      version: "0.1.0"
    });
    proxyClient = new Client({
      name: "lyhna-mcp-proxy-e2e-client",
      version: "0.1.0"
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([proxyServer.connect(serverTransport), proxyClient.connect(clientTransport)]);
  }

  async function readEchoCallCount(): Promise<number> {
    const result = await proxyClient.callTool({
      name: "read_count",
      arguments: {}
    });
    return Number((result.structuredContent as { echoCallCount?: unknown } | undefined)?.echoCallCount);
  }

  afterEach(async () => {
    await proxyClient?.close();
    await proxyServer?.close();
    await upstream?.close();
  });

  describe("APPROVED bind", () => {
    beforeEach(async () => {
      await startProxy({
        async bind() {
          return {
            outcome: "APPROVED",
            receipt_id: "receipt_approved",
            signature: "sig_approved"
          };
        }
      });
    });

    it("mirrors real upstream tools/list and forwards tools/call to the real upstream", async () => {
      const listResult = await proxyClient.listTools();

      expect(listResult.tools.map((tool) => tool.name).sort()).toEqual(["echo", "read_count"]);
      expect(await readEchoCallCount()).toBe(0);

      const callResult = await proxyClient.callTool({
        name: "echo",
        arguments: { message: "hello from e2e" }
      });

      expect(callResult.content).toEqual([{ type: "text", text: "hello from e2e" }]);
      expect(callResult.structuredContent).toEqual({
        message: "hello from e2e",
        echoCallCount: 1
      });
      expect(await readEchoCallCount()).toBe(1);
    });
  });

  it("fails closed and does not forward when bind refuses", async () => {
    await startProxy(bindByToolName({ echo: "REFUSED", read_count: "APPROVED" }));

    expect(await readEchoCallCount()).toBe(0);
    await expect(
      proxyClient.callTool({
        name: "echo",
        arguments: { message: "should not forward" }
      })
    ).rejects.toThrow(/Bind refused|did not allow forwarding/);
    expect(await readEchoCallCount()).toBe(0);
  });

  it("fails closed and does not forward when bind errors", async () => {
    await startProxy({
      async bind(request) {
        if (request.action_type === "read_count") {
          return {
            outcome: "APPROVED",
            receipt_id: "receipt_read_count",
            signature: "sig_read_count"
          };
        }
        throw new Error("bind unreachable");
      }
    });

    expect(await readEchoCallCount()).toBe(0);
    await expect(
      proxyClient.callTool({
        name: "echo",
        arguments: { message: "should not forward" }
      })
    ).rejects.toThrow(/Bind failed before upstream execution/);
    expect(await readEchoCallCount()).toBe(0);
  });

  it("holds and does not forward when bind escalates", async () => {
    await startProxy(bindByToolName({ echo: "ESCALATED", read_count: "APPROVED" }));

    expect(await readEchoCallCount()).toBe(0);
    await expect(
      proxyClient.callTool({
        name: "echo",
        arguments: { message: "should be held" }
      })
    ).rejects.toThrow(/Bind escalated/);
    expect(await readEchoCallCount()).toBe(0);
  });
});

function bindByToolName(outcomes: Record<string, BindOutcome>): BindClient {
  return {
    async bind(request) {
      const outcome = outcomes[request.action_type] ?? "REFUSED";
      return {
        outcome,
        receipt_id: `receipt_${request.action_type}_${outcome}`,
        signature: `sig_${request.action_type}_${outcome}`
      };
    }
  };
}
