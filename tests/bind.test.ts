import { describe, expect, it } from "vitest";
import { buildBindRequest, decideForward } from "../src/index.js";

describe("buildBindRequest", () => {
  it("builds the strict four-field hosted bind request shape", () => {
    const args = { project: "lyhna", count: 2 };
    const request = buildBindRequest({
      toolName: "repo.search",
      arguments: args
    });

    expect(Object.keys(request).sort()).toEqual([
      "action_payload",
      "action_type",
      "intent",
      "intent_version"
    ]);
    expect(request).toEqual({
      action_type: "repo.search",
      action_payload: {
        tool_name: "repo.search",
        arguments: args
      },
      intent: "mcp:repo.search",
      intent_version: "1.0"
    });
    expect("authority_tier" in request).toBe(false);
    expect("metadata" in request).toBe(false);
    expect("payload_hash" in request).toBe(false);
  });

  it("places the MCP tool name and arguments inside the generic action_payload object", () => {
    const args = { query: "contract" };
    const request = buildBindRequest({
      toolName: "repo.search",
      arguments: args
    });

    expect(request.action_payload).toEqual({
      tool_name: "repo.search",
      arguments: args
    });
    expect(request.action_payload.arguments).toBe(args);
  });
});

describe("decideForward", () => {
  it("only forwards approved bind responses", () => {
    expect(decideForward({ outcome: "APPROVED", receipt_id: "r1", signature: "s1" })).toBe(
      "FORWARD"
    );
    expect(decideForward({ outcome: "ESCALATED", receipt_id: "r2", signature: "s2" })).toBe(
      "HOLD_AWAIT_RESOLUTION"
    );
    expect(decideForward({ outcome: "REFUSED", receipt_id: "r3", signature: "s3" })).toBe(
      "FAIL_CLOSED"
    );
  });
});
