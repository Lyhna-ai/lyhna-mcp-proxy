import { describe, expect, it } from "vitest";

import {
  buildContinuationCapsule,
  buildLoopProofBundle,
  createJudgmentRecorder,
  createScopeEventRecorder,
  deriveGoalHash,
  reduceJudgmentLedger,
  sealScopeCapsule,
  type JudgmentTurn,
  type ProofReceipt,
  type ScopeEvent,
  type ScopePrivacyMode,
  type SealedScope
} from "../src/index.js";

const PUBKEY = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
const LOOP_ID = "loop-cg2-fixture";
const GOAL = "fix checkout bug";
const GOAL_HASH = deriveGoalHash(GOAL);

function sealedScope(privacy_mode: ScopePrivacyMode): SealedScope {
  return sealScopeCapsule({
    capsule: {
      structural: {
        capsule_type: "scope_capsule",
        capsule_version: "scope-capsule/v1",
        loop_id: LOOP_ID,
        goal_hash: GOAL_HASH,
        privacy_mode,
        allowed_action_classes: ["write", "run_tests"],
        class_map: { write_file: "write", run_tests: "run_tests" }
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
function fixture(mode: ScopePrivacyMode) {
  const sealed = sealedScope(mode);
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
  rec.append({
    loop_id: LOOP_ID,
    scope_ref,
    prior_receipt_id: "r1",
    proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
    verdict: { kind: "APPROVED", source: "bind", receipt_id: "r2" }
  });
  const turns = rec.judgmentLedgerForLoop(LOOP_ID);

  const reduced = reduceJudgmentLedger({ loop_id: LOOP_ID, scope_ref, turns, mode });
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
    // Drop the last bind turn (for r2); the chain stays valid (2 contiguous turns) but r2 is unmapped.
    const f = fixture("verified_context");
    const turns = f.turns.slice(0, 2);
    expect(() => build("verified_context", { turns })).toThrow(/In-loop receipt r2 has no matching judgment turn/);
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
    expect(() => build("verified_context", { turns: rec.judgmentLedgerForLoop(LOOP_ID) })).toThrow(/not a signed in-loop receipt/);
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
