import type { Json } from "./json.js";

export type McpTool = Record<string, unknown> & {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type McpToolCall = {
  toolName: string;
  arguments: Json;
};

export type McpToolResult = Record<string, unknown>;

export type UpstreamMcpClient = {
  listTools(): Promise<readonly McpTool[]>;
  callTool(call: McpToolCall): Promise<McpToolResult>;
};
