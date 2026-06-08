import { describe, expect, it } from "vitest";

import {
  amendScope,
  assertScopeStructuralContentBlind,
  checkScopeStructural,
  deriveScopeRef,
  globToRegExp,
  projectScopeCapsuleForExport,
  sealScopeCapsule,
  SCOPE_CAPSULE_VERSION,
  type ScopeCapsule,
  type ScopeStructuralProjection
} from "../src/index.js";

function structural(overrides: Partial<ScopeStructuralProjection> = {}): ScopeStructuralProjection {
  return {
    capsule_type: "scope_capsule",
    capsule_version: SCOPE_CAPSULE_VERSION,
    loop_id: "loop-1",
    goal_hash: "a".repeat(64),
    privacy_mode: "verified_context",
    allowed_action_classes: ["read", "write", "run_tests"],
    allowed_targets: ["/checkout/**", "/payments/types.ts"],
    forbidden_targets: ["/billing/migrations/**"],
    ...overrides
  };
}

function capsule(overrides: Partial<ScopeStructuralProjection> = {}): ScopeCapsule {
  return { structural: structural(overrides), sidecar: { goal_summary: "fix checkout bug" } };
}

describe("sealScopeCapsule", () => {
  it("derives a deterministic scope_ref over the structural projection only", () => {
    const a = sealScopeCapsule({ capsule: capsule() });
    const b = sealScopeCapsule({ capsule: capsule() });
    expect(a.scope_ref).toBe(b.scope_ref);
    expect(a.scope_ref).toMatch(/^scope_v1:[0-9a-f]{64}$/);
    expect(a.scope_ref).toBe(deriveScopeRef(structural()));
  });

  it("scope_ref ignores the sidecar (content-blind); a sidecar-only change does not move it", () => {
    const a = sealScopeCapsule({ capsule: { structural: structural() } });
    const b = sealScopeCapsule({
      capsule: { structural: structural(), sidecar: { goal_summary: "totally different note" } }
    });
    expect(a.scope_ref).toBe(b.scope_ref);
    expect(a.sidecar_hash).toBeNull();
    expect(b.sidecar_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("a structural change DOES move scope_ref", () => {
    const a = sealScopeCapsule({ capsule: capsule() });
    const b = sealScopeCapsule({ capsule: capsule({ forbidden_targets: ["/secrets/**"] }) });
    expect(a.scope_ref).not.toBe(b.scope_ref);
  });

  it("rejects a structural projection carrying a plaintext plan field (fail closed)", () => {
    const leaky = structural() as unknown as Record<string, unknown>;
    leaky.planned_steps = ["do a thing"];
    expect(() => assertScopeStructuralContentBlind(leaky as ScopeStructuralProjection)).toThrow(/content-blind/);
    expect(() => sealScopeCapsule({ capsule: { structural: leaky as ScopeStructuralProjection } })).toThrow();
  });
});

describe("amendScope", () => {
  it("chains a new sealed scope_ref to the prior", () => {
    const original = sealScopeCapsule({ capsule: capsule() });
    const amended = amendScope(original, capsule({ allowed_targets: ["/checkout/**", "/cart/**"] }));
    expect(amended.prior_scope_ref).toBe(original.scope_ref);
    expect(amended.scope_ref).not.toBe(original.scope_ref);
  });
});

describe("globToRegExp", () => {
  it("matches ** across path segments and * within a segment", () => {
    expect(globToRegExp("/checkout/**").test("/checkout/cart/index.ts")).toBe(true);
    expect(globToRegExp("/checkout/**").test("/checkout")).toBe(true);
    expect(globToRegExp("/payments/types.ts").test("/payments/types.ts")).toBe(true);
    expect(globToRegExp("/payments/*.ts").test("/payments/types.ts")).toBe(true);
    expect(globToRegExp("/payments/*.ts").test("/payments/nested/types.ts")).toBe(false);
  });
});

describe("checkScopeStructural — Verified Context Mode", () => {
  const sealed = sealScopeCapsule({ capsule: capsule() });

  it("passes an in-lane write to an allowed target and stamps a hashed descriptor (never plaintext)", () => {
    const d = checkScopeStructural(
      { toolName: "write_file", arguments: { path: "/checkout/cart.ts" } },
      sealed,
      { mode: "verified_context" }
    );
    expect(d.decision).toBe("IN_SCOPE");
    expect(d.descriptor.action_class).toBe("write");
    expect(d.descriptor.target_descriptor).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The plaintext target is available to the gate (for the sidecar event) but is NOT the
    // stamped descriptor.
    expect(d.target_plaintext).toBe("/checkout/cart.ts");
    expect(d.descriptor.target_descriptor).not.toContain("/checkout");
  });

  it("REFUSES a write to a forbidden target before execution", () => {
    const d = checkScopeStructural(
      { toolName: "write_file", arguments: { path: "/billing/migrations/2026_ledger.sql" } },
      sealed,
      { mode: "verified_context" }
    );
    expect(d.decision).toBe("REFUSED");
    expect(d.matched_rule).toBe("/billing/migrations/**");
  });

  it("REFUSES a target outside the allowed set", () => {
    const d = checkScopeStructural(
      { toolName: "write_file", arguments: { path: "/unrelated/file.ts" } },
      sealed,
      { mode: "verified_context" }
    );
    expect(d.decision).toBe("REFUSED");
    expect(d.matched_rule).toBe("allowed_targets");
  });

  it("REFUSES a tool outside allowed_tools", () => {
    const scoped = sealScopeCapsule({ capsule: capsule({ allowed_tools: ["write_file", "run_tests"] }) });
    const d = checkScopeStructural(
      { toolName: "exfiltrate", arguments: {} },
      scoped,
      { mode: "verified_context" }
    );
    expect(d.decision).toBe("REFUSED");
    expect(d.matched_rule).toBe("allowed_tools");
  });
});

describe("checkScopeStructural — Verified Context Mode fail-closed on unresolved target (P1)", () => {
  it("REFUSES a target-bearing call whose target cannot be resolved when target rules are declared", () => {
    const sealed = sealScopeCapsule({ capsule: capsule() });
    // write_file carries its argument under an unrecognized key — no target resolves.
    const d = checkScopeStructural(
      { toolName: "write_file", arguments: { command: "rm -rf /billing" } },
      sealed,
      { mode: "verified_context" }
    );
    expect(d.decision).toBe("REFUSED");
    expect(d.matched_rule).toBe("unresolved_target");
  });

  it("allows an action class the capsule explicitly declares targetless", () => {
    const sealed = sealScopeCapsule({ capsule: capsule({ targetless_action_classes: ["run_tests"] }) });
    const d = checkScopeStructural(
      { toolName: "run_tests", arguments: { suite: "checkout" } },
      sealed,
      { mode: "verified_context" }
    );
    expect(d.decision).toBe("IN_SCOPE");
  });

  it("resolves a target from a capsule-declared target_arg_key and applies forbidden/allowed rules", () => {
    // write_file derives to the allowed "write" class; the target lives under a declared key.
    const sealed = sealScopeCapsule({ capsule: capsule({ target_arg_keys: ["command"] }) });
    expect(
      checkScopeStructural({ toolName: "write_file", arguments: { command: "/checkout/build.ts" } }, sealed, {
        mode: "verified_context"
      }).decision
    ).toBe("IN_SCOPE");
    expect(
      checkScopeStructural({ toolName: "write_file", arguments: { command: "/billing/migrations/x.sql" } }, sealed, {
        mode: "verified_context"
      }).decision
    ).toBe("REFUSED");
  });

  it("does not require a target when the capsule declares no target rules", () => {
    const sealed = sealScopeCapsule({
      capsule: {
        structural: structural({
          allowed_action_classes: undefined,
          allowed_targets: undefined,
          forbidden_targets: undefined
        })
      }
    });
    const d = checkScopeStructural({ toolName: "ping", arguments: {} }, sealed, { mode: "verified_context" });
    expect(d.decision).toBe("IN_SCOPE");
  });
});

describe("checkScopeStructural — Proof Mode (content-blind)", () => {
  it("does not read a plaintext target; degrades to descriptor-hash membership", () => {
    const hash = "sha256:" + "b".repeat(64);
    const sealed = sealScopeCapsule({
      capsule: { structural: structural({ privacy_mode: "proof", target_descriptor_hashes: [hash] }) }
    });
    const refused = checkScopeStructural(
      { toolName: "write_file", arguments: { path: "/billing/migrations/x.sql" } },
      sealed,
      { mode: "proof" }
    );
    // Proof Mode never reads the plaintext path; with a required descriptor hash absent, it refuses.
    expect(refused.decision).toBe("REFUSED");
    expect(refused.target_plaintext).toBeUndefined();

    const passed = checkScopeStructural(
      { toolName: "write_file", arguments: { target_descriptor: hash } },
      sealed,
      { mode: "proof" }
    );
    expect(passed.decision).toBe("IN_SCOPE");
    expect(passed.target_plaintext).toBeUndefined();
  });

  it("FAILS CLOSED when target rules are declared but no descriptor hashes back them (P1 round 2)", () => {
    // Proof Mode cannot evaluate plaintext globs; without target_descriptor_hashes it must refuse.
    const sealed = sealScopeCapsule({
      capsule: { structural: structural({ privacy_mode: "proof", target_descriptor_hashes: undefined }) }
    });
    const d = checkScopeStructural(
      { toolName: "write_file", arguments: { path: "/anywhere.ts" } },
      sealed,
      { mode: "proof" }
    );
    expect(d.decision).toBe("REFUSED");
    expect(d.matched_rule).toBe("proof_mode_target_unenforceable");
  });

  it("a declared targetless action class is exempt from the Proof Mode target requirement", () => {
    const sealed = sealScopeCapsule({
      capsule: {
        structural: structural({
          privacy_mode: "proof",
          target_descriptor_hashes: undefined,
          allowed_action_classes: ["run_tests"],
          targetless_action_classes: ["run_tests"]
        })
      }
    });
    const d = checkScopeStructural({ toolName: "run_tests", arguments: {} }, sealed, { mode: "proof" });
    expect(d.decision).toBe("IN_SCOPE");
  });
});

describe("projectScopeCapsuleForExport", () => {
  it("Proof Mode export is structural-only (no sidecar)", () => {
    const sealed = sealScopeCapsule({ capsule: capsule() });
    const exported = projectScopeCapsuleForExport(sealed, "proof");
    expect(exported.sidecar).toBeUndefined();
    expect(exported.structural).toBeDefined();
  });

  it("Verified Context Mode export carries the plaintext sidecar", () => {
    const sealed = sealScopeCapsule({ capsule: capsule() });
    const exported = projectScopeCapsuleForExport(sealed, "verified_context");
    expect(exported.sidecar?.goal_summary).toBe("fix checkout bug");
  });
});
