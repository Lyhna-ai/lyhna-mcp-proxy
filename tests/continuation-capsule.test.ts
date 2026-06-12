import { describe, expect, it } from "vitest";

import {
  amendScope,
  buildContinuationCapsule,
  createScopeEventRecorder,
  projectContinuationProofMode,
  sealScopeCapsule,
  type ScopeCapsule,
  type ScopeStructuralProjection
} from "../src/index.js";

function structural(overrides: Partial<ScopeStructuralProjection> = {}): ScopeStructuralProjection {
  return {
    capsule_type: "scope_capsule",
    capsule_version: "scope-capsule/v1",
    loop_id: "loop-1",
    goal_hash: "a".repeat(64),
    privacy_mode: "verified_context",
    allowed_targets: ["/checkout/**"],
    forbidden_targets: ["/billing/migrations/**"],
    ...overrides
  };
}

function capsule(overrides: Partial<ScopeStructuralProjection> = {}): ScopeCapsule {
  return { structural: structural(overrides), sidecar: { goal_summary: "fix checkout bug" } };
}

describe("buildContinuationCapsule", () => {
  it("inherits scope_ref / goal_hash / loop_id and records settled/open/next (Verified Context)", () => {
    const original = sealScopeCapsule({ capsule: capsule() });
    const cont = buildContinuationCapsule({
      scope_history: [original],
      scope_events: [],
      loop: { loop_id: "loop-1", goal_hash: "a".repeat(64), sealed: true, action_count: 2 },
      settled: ["used the checkout fix"],
      open_questions: ["regression coverage?"],
      next_actions: ["ship"],
      mode: "verified_context"
    });
    expect(cont.loop_id).toBe("loop-1");
    expect(cont.goal_hash).toBe("a".repeat(64));
    expect(cont.scope_ref).toBe(original.scope_ref);
    expect(cont.inherits_from.scope_ref).toBe(original.scope_ref);
    expect(cont.sealed).toBe(true);
    expect(cont.action_count).toBe(2);
    expect(cont.settled).toEqual(["used the checkout fix"]);
    expect(cont.open_questions).toEqual(["regression coverage?"]);
    expect(cont.next_actions).toEqual(["ship"]);
  });

  it("records what changed for an amendment, with the final scope_ref and a structural diff", () => {
    const original = sealScopeCapsule({ capsule: capsule() });
    const amended = amendScope(original, capsule({ allowed_targets: ["/checkout/**", "/cart/**"] }));
    const cont = buildContinuationCapsule({
      scope_history: [original, amended],
      scope_events: [],
      loop: { loop_id: "loop-1", goal_hash: "a".repeat(64), sealed: true, action_count: 1 },
      mode: "verified_context"
    });
    expect(cont.scope_ref).toBe(amended.scope_ref);
    expect(cont.inherits_from.scope_ref).toBe(original.scope_ref);
    expect(cont.what_changed).toHaveLength(1);
    expect(cont.what_changed[0]!.from_scope_ref).toBe(original.scope_ref);
    expect(cont.what_changed[0]!.to_scope_ref).toBe(amended.scope_ref);
    expect(cont.what_changed[0]!.changed_fields).toContain("allowed_targets");
  });

  it("lists attested scope events by structural reference", () => {
    const original = sealScopeCapsule({ capsule: capsule() });
    const rec = createScopeEventRecorder();
    const event = rec.record({
      event_type: "scope_refusal",
      loop_id: "loop-1",
      scope_ref: original.scope_ref,
      attempted: { action_class: "write", tool_name: "write_file", target_descriptor: "sha256:" + "c".repeat(64) },
      matched_rule: "/billing/migrations/**",
      decision: "REFUSED",
      prior_receipt_id: "lrv2_0002"
    });
    const cont = buildContinuationCapsule({
      scope_history: [original],
      scope_events: [event],
      loop: { loop_id: "loop-1", goal_hash: "a".repeat(64), sealed: true, action_count: 1 },
      mode: "verified_context"
    });
    expect(cont.scope_events).toHaveLength(1);
    expect(cont.scope_events[0]).toMatchObject({
      event_hash: event.event_hash,
      decision: "REFUSED",
      prior_receipt_id: "lrv2_0002"
    });
  });

  it("Proof Mode projection strips the plaintext sidecar fields", () => {
    const original = sealScopeCapsule({ capsule: capsule() });
    const cont = buildContinuationCapsule({
      scope_history: [original],
      scope_events: [],
      loop: { loop_id: "loop-1", goal_hash: "a".repeat(64), sealed: true, action_count: 0 },
      settled: ["secret settled note"],
      mode: "verified_context"
    });
    const proof = projectContinuationProofMode(cont);
    expect(proof.settled).toBeUndefined();
    expect(JSON.stringify(proof)).not.toContain("secret settled note");
    // Structural core survives.
    expect(proof.scope_ref).toBe(original.scope_ref);
  });

  it("Proof Mode projection drops UNKNOWN extra keys (content-blind allowlist), not just the typed sidecar", () => {
    const original = sealScopeCapsule({ capsule: capsule() });
    const cont = buildContinuationCapsule({
      scope_history: [original],
      scope_events: [],
      loop: { loop_id: "loop-1", goal_hash: "a".repeat(64), sealed: true, action_count: 0 },
      mode: "verified_context"
    });
    // A JSON-loaded continuation smuggling arbitrary plaintext beyond the typed fields.
    const tainted = { ...cont, notes: "secret plan text", plan: ["leak step"] } as unknown as typeof cont;
    const proof = projectContinuationProofMode(tainted);
    expect(JSON.stringify(proof)).not.toContain("secret plan text");
    expect(JSON.stringify(proof)).not.toContain("leak step");
    expect((proof as Record<string, unknown>).notes).toBeUndefined();
    expect((proof as Record<string, unknown>).plan).toBeUndefined();
    expect(Object.keys(proof).sort()).toEqual(
      ["action_count", "capsule_type", "capsule_version", "closed_at", "goal_hash", "inherits_from", "loop_id", "scope_events", "scope_ref", "sealed", "what_changed"]
    );
  });

  it("carries the cross-loop edge from the ORIGINAL sealed scope; absent when undeclared", () => {
    const edge = {
      capsule_ref: "cap_v1:" + "1".repeat(64),
      scope_ref: "scope_v1:" + "2".repeat(64),
      final_turn_ref: "turn_v1:" + "3".repeat(64)
    };
    const original = sealScopeCapsule({ capsule: capsule({ inherits_loop: edge }) });
    // Amendment keeps the edge but widens targets — the continuation still reads the ORIGINAL's edge.
    const amended = amendScope(original, capsule({ inherits_loop: edge, allowed_targets: ["/checkout/**", "/cart/**"] }));
    const cont = buildContinuationCapsule({
      scope_history: [original, amended],
      scope_events: [],
      loop: { loop_id: "loop-1", goal_hash: "a".repeat(64), sealed: true, action_count: 1 },
      mode: "verified_context"
    });
    expect(cont.inherits_loop).toEqual(edge);
    // The intra-loop field is untouched by the edge.
    expect(cont.inherits_from.scope_ref).toBe(original.scope_ref);

    const noEdge = buildContinuationCapsule({
      scope_history: [sealScopeCapsule({ capsule: capsule() })],
      scope_events: [],
      loop: { loop_id: "loop-1", goal_hash: "a".repeat(64), sealed: true, action_count: 0 },
      mode: "verified_context"
    });
    expect(noEdge.inherits_loop).toBeUndefined();
  });

  it("Proof Mode projection RETAINS the edge (content-blind refs) and rebuilds the closed triple", () => {
    const edge = {
      capsule_ref: "cap_v1:" + "1".repeat(64),
      scope_ref: "scope_v1:" + "2".repeat(64),
      final_turn_ref: "turn_v1:" + "3".repeat(64)
    };
    const original = sealScopeCapsule({ capsule: capsule({ inherits_loop: edge }) });
    const cont = buildContinuationCapsule({
      scope_history: [original],
      scope_events: [],
      loop: { loop_id: "loop-1", goal_hash: "a".repeat(64), sealed: true, action_count: 0 },
      mode: "verified_context"
    });
    const proof = projectContinuationProofMode(cont);
    expect(proof.inherits_loop).toEqual(edge);
    // A JSON-loaded continuation smuggling a stray key INSIDE the edge: the projection rebuilds
    // the closed triple, so the stray never reaches a content-blind pack.
    const tainted = { ...cont, inherits_loop: { ...edge, notes: "secret prior plan" } } as unknown as typeof cont;
    const projected = projectContinuationProofMode(tainted);
    expect(projected.inherits_loop).toEqual(edge);
    expect(JSON.stringify(projected)).not.toContain("secret prior plan");
  });

  it("Proof Mode build omits sidecar fields from the start (mode=proof)", () => {
    const original = sealScopeCapsule({ capsule: capsule() });
    const cont = buildContinuationCapsule({
      scope_history: [original],
      scope_events: [],
      loop: { loop_id: "loop-1", goal_hash: "a".repeat(64), sealed: true, action_count: 0 },
      settled: ["should not appear"],
      mode: "proof"
    });
    expect(cont.settled).toBeUndefined();
  });
});
