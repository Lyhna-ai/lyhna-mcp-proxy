import { describe, expect, it } from "vitest";

import { createJudgmentRecorder } from "../src/judgment-recorder.js";
import { createClaimRecorder } from "../src/claim-recorder.js";
import { assembleWitnessInput } from "../src/witness-bridge.js";
import type { JudgmentTurnInput } from "../src/judgment-ledger.js";

function approved(loop_id: string, tool: string, receipt_id: string): JudgmentTurnInput {
  return {
    loop_id,
    scope_ref: "scope_v1:abc",
    prior_receipt_id: null,
    proposed: { action_class: "write", tool_name: tool, target_descriptor: "sha256:tgt" },
    verdict: { kind: "APPROVED", source: "bind", receipt_id }
  };
}

describe("witness-bridge", () => {
  it("projects a JudgmentTurn into the witness event vocabulary (tool name + verdict + runtime report)", () => {
    const jr = createJudgmentRecorder();
    const turn = jr.append(approved("L1", "mcp__Gmail__create_draft", "rcpt_1"));
    jr.attachRuntimeReport("L1", turn.turn_ref, { returned: true, result_hash: "sha256:r" });

    const input = assembleWitnessInput({ objective: "o", claims: [], turns: jr.judgmentLedgerForLoop("L1") });
    expect(input.steps).toHaveLength(1);
    expect(input.steps[0]!.claim).toBeNull();
    expect(input.steps[0]!.event).toEqual({
      call: { toolName: "mcp__Gmail__create_draft" },
      verdict: { kind: "APPROVED" },
      runtime_report: { returned: true, result_hash: "sha256:r" }
    });
  });

  it("pairs a claim with the witnessed turn at the same ordinal", () => {
    const jr = createJudgmentRecorder();
    jr.append(approved("L1", "mcp__Gmail__create_draft", "rcpt_1"));
    const cr = createClaimRecorder();
    cr.record({ loop_id: "L1", system: "gmail", action: "send", result: "sent", user_facing: true });

    const input = assembleWitnessInput({
      objective: "o",
      claims: cr.claimsForLoop("L1"),
      turns: jr.judgmentLedgerForLoop("L1")
    });
    expect(input.steps).toHaveLength(1);
    expect(input.steps[0]!.claim).toEqual({ system: "gmail", action: "send", result: "sent", user_facing: true });
    expect(input.steps[0]!.event!.call.toolName).toBe("mcp__Gmail__create_draft");
  });

  it("leaves a claim with no witnessed turn as event: null (claimed but never seen)", () => {
    const cr = createClaimRecorder();
    cr.record({ loop_id: "L1", system: "gmail", action: "send", user_facing: true });
    const input = assembleWitnessInput({ objective: "o", claims: cr.claimsForLoop("L1"), turns: [] });
    expect(input.steps[0]!.event).toBeNull();
    expect(input.steps[0]!.claim!.system).toBe("gmail");
  });

  it("appends a witnessed turn that no claim matched as an observed (claim: null) step", () => {
    const jr = createJudgmentRecorder();
    jr.append(approved("L1", "a.tool", "rcpt_1"));
    jr.append(approved("L1", "b.tool", "rcpt_2"));
    const cr = createClaimRecorder();
    cr.record({ loop_id: "L1", system: "a", action: "tool" }); // only claims the first

    const input = assembleWitnessInput({
      objective: "o",
      claims: cr.claimsForLoop("L1"),
      turns: jr.judgmentLedgerForLoop("L1")
    });
    expect(input.steps).toHaveLength(2);
    expect(input.steps[0]!.claim!.system).toBe("a");
    expect(input.steps[1]!.claim).toBeNull();
    expect(input.steps[1]!.event!.call.toolName).toBe("b.tool");
  });

  it("honors an explicit turn_ref override over ordinal pairing", () => {
    const jr = createJudgmentRecorder();
    jr.append(approved("L1", "first.tool", "rcpt_1"));
    const second = jr.append(approved("L1", "second.tool", "rcpt_2"));
    const cr = createClaimRecorder();
    // A single claim that explicitly binds to the SECOND turn, not the ordinal-0 turn.
    cr.record({ loop_id: "L1", system: "second", turn_ref: second.turn_ref });

    const input = assembleWitnessInput({
      objective: "o",
      claims: cr.claimsForLoop("L1"),
      turns: jr.judgmentLedgerForLoop("L1")
    });
    const claimed = input.steps.find((s) => s.claim?.system === "second");
    expect(claimed!.event!.call.toolName).toBe("second.tool");
    // the unmatched first turn still appears as an observed step
    expect(input.steps.some((s) => s.claim === null && s.event!.call.toolName === "first.tool")).toBe(true);
  });

  it("never falls back from an unresolved explicit turn_ref to an unrelated ordinal turn", () => {
    const jr = createJudgmentRecorder();
    jr.append(approved("L1", "unrelated.tool", "rcpt_1")); // exists at ordinal 0
    const cr = createClaimRecorder();
    // The claim explicitly references a turn that is NOT in the ledger. It must NOT be paired with
    // the ordinal-0 unrelated turn — it must stay unmatched (event: null), exposing the mismatch.
    cr.record({ loop_id: "L1", system: "gmail", action: "send", turn_ref: "turn:does-not-exist" });

    const input = assembleWitnessInput({
      objective: "o",
      claims: cr.claimsForLoop("L1"),
      turns: jr.judgmentLedgerForLoop("L1")
    });
    const claimed = input.steps.find((s) => s.claim?.system === "gmail");
    expect(claimed!.event).toBeNull();
    // the unrelated turn still appears as its own observed (claim: null) step
    expect(input.steps.some((s) => s.claim === null && s.event!.call.toolName === "unrelated.tool")).toBe(true);
  });

  it("passes through continuation state and proof refs", () => {
    const input = assembleWitnessInput({
      objective: "o",
      claims: [],
      turns: [],
      settled: ["x"],
      next_actions: ["y"],
      proof_refs: { doc: "url" }
    });
    expect(input.settled).toEqual(["x"]);
    expect(input.next_actions).toEqual(["y"]);
    expect(input.proof_refs).toEqual({ doc: "url" });
  });
});
