import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const hashTarget = (t: string) => "sha256:" + createHash("sha256").update(t, "utf8").digest("hex");

import {
  amendScope,
  canonicalScopeJson,
  assertContentBlind,
  assertScopeCapsuleStructuralOnly,
  assertScopeConstraintStructural,
  buildLoopProofBundle,
  createScopeEventRecorder,
  createSyntheticDemoBindClient,
  mergeScopeConstraint,
  projectScopeCapsuleForExport,
  sealScopeCapsule,
  type BindRequest,
  type ProofReceipt,
  type ScopeCapsule,
  type ScopeConstraint
} from "../src/index.js";

const capsule: ScopeCapsule = {
  structural: {
    capsule_type: "scope_capsule",
    capsule_version: "scope-capsule/v1",
    loop_id: "loop-1",
    goal_hash: "a".repeat(64),
    privacy_mode: "proof",
    allowed_targets: ["/checkout/**"]
  },
  sidecar: {
    goal_summary: "fix checkout bug",
    planned_steps: ["read /checkout", "write fix", "run tests"],
    open_questions: ["which test suite?"]
  }
};

const structuralScope: ScopeConstraint = {
  scope_ref: "scope_v1:" + "a".repeat(64),
  prior_receipt_id: "lrv2_0001",
  action_class: "write",
  tool_name: "write_file",
  target_descriptor: "sha256:" + "c".repeat(64)
};

describe("content-blind: gate/core path carries no plaintext plan field (criterion 15.8)", () => {
  it("mergeScopeConstraint stamps only the closed structural key set", () => {
    const req: BindRequest = {
      action_type: "write_file",
      action_payload: { tool_name: "write_file", arguments: { path: "/checkout/x.ts" } },
      intent: "mcp:write_file",
      intent_version: "1.0"
    };
    const stamped = mergeScopeConstraint(req, structuralScope);
    const scope = stamped.constraints?.scope as Record<string, unknown>;
    expect(Object.keys(scope).sort()).toEqual(
      ["action_class", "prior_receipt_id", "scope_ref", "target_descriptor", "tool_name"]
    );
    // action_payload is untouched (payload identity preserved).
    expect(stamped.action_payload).toBe(req.action_payload);
  });

  it("fails closed if a plaintext plan field is smuggled into constraints.scope", () => {
    const leaky = { ...structuralScope, planned_steps: ["leak"] } as unknown as Record<string, unknown>;
    expect(() => assertScopeConstraintStructural(leaky)).toThrow(/unexpected key/);
    const req: BindRequest = {
      action_type: "x",
      action_payload: {},
      intent: "i",
      intent_version: "1.0"
    };
    expect(() => mergeScopeConstraint(req, leaky as unknown as ScopeConstraint)).toThrow();
  });

  it("a scope-stamped synthetic receipt is content-blind (no plaintext goal/plan in the receipt)", async () => {
    const bind = createSyntheticDemoBindClient();
    const req: BindRequest = {
      action_type: "write_file",
      action_payload: { tool_name: "write_file", arguments: { path: "/checkout/x.ts" } },
      intent: "mcp:write_file",
      intent_version: "1.0"
    };
    const receipt = (await bind.bind(mergeScopeConstraint(req, structuralScope))) as ProofReceipt;
    // The receipt echoes constraints.scope (structural only) — assertContentBlind must pass.
    expect(() => assertContentBlind([receipt])).not.toThrow();
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain("fix checkout bug");
    expect(serialized).not.toContain("planned_steps");
  });
});

describe("content-blind: assertContentBlind rejects plan-bearing keys in receipts", () => {
  it("rejects a receipt carrying a plaintext plan key", () => {
    const leaky: ProofReceipt = {
      receipt_id: "r1",
      public_key: "k",
      tenant_hash: "t",
      planned_steps: ["leak"]
    };
    expect(() => assertContentBlind([leaky])).toThrow(/content-blind/);
  });
});

describe("content-blind: Proof Mode scope-capsule.json is structural-only (criteria 15.9-15.10)", () => {
  it("projectScopeCapsuleForExport(proof) drops the sidecar and passes the structural-only guard", () => {
    const sealed = sealScopeCapsule({ capsule });
    const exported = projectScopeCapsuleForExport(sealed, "proof");
    expect(exported.sidecar).toBeUndefined();
    expect(() => assertScopeCapsuleStructuralOnly(exported)).not.toThrow();
    // No plaintext plan survives the projection.
    expect(JSON.stringify(exported)).not.toContain("fix checkout bug");
    expect(JSON.stringify(exported)).not.toContain("planned_steps");
  });

  it("assertScopeCapsuleStructuralOnly fails closed if a sidecar is present", () => {
    const sealed = sealScopeCapsule({ capsule });
    const vcm = projectScopeCapsuleForExport(sealed, "verified_context");
    expect(vcm.sidecar).toBeDefined();
    // Hand the VCM (sidecar-bearing) object to the Proof Mode guard — it must reject.
    expect(() => assertScopeCapsuleStructuralOnly(vcm)).toThrow(/structural-only/);
  });
});

describe("content-blind: Proof Mode bundle export carries no plaintext", () => {
  it("buildLoopProofBundle(mode=proof) keeps the scope capsule structural-only", () => {
    const sealed = sealScopeCapsule({ capsule });
    const receipts: ProofReceipt[] = [
      {
        version: "LYHNA_RECEIPT_V2",
        receipt_id: "r1",
        public_key: "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2",
        tenant_hash: "55b966349a28aaaa",
        action_type: "loop_close",
        outcome: "APPROVED",
        signature: "c3R1Yg==",
        constraints: {
          loop: { loop_id: "loop-1", prior_receipt_id: null, goal_hash: "a".repeat(64) },
          loop_close: {
            loop_id: "loop-1",
            goal_hash: "a".repeat(64),
            action_count: 0,
            outcome: "COMPLETED",
            prior_receipt_id: null,
            termination_reason: "test"
          }
        }
      }
    ];
    const continuation = {
      capsule_type: "continuation_capsule" as const,
      capsule_version: "continuation-capsule/v1",
      loop_id: "loop-1",
      goal_hash: "a".repeat(64),
      scope_ref: sealed.scope_ref,
      inherits_from: { scope_ref: sealed.scope_ref },
      sealed: true,
      action_count: 0,
      closed_at: "2026-06-08T00:00:00.000Z",
      what_changed: [],
      scope_events: [],
      settled: ["this should be stripped in proof mode"]
    };
    const built = buildLoopProofBundle({
      receipts,
      source_env: "test",
      capsule: { mode: "proof", sealed_scope: sealed, continuation, scope_events: [] }
    });
    expect(built.scope_capsule?.sidecar).toBeUndefined();
    expect(built.continuation_capsule?.settled).toBeUndefined();
    expect(JSON.stringify(built.scope_capsule)).not.toContain("fix checkout bug");
    expect(JSON.stringify(built.continuation_capsule)).not.toContain("stripped in proof mode");
    expect(built.bundle.capsule?.mode).toBe("proof");
  });
});

describe("export identity binding + mode contract (fail closed)", () => {
  function loopCloseReceipts(loop_id: string, goal_hash: string): ProofReceipt[] {
    return [
      {
        version: "LYHNA_RECEIPT_V2",
        receipt_id: "r1",
        public_key: "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2",
        tenant_hash: "55b966349a28aaaa",
        action_type: "loop_close",
        outcome: "APPROVED",
        signature: "c3R1Yg==",
        constraints: {
          loop: { loop_id, prior_receipt_id: null, goal_hash },
          loop_close: { loop_id, goal_hash, action_count: 0, outcome: "COMPLETED", prior_receipt_id: null, termination_reason: "t" }
        }
      }
    ];
  }
  function continuationFor(loop_id: string, goal_hash: string, scope_ref: string) {
    return {
      capsule_type: "continuation_capsule" as const,
      capsule_version: "continuation-capsule/v1",
      loop_id,
      goal_hash,
      scope_ref,
      inherits_from: { scope_ref },
      sealed: true,
      action_count: 0,
      closed_at: "2026-06-08T00:00:00.000Z",
      what_changed: [],
      scope_events: []
    };
  }

  it("fails closed when the capsule belongs to a DIFFERENT loop than the receipts", () => {
    const sealed = sealScopeCapsule({ capsule }); // loop-1
    const receipts = loopCloseReceipts("loop-OTHER", "a".repeat(64));
    const continuation = continuationFor("loop-OTHER", "a".repeat(64), sealed.scope_ref);
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: sealed, continuation, scope_events: [] } })
    ).toThrow(/does not belong to the receipt chain/);
  });

  it("fails closed when the continuation scope_ref does not match the sealed scope", () => {
    const sealed = sealScopeCapsule({ capsule }); // loop-1
    const receipts = loopCloseReceipts("loop-1", "a".repeat(64));
    const continuation = continuationFor("loop-1", "a".repeat(64), "scope_v1:" + "f".repeat(64));
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: sealed, continuation, scope_events: [] } })
    ).toThrow(/does not belong to the receipt chain/);
  });

  it("refuses to export a Proof-Mode-sealed scope in Verified Context Mode (would leak plaintext)", () => {
    const sealed = sealScopeCapsule({ capsule }); // privacy_mode: "proof"
    const receipts = loopCloseReceipts("loop-1", "a".repeat(64));
    const continuation = continuationFor("loop-1", "a".repeat(64), sealed.scope_ref);
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "verified_context", sealed_scope: sealed, continuation, scope_events: [] } })
    ).toThrow(/Verified Context Mode/);
  });

  it("fails closed when the sealed scope_ref does not hash to its structural projection (tamper)", () => {
    const sealed = sealScopeCapsule({ capsule });
    // Mutate the structural rules but KEEP the original scope_ref (the tamper Codex described).
    const tampered = { ...sealed, structural: { ...sealed.structural, allowed_targets: ["/anything/**"] } };
    const receipts = loopCloseReceipts("loop-1", "a".repeat(64));
    const continuation = continuationFor("loop-1", "a".repeat(64), tampered.scope_ref);
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: tampered, continuation, scope_events: [] } })
    ).toThrow(/does not match the hash/);
  });

  it("fails closed when an in-loop consequential receipt is NOT scope-stamped (scoped export)", () => {
    const sealed = sealScopeCapsule({ capsule });
    const goal_hash = "a".repeat(64);
    const pk = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
    const receipts: ProofReceipt[] = [
      {
        // In-loop consequential receipt with constraints.loop but NO constraints.scope.
        version: "LYHNA_RECEIPT_V2",
        receipt_id: "r1",
        public_key: pk,
        tenant_hash: "55b966349a28aaaa",
        action_type: "write_file",
        outcome: "APPROVED",
        signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: null, goal_hash } }
      },
      {
        version: "LYHNA_RECEIPT_V2",
        receipt_id: "r2",
        public_key: pk,
        tenant_hash: "55b966349a28aaaa",
        action_type: "loop_close",
        outcome: "APPROVED",
        signature: "c3R1Yg==",
        constraints: {
          loop: { loop_id: "loop-1", prior_receipt_id: "r1", goal_hash },
          loop_close: { loop_id: "loop-1", goal_hash, action_count: 1, outcome: "COMPLETED", prior_receipt_id: "r1", termination_reason: "t" }
        }
      }
    ];
    const continuation = continuationFor("loop-1", goal_hash, sealed.scope_ref);
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: sealed, continuation, scope_events: [] } })
    ).toThrow(/no constraints\.scope\.scope_ref|scope-stamped/);
  });

  it("fails closed when the continuation claims an amendment to a scope_ref outside the verified history", () => {
    const sealed = sealScopeCapsule({ capsule });
    const receipts = loopCloseReceipts("loop-1", "a".repeat(64));
    const continuation = {
      ...continuationFor("loop-1", "a".repeat(64), sealed.scope_ref),
      // A tampered amendment claiming a from-ref that is not in the (single-version) verified history.
      what_changed: [{ from_scope_ref: "scope_v1:" + "d".repeat(64), to_scope_ref: sealed.scope_ref, sealed_at: "x", changed_fields: ["allowed_targets"] }]
    };
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: sealed, continuation, scope_events: [] } })
    ).toThrow(/verified history/);
  });

  it("fails closed when the continuation UNDER-reports amendments vs the verified history", () => {
    const original = sealScopeCapsule({ capsule });
    const amended = amendScope(original, { structural: { ...capsule.structural, allowed_targets: ["/checkout/**", "/cart/**"] } });
    const goal_hash = "a".repeat(64);
    const pk = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
    const receipts: ProofReceipt[] = [
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r1", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "write_file", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: null, goal_hash }, scope: { scope_ref: original.scope_ref, prior_receipt_id: null } }
      },
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r2", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "loop_close", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: "r1", goal_hash }, loop_close: { loop_id: "loop-1", goal_hash, action_count: 1, outcome: "COMPLETED", prior_receipt_id: "r1", termination_reason: "t" } }
      }
    ];
    // History has 1 amendment, but the continuation hides it (what_changed: []).
    const continuation = {
      ...continuationFor("loop-1", goal_hash, amended.scope_ref),
      inherits_from: { scope_ref: original.scope_ref },
      what_changed: []
    };
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: amended, scope_history: [original, amended], continuation, scope_events: [] } })
    ).toThrow(/verified history/);
  });

  it("fails closed when a supplied scope event's hash does not match its contents (tamper)", () => {
    const sealed = sealScopeCapsule({ capsule });
    const rec = createScopeEventRecorder();
    const event = rec.record({
      event_type: "scope_refusal",
      loop_id: "loop-1",
      scope_ref: sealed.scope_ref,
      attempted: { action_class: "write", tool_name: "write_file", target_descriptor: "sha256:" + "c".repeat(64) },
      matched_rule: "/billing/migrations/**",
      decision: "REFUSED",
      prior_receipt_id: null
    });
    // Tamper the decision while keeping the (now stale) event_hash.
    const tampered = { ...event, matched_rule: "allowed_targets" };
    const receipts = loopCloseReceipts("loop-1", "a".repeat(64));
    const continuation = continuationFor("loop-1", "a".repeat(64), sealed.scope_ref);
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: sealed, continuation, scope_events: [tampered] } })
    ).toThrow(/event_hash does not match/);
  });

  it("accepts a real amendment when the full verified scope_history is supplied", () => {
    // Export-verifiable target lane: the scope declares target_descriptor_hashes (Option B).
    const base = {
      capsule_type: "scope_capsule" as const,
      capsule_version: "scope-capsule/v1",
      loop_id: "loop-1",
      goal_hash: "a".repeat(64),
      privacy_mode: "proof" as const,
      allowed_action_classes: ["write"],
      target_descriptor_hashes: [hashTarget("/checkout/cart.ts")]
    };
    const original = sealScopeCapsule({ capsule: { structural: base } });
    // A STRUCTURALLY distinct amendment -> a new scope_ref, chained to the original.
    const amended = amendScope(original, { structural: { ...base, allowed_action_classes: ["write", "read"] } });
    const goal_hash = "a".repeat(64);
    const pk = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
    // One in-loop receipt stamped under the ORIGINAL scope_ref with an in-lane (member) target.
    const receipts: ProofReceipt[] = [
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r1", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "write_file", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: null, goal_hash }, scope: { scope_ref: original.scope_ref, action_class: "write", target_descriptor: hashTarget("/checkout/cart.ts"), prior_receipt_id: null } }
      },
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r2", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "loop_close", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: "r1", goal_hash }, loop_close: { loop_id: "loop-1", goal_hash, action_count: 1, outcome: "COMPLETED", prior_receipt_id: "r1", termination_reason: "t" } }
      }
    ];
    const continuation = {
      ...continuationFor("loop-1", goal_hash, amended.scope_ref),
      inherits_from: { scope_ref: original.scope_ref },
      what_changed: [{ from_scope_ref: original.scope_ref, to_scope_ref: amended.scope_ref, sealed_at: amended.sealed_at, changed_fields: ["allowed_action_classes"] }]
    };
    const built = buildLoopProofBundle({
      receipts,
      source_env: "t",
      capsule: { mode: "proof", sealed_scope: amended, scope_history: [original, amended], continuation, scope_events: [] }
    });
    expect(built.bundle.capsule?.scope_ref).toBe(amended.scope_ref);
  });

  it("fails closed: a globs-only target scope cannot be export-re-validated (Option B)", () => {
    const sealed = sealScopeCapsule({ capsule }); // allowed_targets globs, NO target_descriptor_hashes
    const goal_hash = "a".repeat(64);
    const pk = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
    const receipts: ProofReceipt[] = [
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r1", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "write_file", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: null, goal_hash }, scope: { scope_ref: sealed.scope_ref, action_class: "write", target_descriptor: hashTarget("/checkout/cart.ts"), prior_receipt_id: null } }
      },
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r2", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "loop_close", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: "r1", goal_hash }, loop_close: { loop_id: "loop-1", goal_hash, action_count: 1, outcome: "COMPLETED", prior_receipt_id: "r1", termination_reason: "t" } }
      }
    ];
    const continuation = continuationFor("loop-1", goal_hash, sealed.scope_ref);
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: sealed, continuation, scope_events: [] } })
    ).toThrow(/target_descriptor_hashes|export-verifiable target lane/);
  });

  it("re-validates a PRESENT target even for a declared-targetless action class (round 18 #1)", () => {
    const base = {
      capsule_type: "scope_capsule" as const,
      capsule_version: "scope-capsule/v1",
      loop_id: "loop-1",
      goal_hash: "a".repeat(64),
      privacy_mode: "proof" as const,
      allowed_action_classes: ["run_tests"],
      targetless_action_classes: ["run_tests"],
      target_descriptor_hashes: [hashTarget("/checkout/cart.ts")]
    };
    const sealed = sealScopeCapsule({ capsule: { structural: base } });
    const goal_hash = "a".repeat(64);
    const pk = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
    const receipts: ProofReceipt[] = [
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r1", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "run_tests", outcome: "APPROVED", signature: "c3R1Yg==",
        // Targetless class but it NAMES an out-of-lane target hash — must still be re-validated.
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: null, goal_hash }, scope: { scope_ref: sealed.scope_ref, action_class: "run_tests", target_descriptor: hashTarget("/billing/migrations/x.sql"), prior_receipt_id: null } }
      },
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r2", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "loop_close", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: "r1", goal_hash }, loop_close: { loop_id: "loop-1", goal_hash, action_count: 1, outcome: "COMPLETED", prior_receipt_id: "r1", termination_reason: "t" } }
      }
    ];
    const continuation = continuationFor("loop-1", goal_hash, sealed.scope_ref);
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: sealed, continuation, scope_events: [] } })
    ).toThrow(/not a declared member/);
  });

  it("keeps multi-target stamps exportable when every target is declared, rejects a non-member (round 18 #2)", () => {
    const base = {
      capsule_type: "scope_capsule" as const,
      capsule_version: "scope-capsule/v1",
      loop_id: "loop-1",
      goal_hash: "a".repeat(64),
      privacy_mode: "proof" as const,
      allowed_action_classes: ["write"],
      target_descriptor_hashes: [hashTarget("/checkout/a.ts"), hashTarget("/checkout/b.ts")]
    };
    const sealed = sealScopeCapsule({ capsule: { structural: base } });
    const goal_hash = "a".repeat(64);
    const pk = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
    const mkReceipts = (targetHashes: string[]): ProofReceipt[] => [
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r1", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "copy_file", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: null, goal_hash }, scope: { scope_ref: sealed.scope_ref, action_class: "write", target_descriptor: "sha256:" + "9".repeat(64), target_descriptors: targetHashes, prior_receipt_id: null } }
      },
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r2", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "loop_close", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: "r1", goal_hash }, loop_close: { loop_id: "loop-1", goal_hash, action_count: 1, outcome: "COMPLETED", prior_receipt_id: "r1", termination_reason: "t" } }
      }
    ];
    const continuation = continuationFor("loop-1", goal_hash, sealed.scope_ref);
    // Both targets declared -> exportable.
    const built = buildLoopProofBundle({
      receipts: mkReceipts([hashTarget("/checkout/a.ts"), hashTarget("/checkout/b.ts")]),
      source_env: "t",
      capsule: { mode: "proof", sealed_scope: sealed, continuation, scope_events: [] }
    });
    expect(built.bundle.capsule?.scope_ref).toBe(sealed.scope_ref);
    // One target not a declared member -> fail closed.
    expect(() =>
      buildLoopProofBundle({
        receipts: mkReceipts([hashTarget("/checkout/a.ts"), hashTarget("/checkout/c.ts")]),
        source_env: "t",
        capsule: { mode: "proof", sealed_scope: sealed, continuation, scope_events: [] }
      })
    ).toThrow(/not a declared member/);
  });

  it("fails closed when an imported scope is hash-consistent but carries an unsafe structural key (round 19)", () => {
    // A leaky structural projection with an extra (non-blacklisted) key, plus a scope_ref that is
    // the genuine hash of THAT projection — so recompute passes, but the closed allowlist must reject it.
    const structural = {
      capsule_type: "scope_capsule",
      capsule_version: "scope-capsule/v1",
      loop_id: "loop-1",
      goal_hash: "a".repeat(64),
      privacy_mode: "proof",
      description: "fix checkout bug"
    };
    const scope_ref = "scope_v1:" + createHash("sha256").update(canonicalScopeJson(structural), "utf8").digest("hex");
    const sealed = { scope_ref, sidecar_hash: null, structural, prior_scope_ref: null, sealed_at: "x" } as never;
    const receipts = loopCloseReceipts("loop-1", "a".repeat(64));
    const continuation = continuationFor("loop-1", "a".repeat(64), scope_ref);
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: sealed, continuation, scope_events: [] } })
    ).toThrow(/unknown field|closed allowlist/);
  });

  it("fails closed when an empty target_descriptors array tries to hide a stamped target_descriptor (round 20)", () => {
    const base = {
      capsule_type: "scope_capsule" as const,
      capsule_version: "scope-capsule/v1",
      loop_id: "loop-1",
      goal_hash: "a".repeat(64),
      privacy_mode: "proof" as const,
      allowed_action_classes: ["run_tests"],
      targetless_action_classes: ["run_tests"],
      target_descriptor_hashes: [hashTarget("/checkout/cart.ts")]
    };
    const sealed = sealScopeCapsule({ capsule: { structural: base } });
    const goal_hash = "a".repeat(64);
    const pk = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
    const receipts: ProofReceipt[] = [
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r1", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "run_tests", outcome: "APPROVED", signature: "c3R1Yg==",
        // Targetless class, an out-of-lane target hash, but an EMPTY target_descriptors array to dodge it.
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: null, goal_hash }, scope: { scope_ref: sealed.scope_ref, action_class: "run_tests", target_descriptor: hashTarget("/billing/x.sql"), target_descriptors: [], prior_receipt_id: null } }
      },
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r2", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "loop_close", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: "r1", goal_hash }, loop_close: { loop_id: "loop-1", goal_hash, action_count: 1, outcome: "COMPLETED", prior_receipt_id: "r1", termination_reason: "t" } }
      }
    ];
    const continuation = continuationFor("loop-1", goal_hash, sealed.scope_ref);
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: sealed, continuation, scope_events: [] } })
    ).toThrow(/not a declared member/);
  });

  it("fails closed when a continuation amendment falsifies changed_fields (hides what changed)", () => {
    const original = sealScopeCapsule({ capsule });
    const amended = amendScope(original, { structural: { ...capsule.structural, allowed_targets: ["/checkout/**", "/cart/**"] } });
    const goal_hash = "a".repeat(64);
    const pk = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
    const receipts: ProofReceipt[] = [
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r1", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "write_file", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: null, goal_hash }, scope: { scope_ref: original.scope_ref, prior_receipt_id: null } }
      },
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r2", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "loop_close", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: "r1", goal_hash }, loop_close: { loop_id: "loop-1", goal_hash, action_count: 1, outcome: "COMPLETED", prior_receipt_id: "r1", termination_reason: "t" } }
      }
    ];
    const continuation = {
      ...continuationFor("loop-1", goal_hash, amended.scope_ref),
      inherits_from: { scope_ref: original.scope_ref },
      // Correct refs + sealed_at, but changed_fields LIES (hides the allowed_targets expansion).
      what_changed: [{ from_scope_ref: original.scope_ref, to_scope_ref: amended.scope_ref, sealed_at: amended.sealed_at, changed_fields: [] }]
    };
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: amended, scope_history: [original, amended], continuation, scope_events: [] } })
    ).toThrow(/changed_fields do not match/);
  });

  it("fails closed when a receipt's stamped descriptor is out-of-scope for its scope_ref (round 16)", () => {
    // A scope that allows only write_file / write — but a receipt stamps a valid scope_ref with an
    // out-of-scope tool. Chain-membership passes; descriptor re-validation must reject it.
    const scoped = sealScopeCapsule({
      capsule: {
        structural: {
          capsule_type: "scope_capsule",
          capsule_version: "scope-capsule/v1",
          loop_id: "loop-1",
          goal_hash: "a".repeat(64),
          privacy_mode: "proof",
          allowed_action_classes: ["write"],
          allowed_tools: ["write_file"]
        }
      }
    });
    const goal_hash = "a".repeat(64);
    const pk = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
    const receipts: ProofReceipt[] = [
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r1", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "exfiltrate", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: {
          loop: { loop_id: "loop-1", prior_receipt_id: null, goal_hash },
          scope: { scope_ref: scoped.scope_ref, action_class: "write", tool_name: "exfiltrate", prior_receipt_id: null }
        }
      },
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r2", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "loop_close", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: "r1", goal_hash }, loop_close: { loop_id: "loop-1", goal_hash, action_count: 1, outcome: "COMPLETED", prior_receipt_id: "r1", termination_reason: "t" } }
      }
    ];
    const continuation = continuationFor("loop-1", goal_hash, scoped.scope_ref);
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: scoped, continuation, scope_events: [] } })
    ).toThrow(/not allowed under scope/);
  });

  it("fails closed when a receipt carries a scope_ref outside the exported scope chain", () => {
    const sealed = sealScopeCapsule({ capsule });
    const goal_hash = "a".repeat(64);
    const pk = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
    const receipts: ProofReceipt[] = [
      {
        version: "LYHNA_RECEIPT_V2",
        receipt_id: "r1",
        public_key: pk,
        tenant_hash: "55b966349a28aaaa",
        action_type: "write_file",
        outcome: "APPROVED",
        signature: "c3R1Yg==",
        constraints: {
          loop: { loop_id: "loop-1", prior_receipt_id: null, goal_hash },
          scope: { scope_ref: "scope_v1:" + "e".repeat(64), prior_receipt_id: null }
        }
      },
      {
        version: "LYHNA_RECEIPT_V2",
        receipt_id: "r2",
        public_key: pk,
        tenant_hash: "55b966349a28aaaa",
        action_type: "loop_close",
        outcome: "APPROVED",
        signature: "c3R1Yg==",
        constraints: {
          loop: { loop_id: "loop-1", prior_receipt_id: "r1", goal_hash },
          loop_close: { loop_id: "loop-1", goal_hash, action_count: 1, outcome: "COMPLETED", prior_receipt_id: "r1", termination_reason: "t" }
        }
      }
    ];
    const continuation = continuationFor("loop-1", goal_hash, sealed.scope_ref);
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: sealed, continuation, scope_events: [] } })
    ).toThrow(/outside the exported scope/);
  });
});
