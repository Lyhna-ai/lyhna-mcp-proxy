import { describe, expect, it } from "vitest";

import {
  createScopeEventRecorder,
  deriveScopeEventHash,
  projectScopeEvent,
  type RecordScopeEventInput
} from "../src/index.js";

function refusal(overrides: Partial<RecordScopeEventInput> = {}): RecordScopeEventInput {
  return {
    event_type: "scope_refusal",
    loop_id: "loop-1",
    scope_ref: "scope_v1:" + "a".repeat(64),
    attempted: {
      action_class: "write",
      tool_name: "write_file",
      target_descriptor: "sha256:" + "c".repeat(64),
      target: "/billing/migrations/2026_ledger.sql"
    },
    matched_rule: "/billing/migrations/**",
    decision: "REFUSED",
    prior_receipt_id: "lrv2_0003",
    ts: "2026-06-08T00:00:00.000Z",
    ...overrides
  };
}

describe("createScopeEventRecorder", () => {
  it("records and dumps events keyed by loop_id, anchored to the prior receipt", () => {
    const rec = createScopeEventRecorder();
    const e = rec.record(refusal());
    expect(e.event_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(e.prior_receipt_id).toBe("lrv2_0003");

    const dumped = rec.scopeEventsForLoop("loop-1");
    expect(dumped).toHaveLength(1);
    expect(rec.scopeEventsForLoop("other")).toEqual([]);
    expect(rec.knownLoopIds()).toEqual(["loop-1"]);
  });

  it("event_hash is content-blind: identical whether or not the plaintext target is present", () => {
    const withTarget = deriveScopeEventHash({
      event_type: "scope_refusal",
      loop_id: "loop-1",
      scope_ref: "scope_v1:" + "a".repeat(64),
      attempted: { action_class: "write", tool_name: "write_file", target_descriptor: "sha256:" + "c".repeat(64), target: "/secret/path" },
      matched_rule: "/billing/migrations/**",
      decision: "REFUSED",
      prior_receipt_id: "lrv2_0003",
      ts: "2026-06-08T00:00:00.000Z"
    });
    const withoutTarget = deriveScopeEventHash({
      event_type: "scope_refusal",
      loop_id: "loop-1",
      scope_ref: "scope_v1:" + "a".repeat(64),
      attempted: { action_class: "write", tool_name: "write_file", target_descriptor: "sha256:" + "c".repeat(64) },
      matched_rule: "/billing/migrations/**",
      decision: "REFUSED",
      prior_receipt_id: "lrv2_0003",
      ts: "2026-06-08T00:00:00.000Z"
    });
    expect(withTarget).toBe(withoutTarget);
  });

  it("projectScopeEvent strips plaintext target in Proof Mode, retains it in Verified Context Mode", () => {
    const rec = createScopeEventRecorder();
    const e = rec.record(refusal());
    const proof = projectScopeEvent(e, "proof");
    expect(proof.attempted.target).toBeUndefined();
    expect(proof.attempted.target_descriptor).toBe(e.attempted.target_descriptor);
    expect(proof.event_hash).toBe(e.event_hash);

    const vcm = projectScopeEvent(e, "verified_context");
    expect(vcm.attempted.target).toBe("/billing/migrations/2026_ledger.sql");
  });
});
