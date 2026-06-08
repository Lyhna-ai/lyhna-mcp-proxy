import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { BindClient, BindRequest, BindResponse } from "../src/index.js";
import {
  buildLoopCloseRequest,
  closeLoopWithRetry,
  createLoopContext,
  createProxyCore,
  deriveGoalHash,
  loadLoopContextFromEnv,
  LoopSession,
  LoopStepBoundError,
  mergeLoopConstraint,
  stripAuthorityTier,
  verifyLoopChain,
  type LoopChainLink,
  type UpstreamMcpClient
} from "../src/index.js";

const CONTEXT = createLoopContext({ loop_id: "loop_abc", goal: "ship the adapter" });

function baseRequest(overrides: Partial<BindRequest> = {}): BindRequest {
  return {
    action_type: "repo.search",
    action_payload: { tool_name: "repo.search", arguments: { query: "x" } },
    intent: "mcp:repo.search",
    intent_version: "1.0",
    ...overrides
  };
}

function receiptBind(): BindClient["bind"] {
  let n = 0;
  return async () => {
    n += 1;
    return { outcome: "APPROVED", receipt_id: `receipt_${n}`, signature: `sig_${n}` };
  };
}

describe("stripAuthorityTier", () => {
  it("removes caller authority_tier at top level and under constraints, without mutating input", () => {
    const request = baseRequest({
      // @ts-expect-error caller attempting to supply forbidden authority_tier
      authority_tier: "ADMIN",
      constraints: { authority_tier: "ADMIN", loop: { keep: true } }
    });

    const stripped = stripAuthorityTier(request);

    expect("authority_tier" in stripped).toBe(false);
    expect("authority_tier" in (stripped.constraints ?? {})).toBe(false);
    expect(stripped.constraints?.loop).toEqual({ keep: true });
    // input untouched
    expect("authority_tier" in request).toBe(true);
  });
});

describe("mergeLoopConstraint", () => {
  it("layers constraints.loop as a distinct key over sibling constraints (canonical)", () => {
    // Server-appended fields ride as SIBLINGS of `loop` (e.g. resolved_by); the loop
    // layer owns the `loop` key exactly and neither clobbers the other.
    const request = baseRequest({
      constraints: { resolved_by: "keep", original_escalation: "keep" }
    });

    const merged = mergeLoopConstraint(request, {
      loop_id: "loop_abc",
      prior_receipt_id: null,
      goal_hash: "goal_123"
    });

    expect(merged.constraints).toEqual({
      resolved_by: "keep",
      original_escalation: "keep",
      loop: {
        loop_id: "loop_abc",
        prior_receipt_id: null,
        goal_hash: "goal_123"
      }
    });
  });

  it("strips caller authority_tier and never mutates action_payload identity", () => {
    const args = { query: "x" };
    const request = baseRequest({
      action_payload: { tool_name: "repo.search", arguments: args },
      // @ts-expect-error forbidden field
      authority_tier: "ADMIN"
    });

    const merged = mergeLoopConstraint(request, {
      loop_id: "loop_abc",
      prior_receipt_id: "receipt_1",
      goal_hash: "goal_123"
    });

    expect("authority_tier" in merged).toBe(false);
    expect(merged.action_payload.arguments).toBe(args);
  });
});

describe("deriveGoalHash", () => {
  it("is sha256(utf8(goal)) hex with no normalization or trimming", () => {
    const goal = "  Ship the adapter 🚀  ";
    const expected = createHash("sha256").update(goal, "utf8").digest("hex");

    expect(deriveGoalHash(goal)).toBe(expected);
    // No trim: the trimmed goal hashes to a different digest and must not collide.
    expect(deriveGoalHash(goal)).not.toBe(deriveGoalHash(goal.trim()));
  });

  it("createLoopContext derives goal_hash from the raw goal", () => {
    const context = createLoopContext({ loop_id: "loop_x", goal: "do the thing" });
    expect(context).toEqual({
      loop_id: "loop_x",
      goal: "do the thing",
      goal_hash: deriveGoalHash("do the thing")
    });
  });
});

describe("buildLoopCloseRequest", () => {
  it("matches the canonical loop_close shape", () => {
    const request = buildLoopCloseRequest(CONTEXT, {
      action_count: 3,
      prior_receipt_id: "receipt_3",
      outcome: "COMPLETED",
      termination_reason: "SIGTERM"
    });

    // 2: action_type is exactly "loop_close"
    expect(request.action_type).toBe("loop_close");
    // 3: action_payload is exactly { loop_id, action_count } — not the full summary
    expect(request.action_payload).toEqual({ loop_id: "loop_abc", action_count: 3 });
    // 4: intent defaults to the goal; intent_version is "loop_v1"
    expect(request.intent).toBe(CONTEXT.goal);
    expect(request.intent_version).toBe("loop_v1");
    // 5: constraints carries BOTH loop and loop_close, goal_hash present in both
    expect(request.constraints?.loop).toEqual({
      loop_id: "loop_abc",
      prior_receipt_id: "receipt_3",
      goal_hash: CONTEXT.goal_hash
    });
    expect(request.constraints?.loop_close).toEqual({
      loop_id: "loop_abc",
      outcome: "COMPLETED",
      termination_reason: "SIGTERM",
      action_count: 3,
      prior_receipt_id: "receipt_3",
      goal_hash: CONTEXT.goal_hash
    });
    expect((request.constraints?.loop as { goal_hash: string }).goal_hash).toBe(
      (request.constraints?.loop_close as { goal_hash: string }).goal_hash
    );
  });

  it("allows deliberate intent / intent_version overrides", () => {
    const request = buildLoopCloseRequest(CONTEXT, {
      action_count: 0,
      prior_receipt_id: null,
      outcome: "COMPLETED",
      termination_reason: "SIGTERM",
      intent: "proof-run-label",
      intent_version: "custom_v9"
    });

    expect(request.intent).toBe("proof-run-label");
    expect(request.intent_version).toBe("custom_v9");
  });
});

describe("LoopSession chain advance", () => {
  it("starts at a null root prior and advances prior_receipt_id after every bind", async () => {
    const session = new LoopSession(CONTEXT);
    const seenPriors: Array<string | null> = [];

    const bind = async (request: BindRequest): Promise<BindResponse> => {
      const loop = request.constraints?.loop as { prior_receipt_id: string | null };
      seenPriors.push(loop.prior_receipt_id);
      return { outcome: "APPROVED", receipt_id: `receipt_${seenPriors.length}`, signature: "s" };
    };

    expect(session.priorReceiptId).toBeNull();
    await session.bindToolCall(baseRequest(), bind);
    await session.bindToolCall(baseRequest(), bind);
    await session.bindToolCall(baseRequest(), bind);

    expect(seenPriors).toEqual([null, "receipt_1", "receipt_2"]);
    expect(session.priorReceiptId).toBe("receipt_3");
    expect(session.actionCount).toBe(3);
  });

  it("serializes concurrent tools/call so the chain cannot fork", async () => {
    const session = new LoopSession(CONTEXT);
    const seenPriors: Array<string | null> = [];
    let counter = 0;

    // A bind that yields to the event loop, so without the mutex concurrent calls
    // would interleave and observe the same prior.
    const bind = async (request: BindRequest): Promise<BindResponse> => {
      const loop = request.constraints?.loop as { prior_receipt_id: string | null };
      seenPriors.push(loop.prior_receipt_id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      counter += 1;
      return { outcome: "APPROVED", receipt_id: `receipt_${counter}`, signature: "s" };
    };

    await Promise.all([
      session.bindToolCall(baseRequest(), bind),
      session.bindToolCall(baseRequest(), bind),
      session.bindToolCall(baseRequest(), bind),
      session.bindToolCall(baseRequest(), bind)
    ]);

    // Strictly linear chain: each prior is the previous receipt, no duplicates.
    expect(seenPriors).toEqual([null, "receipt_1", "receipt_2", "receipt_3"]);
    expect(new Set(seenPriors).size).toBe(seenPriors.length);
    expect(session.priorReceiptId).toBe("receipt_4");
    expect(session.actionCount).toBe(4);
  });

  it("refuses in-loop binds after the loop is closed (fail closed)", async () => {
    const session = new LoopSession(CONTEXT);
    const bind = receiptBind();

    await session.bindToolCall(baseRequest(), bind);
    await session.close(bind, { outcome: "COMPLETED", termination_reason: "SIGTERM" });

    expect(session.closed).toBe(true);
    await expect(session.bindToolCall(baseRequest(), bind)).rejects.toThrow(/already closed/);
  });
});

describe("LoopSession.close + closeLoopWithRetry", () => {
  it("seals with the final prior and action_count", async () => {
    const session = new LoopSession(CONTEXT);
    const bind = receiptBind();

    await session.bindToolCall(baseRequest(), bind);
    await session.bindToolCall(baseRequest(), bind);

    let closeRequest: BindRequest | undefined;
    const capturingBind = async (request: BindRequest): Promise<BindResponse> => {
      closeRequest = request;
      return { outcome: "APPROVED", receipt_id: "receipt_close", signature: "s" };
    };

    const result = await closeLoopWithRetry(session, capturingBind, {
      outcome: "COMPLETED",
      termination_reason: "SIGTERM",
      graceMs: 1000,
      retryDelayMs: 10
    });

    expect(result.sealed).toBe(true);
    expect(closeRequest?.constraints?.loop_close).toMatchObject({
      action_count: 2,
      prior_receipt_id: "receipt_2",
      outcome: "COMPLETED",
      termination_reason: "SIGTERM"
    });
    expect(session.closed).toBe(true);
  });

  it("retries within the grace window then seals", async () => {
    const session = new LoopSession(CONTEXT);
    let attempts = 0;
    const flakyBind = async (): Promise<BindResponse> => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("bind transport down");
      }
      return { outcome: "APPROVED", receipt_id: "receipt_close", signature: "s" };
    };

    const result = await closeLoopWithRetry(session, flakyBind, {
      outcome: "COMPLETED",
      termination_reason: "SIGTERM",
      graceMs: 1000,
      retryDelayMs: 5
    });

    expect(attempts).toBe(3);
    expect(result.sealed).toBe(true);
    expect(session.closed).toBe(true);
  });

  it("leaves the chain unsealed when the close ultimately fails within the grace window", async () => {
    const session = new LoopSession(CONTEXT);
    const alwaysFails = async (): Promise<BindResponse> => {
      throw new Error("bind transport down");
    };

    const result = await closeLoopWithRetry(session, alwaysFails, {
      outcome: "COMPLETED",
      termination_reason: "SIGTERM",
      graceMs: 30,
      retryDelayMs: 5
    });

    expect(result.sealed).toBe(false);
    expect(session.closed).toBe(false);
  });

  // RED-GREEN (additive defense-in-depth). The registry already guarantees one terminal
  // per session_id (coalesce + delete-on-seal). This makes the invariant LOCAL to the
  // session: a SECOND direct close() — bypassing the registry entirely — must never build
  // or re-bind a second terminal loop_close. It returns the already-sealed result verbatim.
  // Without the closedFlag short-circuit in close(), this test REDS: close() would build
  // and bind a second loop_close (two terminals), and the two results would differ.
  it("close() is idempotent: a direct second close emits no second terminal and returns the same sealed result", async () => {
    const session = new LoopSession(CONTEXT);
    const closeBinds: BindRequest[] = [];
    let n = 0;
    const bind = async (request: BindRequest): Promise<BindResponse> => {
      if (request.action_type === "loop_close") {
        closeBinds.push(request);
      }
      n += 1;
      return { outcome: "APPROVED", receipt_id: `receipt_${n}`, signature: `sig_${n}` };
    };

    await session.bindToolCall(baseRequest(), bind);

    const first = await session.close(bind, { outcome: "COMPLETED", termination_reason: "explicit" });
    // A second close with a DIFFERENT outcome must NOT win and must NOT re-bind: first
    // writer wins, locally, at the session.
    const second = await session.close(bind, { outcome: "FAILED", termination_reason: "second-writer" });

    // Exactly ONE terminal loop_close bind was emitted.
    expect(closeBinds).toHaveLength(1);
    // Both calls return the SAME sealed result, byte-identically (same object reference,
    // and structurally equal — the second call's FAILED/second-writer fields never appear).
    expect(first.sealed).toBe(true);
    expect(second).toBe(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    if (first.sealed && second.sealed) {
      expect(second.receipt.receipt_id).toBe(first.receipt.receipt_id);
    }
    expect(session.closed).toBe(true);
  });
});

describe("verifyLoopChain (sealed vs unsealed)", () => {
  function sealedChain(): LoopChainLink[] {
    return [
      { receipt_id: "r1", loop: { loop_id: "L", prior_receipt_id: null, goal_hash: "g" } },
      { receipt_id: "r2", loop: { loop_id: "L", prior_receipt_id: "r1", goal_hash: "g" } },
      {
        // Canonical terminal link carries BOTH loop and loop_close.
        receipt_id: "r_close",
        loop: { loop_id: "L", prior_receipt_id: "r2", goal_hash: "g" },
        loop_close: {
          loop_id: "L",
          goal_hash: "g",
          action_count: 2,
          outcome: "COMPLETED",
          prior_receipt_id: "r2",
          termination_reason: "SIGTERM"
        }
      }
    ];
  }

  it("accepts a sealed chain", () => {
    expect(verifyLoopChain(sealedChain())).toEqual({
      valid: true,
      sealed: true,
      loop_id: "L",
      action_count: 2
    });
  });

  it("REJECTS in-loop links with no terminal loop_close", () => {
    const chain = sealedChain().slice(0, 2);
    const result = verifyLoopChain(chain);
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toMatch(/unsealed/);
  });

  it("accepts an empty chain and a loop opened-then-closed with zero actions", () => {
    expect(verifyLoopChain([])).toMatchObject({ valid: true, sealed: true });
    expect(
      verifyLoopChain([
        {
          receipt_id: "r_close",
          loop_close: {
            loop_id: "L",
            goal_hash: "g",
            action_count: 0,
            outcome: "COMPLETED",
            prior_receipt_id: null,
            termination_reason: "SIGTERM"
          }
        }
      ])
    ).toMatchObject({ valid: true, action_count: 0 });
  });

  it("rejects a broken prior_receipt_id chain", () => {
    const chain = sealedChain();
    (chain[1].loop as { prior_receipt_id: string }).prior_receipt_id = "WRONG";
    expect(verifyLoopChain(chain)).toMatchObject({ valid: false });
  });

  it("rejects a link spliced in from a different goal (goal_hash mismatch)", () => {
    // Same loop_id and a continuous prior chain, but one link carries a different goal.
    const chain = sealedChain();
    (chain[1].loop as { goal_hash: string }).goal_hash = "different-goal";
    const result = verifyLoopChain(chain);
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toMatch(/goal_hash mismatch/);
  });

  it("rejects a terminal whose own loop link goal_hash diverges", () => {
    const chain = sealedChain();
    (chain[2].loop as { goal_hash: string }).goal_hash = "different-goal";
    expect(verifyLoopChain(chain)).toMatchObject({ valid: false });
  });

  it("rejects a loop_close that does not seal the last in-loop link", () => {
    const chain = sealedChain();
    (chain[2].loop_close as { prior_receipt_id: string }).prior_receipt_id = "WRONG";
    expect(verifyLoopChain(chain)).toMatchObject({ valid: false });
  });

  it("rejects an action_count that disagrees with the in-loop link count", () => {
    const chain = sealedChain();
    (chain[2].loop_close as { action_count: number }).action_count = 5;
    expect(verifyLoopChain(chain)).toMatchObject({ valid: false });
  });

  it("rejects multiple terminal loop_close links", () => {
    const chain = sealedChain();
    chain.push({ ...chain[2] });
    expect(verifyLoopChain(chain)).toMatchObject({ valid: false });
  });
});

describe("loadLoopContextFromEnv", () => {
  it("returns undefined when no loop env is set", () => {
    expect(loadLoopContextFromEnv({})).toBeUndefined();
  });

  it("requires both loop_id and goal together", () => {
    expect(() => loadLoopContextFromEnv({ LYHNA_PROXY_LOOP_ID: "loop_x" })).toThrow(
      /both LYHNA_PROXY_LOOP_ID and LYHNA_PROXY_GOAL/i
    );
  });

  it("reads a loop context and derives goal_hash from the raw goal", () => {
    expect(
      loadLoopContextFromEnv({ LYHNA_PROXY_LOOP_ID: "loop_x", LYHNA_PROXY_GOAL: "do the thing" })
    ).toEqual({
      loop_id: "loop_x",
      goal: "do the thing",
      goal_hash: deriveGoalHash("do the thing")
    });
  });
});

describe("createProxyCore with a loop session", () => {
  function upstreamSpy(): UpstreamMcpClient & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      async listTools() {
        return [{ name: "repo.search" }];
      },
      async callTool(call) {
        calls.push(call);
        return { ok: true };
      }
    };
  }

  it("stamps each forwarded tools/call bind with an advancing loop chain and preserves payload identity", async () => {
    const session = new LoopSession(CONTEXT);
    const upstream = upstreamSpy();
    const boundLoops: Array<unknown> = [];

    const bindClient: BindClient = {
      async bind(request) {
        boundLoops.push(request.constraints?.loop);
        return {
          outcome: "APPROVED",
          receipt_id: `receipt_${boundLoops.length}`,
          signature: "s"
        };
      }
    };

    const proxy = createProxyCore({ upstream, bindClient, loopSession: session });

    const args1 = { query: "first" };
    const args2 = { query: "second" };
    await proxy.callTool({ toolName: "repo.search", arguments: args1 });
    await proxy.callTool({ toolName: "repo.search", arguments: args2 });

    expect(boundLoops).toEqual([
      { loop_id: "loop_abc", prior_receipt_id: null, goal_hash: CONTEXT.goal_hash },
      { loop_id: "loop_abc", prior_receipt_id: "receipt_1", goal_hash: CONTEXT.goal_hash }
    ]);
    // Invariant 2: forwarded arguments are the exact originals, untouched by stamping.
    expect((upstream.calls[0] as { arguments: unknown }).arguments).toBe(args1);
    expect((upstream.calls[1] as { arguments: unknown }).arguments).toBe(args2);
  });

  it("does not advance the chain when a bind throws (fail closed)", async () => {
    const session = new LoopSession(CONTEXT);
    const upstream = upstreamSpy();
    const bindClient: BindClient = {
      async bind() {
        throw new Error("network down");
      }
    };

    const proxy = createProxyCore({ upstream, bindClient, loopSession: session });

    await expect(
      proxy.callTool({ toolName: "repo.search", arguments: {} })
    ).rejects.toMatchObject({ name: "BindGateError", decision: "FAIL_CLOSED" });
    expect(session.priorReceiptId).toBeNull();
    expect(session.actionCount).toBe(0);
    expect(upstream.calls).toEqual([]);
  });
});

describe("LoopSession.bindToolCall scope stamping (Capsule Gate 1)", () => {
  // A bind that echoes the stamped constraints and mints unique receipt ids, so the chain and
  // the scope anchors can be inspected exactly as a verifier would see them.
  function echoBind(): BindClient & { seen: BindRequest[] } {
    let n = 0;
    const seen: BindRequest[] = [];
    return {
      seen,
      async bind(request) {
        seen.push(request);
        n += 1;
        return { outcome: "APPROVED", receipt_id: `r_${n}`, signature: "sig", constraints: request.constraints };
      }
    };
  }

  const scopeStamp = { scope_ref: "scope_v1:" + "a".repeat(64), action_class: "write", tool_name: "write_file", target_descriptor: "sha256:" + "b".repeat(64) };

  it("stamps constraints.scope with the SAME prior_receipt_id as constraints.loop", async () => {
    const session = new LoopSession(createLoopContext({ loop_id: "loop_s", goal: "g" }));
    const bind = echoBind();
    await session.bindToolCall(baseRequest(), (r) => bind.bind(r), scopeStamp);
    await session.bindToolCall(baseRequest(), (r) => bind.bind(r), scopeStamp);

    for (const req of bind.seen) {
      const loop = req.constraints?.loop as { prior_receipt_id: string | null };
      const scope = req.constraints?.scope as { prior_receipt_id: string | null; scope_ref: string };
      expect(scope.prior_receipt_id).toBe(loop.prior_receipt_id); // same anchor, never stale
      expect(scope.scope_ref).toBe(scopeStamp.scope_ref);
    }
    // Second link's anchor is the first receipt id (chain advanced under the mutex).
    const secondScope = bind.seen[1]!.constraints?.scope as { prior_receipt_id: string | null };
    expect(secondScope.prior_receipt_id).toBe("r_1");
  });

  it("under CONCURRENT scoped calls, each scope anchor matches its own loop anchor (mutex-stamped)", async () => {
    const session = new LoopSession(createLoopContext({ loop_id: "loop_c", goal: "g" }));
    const bind = echoBind();
    await Promise.all([
      session.bindToolCall(baseRequest(), (r) => bind.bind(r), scopeStamp),
      session.bindToolCall(baseRequest(), (r) => bind.bind(r), scopeStamp),
      session.bindToolCall(baseRequest(), (r) => bind.bind(r), scopeStamp)
    ]);
    const priors = new Set<string | null>();
    for (const req of bind.seen) {
      const loop = req.constraints?.loop as { prior_receipt_id: string | null };
      const scope = req.constraints?.scope as { prior_receipt_id: string | null };
      expect(scope.prior_receipt_id).toBe(loop.prior_receipt_id);
      priors.add(loop.prior_receipt_id);
    }
    // Three distinct anchors (null, r_1, r_2) — the chain serialized cleanly.
    expect(priors.size).toBe(3);
  });

  it("enforces max_steps inside the mutex: the over-limit call throws LoopStepBoundError and never binds", async () => {
    const session = new LoopSession(createLoopContext({ loop_id: "loop_ms", goal: "g" }));
    const bind = echoBind();
    await session.bindToolCall(baseRequest(), (r) => bind.bind(r), scopeStamp, 1); // step 1: ok
    await expect(
      session.bindToolCall(baseRequest(), (r) => bind.bind(r), scopeStamp, 1)
    ).rejects.toBeInstanceOf(LoopStepBoundError);
    expect(bind.seen).toHaveLength(1); // the 2nd call never bound
  });

  it("under CONCURRENCY, max_steps:1 admits exactly one bind; the rest throw (no pre-bind race)", async () => {
    const session = new LoopSession(createLoopContext({ loop_id: "loop_msc", goal: "g" }));
    const bind = echoBind();
    const results = await Promise.allSettled([
      session.bindToolCall(baseRequest(), (r) => bind.bind(r), scopeStamp, 1),
      session.bindToolCall(baseRequest(), (r) => bind.bind(r), scopeStamp, 1),
      session.bindToolCall(baseRequest(), (r) => bind.bind(r), scopeStamp, 1)
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
    expect(bind.seen).toHaveLength(1); // exactly one bind crossed the bound
  });
});
