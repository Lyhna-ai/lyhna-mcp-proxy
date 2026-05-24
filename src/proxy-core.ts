import type { BindClient, BindRequest, BindResponse } from "./bind.js";
import { buildBindRequest } from "./bind.js";
import { decideForward, type ForwardDecision } from "./enforcement.js";
import type { McpToolCall, McpToolResult, UpstreamMcpClient } from "./mcp.js";

export type ProxyCoreOptions = {
  upstream: UpstreamMcpClient;
  bindClient: BindClient;
  buildRequest?: (call: McpToolCall) => BindRequest;
};

export class BindGateError extends Error {
  readonly decision: Exclude<ForwardDecision, "FORWARD">;
  readonly bindResponse?: BindResponse;

  constructor(
    decision: Exclude<ForwardDecision, "FORWARD">,
    message: string,
    bindResponse?: BindResponse,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "BindGateError";
    this.decision = decision;
    this.bindResponse = bindResponse;
  }
}

export function createProxyCore(options: ProxyCoreOptions): UpstreamMcpClient {
  const buildRequest = options.buildRequest ?? buildBindRequest;

  return {
    listTools() {
      return options.upstream.listTools();
    },

    async callTool(call: McpToolCall): Promise<McpToolResult> {
      const bindRequest = buildRequest(call);
      let bindResponse: BindResponse;

      try {
        bindResponse = await options.bindClient.bind(bindRequest);
      } catch (error) {
        throw new BindGateError(
          "FAIL_CLOSED",
          "Bind failed before upstream execution; call was not forwarded.",
          undefined,
          { cause: error }
        );
      }

      const decision = decideForward(bindResponse);

      if (decision === "FORWARD") {
        return options.upstream.callTool(call);
      }

      if (decision === "HOLD_AWAIT_RESOLUTION") {
        throw new BindGateError(
          decision,
          "Bind escalated; call is held and was not forwarded.",
          bindResponse
        );
      }

      throw new BindGateError(
        decision,
        "Bind refused or did not allow forwarding; call was not forwarded.",
        bindResponse
      );
    }
  };
}
