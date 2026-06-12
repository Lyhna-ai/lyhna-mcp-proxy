import { describe, expect, it } from "vitest";

import {
  buildContinuationCapsule,
  buildLoopProofBundle,
  createJudgmentRecorder,
  deriveContinuationRef,
  createScopeEventRecorder,
  deriveGoalHash,
  reduceJudgmentLedger,
  sealScopeCapsule,
  type ContinuationCapsule,
  type JudgmentTurn,
  type ProofReceipt,
  type ScopeEvent,
  type ScopeInheritsLoop,
  type ScopePrivacyMode,
  type SealedScope
} from "../src/index.js";

const PUBKEY = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
const LOOP_ID = "loop-cg2-fixture";
const GOAL = "fix checkout bug";
const GOAL_HASH = deriveGoalHash(GOAL);

function sealedScope(privacy_mode: ScopePrivacyMode, inherits_loop?: ScopeInheritsLoop): SealedScope {
  return sealScopeCapsule({
    capsule: {
      structural: {
        capsule_type: "scope_capsule",
        capsule_version: "scope-capsule/v1",
        loop_id: LOOP_ID,
        goal_hash: GOAL_HASH,
        privacy_mode,
        allowed_action_classes: ["write", "run_tests"],
        class_map: { write_file: "write", run_tests: "run_tests" },
        ...(inherits_loop ? { inherits_loop } : {})
      },
      sidecar: { goal_summary: "fix checkout bug" }
    }
  });
}

function inLoopReceipt(receipt_id: string, prior: string | null, scope_ref: string): ProofReceipt {
  return {
    version: "LYHNA_RECEIPT_V2",
    receipt_id,
    public_key: PUBKEY,
    tenant_hash: "55b966349a28aaaa",
    action_type: "tool_call",
    outcome: "APPROVED",
    signature: "c3R1Yg==",
    constraints: {
      loop: { loop_id: LOOP_ID, prior_receipt_id: prior, goal_hash: GOAL_HASH },
      scope: { scope_ref, prior_receipt_id: prior, action_class: "write", tool_name: "write_file", target_descriptor: null }
    }
  };
}

function terminalReceipt(receipt_id: string, prior: string, action_count: number): ProofReceipt {
  return {
    version: "LYHNA_RECEIPT_V2",
    receipt_id,
    public_key: PUBKEY,
    tenant_hash: "55b966349a28aaaa",
    action_type: "loop_close",
    outcome: "APPROVED",
    signature: "c3R1Yg==",
    constraints: {
      loop: { loop_id: LOOP_ID, prior_receipt_id: prior, goal_hash: GOAL_HASH },
      loop_close: {
        loop_id: LOOP_ID,
        goal_hash: GOAL_HASH,
        action_count,
        outcome: "COMPLETED",
        prior_receipt_id: prior,
        termination_reason: "done"
      }
    }
  };
}

/**
 * A consistent scoped fixture: two in-lane approved binds (r1, r2) + one attested scope refusal,
 * a sealed scope, the matching judgment ledger, a scope event, and a continuation folded from the
 * reduced ledger. Everything cross-references so buildLoopProofBundle validates green.
 */
function fixture(
  mode: ScopePrivacyMode,
  inherits_loop?: ScopeInheritsLoop,
  seed?: { settled?: string[]; open_questions?: string[]; next_actions?: string[]; changed?: string[] }
) {
  const sealed = sealedScope(mode, inherits_loop);
  const scope_ref = sealed.scope_ref;

  const receipts: ProofReceipt[] = [
    inLoopReceipt("r1", null, scope_ref),
    inLoopReceipt("r2", "r1", scope_ref),
    terminalReceipt("close", "r2", 2)
  ];

  const scopeRec = createScopeEventRecorder();
  const event: ScopeEvent = scopeRec.record({
    event_type: "scope_refusal",
    loop_id: LOOP_ID,
    scope_ref,
    attempted: { action_class: "write", tool_name: "write_file", target_descriptor: null },
    matched_rule: "forbidden_targets",
    decision: "REFUSED",
    prior_receipt_id: "r1"
  });

  const rec = createJudgmentRecorder();
  const t0 = rec.append({
    loop_id: LOOP_ID,
    scope_ref,
    prior_receipt_id: null,
    proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
    verdict: { kind: "APPROVED", source: "bind", receipt_id: "r1" }
  });
  rec.attachRuntimeReport(LOOP_ID, t0.turn_ref, { returned: true, result_hash: `sha256:${"a".repeat(64)}` });
  rec.attachDelta(LOOP_ID, t0.turn_ref, { settled: ["wrote cart.ts"], changed: ["/checkout/cart.ts"] });
  rec.append({
    loop_id: LOOP_ID,
    scope_ref,
    prior_receipt_id: "r1",
    proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
    verdict: { kind: "REFUSED", source: "scope_gate", scope_event_hash: event.event_hash, reason_code: "forbidden_targets" }
  });
  const t2 = rec.append({
    loop_id: LOOP_ID,
    scope_ref,
    prior_receipt_id: "r1",
    proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
    verdict: { kind: "APPROVED", source: "bind", receipt_id: "r2" }
  });
  // Every APPROVED (forwarded) bind turn carries a runtime report (required at export).
  rec.attachRuntimeReport(LOOP_ID, t2.turn_ref, { returned: true, result_hash: `sha256:${"d".repeat(64)}` });
  const turns = rec.judgmentLedgerForLoop(LOOP_ID);

  // The continuation is folded over the SAME seed the export will re-fold with, so the export's
  // continuation<->reduced binding holds.
  const reduced = reduceJudgmentLedger({ loop_id: LOOP_ID, scope_ref, turns, mode, seed });
  const continuation = buildContinuationCapsule({
    scope_history: [sealed],
    scope_events: [event],
    loop: { loop_id: LOOP_ID, goal_hash: GOAL_HASH, sealed: true, action_count: 2 },
    mode,
    reduced
  });

  return { sealed, scope_ref, receipts, event, turns, continuation };
}

function build(mode: ScopePrivacyMode, overrides: { turns?: JudgmentTurn[]; receipts?: ProofReceipt[]; scope_events?: ScopeEvent[] } = {}) {
  const f = fixture(mode);
  return buildLoopProofBundle({
    receipts: overrides.receipts ?? f.receipts,
    source_env: "test",
    capsule: {
      mode,
      sealed_scope: f.sealed,
      scope_history: [f.sealed],
      continuation: f.continuation,
      scope_events: overrides.scope_events ?? [f.event],
      judgment_turns: overrides.turns ?? f.turns
    }
  });
}

describe("Capsule Gate 2 — LoopProofBundle judgment artifacts", () => {
  it("emits judgment-ledger.json, judgment-ledger.md, and memory-injection.json", () => {
    const built = build("verified_context");
    expect(built.judgment_ledger).toBeDefined();
    expect(built.judgment_ledger!.turn_count).toBe(3);
    expect(built.judgment_ledger!.turns).toHaveLength(3);
    expect(built.judgment_ledger_markdown).toContain("# Judgment Ledger");
    expect(built.memory_injection).toBeDefined();
    expect(built.memory_injection!.type).toBe("lyhna_verified_memory_capsule");
    expect(built.memory_injection!.judgment_ledger_file).toBe("judgment-ledger.json");
  });

  it("bundle.json references the judgment artifacts by file + final_turn_ref + count", () => {
    const built = build("verified_context");
    const j = built.bundle.capsule!.judgment!;
    expect(j.judgment_ledger_file).toBe("judgment-ledger.json");
    expect(j.judgment_ledger_markdown_file).toBe("judgment-ledger.md");
    expect(j.memory_injection_file).toBe("memory-injection.json");
    expect(j.turn_count).toBe(3);
    expect(j.final_turn_ref).toBe(built.judgment_ledger!.final_turn_ref);
  });

  it("Verified Context memory-injection carries the folded settled/changed", () => {
    const built = build("verified_context");
    expect(built.memory_injection!.settled).toEqual(["wrote cart.ts"]);
    expect(built.memory_injection!.changed).toEqual(["/checkout/cart.ts"]);
  });

  it("Proof Mode export is content-blind: no plaintext deltas in any judgment artifact", () => {
    const built = build("proof");
    const blob = JSON.stringify(built.judgment_ledger) + (built.judgment_ledger_markdown ?? "") + JSON.stringify(built.memory_injection);
    expect(blob).not.toContain("wrote cart.ts");
    expect(blob).not.toContain("/checkout/cart.ts");
    for (const t of built.judgment_ledger!.turns) {
      expect(t.declared_delta).toBeUndefined();
    }
    expect(built.memory_injection!.settled).toEqual([]);
    expect(built.memory_injection!.changed).toEqual([]);
  });

  it("cold validation fails when an in-loop receipt has no matching judgment turn", () => {
    // Drop the last bind turn (for r2); the chain stays valid (2 contiguous turns) but a receipt is unmapped.
    const f = fixture("verified_context");
    const turns = f.turns.slice(0, 2);
    expect(() => build("verified_context", { turns })).toThrow(/does not match in-loop receipt count/);
  });

  it("cold validation fails when a scope event has no matching judgment turn", () => {
    const f = fixture("verified_context");
    // A SECOND attested scope event the judgment ledger never anchored. The continuation is rebuilt
    // to list BOTH events (so the Capsule Gate 1 continuation<->events check passes), isolating the
    // Capsule Gate 2 judgment cross-check as the failing one.
    const extra = createScopeEventRecorder().record({
      event_type: "scope_refusal",
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      attempted: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      matched_rule: "allowed_action_classes",
      decision: "REFUSED",
      prior_receipt_id: "r2"
    });
    const reduced = reduceJudgmentLedger({ loop_id: LOOP_ID, scope_ref: f.scope_ref, turns: f.turns, mode: "verified_context" });
    const continuation = buildContinuationCapsule({
      scope_history: [f.sealed],
      scope_events: [f.event, extra],
      loop: { loop_id: LOOP_ID, goal_hash: GOAL_HASH, sealed: true, action_count: 2 },
      mode: "verified_context",
      reduced
    });
    expect(() =>
      buildLoopProofBundle({
        receipts: f.receipts,
        source_env: "test",
        capsule: { mode: "verified_context", sealed_scope: f.sealed, scope_history: [f.sealed], continuation, scope_events: [f.event, extra], judgment_turns: f.turns }
      })
    ).toThrow(/has no matching judgment turn/);
  });

  it("cold validation fails on a broken turn chain", () => {
    const f = fixture("verified_context");
    const turns = f.turns.map((t, i) => (i === 2 ? ({ ...t, prior_turn_ref: "turn_v1:bogus" } as JudgmentTurn) : t));
    expect(() => build("verified_context", { turns })).toThrow(/not a valid chain/);
  });

  it("cold validation fails when a bind turn anchors a receipt that is not in the chain", () => {
    const f = fixture("verified_context");
    // Re-build the ledger so the second bind turn anchors a non-existent receipt id.
    const rec = createJudgmentRecorder();
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: null,
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r1" }
    });
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "REFUSED", source: "scope_gate", scope_event_hash: f.event.event_hash, reason_code: "forbidden_targets" }
    });
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r_GHOST" }
    });
    expect(() => build("verified_context", { turns: rec.judgmentLedgerForLoop(LOOP_ID) })).toThrow(/chain position/);
  });

  // Helper: build a 3-turn ledger (bind, scope-refusal, bind) with caller-chosen verdicts, so each
  // tamper test exercises one binding (order / outcome / scope content) against the same fixture.
  function tamperedTurns(f: ReturnType<typeof fixture>, opts: {
    bind0?: { kind?: "APPROVED" | "ESCALATED" | "REFUSED"; receipt_id?: string };
    bind2?: { kind?: "APPROVED" | "ESCALATED" | "REFUSED"; receipt_id?: string };
    scope?: { kind?: "APPROVED" | "ESCALATED" | "REFUSED"; source?: "scope_gate" | "loop_bound" };
  }): JudgmentTurn[] {
    const rec = createJudgmentRecorder();
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: null,
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: opts.bind0?.kind ?? "APPROVED", source: "bind", receipt_id: opts.bind0?.receipt_id ?? "r1" }
    });
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: {
        kind: opts.scope?.kind ?? "REFUSED",
        source: opts.scope?.source ?? "scope_gate",
        scope_event_hash: f.event.event_hash,
        reason_code: "forbidden_targets"
      }
    });
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: opts.bind2?.kind ?? "APPROVED", source: "bind", receipt_id: opts.bind2?.receipt_id ?? "r2" }
    });
    return rec.judgmentLedgerForLoop(LOOP_ID);
  }

  // Build the bundle from ONE fixture (so the tampered turns anchor the SAME scope-event hash the
  // pack carries) with caller-tampered turns.
  function buildTampered(opts: Parameters<typeof tamperedTurns>[1]) {
    const f = fixture("verified_context");
    const turns = tamperedTurns(f, opts);
    return () =>
      buildLoopProofBundle({
        receipts: f.receipts,
        source_env: "test",
        capsule: { mode: "verified_context", sealed_scope: f.sealed, scope_history: [f.sealed], continuation: f.continuation, scope_events: [f.event], judgment_turns: turns }
      });
  }

  it("cold validation fails when bind turns are swapped out of signed-receipt order", () => {
    // Anchor r2 at chain position 0 and r1 at position 2 — a contiguous, hash-valid chain whose
    // bind order diverges from the signed receipt chain.
    expect(buildTampered({ bind0: { receipt_id: "r2" }, bind2: { receipt_id: "r1" } })).toThrow(/diverges from the signed receipt order/);
  });

  it("cold validation fails when a bind turn relabels an APPROVED receipt as REFUSED", () => {
    expect(buildTampered({ bind0: { kind: "REFUSED" } })).toThrow(/does not match signed receipt r1 outcome/);
  });

  it("cold validation fails when a scope turn claims APPROVED over an attested REFUSED event", () => {
    expect(buildTampered({ scope: { kind: "APPROVED" } })).toThrow(/does not match attested scope event .* decision REFUSED/);
  });

  it("cold validation fails when a scope turn mislabels its source vs the attested event", () => {
    // The attested event's matched_rule is "forbidden_targets" -> source must be scope_gate, not loop_bound.
    expect(buildTampered({ scope: { source: "loop_bound" } })).toThrow(/source loop_bound does not match attested scope event/);
  });

  it("cold validation fails when the continuation judgment summary is tampered (hidden refused step)", () => {
    const f = fixture("verified_context");
    // The honest continuation summary lists the refused step; hide it while leaving counts/refs.
    const tampered = JSON.parse(JSON.stringify(f.continuation));
    tampered.judgment.refused_steps = [];
    expect(() =>
      buildLoopProofBundle({
        receipts: f.receipts,
        source_env: "test",
        capsule: { mode: "verified_context", sealed_scope: f.sealed, scope_history: [f.sealed], continuation: tampered, scope_events: [f.event], judgment_turns: f.turns }
      })
    ).toThrow(/judgment summary does not match/);
  });

  it("cold validation fails when the continuation judgment summary fakes a runtime hash", () => {
    const f = fixture("verified_context");
    const tampered = JSON.parse(JSON.stringify(f.continuation));
    tampered.judgment.runtime_result_hashes = [`sha256:${"f".repeat(64)}`];
    expect(() =>
      buildLoopProofBundle({
        receipts: f.receipts,
        source_env: "test",
        capsule: { mode: "verified_context", sealed_scope: f.sealed, scope_history: [f.sealed], continuation: tampered, scope_events: [f.event], judgment_turns: f.turns }
      })
    ).toThrow(/judgment summary does not match/);
  });

  // Build the bundle from one fixture with caller-supplied turns (consistent scope-event hash).
  function buildWith(f: ReturnType<typeof fixture>, turns: JudgmentTurn[]) {
    return () =>
      buildLoopProofBundle({
        receipts: f.receipts,
        source_env: "test",
        capsule: { mode: "verified_context", sealed_scope: f.sealed, scope_history: [f.sealed], continuation: f.continuation, scope_events: [f.event], judgment_turns: turns }
      });
  }

  it("cold validation fails when a bind turn's proposed descriptor diverges from the signed scope stamp", () => {
    const f = fixture("verified_context");
    const rec = createJudgmentRecorder();
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: null,
      // tool_name differs from the signed constraints.scope stamp ("write_file") on receipt r1
      proposed: { action_class: "write", tool_name: "DELETE_EVERYTHING", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r1" }
    });
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "REFUSED", source: "scope_gate", scope_event_hash: f.event.event_hash, reason_code: "forbidden_targets" }
    });
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r2" }
    });
    expect(buildWith(f, rec.judgmentLedgerForLoop(LOOP_ID))).toThrow(/does not match the signed constraints.scope stamp/);
  });

  it("cold validation fails when a scope turn's inherited prior diverges from the attested event anchor", () => {
    const f = fixture("verified_context"); // f.event is anchored to prior_receipt_id "r1"
    const rec = createJudgmentRecorder();
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: null,
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r1" }
    });
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: "r2", // tampered: the attested event is anchored to "r1"
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "REFUSED", source: "scope_gate", scope_event_hash: f.event.event_hash, reason_code: "forbidden_targets" }
    });
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r2" }
    });
    expect(buildWith(f, rec.judgmentLedgerForLoop(LOOP_ID))).toThrow(/is anchored to "r1" \(fail closed\)/);
  });

  // A 3-turn ledger (bind r1, scope refusal, bind r2) with valid turn_refs, returned for tampering.
  // APPROVED bind turns carry valid runtime reports by default (required at export); pass
  // `skipT0Report` so a test can attach its own (e.g. contradictory) report to t0.
  function threeTurns(f: ReturnType<typeof fixture>, opts: { skipT0Report?: boolean } = {}) {
    const rec = createJudgmentRecorder();
    const t0 = rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: null,
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r1" }
    });
    if (!opts.skipT0Report) {
      rec.attachRuntimeReport(LOOP_ID, t0.turn_ref, { returned: true, result_hash: `sha256:${"a".repeat(64)}` });
    }
    const scopeTurn = rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "REFUSED", source: "scope_gate", scope_event_hash: f.event.event_hash, reason_code: "forbidden_targets" }
    });
    const t2 = rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r2" }
    });
    rec.attachRuntimeReport(LOOP_ID, t2.turn_ref, { returned: true, result_hash: `sha256:${"d".repeat(64)}` });
    return { rec, t0, scopeTurn };
  }

  it("cold validation rejects a runtime_report bolted onto a non-forwarded (scope_gate) turn", () => {
    const f = fixture("verified_context");
    const { rec, scopeTurn } = threeTurns(f);
    rec.attachRuntimeReport(LOOP_ID, scopeTurn.turn_ref, { returned: true, result_hash: `sha256:${"a".repeat(64)}` });
    expect(buildWith(f, rec.judgmentLedgerForLoop(LOOP_ID))).toThrow(/is not an APPROVED bind turn/);
  });

  it("cold validation rejects a runtime_report whose hashes contradict `returned`", () => {
    const f = fixture("verified_context");
    const { rec, t0 } = threeTurns(f, { skipT0Report: true });
    // returned=true but also carries an error_hash (recorder permits it; the export must not).
    rec.attachRuntimeReport(LOOP_ID, t0.turn_ref, { returned: true, result_hash: `sha256:${"a".repeat(64)}`, error_hash: `sha256:${"b".repeat(64)}` });
    expect(buildWith(f, rec.judgmentLedgerForLoop(LOOP_ID))).toThrow(/must not carry an error_hash/);
  });

  it("cold validation fails when an APPROVED (forwarded) bind turn lacks a runtime_report", () => {
    const f = fixture("verified_context");
    // Valid through steps 1–3, but t0 (an APPROVED bind turn) carries no runtime report.
    const { rec } = threeTurns(f, { skipT0Report: true });
    expect(buildWith(f, rec.judgmentLedgerForLoop(LOOP_ID))).toThrow(/carries no runtime_report/);
  });

  it("cold validation fails when a bind turn cites a scope_ref different from the signed stamp", () => {
    const f = fixture("verified_context");
    const rec = createJudgmentRecorder();
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: "scope_v1:FORGED", // != the signed constraints.scope.scope_ref on receipt r1
      prior_receipt_id: null,
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r1" }
    });
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "REFUSED", source: "scope_gate", scope_event_hash: f.event.event_hash, reason_code: "forbidden_targets" }
    });
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r2" }
    });
    expect(buildWith(f, rec.judgmentLedgerForLoop(LOOP_ID))).toThrow(/cites scope_ref "scope_v1:FORGED" but the signed/);
  });

  it("cold validation fails when a scope turn cites a scope_ref different from the attested event", () => {
    const f = fixture("verified_context"); // f.event commits scope_ref f.scope_ref
    const rec = createJudgmentRecorder();
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: null,
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r1" }
    });
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: "scope_v1:FORGED", // != the attested event's committed scope_ref
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "REFUSED", source: "scope_gate", scope_event_hash: f.event.event_hash, reason_code: "forbidden_targets" }
    });
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r2" }
    });
    expect(buildWith(f, rec.judgmentLedgerForLoop(LOOP_ID))).toThrow(/commits scope_ref "scope_v1:[0-9a-f]+" \(fail closed\)/);
  });

  it("cold validation fails when a multi-target bind turn's per-target hashes diverge from the signed stamp", () => {
    const sealed = sealedScope("verified_context");
    const scope_ref = sealed.scope_ref;
    const stampTargets = [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`];
    const aggregate = `sha256:${"c".repeat(64)}`; // stand-in multi-target set digest
    const receipts: ProofReceipt[] = [
      {
        version: "LYHNA_RECEIPT_V2",
        receipt_id: "r1",
        public_key: PUBKEY,
        tenant_hash: "55b966349a28aaaa",
        action_type: "tool_call",
        outcome: "APPROVED",
        signature: "c3R1Yg==",
        constraints: {
          loop: { loop_id: LOOP_ID, prior_receipt_id: null, goal_hash: GOAL_HASH },
          scope: { scope_ref, prior_receipt_id: null, action_class: "write", tool_name: "copy_file", target_descriptor: aggregate, target_descriptors: stampTargets }
        }
      },
      terminalReceipt("close", "r1", 1)
    ];
    const honestTurns = (() => {
      const rec = createJudgmentRecorder();
      rec.append({
        loop_id: LOOP_ID,
        scope_ref,
        prior_receipt_id: null,
        proposed: { action_class: "write", tool_name: "copy_file", target_descriptor: aggregate, target_descriptors: stampTargets },
        verdict: { kind: "APPROVED", source: "bind", receipt_id: "r1" }
      });
      return rec.judgmentLedgerForLoop(LOOP_ID);
    })();
    const reduced = reduceJudgmentLedger({ loop_id: LOOP_ID, scope_ref, turns: honestTurns, mode: "verified_context" });
    const continuation = buildContinuationCapsule({
      scope_history: [sealed],
      scope_events: [],
      loop: { loop_id: LOOP_ID, goal_hash: GOAL_HASH, sealed: true, action_count: 1 },
      mode: "verified_context",
      reduced
    });
    // Tamper: keep the aggregate target_descriptor, but swap one per-target hash.
    const rec = createJudgmentRecorder();
    rec.append({
      loop_id: LOOP_ID,
      scope_ref,
      prior_receipt_id: null,
      proposed: { action_class: "write", tool_name: "copy_file", target_descriptor: aggregate, target_descriptors: [`sha256:${"a".repeat(64)}`, `sha256:${"f".repeat(64)}`] },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r1" }
    });
    expect(() =>
      buildLoopProofBundle({
        receipts,
        source_env: "test",
        capsule: { mode: "verified_context", sealed_scope: sealed, scope_history: [sealed], continuation, scope_events: [], judgment_turns: rec.judgmentLedgerForLoop(LOOP_ID) }
      })
    ).toThrow(/per-target hash list/);
  });

  it("cold validation fails on a turn with an unknown verdict.source (dodging the source-keyed checks)", () => {
    const f = fixture("verified_context");
    const rec = createJudgmentRecorder();
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: null,
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r1" }
    });
    // A hash-valid turn whose source is neither bind nor scope_gate/loop_bound: it would otherwise be
    // skipped by every source-keyed cross-check while still folded by the reducer.
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "REFUSED", source: "spoof" as never, scope_event_hash: f.event.event_hash }
    });
    rec.append({
      loop_id: LOOP_ID,
      scope_ref: f.scope_ref,
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r2" }
    });
    expect(buildWith(f, rec.judgmentLedgerForLoop(LOOP_ID))).toThrow(/unknown verdict.source/);
  });

  it("a non-scoped (judgment-less) bundle is unaffected", () => {
    const built = buildLoopProofBundle({
      receipts: [inLoopReceipt("r1", null, "scope_v1:x"), terminalReceipt("close", "r1", 1)].map((r) => {
        // Strip scope stamps for a plain (non-capsule) bundle.
        const c = r.constraints as Record<string, unknown>;
        delete (c as { scope?: unknown }).scope;
        return r;
      }),
      source_env: "test"
    });
    expect(built.judgment_ledger).toBeUndefined();
    expect(built.bundle.capsule).toBeUndefined();
  });
});

describe("cross-loop edge (inherits_loop) — surfaced and bound in the pack", () => {
  const edge: ScopeInheritsLoop = {
    capsule_ref: "cap_v1:" + "1".repeat(64),
    scope_ref: "scope_v1:" + "2".repeat(64),
    final_turn_ref: "turn_v1:" + "3".repeat(64)
  };

  function buildEdgePack(mode: ScopePrivacyMode) {
    const f = fixture(mode, edge);
    return {
      f,
      built: buildLoopProofBundle({
        receipts: f.receipts,
        source_env: "test",
        capsule: {
          mode,
          sealed_scope: f.sealed,
          scope_history: [f.sealed],
          continuation: f.continuation,
          scope_events: [f.event],
          judgment_turns: f.turns
        }
      })
    };
  }

  it("carries the edge through continuation-capsule.json and memory-injection.json in BOTH modes", () => {
    for (const mode of ["verified_context", "proof"] as const) {
      const { built } = buildEdgePack(mode);
      expect(built.continuation_capsule!.inherits_loop).toEqual(edge);
      expect(built.memory_injection!.inherits_loop).toEqual(edge);
      // The handoff face shows the prior-loop refs (structural, content-blind).
      expect(built.handoff_markdown).toContain(edge.capsule_ref);
      expect(built.handoff_markdown).toContain(edge.final_turn_ref);
    }
  });

  it("fails closed when the continuation HIDES the edge the original scope sealed", () => {
    const f = fixture("verified_context", edge);
    const hiding = { ...f.continuation };
    delete (hiding as Record<string, unknown>).inherits_loop;
    expect(() =>
      buildLoopProofBundle({
        receipts: f.receipts,
        source_env: "test",
        capsule: { mode: "verified_context", sealed_scope: f.sealed, scope_history: [f.sealed], continuation: hiding, scope_events: [f.event], judgment_turns: f.turns }
      })
    ).toThrow(/inherits_loop/);
  });

  it("fails closed when the continuation CLAIMS an edge the original scope never sealed", () => {
    const f = fixture("verified_context");
    const claiming = { ...f.continuation, inherits_loop: edge };
    expect(() =>
      buildLoopProofBundle({
        receipts: f.receipts,
        source_env: "test",
        capsule: { mode: "verified_context", sealed_scope: f.sealed, scope_history: [f.sealed], continuation: claiming, scope_events: [f.event], judgment_turns: f.turns }
      })
    ).toThrow(/inherits_loop/);
  });

  it("fails closed when the continuation's edge DIFFERS from the sealed one (member-by-member)", () => {
    const f = fixture("verified_context", edge);
    const swapped = { ...f.continuation, inherits_loop: { ...edge, final_turn_ref: "turn_v1:" + "9".repeat(64) } };
    expect(() =>
      buildLoopProofBundle({
        receipts: f.receipts,
        source_env: "test",
        capsule: { mode: "verified_context", sealed_scope: f.sealed, scope_history: [f.sealed], continuation: swapped, scope_events: [f.event], judgment_turns: f.turns }
      })
    ).toThrow(/inherits_loop/);
  });

  it("fails closed on a present-but-null edge (null is malformed PRESENT, not absent)", () => {
    // A JSON-loaded continuation carrying `inherits_loop: null` against a NO-edge scope must not
    // pass as "absent" — a Verified Context export emits the continuation verbatim and would
    // publish the malformed null field in continuation-capsule.json.
    const f = fixture("verified_context");
    const nullEdge = { ...f.continuation, inherits_loop: null } as unknown as typeof f.continuation;
    expect(() =>
      buildLoopProofBundle({
        receipts: f.receipts,
        source_env: "test",
        capsule: { mode: "verified_context", sealed_scope: f.sealed, scope_history: [f.sealed], continuation: nullEdge, scope_events: [f.event], judgment_turns: f.turns }
      })
    ).toThrow(/inherits_loop/);
  });

  it("a no-edge pack is unchanged (field absent everywhere)", () => {
    const f = fixture("verified_context");
    const built = buildLoopProofBundle({
      receipts: f.receipts,
      source_env: "test",
      capsule: { mode: "verified_context", sealed_scope: f.sealed, scope_history: [f.sealed], continuation: f.continuation, scope_events: [f.event], judgment_turns: f.turns }
    });
    expect(built.continuation_capsule!.inherits_loop).toBeUndefined();
    expect(built.memory_injection!.inherits_loop).toBeUndefined();
  });
});

describe("lineage passthrough (inherited_state) — prior loop's state folded before this loop's", () => {
  const seed = { settled: ["loop1: chose Ed25519"], next_actions: ["loop1: wire export"] };

  // A realistic PRIOR loop continuation (the prior pack's continuation-capsule.json). The sealed
  // edge is DERIVED from it — capsule_ref recomputed, scope_ref / final_turn_ref copied — exactly
  // how a genuine Loop 2 open would pin it.
  const priorContinuation: ContinuationCapsule = {
    capsule_type: "continuation_capsule",
    capsule_version: "continuation-capsule/v1",
    loop_id: "loop-prior",
    goal_hash: "b".repeat(64),
    scope_ref: "scope_v1:" + "2".repeat(64),
    inherits_from: { scope_ref: "scope_v1:" + "2".repeat(64) },
    sealed: true,
    action_count: 3,
    closed_at: "2026-06-10T00:00:00.000Z",
    what_changed: [],
    scope_events: [],
    final_turn_ref: "turn_v1:" + "3".repeat(64),
    settled: ["loop1: chose Ed25519"],
    next_actions: ["loop1: wire export"]
  };
  const edge: ScopeInheritsLoop = {
    capsule_ref: deriveContinuationRef(priorContinuation),
    scope_ref: priorContinuation.scope_ref,
    final_turn_ref: priorContinuation.final_turn_ref!
  };

  function buildSeeded(overrides: {
    seed?: typeof seed | { settled: string[] };
    prior?: ContinuationCapsule;
    edge?: ScopeInheritsLoop;
  }) {
    const f = fixture("verified_context", overrides.edge, overrides.seed as never);
    return buildLoopProofBundle({
      receipts: f.receipts,
      source_env: "test",
      capsule: {
        mode: "verified_context",
        sealed_scope: f.sealed,
        scope_history: [f.sealed],
        continuation: f.continuation,
        scope_events: [f.event],
        judgment_turns: f.turns,
        inherited_state: overrides.seed,
        prior_continuation: overrides.prior
      }
    });
  }

  it("Verified Context: a BOUND prior pack seeds continuation + memory-injection BEFORE this loop's deltas", () => {
    const built = buildSeeded({ seed, prior: priorContinuation, edge });
    // Seed first (lineage order), then this loop's own folded delta ("wrote cart.ts").
    expect(built.memory_injection!.settled).toEqual(["loop1: chose Ed25519", "wrote cart.ts"]);
    expect(built.memory_injection!.next_actions).toEqual(["loop1: wire export"]);
    expect(built.continuation_capsule!.settled).toEqual(["loop1: chose Ed25519", "wrote cart.ts"]);
    expect(built.continuation_capsule!.next_actions).toEqual(["loop1: wire export"]);
  });

  it("fails closed: inherited_state WITHOUT a sealed inherits_loop edge (unanchored lineage)", () => {
    expect(() => buildSeeded({ seed })).toThrow(/unanchored lineage|inherits_loop edge/);
  });

  it("fails closed: inherited_state with an edge but WITHOUT the prior pack's continuation", () => {
    // The edge proves WHICH capsule was referenced, not that the values came from it.
    expect(() => buildSeeded({ seed, edge })).toThrow(/supply the prior pack|prior_continuation/);
  });

  it("fails closed: prior continuation whose recomputed capsule_ref does not match the sealed edge", () => {
    const forgedPrior = { ...priorContinuation, action_count: 99 }; // structural change -> different capsule_ref
    expect(() => buildSeeded({ seed, prior: forgedPrior, edge })).toThrow(/capsule_ref/);
  });

  it("fails closed: seed that does not equal the prior capsule's verified state (forged values)", () => {
    // Even with a continuation folded over the forged seed, the prior capsule's real state wins:
    // the supplied prior binds by capsule_ref, and the forged seed != its state. (Forging the prior
    // DOCUMENT's plaintext instead is caught by the prior pack's own export-time plaintext binding
    // and the Stage E two-pack check.)
    const forgedSeed = { settled: ["loop1: FORGED memory"] };
    expect(() => buildSeeded({ seed: forgedSeed, prior: priorContinuation, edge })).toThrow(/does not equal the prior capsule/);
  });

  it("fails closed: a prior continuation supplied with NO sealed edge", () => {
    expect(() => buildSeeded({ prior: priorContinuation })).toThrow(/seals no inherits_loop edge/);
  });

  it("Proof Mode: inherited_state is ignored — pack stays content-blind", () => {
    const f = fixture("proof", undefined, seed);
    const built = buildLoopProofBundle({
      receipts: f.receipts,
      source_env: "test",
      capsule: {
        mode: "proof",
        sealed_scope: f.sealed,
        scope_history: [f.sealed],
        continuation: f.continuation,
        scope_events: [f.event],
        judgment_turns: f.turns,
        inherited_state: seed
      }
    });
    expect(built.memory_injection!.settled).toEqual([]);
    expect(built.memory_injection!.next_actions).toEqual([]);
    const blob = JSON.stringify(built.judgment_ledger) + (built.judgment_ledger_markdown ?? "") + JSON.stringify(built.memory_injection) + JSON.stringify(built.continuation_capsule);
    expect(blob).not.toContain("loop1: chose Ed25519");
    expect(blob).not.toContain("loop1: wire export");
  });

  it("a no-seed pack is unchanged (lineage passthrough is opt-in)", () => {
    const f = fixture("verified_context");
    const built = buildLoopProofBundle({
      receipts: f.receipts,
      source_env: "test",
      capsule: { mode: "verified_context", sealed_scope: f.sealed, scope_history: [f.sealed], continuation: f.continuation, scope_events: [f.event], judgment_turns: f.turns }
    });
    expect(built.memory_injection!.settled).toEqual(["wrote cart.ts"]);
  });
});
