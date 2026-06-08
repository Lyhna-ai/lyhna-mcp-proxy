import { describe, expect, it } from "vitest";

import type { BindRequest, BindResponse, LoopChainLink, ScopeCapsule } from "../src/index.js";
import { createScopeEventRecorder, LoopSessionRegistry, verifyLoopChain } from "../src/index.js";

type BindRecord = { request: BindRequest; response: BindResponse };

// A synthetic bind that records every (request, response) and mints unique receipt ids,
// so a chain can be reconstructed COLD from emitted receipts alone — exactly what an
// independent verifier sees. No live bind, no hosted contract.
function recordingBind(): { bind: (r: BindRequest) => Promise<BindResponse>; records: BindRecord[] } {
  let n = 0;
  const records: BindRecord[] = [];
  return {
    records,
    bind: async (request) => {
      n += 1;
      const response: BindResponse = {
        outcome: "APPROVED",
        receipt_id: `rcpt_${n}`,
        signature: `sig_${n}`
      };
      records.push({ request, response });
      return response;
    }
  };
}

function toolCallRequest(query: string): BindRequest {
  return {
    action_type: "repo.search",
    action_payload: { tool_name: "repo.search", arguments: { query } },
    intent: "mcp:repo.search",
    intent_version: "1.0"
  };
}

// Cold reconstruction: from the flat record of binds, pull the links belonging to one
// loop_id (in chain order) and shape them the way the canonical verifier expects.
function reconstructLinks(records: BindRecord[], loopId: string): LoopChainLink[] {
  return records
    .filter(({ request }) => {
      const loop = request.constraints?.loop as { loop_id?: string } | undefined;
      const close = request.constraints?.loop_close as { loop_id?: string } | undefined;
      return loop?.loop_id === loopId || close?.loop_id === loopId;
    })
    .map(({ request, response }) => ({
      receipt_id: response.receipt_id,
      loop: (request.constraints?.loop as LoopChainLink["loop"]) ?? null,
      loop_close: (request.constraints?.loop_close as LoopChainLink["loop_close"]) ?? null
    }));
}

const TUNING = { graceMs: 200, retryDelayMs: 5 };

describe("LoopSessionRegistry lifecycle", () => {
  it("opens a loop, advances its chain, seals it, and the sealed chain verifies COLD", async () => {
    const { bind, records } = recordingBind();
    const registry = new LoopSessionRegistry(bind, TUNING);

    const session = registry.openLoop({ session_id: "s1", loop_id: "loop_s1", goal: "ship it" });
    expect(registry.size).toBe(1);

    await session.bindToolCall(toolCallRequest("a"), bind);
    await session.bindToolCall(toolCallRequest("b"), bind);
    await session.bindToolCall(toolCallRequest("c"), bind);
    expect(session.actionCount).toBe(3);

    const result = await registry.closeLoop({ session_id: "s1", outcome: "COMPLETED", reason: "task_done" });
    expect(result.sealed).toBe(true);
    // Sealed sessions are removed so any later agent call fails closed.
    expect(registry.get("s1")).toBeUndefined();
    expect(registry.size).toBe(0);

    const cold = verifyLoopChain(reconstructLinks(records, "loop_s1"));
    expect(cold).toEqual({ valid: true, sealed: true, loop_id: "loop_s1", action_count: 3 });
  });

  it("runs multiple concurrent sessions with fully independent chains (no cross-contamination)", async () => {
    const { bind, records } = recordingBind();
    const registry = new LoopSessionRegistry(bind, TUNING);

    const a = registry.openLoop({ session_id: "A", loop_id: "loop_A", goal: "goal A" });
    const b = registry.openLoop({ session_id: "B", loop_id: "loop_B", goal: "goal B" });
    const c = registry.openLoop({ session_id: "C", loop_id: "loop_C", goal: "goal C" });
    expect(registry.size).toBe(3);

    // Interleave calls across all three sessions concurrently.
    await Promise.all([
      a.bindToolCall(toolCallRequest("a1"), bind),
      b.bindToolCall(toolCallRequest("b1"), bind),
      c.bindToolCall(toolCallRequest("c1"), bind),
      a.bindToolCall(toolCallRequest("a2"), bind),
      b.bindToolCall(toolCallRequest("b2"), bind)
    ]);

    await registry.closeLoop({ session_id: "A", outcome: "COMPLETED", reason: "done" });
    await registry.closeLoop({ session_id: "B", outcome: "COMPLETED", reason: "done" });
    await registry.closeLoop({ session_id: "C", outcome: "COMPLETED", reason: "done" });

    // Each chain verifies cold on its own, with its own action count.
    expect(verifyLoopChain(reconstructLinks(records, "loop_A"))).toMatchObject({
      valid: true,
      sealed: true,
      action_count: 2
    });
    expect(verifyLoopChain(reconstructLinks(records, "loop_B"))).toMatchObject({
      valid: true,
      sealed: true,
      action_count: 2
    });
    expect(verifyLoopChain(reconstructLinks(records, "loop_C"))).toMatchObject({
      valid: true,
      sealed: true,
      action_count: 1
    });

    // No prior_receipt_id from one loop ever references another loop's receipts.
    const aReceipts = new Set(reconstructLinks(records, "loop_A").map((l) => l.receipt_id));
    for (const link of reconstructLinks(records, "loop_B")) {
      const prior = link.loop?.prior_receipt_id ?? link.loop_close?.prior_receipt_id ?? null;
      if (prior !== null) {
        expect(aReceipts.has(prior)).toBe(false);
      }
    }
  });

  it("refuses to open a duplicate session (fail closed, no silent orphaning)", () => {
    const { bind } = recordingBind();
    const registry = new LoopSessionRegistry(bind, TUNING);
    registry.openLoop({ session_id: "dup", loop_id: "loop_dup", goal: "g" });
    expect(() => registry.openLoop({ session_id: "dup", loop_id: "loop_dup2", goal: "g2" })).toThrow(
      /already open/
    );
  });

  it("rejects reusing a loop_id — concurrently and after close — so recorded chains can't merge", async () => {
    const { bind } = recordingBind();
    const registry = new LoopSessionRegistry(bind, TUNING);
    registry.openLoop({ session_id: "s1", loop_id: "loop_shared", goal: "g" });

    // A second, distinct session may NOT reuse an active loop_id (would interleave in the
    // recorder's single loop_id bucket).
    expect(() => registry.openLoop({ session_id: "s2", loop_id: "loop_shared", goal: "g" })).toThrow(
      /loop_id|already used/i
    );

    // And not after close either: the recorder retains receipts past close, so a reused
    // loop_id would append a new chain onto the old bucket. loop_id is single-use per process.
    await registry.closeLoop({ session_id: "s1", outcome: "COMPLETED", reason: "done" });
    expect(registry.size).toBe(0);
    expect(() => registry.openLoop({ session_id: "s3", loop_id: "loop_shared", goal: "g" })).toThrow(
      /loop_id|already used/i
    );
  });

  it("rejects open with missing identity fields", () => {
    const { bind } = recordingBind();
    const registry = new LoopSessionRegistry(bind, TUNING);
    expect(() => registry.openLoop({ session_id: "", loop_id: "l", goal: "g" })).toThrow(/session_id/);
    expect(() => registry.openLoop({ session_id: "s", loop_id: "", goal: "g" })).toThrow(/loop_id/);
    expect(() => registry.openLoop({ session_id: "s", loop_id: "l", goal: "" })).toThrow(/goal/);
  });

  it("coalesces concurrent closes for one session into a single terminal loop_close", async () => {
    const { bind, records } = recordingBind();
    const registry = new LoopSessionRegistry(bind, TUNING);
    const session = registry.openLoop({ session_id: "race", loop_id: "loop_race", goal: "g" });
    await session.bindToolCall(toolCallRequest("a"), bind);

    // Two overlapping closes (e.g. a supervisor retry sending two `close` lines).
    const [r1, r2] = await Promise.all([
      registry.closeLoop({ session_id: "race", outcome: "COMPLETED", reason: "first" }),
      registry.closeLoop({ session_id: "race", outcome: "COMPLETED", reason: "second" })
    ]);

    expect(r1.sealed).toBe(true);
    expect(r2.sealed).toBe(true);
    // Both coalesced onto the SAME close — identical terminal receipt.
    if (r1.sealed && r2.sealed) {
      expect(r1.receipt.receipt_id).toBe(r2.receipt.receipt_id);
    }

    // Exactly one terminal close bind was emitted.
    const closeBinds = records.filter(({ request }) => request.action_type === "loop_close");
    expect(closeBinds).toHaveLength(1);
    expect(registry.size).toBe(0);

    // The reconstructed chain has a single terminal and verifies cold.
    expect(verifyLoopChain(reconstructLinks(records, "loop_race"))).toEqual({
      valid: true,
      sealed: true,
      loop_id: "loop_race",
      action_count: 1
    });
  });

  it("coalesces a control close racing the closeAll sweep into a single terminal", async () => {
    const { bind, records } = recordingBind();
    const registry = new LoopSessionRegistry(bind, TUNING);
    const session = registry.openLoop({ session_id: "sweep", loop_id: "loop_sweep", goal: "g" });
    await session.bindToolCall(toolCallRequest("a"), bind);

    // A direct control close racing the SIGTERM sweep over the same session.
    await Promise.all([
      registry.closeLoop({ session_id: "sweep", outcome: "COMPLETED", reason: "control" }),
      registry.closeAll("SIGTERM")
    ]);

    const closeBinds = records.filter(({ request }) => request.action_type === "loop_close");
    expect(closeBinds).toHaveLength(1);
    expect(registry.size).toBe(0);
    expect(verifyLoopChain(reconstructLinks(records, "loop_sweep"))).toMatchObject({
      valid: true,
      sealed: true,
      action_count: 1
    });
  });

  it("throws when closing an unknown session", async () => {
    const { bind } = recordingBind();
    const registry = new LoopSessionRegistry(bind, TUNING);
    await expect(
      registry.closeLoop({ session_id: "nope", outcome: "COMPLETED", reason: "x" })
    ).rejects.toThrow(/No open loop/);
  });

  it("closeAll seals every open loop", async () => {
    const { bind, records } = recordingBind();
    const registry = new LoopSessionRegistry(bind, TUNING);
    registry.openLoop({ session_id: "x", loop_id: "loop_x", goal: "gx" });
    registry.openLoop({ session_id: "y", loop_id: "loop_y", goal: "gy" });

    const results = await registry.closeAll("SIGTERM");
    expect([...results.values()].every((r) => r.sealed)).toBe(true);
    expect(registry.size).toBe(0);
    expect(verifyLoopChain(reconstructLinks(records, "loop_x"))).toMatchObject({ valid: true, sealed: true });
    expect(verifyLoopChain(reconstructLinks(records, "loop_y"))).toMatchObject({ valid: true, sealed: true });
  });
});

const SCOPE_CAPSULE: ScopeCapsule = {
  structural: {
    capsule_type: "scope_capsule",
    capsule_version: "scope-capsule/v1",
    loop_id: "loop_scoped",
    goal_hash: "",
    privacy_mode: "verified_context",
    allowed_targets: ["/checkout/**"]
  }
};

describe("LoopSessionRegistry scope (Capsule Gate 1)", () => {
  it("fails closed: opening a scoped loop without a scope-event recorder is rejected (P2)", () => {
    const { bind } = recordingBind();
    const registry = new LoopSessionRegistry(bind, TUNING); // no scope-event recorder
    expect(() =>
      registry.openLoop({ session_id: "s1", loop_id: "loop_scoped", goal: "g", scope_capsule: SCOPE_CAPSULE })
    ).toThrow(/scope-event recorder/);
    // A non-scoped open on the same recorder-less registry is unaffected.
    expect(() => registry.openLoop({ session_id: "s2", loop_id: "loop_plain", goal: "g" })).not.toThrow();
  });

  it("with a recorder, a scoped loop opens and getScope returns an engaged gate context", () => {
    const { bind } = recordingBind();
    const registry = new LoopSessionRegistry(bind, TUNING, createScopeEventRecorder());
    registry.openLoop({ session_id: "s1", loop_id: "loop_scoped", goal: "g", scope_capsule: SCOPE_CAPSULE });
    const scope = registry.getScope("s1");
    expect(scope?.mode).toBe("verified_context");
    expect(scope?.sealed.scope_ref).toMatch(/^scope_v1:/);
    expect(scope?.recorder).toBeDefined();
  });
});
