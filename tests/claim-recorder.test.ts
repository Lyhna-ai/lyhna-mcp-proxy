import { describe, expect, it } from "vitest";

import { createClaimRecorder } from "../src/claim-recorder.js";

describe("claim-recorder", () => {
  it("appends claims per loop with contiguous claim_index", () => {
    const rec = createClaimRecorder();
    const a = rec.record({ loop_id: "L1", system: "gmail", action: "send", result: "sent it", user_facing: true });
    const b = rec.record({ loop_id: "L1", system: "google_drive", action: "create_file" });
    expect(a.claim_index).toBe(0);
    expect(b.claim_index).toBe(1);
    expect(rec.claimsForLoop("L1")).toHaveLength(2);
    expect(rec.knownLoopIds()).toEqual(["L1"]);
  });

  it("isolates claims by loop_id", () => {
    const rec = createClaimRecorder();
    rec.record({ loop_id: "L1", system: "gmail" });
    rec.record({ loop_id: "L2", system: "slack" });
    expect(rec.claimsForLoop("L1")).toHaveLength(1);
    expect(rec.claimsForLoop("L2")).toHaveLength(1);
    expect(rec.claimsForLoop("L1")[0]!.system).toBe("gmail");
    expect(new Set(rec.knownLoopIds())).toEqual(new Set(["L1", "L2"]));
  });

  it("trims fields and drops blanks; preserves a real boolean user_facing", () => {
    const rec = createClaimRecorder();
    const c = rec.record({ loop_id: "L1", system: "  gmail  ", action: " send ", result: "  ", via: "", user_facing: true });
    expect(c.system).toBe("gmail");
    expect(c.action).toBe("send");
    expect(c.result).toBeUndefined();
    expect(c.via).toBeUndefined();
    expect(c.user_facing).toBe(true);
  });

  it("fails closed on a non-boolean user_facing instead of coercing it", () => {
    const rec = createClaimRecorder();
    // Untyped MCP/tool JSON: these must NOT be silently coerced (e.g. "false" → true).
    for (const bad of ["false", "0", 1, 0, {}]) {
      expect(() => rec.record({ loop_id: "L1", system: "gmail", user_facing: bad as unknown as boolean })).toThrow(/user_facing/);
    }
    // absent/null is allowed and recorded as unset (not false).
    expect(rec.record({ loop_id: "L1", system: "gmail" }).user_facing).toBeUndefined();
    expect(rec.record({ loop_id: "L1", system: "gmail", user_facing: null as unknown as boolean }).user_facing).toBeUndefined();
  });

  it("preserves an explicit turn_ref for correlation", () => {
    const rec = createClaimRecorder();
    const c = rec.record({ loop_id: "L1", system: "gmail", turn_ref: "turn:abc" });
    expect(c.turn_ref).toBe("turn:abc");
  });

  it("fails closed on a missing loop_id or blank system", () => {
    const rec = createClaimRecorder();
    expect(() => rec.record({ loop_id: "", system: "gmail" })).toThrow(/loop_id/);
    expect(() => rec.record({ loop_id: "L1", system: "   " })).toThrow(/system/);
  });

  it("returns a copy of the array so callers cannot mutate recorded order", () => {
    const rec = createClaimRecorder();
    rec.record({ loop_id: "L1", system: "gmail" });
    const snapshot = rec.claimsForLoop("L1");
    snapshot.push({ loop_id: "L1", claim_index: 99, system: "forged" });
    expect(rec.claimsForLoop("L1")).toHaveLength(1);
  });
});
