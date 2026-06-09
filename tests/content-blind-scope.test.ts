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
  deriveScopeEventHash,
  createSyntheticDemoBindClient,
  mergeScopeConstraint,
  projectScopeCapsuleForExport,
  sealScopeCapsule,
  type BindRequest,
  type ProofReceipt,
  type ScopeCapsule,
  type ScopeConstraint,
  type ScopeEvent
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
  function continuationFor(loop_id: string, goal_hash: string, scope_ref: string, events: ScopeEvent[] = []) {
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
      scope_events: events.map((e) => ({
        event_hash: e.event_hash,
        event_type: e.event_type,
        decision: e.decision,
        scope_ref: e.scope_ref,
        prior_receipt_id: e.prior_receipt_id,
        matched_rule: e.matched_rule
      }))
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

  it("judges the mode contract on the VERIFIED finalScope, not an untrusted sealed_scope input (round 21)", () => {
    // The verified final history version is content-blind (proof). With --scope-history, the separate
    // `sealed_scope` input is NEVER hash-validated — only its scope_ref is matched to finalScope. A
    // caller crafts a sealed_scope that reuses the proof version's scope_ref but flips privacy_mode to
    // "verified_context", trying to unlock a plaintext-sidecar export of the verified (proof) final
    // scope. The mode contract must be judged on finalScope, so this still fails closed.
    const sealedProof = sealScopeCapsule({ capsule }); // privacy_mode: "proof", carries a plaintext sidecar
    const lyingSealed = {
      ...sealedProof,
      // scope_ref stays sealedProof.scope_ref (via spread) so the identity check passes, but the
      // unvalidated structural now claims verified_context.
      structural: { ...sealedProof.structural, privacy_mode: "verified_context" as const }
    };
    const receipts = loopCloseReceipts("loop-1", "a".repeat(64));
    const continuation = continuationFor("loop-1", "a".repeat(64), sealedProof.scope_ref);
    expect(() =>
      buildLoopProofBundle({
        receipts,
        source_env: "t",
        capsule: { mode: "verified_context", sealed_scope: lyingSealed, scope_history: [sealedProof], continuation, scope_events: [] }
      })
    ).toThrow(/verified final scope's privacy_mode/);
  });

  it("fails closed when a verified-context scope event's retained plaintext target does not hash to its descriptor (round 22)", () => {
    // A verified-context scope (plaintext retained in the sidecar). `event_hash` covers only the
    // structural target_descriptor (a hash), NOT the plaintext target — so a tampered scope-events.json
    // can keep the same descriptor/event_hash while swapping ONLY the plaintext, publishing a false
    // plaintext target in the tenant-visible sidecar. The export must bind retained plaintext to its hash.
    const vc: ScopeCapsule = {
      structural: {
        capsule_type: "scope_capsule",
        capsule_version: "scope-capsule/v1",
        loop_id: "loop-1",
        goal_hash: "a".repeat(64),
        privacy_mode: "verified_context",
        allowed_targets: ["/checkout/**"]
      },
      sidecar: { goal_summary: "x", planned_steps: [], open_questions: [] }
    };
    const sealed = sealScopeCapsule({ capsule: vc });
    const rec = createScopeEventRecorder();
    // A legit refusal: target outside allowed_targets; descriptor == hashTarget(the real plaintext).
    const event = rec.record({
      event_type: "scope_refusal",
      loop_id: "loop-1",
      scope_ref: sealed.scope_ref,
      attempted: { action_class: "write", tool_name: "write_file", target_descriptor: hashTarget("/billing/secrets.env"), target: "/billing/secrets.env" },
      matched_rule: "allowed_targets",
      decision: "REFUSED",
      prior_receipt_id: null
    });
    // Tamper ONLY the retained plaintext; descriptor + event_hash (which excludes the plaintext) are unchanged.
    const tampered = { ...event, attempted: { ...event.attempted, target: "/checkout/cart.ts" } };
    const receipts = loopCloseReceipts("loop-1", "a".repeat(64));
    // Continuation refs match the event (only attempted.target differs under tamper, which is not a ref field).
    const continuation = continuationFor("loop-1", "a".repeat(64), sealed.scope_ref, [event]);
    // The event_hash still validates (it never covered the plaintext) — the new binding check is what catches it.
    expect(deriveScopeEventHash({ ...tampered })).toBe(event.event_hash);
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "verified_context", sealed_scope: sealed, continuation, scope_events: [tampered] } })
    ).toThrow(/does not hash to its committed/);

    // Control: the untampered event exports cleanly in verified-context mode.
    const ok = buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "verified_context", sealed_scope: sealed, continuation, scope_events: [event] } });
    expect(ok.scope_events?.[0]?.attempted.target).toBe("/billing/secrets.env");
  });

  it("fails closed when the continuation under-reports/alters scope events vs the verified pack (round 24)", () => {
    // The pack carries a real attested refusal, but the (unsigned) continuation omits it — the proof
    // card renders its per-event list from the continuation, so it could under-report scope halts.
    const sealed = sealScopeCapsule({ capsule }); // proof mode
    const rec = createScopeEventRecorder();
    const event = rec.record({
      event_type: "scope_refusal",
      loop_id: "loop-1",
      scope_ref: sealed.scope_ref,
      attempted: { action_class: "write", tool_name: "write_file", target_descriptor: hashTarget("/billing/secrets.env") },
      matched_rule: "allowed_targets",
      decision: "REFUSED",
      prior_receipt_id: null
    });
    const receipts = loopCloseReceipts("loop-1", "a".repeat(64));

    // (a) continuation omits the event entirely (0 refs vs 1 verified) -> fail closed.
    const omitting = continuationFor("loop-1", "a".repeat(64), sealed.scope_ref, []);
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: sealed, continuation: omitting, scope_events: [event] } })
    ).toThrow(/misreport attested scope halts/);

    // (b) continuation keeps the count but alters a ref field (decision) -> fail closed.
    const altered = continuationFor("loop-1", "a".repeat(64), sealed.scope_ref, [event]);
    altered.scope_events[0]!.decision = "ESCALATED";
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: sealed, continuation: altered, scope_events: [event] } })
    ).toThrow(/misreport an attested scope halt/);

    // (c) faithful continuation exports cleanly and the bundle advertises the event hash.
    const faithful = continuationFor("loop-1", "a".repeat(64), sealed.scope_ref, [event]);
    const built = buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: sealed, continuation: faithful, scope_events: [event] } });
    expect(built.bundle.capsule?.scope_events.event_hashes).toEqual([event.event_hash]);
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

  it("fails closed when a receipt's scope stamp is anchored to a different predecessor than the signed loop (round 26)", () => {
    // The scope stamp is otherwise IN-LANE (valid scope_ref + allowed tool/class), but its
    // prior_receipt_id cites a different predecessor than the signed constraints.loop. The runtime
    // stamps both with the same prior inside one mutex, so this divergence is stale/forged.
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
        action_type: "write_file", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: {
          // loop predecessor is null (root step), but the scope anchor cites a forged predecessor.
          loop: { loop_id: "loop-1", prior_receipt_id: null, goal_hash },
          scope: { scope_ref: scoped.scope_ref, action_class: "write", tool_name: "write_file", prior_receipt_id: "lrv2_forged" }
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
    ).toThrow(/per-step scope anchor is stale\s+or forged/);
  });

  it("fails closed when an imported chain exceeds the sealed bounds.max_steps hard bound (round 28)", () => {
    // Sealed scope declares max_steps: 1, but the (imported/tampered) chain has TWO in-loop steps.
    const scoped = sealScopeCapsule({
      capsule: {
        structural: {
          capsule_type: "scope_capsule",
          capsule_version: "scope-capsule/v1",
          loop_id: "loop-1",
          goal_hash: "a".repeat(64),
          privacy_mode: "proof",
          allowed_action_classes: ["write"],
          bounds: { max_steps: 1 }
        }
      }
    });
    const goal_hash = "a".repeat(64);
    const pk = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
    const receipts: ProofReceipt[] = [
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r1", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "write_file", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: null, goal_hash }, scope: { scope_ref: scoped.scope_ref, action_class: "write", prior_receipt_id: null } }
      },
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r2", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "write_file", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: "r1", goal_hash }, scope: { scope_ref: scoped.scope_ref, action_class: "write", prior_receipt_id: "r1" } }
      },
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r3", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "loop_close", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: "r2", goal_hash }, loop_close: { loop_id: "loop-1", goal_hash, action_count: 2, outcome: "COMPLETED", prior_receipt_id: "r2", termination_reason: "t" } }
      }
    ];
    const continuation = continuationFor("loop-1", goal_hash, scoped.scope_ref);
    expect(() =>
      buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: scoped, continuation, scope_events: [] } })
    ).toThrow(/exceeds the sealed hard step bound|max_steps/);
  });

  it("exports cleanly when a HELD (ESCALATED) in-loop bind does not consume the max_steps budget (round 30)", () => {
    // max_steps: 1, and the chain has a held (ESCALATED) in-loop step plus ONE forwarded (APPROVED)
    // step. Only the forwarded step counts against the budget, so this is in-bound and exports.
    const scoped = sealScopeCapsule({
      capsule: {
        structural: {
          capsule_type: "scope_capsule",
          capsule_version: "scope-capsule/v1",
          loop_id: "loop-1",
          goal_hash: "a".repeat(64),
          privacy_mode: "proof",
          allowed_action_classes: ["write"],
          bounds: { max_steps: 1 }
        }
      }
    });
    const goal_hash = "a".repeat(64);
    const pk = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
    const receipts: ProofReceipt[] = [
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r1", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "write_file", outcome: "ESCALATED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: null, goal_hash }, scope: { scope_ref: scoped.scope_ref, action_class: "write", prior_receipt_id: null } }
      },
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r2", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "write_file", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: "r1", goal_hash }, scope: { scope_ref: scoped.scope_ref, action_class: "write", prior_receipt_id: "r1" } }
      },
      {
        version: "LYHNA_RECEIPT_V2", receipt_id: "r3", public_key: pk, tenant_hash: "55b966349a28aaaa",
        action_type: "loop_close", outcome: "APPROVED", signature: "c3R1Yg==",
        constraints: { loop: { loop_id: "loop-1", prior_receipt_id: "r2", goal_hash }, loop_close: { loop_id: "loop-1", goal_hash, action_count: 2, outcome: "COMPLETED", prior_receipt_id: "r2", termination_reason: "t" } }
      }
    ];
    const continuation = continuationFor("loop-1", goal_hash, scoped.scope_ref);
    const built = buildLoopProofBundle({ receipts, source_env: "t", capsule: { mode: "proof", sealed_scope: scoped, continuation, scope_events: [] } });
    expect(built.bundle.capsule?.scope_ref).toBe(scoped.scope_ref);
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
