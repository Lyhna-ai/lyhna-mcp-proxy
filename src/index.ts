export type { Json, JsonObject } from "./json.js";
export type { BindClient, BindOutcome, BindReceipt, BindRequest, BindResponse } from "./bind.js";
export { buildBindRequest } from "./bind.js";
export {
  resolveWrapperFamilyActionType,
  WRAPPER_FAMILY_DESCRIPTORS
} from "./extractors/wrapper-registry.js";
export type {
  WrapperArgumentReader,
  WrapperFamilyDescriptor
} from "./extractors/wrapper-registry.js";
export type { ForwardDecision } from "./enforcement.js";
export { decideForward } from "./enforcement.js";
export type { McpTool, McpToolCall, McpToolResult, UpstreamMcpClient } from "./mcp.js";
export { BindGateError, createProxyCore } from "./proxy-core.js";
export {
  connectStreamableHttpUpstream,
  connectStdioUpstream,
  connectUpstream,
  createMcpProxyServer,
  createMcpRequestHandlers,
  serveStreamableHttpProxy,
  serveStdioProxy
} from "./transport/mcp-sdk.js";
export type {
  McpProxyRequestHandlers,
  StreamableHttpUpstream,
  StdioUpstream,
  StdioUpstreamConfig,
  StreamableHttpUpstreamConfig,
  StreamableHttpProxy,
  StreamableHttpProxyOptions,
  UpstreamConfig
} from "./transport/mcp-sdk.js";

export async function main(): Promise<void> {
  process.stdout.write(
    JSON.stringify(
      {
        status: "ready",
        message:
          "Standalone Lyhna MCP proxy core is ready with stdio and Streamable HTTP transport support."
      },
      null,
      2
    ) + "\n"
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
