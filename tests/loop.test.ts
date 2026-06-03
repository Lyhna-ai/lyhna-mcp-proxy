import { describe, expect, it } from "vitest";

import type { BindClient, BindRequest, BindResponse } from "../src/index.js";
import {
  buildLoopCloseRequest,
  closeLoopWithRetry,
  createProxyCore,
  loadLoopContextFromEnv,
  LoopSession,
  mergeLoopConstraint,
  stripAuthorityTier,
  verifyLoopChain,
  type LoopChainLink,
  type UpstreamMcpClient
} from "../src/index.js";

const CONTEXT = { loop_id: "loop_abc", goal_hash: "goal_123" };

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
  it("stamps constraints.loop additively and preserves server-appended fields", () => {
    const request = baseRequest({
      constraints: { server_field: "keep", loop: { server_loop_field: "keep" } }
    });

    const merged = mergeLoopConstraint(request, {
      loop_id: "loop_abc",
      prior_receipt_id: null,
      goal_hash: "goal_123"
    });

    expect(merged.constraints).toEqual({
      server_field: "keep",
      loop: {
        server_loop_field: "keep",
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

describe("buildLoopCloseRequest", () => {
  it("carries constraints.loop_close with the terminal field set", () => {
    const request = buildLoopCloseRequest(CONTEXT, {
      action_count: 3,
      prior_receipt_id: "receipt_3",
      outcome: "COMPLETED",
      termination_reason: "SIGTERM"
    });

    expect(request.action_type).toBe("lyhna.loop.close");
    expect(request.intent).toBe("lyhna:loop_close");
    expect(request.constraints?.loop_close).toEqual({
      loop_id: "loop_abc",
      goal_hash: "goal_123",
      action_count: 3,
      outcome: "COMPLETED",
      prior_receipt_id: "receipt_3",
      termination_reason: "SIGTERM"
    });
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
});

describe("verifyLoopChain (sealed vs unsealed)", () => {
  function sealedChain(): LoopChainLink[] {
    return [
      { receipt_id: "r1", loop: { loop_id: "L", prior_receipt_id: null, goal_hash: "g" } },
      { receipt_id: "r2", loop: { loop_id: "L", prior_receipt_id: "r1", goal_hash: "g" } },
      {
        receipt_id: "r_close",
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

  it("requires both loop_id and goal_hash together", () => {
    expect(() => loadLoopContextFromEnv({ LYHNA_PROXY_LOOP_ID: "loop_x" })).toThrow(
      /both LYHNA_PROXY_LOOP_ID and LYHNA_PROXY_GOAL_HASH/i
    );
  });

  it("reads a full loop context", () => {
    expect(
      loadLoopContextFromEnv({ LYHNA_PROXY_LOOP_ID: "loop_x", LYHNA_PROXY_GOAL_HASH: "goal_y" })
    ).toEqual({ loop_id: "loop_x", goal_hash: "goal_y" });
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
      { loop_id: "loop_abc", prior_receipt_id: null, goal_hash: "goal_123" },
      { loop_id: "loop_abc", prior_receipt_id: "receipt_1", goal_hash: "goal_123" }
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
