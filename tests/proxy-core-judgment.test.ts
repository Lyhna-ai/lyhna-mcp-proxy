import { describe, expect, it } from "vitest";

import {
  createJudgmentRecorder,
  createLoopContext,
  createProxyCore,
  createScopeEventRecorder,
  LoopSession,
  sealScopeCapsule,
  validateJudgmentChain,
  type BindClient,
  type BindOutcome,
  type BindRequest,
  type McpToolCall,
  type ScopeCapsule,
  type ScopeStructuralProjection,
  type UpstreamMcpClient
} from "../src/index.js";

function upstream(): UpstreamMcpClient & { calls: McpToolCall[] } {
  const calls: McpToolCall[] = [];
  return {
    calls,
    async listTools() {
      return [{ name: "write_file" }];
    },
    async callTool(call) {
      calls.push(call);
      return { ok: true, echoed: call.toolName };
    }
  };
}

/** Bind whose outcome is chosen per-call by a queue (defaults APPROVED), recording requests. */
function scriptedBind(outcomes: BindOutcome[] = []): BindClient & { requests: BindRequest[] } {
  const requests: BindRequest[] = [];
  let i = 0;
  return {
    requests,
    async bind(request) {
      requests.push(request);
      const outcome = outcomes[i++] ?? "APPROVED";
      return { outcome, receipt_id: `r_${requests.length}`, signature: "sig" };
    }
  };
}

const capsuleStructural = {
  capsule_type: "scope_capsule" as const,
  capsule_version: "scope-capsule/v1",
  loop_id: "loop-1",
  goal_hash: "a".repeat(64),
  privacy_mode: "verified_context" as const,
  allowed_action_classes: ["read", "write", "run_tests"],
  allowed_targets: ["/checkout/**", "/payments/types.ts"],
  forbidden_targets: ["/billing/migrations/**"],
  targetless_action_classes: ["run_tests"]
};

function harness(opts: { outcomes?: BindOutcome[]; structuralOverride?: Partial<ScopeStructuralProjection> } = {}) {
  const up = upstream();
  const bind = scriptedBind(opts.outcomes);
  const scopeRecorder = createScopeEventRecorder();
  const judgment = createJudgmentRecorder();
  const capsule: ScopeCapsule = {
    structural: { ...capsuleStructural, ...opts.structuralOverride },
    sidecar: { goal_summary: "fix checkout bug" }
  };
  const sealed = sealScopeCapsule({ capsule });
  const session = new LoopSession(createLoopContext({ loop_id: "loop-1", goal: "fix checkout bug" }));
  const proxy = createProxyCore({
    upstream: up,
    bindClient: bind,
    loopSession: session,
    scope: { sealed, mode: "verified_context", recorder: scopeRecorder, judgment }
  });
  return { up, bind, scopeRecorder, judgment, sealed, session, proxy };
}

describe("Capsule Gate 2 — live-path judgment capture", () => {
  it("an approved bind records a turn anchored to the receipt_id (source bind)", async () => {
    const h = harness();
    await h.proxy.callTool({ toolName: "write_file", arguments: { path: "/checkout/cart.ts" } });
    const ledger = h.judgment.judgmentLedgerForLoop("loop-1");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      turn_index: 0,
      prior_turn_ref: null,
      prior_receipt_id: null,
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r_1" }
    });
    expect(ledger[0]!.proposed).toMatchObject({ action_class: "write", tool_name: "write_file" });
    // No plaintext target ever reaches the judgment ledger (only the hash).
    expect(JSON.stringify(ledger[0])).not.toContain("/checkout/cart.ts");
  });

  it("a scope refusal records a turn (source scope_gate) anchored to the scope_event_hash", async () => {
    const h = harness();
    await h.proxy
      .callTool({ toolName: "write_file", arguments: { path: "/billing/migrations/x.sql" } })
      .catch(() => undefined);
    const events = h.scopeRecorder.scopeEventsForLoop("loop-1");
    const ledger = h.judgment.judgmentLedgerForLoop("loop-1");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      verdict: { kind: "REFUSED", source: "scope_gate", scope_event_hash: events[0]!.event_hash }
    });
    // No bind, no forward.
    expect(h.bind.requests).toEqual([]);
    expect(h.up.calls).toEqual([]);
  });

  it("an escalated bind records a turn and does NOT forward", async () => {
    const h = harness({ outcomes: ["ESCALATED"] });
    await h.proxy.callTool({ toolName: "write_file", arguments: { path: "/checkout/cart.ts" } }).catch(() => undefined);
    const ledger = h.judgment.judgmentLedgerForLoop("loop-1");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.verdict).toMatchObject({ kind: "ESCALATED", source: "bind", receipt_id: "r_1" });
    expect(h.up.calls).toEqual([]); // held, not forwarded
  });

  it("a refused bind records a turn and does NOT forward", async () => {
    const h = harness({ outcomes: ["REFUSED"] });
    await h.proxy.callTool({ toolName: "write_file", arguments: { path: "/checkout/cart.ts" } }).catch(() => undefined);
    const ledger = h.judgment.judgmentLedgerForLoop("loop-1");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.verdict).toMatchObject({ kind: "REFUSED", source: "bind", receipt_id: "r_1" });
    expect(h.up.calls).toEqual([]);
  });

  it("a step-bound refusal records a turn with source loop_bound", async () => {
    const h = harness({ structuralOverride: { bounds: { max_steps: 1 } } });
    const call: McpToolCall = { toolName: "write_file", arguments: { path: "/checkout/cart.ts" } };
    await h.proxy.callTool(call); // step 1 forwards (approved bind)
    await h.proxy.callTool(call).catch(() => undefined); // step 2 over the bound
    const ledger = h.judgment.judgmentLedgerForLoop("loop-1");
    expect(ledger).toHaveLength(2);
    expect(ledger[0]!.verdict).toMatchObject({ kind: "APPROVED", source: "bind" });
    expect(ledger[1]!.verdict).toMatchObject({ kind: "REFUSED", source: "loop_bound", reason_code: "max_steps" });
    expect(ledger[1]!.verdict.scope_event_hash).toMatch(/^sha256:/);
  });

  it("every in-loop receipt maps to a judgment turn; every scope event maps to a turn; chain is valid", async () => {
    const h = harness();
    // in-lane, out-of-lane (refused), corrected in-lane
    await h.proxy.callTool({ toolName: "write_file", arguments: { path: "/checkout/cart.ts" } });
    await h.proxy
      .callTool({ toolName: "write_file", arguments: { path: "/billing/migrations/x.sql" } })
      .catch(() => undefined);
    await h.proxy.callTool({ toolName: "run_tests", arguments: { suite: "checkout" } });

    const ledger = h.judgment.judgmentLedgerForLoop("loop-1");
    const events = h.scopeRecorder.scopeEventsForLoop("loop-1");

    // 2 bind receipts (the 2 in-lane forwards) + 1 scope refusal turn = 3 turns.
    const bindTurns = ledger.filter((t) => t.verdict.source === "bind");
    const scopeTurns = ledger.filter((t) => t.verdict.source === "scope_gate");
    expect(bindTurns).toHaveLength(2);
    expect(scopeTurns).toHaveLength(1);

    // Every bind turn anchors a real receipt id the bind emitted.
    const boundReceiptIds = new Set(bindTurns.map((t) => t.verdict.receipt_id));
    expect(boundReceiptIds).toEqual(new Set(["r_1", "r_2"]));

    // Every scope event is anchored by a judgment turn's scope_event_hash.
    const anchoredEventHashes = new Set(scopeTurns.map((t) => t.verdict.scope_event_hash));
    for (const e of events) expect(anchoredEventHashes.has(e.event_hash)).toBe(true);

    const v = validateJudgmentChain(ledger);
    expect(v.valid).toBe(true);
  });

  it("concurrent calls cannot reorder judgment turns away from receipt order", async () => {
    const h = harness();
    const call: McpToolCall = { toolName: "write_file", arguments: { path: "/checkout/cart.ts" } };
    // Fire many calls concurrently; the loop mutex serializes both the receipt chain and the
    // judgment append.
    await Promise.all(Array.from({ length: 12 }, () => h.proxy.callTool(call)));

    const ledger = h.judgment.judgmentLedgerForLoop("loop-1");
    expect(ledger).toHaveLength(12);
    // The bind-anchored turns must appear in the exact order their receipts were issued.
    const receiptOrder = h.bind.requests.map((_, i) => `r_${i + 1}`);
    const turnReceiptOrder = ledger.map((t) => t.verdict.receipt_id);
    expect(turnReceiptOrder).toEqual(receiptOrder);
    // And the prior_receipt_id chain inside the turns matches the receipt predecessor chain.
    expect(ledger[0]!.prior_receipt_id).toBeNull();
    for (let i = 1; i < ledger.length; i += 1) {
      expect(ledger[i]!.prior_receipt_id).toBe(`r_${i}`);
    }
    expect(validateJudgmentChain(ledger).valid).toBe(true);
  });

  it("the existing loop receipt chain still advances (chain verification unaffected)", async () => {
    const h = harness();
    await h.proxy.callTool({ toolName: "write_file", arguments: { path: "/checkout/cart.ts" } });
    await h.proxy.callTool({ toolName: "run_tests", arguments: { suite: "checkout" } });
    expect(h.session.actionCount).toBe(2);
    expect(h.session.priorReceiptId).toBe("r_2");
  });
});
