import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ControlChannelHandle,
  ProofReceipt,
  ScopeCapsule,
  StandingHttpProxy,
  StreamableHttpUpstream,
  UpstreamMcpClient
} from "../src/index.js";
import {
  assertContentBlind,
  buildContinuationCapsule,
  buildLoopProofBundle,
  connectStreamableHttpUpstream,
  createReceiptRecorder,
  createScopeEventRecorder,
  createSyntheticDemoBindClient,
  LoopSessionRegistry,
  serveControlChannel,
  serveStandingHttpProxy
} from "../src/index.js";

const SCOPE_CAPSULE: ScopeCapsule = {
  structural: {
    capsule_type: "scope_capsule",
    capsule_version: "scope-capsule/v1",
    loop_id: "loop-capsule",
    goal_hash: "",
    privacy_mode: "verified_context",
    allowed_action_classes: ["read", "write", "run_tests"],
    allowed_targets: ["/checkout/**", "/payments/types.ts"],
    forbidden_targets: ["/billing/migrations/**"],
    targetless_action_classes: ["run_tests"]
  },
  sidecar: { goal_summary: "fix checkout bug", planned_steps: ["edit /checkout", "run tests"] }
};

function syntheticUpstream(): UpstreamMcpClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listTools() {
      return [{ name: "write_file" }, { name: "run_tests" }];
    },
    async callTool(call) {
      calls.push(call.toolName);
      return { content: [{ type: "text", text: `ok:${call.toolName}` }] };
    }
  };
}

function sendControl(socketPath: string, command: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(command) + "\n"));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const i = buffer.indexOf("\n");
      if (i !== -1) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, i)) as Record<string, unknown>);
      }
    });
    socket.on("error", reject);
  });
}

describe("capsule gate demo: open(scope) -> in-lane -> out-of-scope BLOCKED -> corrected -> close -> continuation", () => {
  let standing: StandingHttpProxy | undefined;
  let control: ControlChannelHandle | undefined;
  let upstream: (UpstreamMcpClient & { calls: string[] }) | undefined;
  const agents: StreamableHttpUpstream[] = [];

  afterEach(async () => {
    for (const agent of agents.splice(0)) await agent.close().catch(() => undefined);
    await control?.close().catch(() => undefined);
    await standing?.close().catch(() => undefined);
    control = undefined;
    standing = undefined;
    upstream = undefined;
  });

  async function start(): Promise<{ socketPath: string }> {
    const recorder = createReceiptRecorder();
    const scopeEvents = createScopeEventRecorder();
    const bindClient = recorder.wrap(createSyntheticDemoBindClient());
    const registry = new LoopSessionRegistry((r) => bindClient.bind(r), { graceMs: 200, retryDelayMs: 5 }, scopeEvents);
    upstream = syntheticUpstream();
    standing = await serveStandingHttpProxy({ upstream, bindClient, registry, host: "127.0.0.1", port: 0, path: "/mcp" });
    const socketPath = join(tmpdir(), `lyhna-capsule-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    control = await serveControlChannel({ transport: "unix", socketPath, registry, receiptSource: recorder, scopeEventSource: scopeEvents });
    return { socketPath };
  }

  async function connectAgent(sessionId: string): Promise<UpstreamMcpClient> {
    const agent = await connectStreamableHttpUpstream(standing!.sessionUrl(sessionId));
    agents.push(agent);
    return agent.client;
  }

  it("blocks the out-of-scope step before execution, attests it, and emits a full capsule proof pack", async () => {
    const { socketPath } = await start();
    const LOOP = "loop-capsule";

    const opened = await sendControl(socketPath, {
      cmd: "open",
      session_id: "c1",
      loop_id: LOOP,
      goal: "fix checkout bug",
      scope_capsule: SCOPE_CAPSULE,
      scope_class_map: { write_file: "write", run_tests: "run_tests" }
    });
    expect(opened).toMatchObject({ ok: true });
    expect(String(opened.scope_ref)).toMatch(/^scope_v1:[0-9a-f]{64}$/);

    const agent = await connectAgent("c1");

    // In-lane write: forwarded to upstream.
    await agent.callTool({ toolName: "write_file", arguments: { path: "/checkout/cart.ts", contents: "// fix" } });

    // Out-of-scope write: BLOCKED before execution (the MCP call rejects).
    await expect(
      agent.callTool({ toolName: "write_file", arguments: { path: "/billing/migrations/2026_ledger.sql" } })
    ).rejects.toBeTruthy();

    // Corrected in-lane action: forwarded.
    await agent.callTool({ toolName: "run_tests", arguments: { suite: "checkout" } });

    // The out-of-scope target NEVER reached the upstream (pre-execution refusal).
    expect(upstream!.calls).toEqual(["write_file", "run_tests"]);

    const closed = await sendControl(socketPath, { cmd: "close", session_id: "c1", outcome: "COMPLETED", reason: "done" });
    expect(closed).toMatchObject({ ok: true, sealed: true });

    const dumped = await sendControl(socketPath, { cmd: "dump", loop_id: LOOP });
    expect(dumped).toMatchObject({ ok: true, count: 3 }); // 2 in-lane + terminal close
    const receipts = dumped.receipts as ProofReceipt[];

    // Consequential receipts cite scope_ref via the additive constraints.scope sibling key.
    const scoped = receipts.filter((r) => (r.constraints?.scope as { scope_ref?: string } | undefined)?.scope_ref);
    expect(scoped).toHaveLength(2);
    expect(() => assertContentBlind(receipts)).not.toThrow();

    const dumpedScope = await sendControl(socketPath, { cmd: "dump_scope", loop_id: LOOP });
    expect(dumpedScope.ok).toBe(true);
    const scopeHistory = dumpedScope.scope_history as Array<{ scope_ref: string; structural: { goal_hash: string } }>;
    const scopeEvents = dumpedScope.scope_events as Array<{ decision: string; matched_rule?: string; event_hash: string; attempted: { target?: string } }>;
    expect(scopeHistory).toHaveLength(1);
    expect(scopeEvents).toHaveLength(1);
    expect(scopeEvents[0]).toMatchObject({ decision: "REFUSED", matched_rule: "/billing/migrations/**" });

    // Build the Continuation Capsule (Verified Context) — inherits scope_ref / goal_hash / loop_id.
    const sealed = scopeHistory[scopeHistory.length - 1]!;
    const continuation = buildContinuationCapsule({
      scope_history: scopeHistory as never,
      scope_events: scopeEvents as never,
      loop: { loop_id: LOOP, goal_hash: sealed.structural.goal_hash, sealed: true, action_count: 2 },
      settled: ["checkout fix written"],
      open_questions: ["rounding?"],
      next_actions: ["ship"],
      mode: "verified_context"
    });
    expect(continuation.scope_ref).toBe(sealed.scope_ref);
    expect(continuation.scope_events).toHaveLength(1);

    // Proof Mode pack: scope-capsule.json structural-only; no plaintext anywhere.
    const proofBuilt = buildLoopProofBundle({
      receipts,
      source_env: "capsule-test",
      capsule: { mode: "proof", sealed_scope: sealed as never, continuation, scope_events: scopeEvents as never }
    });
    expect(proofBuilt.scope_capsule?.sidecar).toBeUndefined();
    expect(proofBuilt.bundle.capsule?.scope_events.count).toBe(1);
    const proofSerialized = JSON.stringify(proofBuilt);
    for (const needle of ["fix checkout bug", "planned_steps", "2026_ledger.sql", "checkout fix written"]) {
      expect(proofSerialized).not.toContain(needle);
    }

    // Verified Context pack: scope-capsule.json carries the sidecar.
    const vcBuilt = buildLoopProofBundle({
      receipts,
      source_env: "capsule-test",
      capsule: { mode: "verified_context", sealed_scope: sealed as never, continuation, scope_events: scopeEvents as never }
    });
    expect(vcBuilt.scope_capsule?.sidecar?.goal_summary).toBe("fix checkout bug");
  });

  it("scope amendment seals a new scope_ref version chained to the prior (supervisor-gated)", async () => {
    const { socketPath } = await start();
    await sendControl(socketPath, {
      cmd: "open",
      session_id: "c2",
      loop_id: "loop-amend",
      goal: "fix checkout bug",
      scope_capsule: SCOPE_CAPSULE
    });
    const amended = await sendControl(socketPath, {
      cmd: "amend",
      session_id: "c2",
      scope_capsule: {
        structural: { ...SCOPE_CAPSULE.structural, allowed_targets: ["/checkout/**", "/cart/**"] }
      }
    });
    expect(amended.ok).toBe(true);
    expect(String(amended.scope_ref)).toMatch(/^scope_v1:/);
    expect(amended.prior_scope_ref).not.toBe(amended.scope_ref);

    const dumpedScope = await sendControl(socketPath, { cmd: "dump_scope", loop_id: "loop-amend" });
    expect((dumpedScope.scope_history as unknown[]).length).toBe(2);
  });
});
