import { describe, expect, it } from "vitest";

import {
  buildContinuationCapsule,
  createJudgmentRecorder,
  projectContinuationProofMode,
  reduceJudgmentLedger,
  sealScopeCapsule,
  type ReducedJudgmentState,
  type ScopeCapsule
} from "../src/index.js";

function sealedScope(privacy_mode: "proof" | "verified_context") {
  const capsule: ScopeCapsule = {
    structural: {
      capsule_type: "scope_capsule",
      capsule_version: "scope-capsule/v1",
      loop_id: "L",
      goal_hash: "a".repeat(64),
      privacy_mode,
      allowed_action_classes: ["write", "run_tests"]
    },
    sidecar: { goal_summary: "fix checkout bug" }
  };
  return sealScopeCapsule({ capsule });
}

function reducedFor(mode: "proof" | "verified_context"): ReducedJudgmentState {
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
  rec.attachDelta("L", t2.turn_ref, { next_actions: ["land the fix"], open_questions: ["rounding?"] });
  return reduceJudgmentLedger({ loop_id: "L", scope_ref, turns: rec.judgmentLedgerForLoop("L"), mode });
}

describe("Capsule Gate 2 — Continuation Capsule consumes the reducer", () => {
  it("a Verified Context continuation includes reduced settled/open/next/changed + final_turn_ref + judgment", () => {
    const reduced = reducedFor("verified_context");
    const cap = buildContinuationCapsule({
      scope_history: [sealedScope("verified_context")],
      scope_events: [],
      loop: { loop_id: "L", goal_hash: "a".repeat(64), sealed: true, action_count: 2 },
      mode: "verified_context",
      reduced
    });
    expect(cap.final_turn_ref).toBe(reduced.final_turn_ref);
    expect(cap.settled).toEqual(["wrote cart.ts"]);
    expect(cap.changed).toEqual(["/checkout/cart.ts"]);
    expect(cap.next_actions).toEqual(["land the fix"]);
    expect(cap.open_questions).toEqual(["rounding?"]);
    // Summarizes (does not replace) the ledger: structural counts + refs present.
    expect(cap.judgment).toBeDefined();
    expect(cap.judgment!.verdict_counts).toEqual({ APPROVED: 2, ESCALATED: 0, REFUSED: 1 });
    expect(cap.judgment!.receipt_refs).toEqual(["r1", "r2"]);
    expect(cap.judgment!.scope_event_refs).toEqual(["sha256:evt1"]);
    expect(cap.continuation_prompt).toMatch(/verified judgment ledger/);
  });

  it("a Proof Mode continuation carries the structural judgment summary but NO plaintext deltas", () => {
    const reduced = reducedFor("proof");
    const vc = buildContinuationCapsule({
      scope_history: [sealedScope("proof")],
      scope_events: [],
      loop: { loop_id: "L", goal_hash: "a".repeat(64), sealed: true, action_count: 2 },
      mode: "proof",
      reduced
    });
    // In Proof Mode the build itself carries no sidecar; project to be doubly sure.
    const proof = projectContinuationProofMode(vc);
    expect(proof.settled).toBeUndefined();
    expect(proof.open_questions).toBeUndefined();
    expect(proof.next_actions).toBeUndefined();
    expect(proof.changed).toBeUndefined();
    expect(proof.continuation_prompt).toBeUndefined();
    // Structural judgment summary survives, content-blind.
    expect(proof.final_turn_ref).toBe(reduced.final_turn_ref);
    expect(proof.judgment).toBeDefined();
    expect(proof.judgment!.receipt_refs).toEqual(["r1", "r2"]);
    expect(proof.judgment!.refused_steps[0]).toMatchObject({ kind: "REFUSED", source: "scope_gate", reason_code: "forbidden_targets" });
    expect(JSON.stringify(proof)).not.toContain("wrote cart.ts");
    expect(JSON.stringify(proof)).not.toContain("/checkout/cart.ts");
    expect(JSON.stringify(proof)).not.toContain("land the fix");
  });

  it("projecting a Verified Context continuation to Proof Mode strips its plaintext sidecar", () => {
    const reduced = reducedFor("verified_context");
    const vc = buildContinuationCapsule({
      scope_history: [sealedScope("verified_context")],
      scope_events: [],
      loop: { loop_id: "L", goal_hash: "a".repeat(64), sealed: true, action_count: 2 },
      mode: "verified_context",
      reduced
    });
    const proof = projectContinuationProofMode(vc);
    expect(proof.settled).toBeUndefined();
    expect(proof.continuation_prompt).toBeUndefined();
    expect(proof.judgment).toBeDefined();
    expect(JSON.stringify(proof)).not.toContain("wrote cart.ts");
  });

  it("without a reduced ledger, the continuation is unchanged (backward compatible)", () => {
    const cap = buildContinuationCapsule({
      scope_history: [sealedScope("verified_context")],
      scope_events: [],
      loop: { loop_id: "L", goal_hash: "a".repeat(64), sealed: true, action_count: 1 },
      mode: "verified_context",
      settled: ["explicit"]
    });
    expect(cap.judgment).toBeUndefined();
    expect(cap.final_turn_ref).toBeUndefined();
    expect(cap.settled).toEqual(["explicit"]);
  });
});
