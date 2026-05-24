import type { McpToolCall } from "./mcp.js";
import { resolveWrapperFamilyActionType } from "./extractors/wrapper-registry.js";

export type BindRequest = {
  action_type: string;
  action_payload: Record<string, unknown>;
  intent: string;
  intent_version: string;
};

export type BindOutcome = "APPROVED" | "ESCALATED" | "REFUSED";

export type BindReceipt = {
  outcome: BindOutcome;
  receipt_id: string;
  signature: string;
  [field: string]: unknown;
};

export type BindResponse = BindReceipt;

export type BindClient = {
  bind(request: BindRequest): Promise<BindResponse>;
};

export function buildBindRequest(call: McpToolCall): BindRequest {
  const actionType = resolveWrapperFamilyActionType(call);

  return {
    action_type: actionType,
    action_payload: {
      tool_name: call.toolName,
      arguments: call.arguments
    },
    intent: `mcp:${actionType}`,
    intent_version: "1.0"
  };
}
