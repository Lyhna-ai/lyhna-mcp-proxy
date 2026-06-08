import { describe, expect, it } from "vitest";

import {
  amendScope,
  assertContentBlind,
  assertScopeCapsuleStructuralOnly,
  assertScopeConstraintStructural,
  buildLoopProofBundle,
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
    ).toThrow(/outside the verified history/);
  });

  it("accepts a real amendment when the full verified scope_history is supplied", () => {
    const original = sealScopeCapsule({ capsule });
    // A STRUCTURALLY distinct amendment -> a new scope_ref, chained to the original.
    const amended = amendScope(original, {
      structural: { ...capsule.structural, allowed_targets: ["/checkout/**", "/cart/**"] }
    });
    const goal_hash = "a".repeat(64);
    const pk = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
    // One in-loop receipt stamped with the ORIGINAL scope_ref, terminal close.
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
      what_changed: [{ from_scope_ref: original.scope_ref, to_scope_ref: amended.scope_ref, sealed_at: amended.sealed_at, changed_fields: [] }]
    };
    const built = buildLoopProofBundle({
      receipts,
      source_env: "t",
      capsule: { mode: "proof", sealed_scope: amended, scope_history: [original, amended], continuation, scope_events: [] }
    });
    expect(built.bundle.capsule?.scope_ref).toBe(amended.scope_ref);
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
