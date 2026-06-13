import { describe, expect, it } from "vitest";

import { createClaimRecorder } from "../src/claim-recorder.js";
import { RECORD_CLAIM_TOOL, RECORD_CLAIM_TOOL_NAME, handleRecordClaim } from "../src/record-claim-tool.js";

describe("record_claim tool", () => {
  it("exposes a well-formed MCP tool descriptor", () => {
    expect(RECORD_CLAIM_TOOL.name).toBe(RECORD_CLAIM_TOOL_NAME);
    expect(typeof RECORD_CLAIM_TOOL.description).toBe("string");
    expect((RECORD_CLAIM_TOOL.description ?? "").length).toBeGreaterThan(0);
    const schema = RECORD_CLAIM_TOOL.inputSchema as { type: string; properties: Record<string, unknown>; required: string[] };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["system"]);
    for (const k of ["system", "action", "result", "via", "user_facing", "turn_ref"]) {
      expect(schema.properties[k]).toBeDefined();
    }
  });

  it("records a claim against the active loop and returns a non-error confirmation", () => {
    const claims = createClaimRecorder();
    const result = handleRecordClaim({
      claims,
      loopId: "L1",
      arguments: { system: "gmail", action: "send", result: "sent the follow-up", user_facing: true }
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: "text" });
    const recorded = claims.claimsForLoop("L1");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ system: "gmail", action: "send", result: "sent the follow-up", user_facing: true, claim_index: 0 });
  });

  it("fails closed (isError) with no open loop and records nothing", () => {
    const claims = createClaimRecorder();
    const result = handleRecordClaim({ claims, loopId: undefined, arguments: { system: "gmail" } });
    expect(result.isError).toBe(true);
    expect(claims.knownLoopIds()).toEqual([]);
  });

  it("turns a malformed claim into an isError result, not a throw", () => {
    const claims = createClaimRecorder();
    const blankSystem = handleRecordClaim({ claims, loopId: "L1", arguments: { action: "send" } });
    expect(blankSystem.isError).toBe(true);
    expect(/system/.test((blankSystem.content[0] as { text: string }).text)).toBe(true);

    const badBoolean = handleRecordClaim({ claims, loopId: "L1", arguments: { system: "gmail", user_facing: "false" } });
    expect(badBoolean.isError).toBe(true);

    expect(claims.claimsForLoop("L1")).toHaveLength(0); // nothing recorded on failure
  });

  it("preserves an explicit turn_ref for correlation", () => {
    const claims = createClaimRecorder();
    handleRecordClaim({ claims, loopId: "L1", arguments: { system: "gmail", turn_ref: "turn:abc" } });
    expect(claims.claimsForLoop("L1")[0]!.turn_ref).toBe("turn:abc");
  });
});
