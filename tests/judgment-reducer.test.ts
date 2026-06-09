import { describe, expect, it } from "vitest";

import { createJudgmentRecorder, reduceJudgmentLedger, type JudgmentTurn } from "../src/index.js";

/**
 * Build a realistic ledger: approved bind (+runtime) -> refused scope -> corrected approved bind
 * (+runtime) -> escalated bind. Deltas are attached to the two approved turns.
 */
function buildLedger() {
  const rec = createJudgmentRecorder();
  const scope_ref = "scope_v1:final";

  const t0 = rec.append({
    loop_id: "L",
    scope_ref,
    prior_receipt_id: null,
    proposed: { action_class: "write", tool_name: "write_file", target_descriptor: "sha256:a" },
    verdict: { kind: "APPROVED", source: "bind", receipt_id: "r1" }
  });
  rec.attachRuntimeReport("L", t0.turn_ref, { returned: true, result_hash: "sha256:res0" });
  rec.attachDelta("L", t0.turn_ref, { settled: ["wrote cart.ts"], changed: ["/checkout/cart.ts"] });

  rec.append({
    loop_id: "L",
    scope_ref,
    prior_receipt_id: "r1",
    proposed: { action_class: "write", tool_name: "write_file", target_descriptor: "sha256:bad" },
    verdict: { kind: "REFUSED", source: "scope_gate", scope_event_hash: "sha256:evt1", reason_code: "forbidden_targets" }
  });

  const t2 = rec.append({
    loop_id: "L",
    scope_ref,
    prior_receipt_id: "r1",
    proposed: { action_class: "run_tests", tool_name: "run_tests", target_descriptor: null },
    verdict: { kind: "APPROVED", source: "bind", receipt_id: "r2" }
  });
  rec.attachRuntimeReport("L", t2.turn_ref, { returned: false, error_hash: "sha256:err2" });
  rec.attachDelta("L", t2.turn_ref, { next_actions: ["land the fix"], open_questions: ["rounding?"] });

  rec.append({
    loop_id: "L",
    scope_ref,
    prior_receipt_id: "r2",
    proposed: { action_class: "write", tool_name: "write_file", target_descriptor: "sha256:c" },
    verdict: { kind: "ESCALATED", source: "bind", receipt_id: "r3" }
  });

  return rec.judgmentLedgerForLoop("L");
}

describe("Capsule Gate 2 — Judgment Ledger Reducer", () => {
  it("emits final_turn_ref, counts, and accumulates receipt + scope-event + runtime refs", () => {
    const turns = buildLedger();
    const reduced = reduceJudgmentLedger({ loop_id: "L", scope_ref: "scope_v1:final", turns, mode: "verified_context" });

    expect(reduced.final_turn_ref).toBe(turns[turns.length - 1]!.turn_ref);
    expect(reduced.turn_count).toBe(4);
    expect(reduced.verdict_counts).toEqual({ APPROVED: 2, ESCALATED: 1, REFUSED: 1 });
    expect(reduced.source_counts).toEqual({ bind: 3, scope_gate: 1, loop_bound: 0 });
    expect(reduced.receipt_refs).toEqual(["r1", "r2", "r3"]);
    expect(reduced.scope_event_refs).toEqual(["sha256:evt1"]);
    expect(reduced.runtime_result_hashes).toEqual(["sha256:res0"]);
    expect(reduced.runtime_error_hashes).toEqual(["sha256:err2"]);
  });

  it("identifies refused / corrected steps structurally", () => {
    const turns = buildLedger();
    const reduced = reduceJudgmentLedger({ loop_id: "L", scope_ref: "scope_v1:final", turns, mode: "verified_context" });
    // The refused scope step (index 1) is corrected (a later APPROVED bind exists).
    const refusal = reduced.refused_steps.find((s) => s.source === "scope_gate")!;
    expect(refusal).toMatchObject({ turn_index: 1, kind: "REFUSED", scope_event_hash: "sha256:evt1", corrected: true });
    // The escalated final step (index 3) is NOT corrected (no later approval).
    const escalation = reduced.refused_steps.find((s) => s.kind === "ESCALATED")!;
    expect(escalation).toMatchObject({ turn_index: 3, corrected: false });
  });

  it("applies declared deltas in Verified Context Mode", () => {
    const turns = buildLedger();
    const reduced = reduceJudgmentLedger({ loop_id: "L", scope_ref: "scope_v1:final", turns, mode: "verified_context" });
    expect(reduced.settled).toEqual(["wrote cart.ts"]);
    expect(reduced.changed).toEqual(["/checkout/cart.ts"]);
    expect(reduced.next_actions).toEqual(["land the fix"]);
    expect(reduced.open_questions).toEqual(["rounding?"]);
  });

  it("strips plaintext deltas in Proof Mode (content-blind)", () => {
    const turns = buildLedger();
    const reduced = reduceJudgmentLedger({ loop_id: "L", scope_ref: "scope_v1:final", turns, mode: "proof" });
    expect(reduced.settled).toBeUndefined();
    expect(reduced.open_questions).toBeUndefined();
    expect(reduced.next_actions).toBeUndefined();
    expect(reduced.changed).toBeUndefined();
    // Structural refs survive.
    expect(reduced.receipt_refs).toEqual(["r1", "r2", "r3"]);
    expect(reduced.runtime_result_hashes).toEqual(["sha256:res0"]);
    expect(JSON.stringify(reduced)).not.toContain("wrote cart.ts");
    expect(JSON.stringify(reduced)).not.toContain("/checkout/cart.ts");
  });

  it("fails closed on a broken prior-turn chain", () => {
    const turns = buildLedger();
    turns[2] = { ...turns[2]!, prior_turn_ref: "turn_v1:bogus" } as JudgmentTurn;
    expect(() => reduceJudgmentLedger({ loop_id: "L", scope_ref: "scope_v1:final", turns, mode: "proof" })).toThrow(/broken prior_turn_ref/);
  });

  it("fails closed on non-contiguous turn indexes", () => {
    const turns = buildLedger();
    turns[1] = { ...turns[1]!, turn_index: 9 } as JudgmentTurn;
    expect(() => reduceJudgmentLedger({ loop_id: "L", scope_ref: "scope_v1:final", turns, mode: "proof" })).toThrow(/non-contiguous/);
  });

  it("fails closed on a missing proof anchor (a bind turn with no receipt_id)", () => {
    const rec = createJudgmentRecorder();
    // Force a bind turn with no receipt_id by appending then stripping it (re-derive turn_ref so the
    // chain stays valid and only the anchor is missing).
    const t = rec.append({
      loop_id: "L",
      scope_ref: "scope_v1:final",
      prior_receipt_id: null,
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind" } // no receipt_id
    });
    const turns = [t];
    expect(() => reduceJudgmentLedger({ loop_id: "L", scope_ref: "scope_v1:final", turns, mode: "proof" })).toThrow(/no receipt_id anchor/);
  });

  it("fails closed on a missing proof anchor (a scope_gate turn with no scope_event_hash)", () => {
    const rec = createJudgmentRecorder();
    const t = rec.append({
      loop_id: "L",
      scope_ref: "scope_v1:final",
      prior_receipt_id: null,
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "REFUSED", source: "scope_gate" } // no scope_event_hash
    });
    expect(() => reduceJudgmentLedger({ loop_id: "L", scope_ref: "scope_v1:final", turns: [t], mode: "proof" })).toThrow(/no scope_event_hash anchor/);
  });

  it("accumulates distinct scope_refs across amendments", () => {
    const rec = createJudgmentRecorder();
    rec.append({
      loop_id: "L",
      scope_ref: "scope_v1:a",
      prior_receipt_id: null,
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r1" }
    });
    rec.append({
      loop_id: "L",
      scope_ref: "scope_v1:b",
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r2" }
    });
    const reduced = reduceJudgmentLedger({ loop_id: "L", scope_ref: "scope_v1:b", turns: rec.judgmentLedgerForLoop("L"), mode: "proof" });
    expect(reduced.scope_refs.sort()).toEqual(["scope_v1:a", "scope_v1:b"]);
  });
});
