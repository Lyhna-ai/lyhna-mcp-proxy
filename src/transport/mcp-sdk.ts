import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters
} from "@modelcontextprotocol/sdk/client/stdio.js";
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

export type McpProxyRequestHandlers = {
  listTools(): Promise<ListToolsResult>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult>;
};

export type StdioUpstream = {
  client: UpstreamMcpClient;
  close(): Promise<void>;
};

export type StreamableHttpProxyOptions = {
  host?: string;
  port?: number;
  path?: string;
  serverInfo?: Implementation;
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

export function createMcpRequestHandlers(core: UpstreamMcpClient): McpProxyRequestHandlers {
  return {
    async listTools() {
      const tools = await core.listTools();
      return { tools: tools as Tool[] };
    },

    async callTool(params) {
      const call: McpToolCall = {
        toolName: params.name,
        arguments: toJson(params.arguments ?? {})
      };

      return (await core.callTool(call)) as CallToolResult;
    }
  };
}

export function createMcpProxyServer(
  core: UpstreamMcpClient,
  serverInfo: Implementation = DEFAULT_SERVER_INFO
): Server {
  const handlers = createMcpRequestHandlers(core);
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
  serverInfo: Implementation = DEFAULT_SERVER_INFO
): Promise<Server> {
  const server = createMcpProxyServer(core, serverInfo);
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
    const mcpServer = createMcpProxyServer(core, serverInfo);

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

function toJson(value: Record<string, unknown>): Json {
  return value as Json;
}
