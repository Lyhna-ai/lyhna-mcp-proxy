// The agent-facing `record_claim` tool — the capture point for the agent's own account of what it did.
//
// This is the AGENT'S voice, by design: claimed-vs-actual only works when the claim comes from the
// narrator under audit. The tool RECORDS a claim into the per-loop claim recorder and returns a
// confirmation — it performs no real action, forwards nothing upstream, and grants nothing. The agent
// can write a claim but can never read or alter the witnessed judgment ledger (supervisor-only), so it
// cannot forge the "actual" side.
//
// This module is the pure tool DEFINITION (the MCP descriptor) + its handler, with no transport
// wiring. The transport layer (mcp-sdk.ts) injects RECORD_CLAIM_TOOL into the tool list and routes a
// call to handleRecordClaim, supplying the claim recorder and the loop_id resolved from the active
// loop session. Keeping the logic here makes it unit-testable without standing up the proxy.

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import type { AgentClaimRecorder } from "./claim-recorder.js";

export const RECORD_CLAIM_TOOL_NAME = "record_claim";

export const RECORD_CLAIM_TOOL: Tool = {
  name: RECORD_CLAIM_TOOL_NAME,
  description:
    "Record what YOU, the agent, CLAIM you did for a step, so Lyhna can compare your account to what " +
    "actually crossed the tool boundary. Call this AFTER the tool call you are describing has returned " +
    "(one claim per step, in order), so your claim lines up with what the witness observed. It records " +
    "your claim only — it does NOT perform the action, forwards nothing, and grants no authority. " +
    "Lyhna independently witnesses the real tool calls; this is the other half of claimed-vs-actual.",
  inputSchema: {
    type: "object",
    properties: {
      system: {
        type: "string",
        description: 'The system you claim you used, e.g. "gmail", "google_drive", "salesforce".'
      },
      action: {
        type: "string",
        description: 'The action you claim you took, e.g. "send", "create_document".'
      },
      result: {
        type: "string",
        description: 'The result you claim you got, e.g. "sent the follow-up to the prospect".'
      },
      via: {
        type: "string",
        description: 'Any intermediary/route you used, if applicable (e.g. "zapier"). Omit if direct.'
      },
      user_facing: {
        type: "boolean",
        description: "Whether this step is reported to a human or sent outward (drives do-not-send when unverified)."
      },
      turn_ref: {
        type: "string",
        description: "Optional: bind this claim to a specific witnessed turn_ref; otherwise it pairs by order."
      }
    },
    required: ["system"]
  }
};

export interface HandleRecordClaimParams {
  claims: AgentClaimRecorder;
  /** The loop_id of the active loop session, resolved by the transport. Undefined ⇒ no open loop. */
  loopId: string | undefined;
  arguments?: Record<string, unknown>;
}

const textResult = (text: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {})
});

/**
 * Handle a `record_claim` call: validate via the recorder (fail-closed) and record the claim against
 * the active loop. Returns a verdict-led tool RESULT — a missing loop or a malformed claim is an
 * `isError` result the agent can see, never an uncaught throw that crashes the transport.
 */
export function handleRecordClaim(params: HandleRecordClaimParams): CallToolResult {
  const args = params.arguments ?? {};
  if (!params.loopId) {
    return textResult(
      "record_claim requires an open loop; no loop session is active for this call. Nothing was recorded.",
      true
    );
  }
  try {
    const claim = params.claims.record({
      loop_id: params.loopId,
      system: args.system as string,
      action: args.action as string | undefined,
      result: args.result as string | undefined,
      via: args.via as string | undefined,
      user_facing: args.user_facing as boolean | undefined,
      turn_ref: args.turn_ref as string | undefined
    });
    const where = [claim.system, claim.action].filter(Boolean).join(".");
    return textResult(
      `Claim recorded (claim_index ${claim.claim_index}) for loop ${claim.loop_id}: ${where}. ` +
        "Lyhna will compare this to the witnessed tool calls at loop close."
    );
  } catch (error) {
    return textResult(`record_claim failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}
