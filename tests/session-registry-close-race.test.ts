import { describe, expect, it } from "vitest";

import type { BindRequest, BindResponse, LoopChainLink } from "../src/index.js";
import { LoopSessionRegistry, verifyLoopChain } from "../src/index.js";

// CHARACTERIZATION TESTS — explicit supervisor close vs SIGTERM fail-safe seal.
//
// These LOCK the existing first-writer-wins behavior of the registry; they are NOT
// red-green tests. Current code is already correct at the registry seam:
//   - closeLoop registers an in-flight claim SYNCHRONOUSLY before the first await, so an
//     explicit close racing the SIGTERM closeAll sweep coalesces onto one terminal;
//   - a sealed session is deleted, so a closeAll sweep that runs AFTER an explicit close
//     never re-sees it (skip-already-sealed by construction);
//   - closeAll only iterates activeSessionIds().
// Together these give: explicit close is authoritative for terminal outcome semantics,
// SIGTERM is the fail-safe seal, exactly one terminal receipt, no open-loop leak.
//
// MEANINGFULNESS (per WS-C): test 1 below would catch removal of the coalesce/delete-on-seal
// logic — drop either and the SIGTERM sweep would emit a SECOND terminal loop_close (two
// terminals → verifyLoopChain rejects the chain, and closeBinds length becomes 2). It does
// NOT red on current code, which is correct.

type BindRecord = { request: BindRequest; response: BindResponse };

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

function closeBindsFor(records: BindRecord[], loopId: string): BindRecord[] {
  return records.filter(({ request }) => {
    const close = request.constraints?.loop_close as { loop_id?: string } | undefined;
    return request.action_type === "loop_close" && close?.loop_id === loopId;
  });
}

function terminalOf(records: BindRecord[], loopId: string): {
  outcome: string;
  termination_reason: string;
} {
  const closes = closeBindsFor(records, loopId);
  const close = closes[0]!.request.constraints?.loop_close as {
    outcome: string;
    termination_reason: string;
  };
  return { outcome: close.outcome, termination_reason: close.termination_reason };
}

const TUNING = { graceMs: 200, retryDelayMs: 5 };

describe("explicit close vs SIGTERM fail-safe (characterization — existing registry behavior)", () => {
  // 1. Explicit close seals, THEN SIGTERM fires. The explicit close is authoritative.
  it("explicit close is authoritative; a later SIGTERM sweep emits no second terminal", async () => {
    const { bind, records } = recordingBind();
    const registry = new LoopSessionRegistry(bind, TUNING);
    registry.openLoop({ session_id: "s1", loop_id: "loop_s1", goal: "ship it" });
    const session = registry.get("s1")!;
    await session.bindToolCall(toolCallRequest("a"), bind);
    await session.bindToolCall(toolCallRequest("b"), bind);

    // Explicit supervisor close with a DISTINCT reason so we can prove which writer won.
    const explicit = await registry.closeLoop({
      session_id: "s1",
      outcome: "COMPLETED",
      reason: "explicit_authoritative"
    });
    expect(explicit.sealed).toBe(true);
    expect(registry.size).toBe(0); // sealed → deleted

    // SIGTERM fail-safe sweep AFTER the explicit close. The sealed session is gone, so the
    // sweep does not re-seal it — no second terminal.
    const sweep = await registry.closeAll("SIGTERM");
    expect(sweep.has("s1")).toBe(false);

    // Exactly one terminal receipt, and it carries the EXPLICIT outcome/reason — not SIGTERM.
    expect(closeBindsFor(records, "loop_s1")).toHaveLength(1);
    expect(terminalOf(records, "loop_s1")).toEqual({
      outcome: "COMPLETED",
      termination_reason: "explicit_authoritative"
    });

    // The chain verifies cold with a single terminal.
    expect(verifyLoopChain(reconstructLinks(records, "loop_s1"))).toEqual({
      valid: true,
      sealed: true,
      loop_id: "loop_s1",
      action_count: 2
    });
  });

  // 2. No explicit close (crash / abrupt agent exit), THEN SIGTERM. The fail-safe seals it.
  it("an un-closed loop is sealed fail-safe by the SIGTERM sweep, with no leak or duplicate", async () => {
    const { bind, records } = recordingBind();
    const registry = new LoopSessionRegistry(bind, TUNING);
    registry.openLoop({ session_id: "s2", loop_id: "loop_s2", goal: "do work" });
    const session = registry.get("s2")!;
    await session.bindToolCall(toolCallRequest("a"), bind);
    await session.bindToolCall(toolCallRequest("b"), bind);
    // No explicit close: the supervisor never sent `close`.

    const sweep = await registry.closeAll("SIGTERM");
    const result = sweep.get("s2");
    expect(result?.sealed).toBe(true);

    // No open-loop leak: the session is gone after the fail-safe seal.
    expect(registry.size).toBe(0);
    // Exactly one terminal, carrying the SIGTERM reason (the fail-safe is the only writer).
    expect(closeBindsFor(records, "loop_s2")).toHaveLength(1);
    expect(terminalOf(records, "loop_s2").termination_reason).toBe("SIGTERM");
    expect(verifyLoopChain(reconstructLinks(records, "loop_s2"))).toEqual({
      valid: true,
      sealed: true,
      loop_id: "loop_s2",
      action_count: 2
    });
  });

  // 3. Explicit FAILED outcome flows faithfully into the terminal receipt.
  it("an explicit FAILED close writes FAILED faithfully into the terminal receipt", async () => {
    const { bind, records } = recordingBind();
    const registry = new LoopSessionRegistry(bind, TUNING);
    registry.openLoop({ session_id: "s3", loop_id: "loop_s3", goal: "attempt" });
    const session = registry.get("s3")!;
    await session.bindToolCall(toolCallRequest("a"), bind);

    const result = await registry.closeLoop({
      session_id: "s3",
      outcome: "FAILED",
      reason: "agent_error"
    });
    expect(result.sealed).toBe(true);

    // The terminal receipt faithfully carries the FAILED outcome — no silent rewrite to COMPLETED.
    expect(terminalOf(records, "loop_s3")).toEqual({
      outcome: "FAILED",
      termination_reason: "agent_error"
    });
    // A FAILED-outcome chain is still a SEALED chain (sealed-ness is independent of outcome).
    expect(verifyLoopChain(reconstructLinks(records, "loop_s3"))).toEqual({
      valid: true,
      sealed: true,
      loop_id: "loop_s3",
      action_count: 1
    });
  });
});
