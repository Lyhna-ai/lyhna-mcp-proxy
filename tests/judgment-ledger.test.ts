import { describe, expect, it } from "vitest";

import {
  deriveTurnRef,
  normalizeDelta,
  projectTurnProofMode,
  projectTurnVerifiedContext,
  validateJudgmentChain,
  type JudgmentTurn,
  type JudgmentTurnInput
} from "../src/judgment-ledger.js";
import { createJudgmentRecorder } from "../src/judgment-recorder.js";

function approvedBind(loop_id: string, prior_receipt_id: string | null, receipt_id: string, tool = "write_file"): JudgmentTurnInput {
  return {
    loop_id,
    scope_ref: "scope_v1:abc",
    prior_receipt_id,
    proposed: { action_class: "write", tool_name: tool, target_descriptor: "sha256:tgt" },
    verdict: { kind: "APPROVED", source: "bind", receipt_id }
  };
}

function refusedScope(loop_id: string, prior_receipt_id: string | null, event_hash: string): JudgmentTurnInput {
  return {
    loop_id,
    scope_ref: "scope_v1:abc",
    prior_receipt_id,
    proposed: { action_class: "write", tool_name: "write_file", target_descriptor: "sha256:bad" },
    verdict: { kind: "REFUSED", source: "scope_gate", scope_event_hash: event_hash, reason_code: "forbidden_targets" }
  };
}

describe("JudgmentLedger recorder — append ordering", () => {
  it("appends turns in order with contiguous turn_index", () => {
    const rec = createJudgmentRecorder();
    const t0 = rec.append(approvedBind("L", null, "r1"));
    const t1 = rec.append(refusedScope("L", "r1", "sha256:evt"));
    const t2 = rec.append(approvedBind("L", "r1", "r2", "run_tests"));
    expect([t0.turn_index, t1.turn_index, t2.turn_index]).toEqual([0, 1, 2]);
    expect(rec.judgmentLedgerForLoop("L").map((t) => t.turn_index)).toEqual([0, 1, 2]);
  });

  it("first turn has prior_turn_ref null; later turns point to the previous turn", () => {
    const rec = createJudgmentRecorder();
    const t0 = rec.append(approvedBind("L", null, "r1"));
    const t1 = rec.append(approvedBind("L", "r1", "r2"));
    expect(t0.prior_turn_ref).toBeNull();
    expect(t1.prior_turn_ref).toBe(t0.turn_ref);
  });

  it("keeps separate ledgers per loop_id", () => {
    const rec = createJudgmentRecorder();
    rec.append(approvedBind("A", null, "r1"));
    rec.append(approvedBind("B", null, "r1"));
    expect(rec.knownLoopIds().sort()).toEqual(["A", "B"]);
    expect(rec.judgmentLedgerForLoop("A")).toHaveLength(1);
    expect(rec.judgmentLedgerForLoop("B")).toHaveLength(1);
  });
});

describe("turn_ref derivation", () => {
  it("changes when judgment-core content changes", () => {
    const base = {
      loop_id: "L",
      turn_index: 0,
      prior_turn_ref: null,
      prior_receipt_id: null,
      scope_ref: "scope_v1:abc",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: "sha256:a" },
      verdict: { kind: "APPROVED" as const, source: "bind" as const, receipt_id: "r1" }
    };
    const ref0 = deriveTurnRef(base);
    const refDifferentTool = deriveTurnRef({ ...base, proposed: { ...base.proposed, tool_name: "read_file" } });
    const refDifferentVerdict = deriveTurnRef({ ...base, verdict: { kind: "REFUSED", source: "bind", receipt_id: "r1" } });
    expect(refDifferentTool).not.toBe(ref0);
    expect(refDifferentVerdict).not.toBe(ref0);
  });

  it("is stable for identical core (deterministic)", () => {
    const base = approvedBind("L", null, "r1");
    const rec1 = createJudgmentRecorder();
    const rec2 = createJudgmentRecorder();
    expect(rec1.append(base).turn_ref).toBe(rec2.append({ ...base }).turn_ref);
  });

  it("is unaffected by runtime_report / declared_delta attachment", () => {
    const rec = createJudgmentRecorder();
    const t = rec.append(approvedBind("L", null, "r1"));
    const before = t.turn_ref;
    rec.attachRuntimeReport("L", t.turn_ref, { returned: true, result_hash: "sha256:res" });
    rec.attachDelta("L", t.turn_ref, { settled: ["did x"] });
    expect(rec.judgmentLedgerForLoop("L")[0]!.turn_ref).toBe(before);
  });
});

describe("chain validation", () => {
  function build(): JudgmentTurn[] {
    const rec = createJudgmentRecorder();
    rec.append(approvedBind("L", null, "r1"));
    rec.append(refusedScope("L", "r1", "sha256:evt"));
    rec.append(approvedBind("L", "r1", "r2"));
    return rec.judgmentLedgerForLoop("L");
  }

  it("accepts a contiguous, hash-linked chain", () => {
    const v = validateJudgmentChain(build());
    expect(v.valid).toBe(true);
    if (v.valid) {
      expect(v.turn_count).toBe(3);
      expect(v.final_turn_ref).toBe(build()[2]!.turn_ref);
    }
  });

  it("accepts an empty ledger", () => {
    expect(validateJudgmentChain([]).valid).toBe(true);
  });

  it("rejects a non-contiguous turn_index gap", () => {
    const turns = build();
    turns[1] = { ...turns[1]!, turn_index: 5 };
    const v = validateJudgmentChain(turns);
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reason).toMatch(/non-contiguous/);
  });

  it("rejects a broken prior_turn_ref", () => {
    const turns = build();
    turns[2] = { ...turns[2]!, prior_turn_ref: "turn_v1:bogus", turn_ref: turns[2]!.turn_ref };
    const v = validateJudgmentChain(turns);
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reason).toMatch(/prior_turn_ref/);
  });

  it("rejects a tampered turn whose turn_ref no longer matches its core", () => {
    const turns = build();
    // Mutate a core field but keep the old turn_ref -> recompute mismatch.
    turns[0] = { ...turns[0]!, proposed: { ...turns[0]!.proposed, tool_name: "deleted_everything" } };
    const v = validateJudgmentChain(turns);
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reason).toMatch(/does not match its judgment core/);
  });

  it("rejects a duplicate turn_ref", () => {
    const turns = build();
    // Force a duplicate: copy turn 0 into position 1 but keep contiguous index + prior chain.
    const dupRef = turns[0]!.turn_ref;
    turns[1] = { ...turns[1]!, turn_ref: dupRef };
    const v = validateJudgmentChain(turns);
    expect(v.valid).toBe(false);
  });
});

describe("recorder fail-closed attachment", () => {
  it("rejects attaching a runtime report to an unknown turn_ref", () => {
    const rec = createJudgmentRecorder();
    rec.append(approvedBind("L", null, "r1"));
    expect(() => rec.attachRuntimeReport("L", "turn_v1:nope", { returned: true })).toThrow(/No judgment turn/);
  });

  it("rejects attaching a delta to an unknown turn_ref", () => {
    const rec = createJudgmentRecorder();
    const t = rec.append(approvedBind("L", null, "r1"));
    expect(() => rec.attachDelta("L", "turn_v1:nope", { settled: ["x"] })).toThrow(/No judgment turn/);
    expect(() => rec.attachDelta("L", t.turn_ref, { bogus: ["x"] } as never)).toThrow(/unknown field/);
  });

  it("refuses to overwrite an existing runtime report", () => {
    const rec = createJudgmentRecorder();
    const t = rec.append(approvedBind("L", null, "r1"));
    rec.attachRuntimeReport("L", t.turn_ref, { returned: true, result_hash: "sha256:a" });
    expect(() => rec.attachRuntimeReport("L", t.turn_ref, { returned: true, result_hash: "sha256:b" })).toThrow(/already carries/);
  });

  it("merges deltas additively", () => {
    const rec = createJudgmentRecorder();
    const t = rec.append(approvedBind("L", null, "r1"));
    rec.attachDelta("L", t.turn_ref, { settled: ["a"] });
    rec.attachDelta("L", t.turn_ref, { settled: ["b"], next_actions: ["c"] });
    const got = rec.judgmentLedgerForLoop("L")[0]!.declared_delta;
    expect(got).toEqual({ settled: ["a", "b"], next_actions: ["c"] });
  });
});

describe("projections", () => {
  it("Proof Mode strips declared_delta; Verified Context retains it", () => {
    const rec = createJudgmentRecorder();
    const t = rec.append(approvedBind("L", null, "r1"));
    rec.attachRuntimeReport("L", t.turn_ref, { returned: true, result_hash: "sha256:res" });
    rec.attachDelta("L", t.turn_ref, { settled: ["did x"] });
    const full = rec.judgmentLedgerForLoop("L")[0]!;

    const proof = projectTurnProofMode(full);
    expect(proof.declared_delta).toBeUndefined();
    // runtime_report is structural (hashes) and is retained in Proof Mode.
    expect(proof.runtime_report).toEqual({ returned: true, result_hash: "sha256:res" });

    const vc = projectTurnVerifiedContext(full);
    expect(vc.declared_delta).toEqual({ settled: ["did x"] });
  });

  it("normalizeDelta drops empty arrays", () => {
    expect(normalizeDelta({ settled: [], next_actions: ["a"] })).toEqual({ next_actions: ["a"] });
  });
});
