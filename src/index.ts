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
  connectStdioUpstream,
  createMcpProxyServer,
  createMcpRequestHandlers,
  serveStdioProxy
} from "./transport/mcp-sdk.js";
export type { McpProxyRequestHandlers, StdioUpstream } from "./transport/mcp-sdk.js";

export async function main(): Promise<void> {
  process.stdout.write(
    JSON.stringify(
      {
        status: "scaffold",
        message:
          "Standalone Lyhna MCP proxy core initialized. Implement MCP transport and hosted bind client next."
      },
      null,
      2
    ) + "\n"
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
