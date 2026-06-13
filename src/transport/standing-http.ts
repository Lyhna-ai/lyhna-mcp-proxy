// Session-aware standing HTTP MCP transport.
//
// The per-task Streamable HTTP server (serveStreamableHttpProxy) is stateless and binds
// one process-global loop. The STANDING server must instead serve many concurrent
// sessions, routing each request to the LoopSession the supervisor opened for it.
//
// Session identity is carried in the URL PATH the supervisor hands the agent:
//
//     http://<host>:<port>/<mcpPath>/<session_id>
//
// The supervisor mints session_id, opens the loop on the control channel, then gives the
// agent ONLY that URL. The session_id is therefore supervisor-chosen, not transport- or
// agent-negotiated, and the agent "holds only a URL" (it is never the proxy's spawner —
// which is what makes the Phase 5b kill-guard achievable).
//
// Per request: resolve the LoopSession from the registry by the path's session_id and
// build a per-request proxy core scoped to it. The MCP transport stays stateless per
// request (sessionIdGenerator: undefined), exactly as before; only the routing is new.
//
// FAIL CLOSED: a request whose session_id has no open loop (never opened, or already
// closed) is refused at tools/call. The standing service NEVER runs a tool call
// ungoverned. There is no open/close verb on this surface — lifecycle is the control
// channel's alone.

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type Implementation } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type Server as HttpServer } from "node:http";

import type { BindClient } from "../bind.js";
import type { LoopSession } from "../loop.js";
import type { McpToolCall, McpToolResult, UpstreamMcpClient } from "../mcp.js";
import { BindGateError, createProxyCore } from "../proxy-core.js";
import type { LoopSessionRegistry } from "../session-registry.js";
import { createMcpProxyServer, type ClaimCapture } from "./mcp-sdk.js";
import type { AgentClaimRecorder } from "../claim-recorder.js";

const DEFAULT_SERVER_INFO: Implementation = {
  name: "lyhna-mcp-proxy-standing",
  version: "0.1.0"
};

export type StandingHttpProxyOptions = {
  upstream: UpstreamMcpClient;
  bindClient: BindClient;
  registry: LoopSessionRegistry;
  host?: string;
  port?: number;
  path?: string;
  serverInfo?: Implementation;
  /**
   * Optional per-loop claim recorder. When provided, each session's MCP surface exposes the
   * record_claim tool and records the agent's claims against that session's loop_id (resolved from
   * the registry per request). Omitted ⇒ no record_claim tool (claimed-vs-actual capture disabled).
   */
  claims?: AgentClaimRecorder;
};

export type StandingHttpProxy = {
  /** Base URL (without a session segment). Append `/<session_id>` for an agent URL. */
  url: string;
  host: string;
  port: number;
  path: string;
  server: HttpServer;
  /** Build the agent-facing URL for a given session_id. */
  sessionUrl(session_id: string): string;
  close(): Promise<void>;
};

export async function serveStandingHttpProxy(
  options: StandingHttpProxyOptions
): Promise<StandingHttpProxy> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 8765;
  const mcpPath = normalizePath(options.path ?? "/mcp");
  const serverInfo = options.serverInfo ?? DEFAULT_SERVER_INFO;

  const httpServer = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
    const sessionId = extractSessionId(requestUrl.pathname, mcpPath);

    if (sessionId === undefined) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32004,
            message: `Not Found. Expected ${mcpPath}/<session_id>.`
          },
          id: null
        })
      );
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      res.writeHead(405, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null
        })
      );
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    // Resolve the session per request. A missing session yields a fail-closed core:
    // tools/list still mirrors (listing is not a governed action), but tools/call is
    // refused so nothing runs ungoverned.
    const session = options.registry.get(sessionId);
    const core = session
      ? createProxyCore({
          upstream: options.upstream,
          bindClient: options.bindClient,
          loopSession: session,
          // Capsule Gate 1: engage the adapter-side pre-bind scope gate when this session opened
          // with a sealed Scope Capsule. Undefined for baseline (ungated) sessions.
          scope: options.registry.getScope(sessionId)
        })
      : failClosedCore(options.upstream, sessionId);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    // Claim capture is per session: the record_claim tool records against THIS session's loop_id,
    // resolved from the registry per request. resolveLoopId returns undefined when the session has no
    // open loop, in which case record_claim fails closed (no claim is recorded).
    const claimCapture: ClaimCapture | undefined = options.claims
      ? { claims: options.claims, resolveLoopId: () => options.registry.loopIdForSession(sessionId) }
      : undefined;
    const mcpServer = createMcpProxyServer(core, serverInfo, claimCapture);

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
    httpServer.listen(requestedPort, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  const baseUrl = `http://${host}:${port}${mcpPath}`;

  return {
    url: baseUrl,
    host,
    port,
    path: mcpPath,
    server: httpServer,
    sessionUrl(session_id: string) {
      return `${baseUrl}/${encodeURIComponent(session_id)}`;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

/**
 * A core for a request whose session has no open loop. Listing mirrors upstream (not a
 * governed action); any tools/call fails closed — the standing service refuses to run a
 * tool call that is not inside a supervisor-opened loop.
 */
function failClosedCore(upstream: UpstreamMcpClient, sessionId: string): UpstreamMcpClient {
  return {
    listTools() {
      return upstream.listTools();
    },
    callTool(_call: McpToolCall): Promise<McpToolResult> {
      return Promise.reject(
        new BindGateError(
          "FAIL_CLOSED",
          `No open loop for session "${sessionId}"; refusing tools/call (fail closed).`
        )
      );
    }
  };
}

/**
 * Extract the session_id from `<mcpPath>/<session_id>`. Returns undefined when the path
 * is not under mcpPath, or is exactly mcpPath with no session segment, or carries extra
 * segments after the session id, or carries a malformed percent-encoding.
 *
 * The session id arrives in the agent URL, so this must never throw: a malformed
 * encoding (e.g. `/mcp/%E0%A4%A`) would otherwise reject the async listener before the
 * request `try` block and surface as an unhandled rejection. Treat it as an unknown path
 * and fail closed (the caller returns a 404 JSON error).
 */
function extractSessionId(pathname: string, mcpPath: string): string | undefined {
  if (!pathname.startsWith(`${mcpPath}/`)) {
    return undefined;
  }
  const remainder = pathname.slice(mcpPath.length + 1);
  if (remainder.length === 0 || remainder.includes("/")) {
    return undefined;
  }
  try {
    return decodeURIComponent(remainder);
  } catch {
    return undefined;
  }
}

function normalizePath(path: string): string {
  const withLeading = path.startsWith("/") ? path : `/${path}`;
  return withLeading.endsWith("/") ? withLeading.slice(0, -1) : withLeading;
}
