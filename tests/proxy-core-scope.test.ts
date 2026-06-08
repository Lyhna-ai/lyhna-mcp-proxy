import { describe, expect, it } from "vitest";

import {
  createLoopContext,
  createProxyCore,
  createScopeEventRecorder,
  LoopSession,
  sealScopeCapsule,
  ScopeGateError,
  type BindClient,
  type BindRequest,
  type McpToolCall,
  type ProxyScopeContext,
  type ScopeCapsule,
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
      return { ok: true };
    }
  };
}

function recordingBind(): BindClient & { requests: BindRequest[] } {
  const requests: BindRequest[] = [];
  return {
    requests,
    async bind(request) {
      requests.push(request);
      return { outcome: "APPROVED", receipt_id: `r_${requests.length}`, signature: "sig" };
    }
  };
}

const capsule: ScopeCapsule = {
  structural: {
    capsule_type: "scope_capsule",
    capsule_version: "scope-capsule/v1",
    loop_id: "loop-1",
    goal_hash: "a".repeat(64),
    privacy_mode: "verified_context",
    allowed_action_classes: ["read", "write", "run_tests"],
    allowed_targets: ["/checkout/**", "/payments/types.ts"],
    forbidden_targets: ["/billing/migrations/**"]
  },
  sidecar: { goal_summary: "fix checkout bug" }
};

function scopeContext(): ProxyScopeContext & { recorderRef: ReturnType<typeof createScopeEventRecorder> } {
  const recorder = createScopeEventRecorder();
  const sealed = sealScopeCapsule({ capsule });
  return { sealed, mode: "verified_context", recorder, recorderRef: recorder };
}

describe("proxy-core scope gate", () => {
  it("forwards an in-lane call and stamps constraints.scope (structural only)", async () => {
    const up = upstream();
    const bind = recordingBind();
    const scope = scopeContext();
    const proxy = createProxyCore({ upstream: up, bindClient: bind, scope });

    await expect(
      proxy.callTool({ toolName: "write_file", arguments: { path: "/checkout/cart.ts" } })
    ).resolves.toEqual({ ok: true });

    expect(up.calls).toHaveLength(1);
    expect(bind.requests).toHaveLength(1);
    const stampedScope = bind.requests[0]!.constraints?.scope as Record<string, unknown>;
    expect(stampedScope.scope_ref).toBe(scope.sealed.scope_ref);
    expect(stampedScope.action_class).toBe("write");
    expect(stampedScope.tool_name).toBe("write_file");
    expect(String(stampedScope.target_descriptor)).toMatch(/^sha256:/);
    // No plaintext target ever reaches the bind/core path.
    expect(JSON.stringify(stampedScope)).not.toContain("/checkout/cart.ts");
  });

  it("REFUSES an out-of-scope target BEFORE bind and BEFORE upstream; attests a scope event", async () => {
    const up = upstream();
    const bind = recordingBind();
    const scope = scopeContext();
    const proxy = createProxyCore({ upstream: up, bindClient: bind, scope });

    await expect(
      proxy.callTool({ toolName: "write_file", arguments: { path: "/billing/migrations/2026_ledger.sql" } })
    ).rejects.toBeInstanceOf(ScopeGateError);

    // Pre-execution: neither bind nor upstream ran.
    expect(bind.requests).toEqual([]);
    expect(up.calls).toEqual([]);

    // The halt is attested as a sidecar scope event.
    const events = scope.recorderRef.scopeEventsForLoop("loop-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "scope_refusal",
      decision: "REFUSED",
      matched_rule: "/billing/migrations/**"
    });
    expect(events[0]!.event_hash).toMatch(/^sha256:/);
  });

  it("a ScopeGateError fails closed (REFUSED) / holds (ESCALATED)", async () => {
    const up = upstream();
    const bind = recordingBind();
    const scope = scopeContext();
    const proxy = createProxyCore({ upstream: up, bindClient: bind, scope });
    await proxy
      .callTool({ toolName: "write_file", arguments: { path: "/billing/migrations/x.sql" } })
      .catch((e: unknown) => {
        expect(e).toBeInstanceOf(ScopeGateError);
        expect((e as ScopeGateError).decision).toBe("FAIL_CLOSED");
      });
  });

  it("with no scope context, behaves exactly as the baseline bind gate", async () => {
    const up = upstream();
    const bind = recordingBind();
    const proxy = createProxyCore({ upstream: up, bindClient: bind });

    await expect(
      proxy.callTool({ toolName: "write_file", arguments: { path: "/anywhere.ts" } })
    ).resolves.toEqual({ ok: true });
    expect(bind.requests).toHaveLength(1);
    expect(bind.requests[0]!.constraints?.scope).toBeUndefined();
  });

  it("enforces max_steps through the full proxy path: the over-limit call is an attested ScopeGateError", async () => {
    const up = upstream();
    const bind = recordingBind();
    const recorder = createScopeEventRecorder();
    const sealed = sealScopeCapsule({
      capsule: { structural: { ...capsule.structural, bounds: { max_steps: 1 } }, sidecar: capsule.sidecar }
    });
    const session = new LoopSession(createLoopContext({ loop_id: "loop-1", goal: "fix checkout bug" }));
    const proxy = createProxyCore({
      upstream: up,
      bindClient: bind,
      loopSession: session,
      scope: { sealed, mode: "verified_context", recorder }
    });
    const call: McpToolCall = { toolName: "write_file", arguments: { path: "/checkout/cart.ts" } };

    await expect(proxy.callTool(call)).resolves.toEqual({ ok: true }); // step 1 forwards
    await expect(proxy.callTool(call)).rejects.toBeInstanceOf(ScopeGateError); // step 2 over the bound

    // The 2nd call never reached the upstream, and the refusal is attested with matched_rule max_steps.
    expect(up.calls).toHaveLength(1);
    const events = recorder.scopeEventsForLoop("loop-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: "REFUSED", matched_rule: "max_steps" });
  });
});
