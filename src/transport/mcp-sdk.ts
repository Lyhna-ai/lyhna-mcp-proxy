import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  type Implementation,
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import { createServer, type Server as HttpServer } from "node:http";

import type { Json } from "../json.js";
import type { McpToolCall, UpstreamMcpClient } from "../mcp.js";
import { BindGateError, ScopeGateError } from "../proxy-core.js";
import type { AgentClaimRecorder } from "../claim-recorder.js";
import { RECORD_CLAIM_TOOL, RECORD_CLAIM_TOOL_NAME, handleRecordClaim } from "../record-claim-tool.js";

export type McpProxyRequestHandlers = {
  listTools(): Promise<ListToolsResult>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult>;
};

/**
 * Optional agent-facing claim capture. When supplied, the proxy injects the `record_claim` tool into
 * the agent's tool list and handles it ITSELF — recording the agent's claim against the active loop
 * and returning, never forwarding it upstream or through the bind gate. The agent can write a claim
 * but can never read or alter the witnessed ledger; that asymmetry is the claimed-vs-actual trust
 * model. `resolveLoopId` resolves the loop_id for the current call's session (undefined ⇒ no loop).
 */
export type ClaimCapture = {
  claims: AgentClaimRecorder;
  resolveLoopId: () => string | undefined;
};

export type StdioUpstream = {
  client: UpstreamMcpClient;
  close(): Promise<void>;
};

export type StreamableHttpUpstream = {
  client: UpstreamMcpClient;
  close(): Promise<void>;
};

export type StdioUpstreamConfig = {
  transport: "stdio";
  description: string;
  serverParams: StdioServerParameters;
};

export type StreamableHttpUpstreamConfig = {
  transport: "streamable_http";
  description: string;
  url: string;
  headers?: Record<string, string>;
};

export type UpstreamConfig = StdioUpstreamConfig | StreamableHttpUpstreamConfig;

export type StreamableHttpProxyOptions = {
  host?: string;
  port?: number;
  path?: string;
  serverInfo?: Implementation;
  claimCapture?: ClaimCapture;
};

export type StreamableHttpProxy = {
  url: string;
  server: HttpServer;
  close(): Promise<void>;
};

const DEFAULT_SERVER_INFO: Implementation = {
  name: "lyhna-mcp-proxy",
  version: "0.1.0"
};

const DEFAULT_UPSTREAM_CLIENT_INFO: Implementation = {
  name: "lyhna-mcp-proxy-upstream",
  version: "0.1.0"
};

/**
 * Render a governance verdict (refusal / hold) as a clean, verdict-led tool
 * RESULT with `isError: true` instead of letting the SDK wrap the throw as an
 * opaque protocol error ("MCP error -32603: …"). A refusal is the product
 * working — the agent (and the person reading its transcript) should see the
 * verdict, the reason, and the attestation, not a stack-trace-shaped string.
 *
 * Only gate verdicts are rendered. Upstream/runtime errors keep their
 * existing contract and propagate VERBATIM.
 */
export function renderGateVerdict(error: unknown): CallToolResult | null {
  if (error instanceof ScopeGateError) {
    const held = error.decision === "HOLD_AWAIT_RESOLUTION";
    const verdict = held ? "⏸ HELD FOR RESOLUTION" : "⛔ REFUSED";
    const text = [
      `${verdict} — Lyhna scope gate, before execution.`,
      `Rule: ${error.scopeDecision.reason}`,
      `Attested scope event: ${error.scopeEvent.event_hash}`,
      held
        ? "The call was not forwarded; it is held for the declared resolver."
        : "Nothing was executed. This step is outside the sealed scope; if it belongs in the loop, the supervisor can amend the scope over the control channel."
    ].join("\n");
    return { content: [{ type: "text", text }], isError: true };
  }

  if (error instanceof BindGateError) {
    const held = error.decision === "HOLD_AWAIT_RESOLUTION";
    const receipt = error.bindResponse;
    // The error's own message carries the precise cause (refused bind,
    // unreachable bind, no open loop, unenforceable bound) — keep it.
    const lines = [
      held
        ? "⏸ HELD FOR RESOLUTION by the declared resolver — the call was not forwarded."
        : "⛔ REFUSED — nothing was executed (fail closed).",
      error.message
    ];
    if (receipt && typeof (receipt as Record<string, unknown>).reason === "string") {
      lines.push(`Reason: ${(receipt as Record<string, unknown>).reason as string}`);
    }
    if (receipt?.receipt_id) {
      lines.push(`Signed receipt: ${receipt.receipt_id}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
  }

  return null;
}

// Whether the upstream itself advertises a tool by the record_claim name. Recomputed against the
// CURRENT tool list every time (no sticky cache) so that if a long-lived upstream starts or stops
// advertising its own record_claim, the proxy stops/starts shadowing accordingly.
const upstreamOwnsRecordClaim = (tools: Tool[]): boolean =>
  tools.some((t) => t.name === RECORD_CLAIM_TOOL_NAME);

export function createMcpRequestHandlers(
  core: UpstreamMcpClient,
  claimCapture?: ClaimCapture
): McpProxyRequestHandlers {
  return {
    async listTools() {
      const tools = (await core.listTools()) as Tool[];
      // Expose record_claim alongside the upstream tools so the agent declares its claims through the
      // same MCP surface it calls tools on. Off by default, and skipped when the (current) upstream
      // list already advertises that name — never list a duplicate or shadow an upstream tool.
      const inject = Boolean(claimCapture) && !upstreamOwnsRecordClaim(tools);
      return { tools: inject ? [...tools, RECORD_CLAIM_TOOL] : tools };
    },

    async callTool(params) {
      // record_claim is the proxy's own tool: record the agent's claim and return. It is NEVER built
      // into an McpToolCall, never forwarded upstream, and never reaches the bind/scope gate — UNLESS
      // the upstream owns the name, in which case the call mirrors through to upstream unchanged. The
      // ownership is re-checked against the current tool list per call (record_claim is infrequent),
      // so it can never go stale against a changing upstream.
      if (
        claimCapture &&
        params.name === RECORD_CLAIM_TOOL_NAME &&
        !upstreamOwnsRecordClaim((await core.listTools()) as Tool[])
      ) {
        return handleRecordClaim({
          claims: claimCapture.claims,
          loopId: claimCapture.resolveLoopId(),
          arguments: params.arguments
        });
      }

      const call: McpToolCall = {
        toolName: params.name,
        arguments: toJson(params.arguments ?? {})
      };

      try {
        return (await core.callTool(call)) as CallToolResult;
      } catch (error) {
        const verdict = renderGateVerdict(error);
        if (verdict) {
          return verdict;
        }
        throw error;
      }
    }
  };
}

export function createMcpProxyServer(
  core: UpstreamMcpClient,
  serverInfo: Implementation = DEFAULT_SERVER_INFO,
  claimCapture?: ClaimCapture
): Server {
  const handlers = createMcpRequestHandlers(core, claimCapture);
  const server = new Server(serverInfo, {
    capabilities: {
      tools: {}
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => handlers.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handlers.callTool(request.params)
  );

  return server;
}

export async function serveStdioProxy(
  core: UpstreamMcpClient,
  serverInfo: Implementation = DEFAULT_SERVER_INFO,
  claimCapture?: ClaimCapture
): Promise<Server> {
  const server = createMcpProxyServer(core, serverInfo, claimCapture);
  await server.connect(new StdioServerTransport());
  return server;
}

export async function serveStreamableHttpProxy(
  core: UpstreamMcpClient,
  options: StreamableHttpProxyOptions = {}
): Promise<StreamableHttpProxy> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8765;
  const mcpPath = options.path ?? "/mcp";
  const serverInfo = options.serverInfo ?? DEFAULT_SERVER_INFO;

  const httpServer = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);

    if (requestUrl.pathname !== mcpPath) {
      res.writeHead(404).end("Not Found");
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      res.writeHead(405, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed."
          },
          id: null
        })
      );
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    const mcpServer = createMcpProxyServer(core, serverInfo, options.claimCapture);

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : "Internal server error"
            },
            id: null
          })
        );
      }
    } finally {
      await mcpServer.close().catch(() => undefined);
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}${mcpPath}`;

  return {
    url,
    server: httpServer,
    async close() {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

export async function connectStdioUpstream(
  serverParams: StdioServerParameters,
  clientInfo: Implementation = DEFAULT_UPSTREAM_CLIENT_INFO
): Promise<StdioUpstream> {
  const client = new Client(clientInfo);
  const transport = new StdioClientTransport(serverParams);

  await client.connect(transport);

  return {
    client: {
      async listTools() {
        const result = await client.listTools();
        return result.tools;
      },

      async callTool(call) {
        return client.callTool({
          name: call.toolName,
          arguments: call.arguments as Record<string, unknown>
        });
      }
    },

    async close() {
      await client.close();
    }
  };
}

export async function connectStreamableHttpUpstream(
  url: string,
  options: {
    headers?: Record<string, string>;
    clientInfo?: Implementation;
  } = {}
): Promise<StreamableHttpUpstream> {
  const client = new Client(options.clientInfo ?? DEFAULT_UPSTREAM_CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: options.headers ? { headers: options.headers } : undefined
  });

  await client.connect(transport);

  return {
    client: {
      async listTools() {
        const result = await client.listTools();
        return result.tools;
      },

      async callTool(call) {
        return client.callTool({
          name: call.toolName,
          arguments: call.arguments as Record<string, unknown>
        });
      }
    },

    async close() {
      await client.close();
    }
  };
}

export async function connectUpstream(
  config: UpstreamConfig,
  clientInfo: Implementation = DEFAULT_UPSTREAM_CLIENT_INFO
): Promise<StdioUpstream | StreamableHttpUpstream> {
  if (config.transport === "stdio") {
    return connectStdioUpstream(config.serverParams, clientInfo);
  }

  return connectStreamableHttpUpstream(config.url, {
    headers: config.headers,
    clientInfo
  });
}

function toJson(value: Record<string, unknown>): Json {
  return value as Json;
}
