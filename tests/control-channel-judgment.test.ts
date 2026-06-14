import { connect as netConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  connectStreamableHttpUpstream,
  createClaimRecorder,
  createJudgmentRecorder,
  createReceiptRecorder,
  createScopeEventRecorder,
  createSyntheticDemoBindClient,
  LoopSessionRegistry,
  serveControlChannel,
  serveStandingHttpProxy,
  type ControlChannelHandle,
  type ScopeCapsule,
  type StandingHttpProxy
} from "../src/index.js";

function syntheticUpstream() {
  return {
    async listTools() {
      return [
        { name: "write_file", inputSchema: { type: "object" } },
        { name: "run_tests", inputSchema: { type: "object" } }
      ];
    },
    async callTool(call: { toolName: string }) {
      return { content: [{ type: "text", text: `ok:${call.toolName}` }] };
    }
  };
}

function scopeCapsule(privacy_mode: "proof" | "verified_context"): ScopeCapsule {
  return {
    structural: {
      capsule_type: "scope_capsule",
      capsule_version: "scope-capsule/v1",
      loop_id: "", // set at open
      goal_hash: "",
      privacy_mode,
      allowed_action_classes: ["read", "write", "run_tests"],
      allowed_targets: ["/checkout/**"],
      forbidden_targets: ["/billing/**"],
      target_descriptor_hashes: [],
      targetless_action_classes: ["run_tests"]
    },
    sidecar: { goal_summary: "fix checkout bug" }
  };
}

function sendControl(address: string, command: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const i = address.lastIndexOf(":");
    const socket = netConnect(Number(address.slice(i + 1)), address.slice(0, i));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(command) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, nl)));
      }
    });
    socket.on("error", reject);
  });
}

const SCOPE_CLASS_MAP = { write_file: "write", run_tests: "run_tests" };

type Rig = {
  standing: StandingHttpProxy;
  control: ControlChannelHandle;
  judgment: ReturnType<typeof createJudgmentRecorder>;
  claims: ReturnType<typeof createClaimRecorder>;
};

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.control.close().catch(() => undefined);
    await r.standing.close().catch(() => undefined);
  }
});

async function rig(
  opts: { privacy: "proof" | "verified_context"; withJudgmentVerbs?: boolean; withClaimVerbs?: boolean } = { privacy: "verified_context" }
): Promise<Rig & { address: string; sessionId: string; loopId: string }> {
  const recorder = createReceiptRecorder();
  const scopeEvents = createScopeEventRecorder();
  const judgment = createJudgmentRecorder();
  const claims = createClaimRecorder();
  const bindClient = recorder.wrap(createSyntheticDemoBindClient());
  const registry = new LoopSessionRegistry((r) => bindClient.bind(r), { graceMs: 1000, retryDelayMs: 25 }, scopeEvents, judgment);
  const standing = await serveStandingHttpProxy({ upstream: syntheticUpstream(), bindClient, registry, claims, host: "127.0.0.1", port: 0, path: "/mcp" });
  const control = await serveControlChannel({
    transport: "tcp",
    host: "127.0.0.1",
    port: 0,
    registry,
    receiptSource: recorder,
    scopeEventSource: scopeEvents,
    judgmentRecorder: opts.withJudgmentVerbs === false ? undefined : judgment,
    claimSource: opts.withClaimVerbs === false ? undefined : claims
  });
  const out = { standing, control, judgment, claims, address: control.address, sessionId: "s1", loopId: "loop-cc-judgment" };
  rigs.push(out);

  const opened = await sendControl(control.address, {
    cmd: "open",
    session_id: out.sessionId,
    loop_id: out.loopId,
    goal: "fix checkout bug",
    scope_capsule: scopeCapsule(opts.privacy),
    scope_class_map: SCOPE_CLASS_MAP
  });
  expect(opened.ok).toBe(true);

  // Record an agent claim for the loop. In production this arrives via the record_claim proxy tool;
  // here it is recorded directly so the dump_claims verb has data to hand back.
  claims.record({ loop_id: out.loopId, system: "gmail", action: "send", result: "sent the follow-up", user_facing: true });

  // Drive the AGENT path to generate judgment turns: one in-lane approved, one out-of-lane refused.
  const agent = await connectStreamableHttpUpstream(standing.sessionUrl(out.sessionId));
  try {
    // In Proof Mode an allowed-glob target with no declared hashes is (correctly) refused, so both
    // calls may throw; the rig only needs the turns they append. In VC mode the first is approved.
    await agent.client.callTool({ toolName: "write_file", arguments: { path: "/checkout/cart.ts", contents: "// fix" } }).catch(() => undefined);
    await agent.client.callTool({ toolName: "write_file", arguments: { path: "/billing/secret.sql", contents: "x" } }).catch(() => undefined);
  } finally {
    await agent.close().catch(() => undefined);
  }
  return out;
}

describe("Capsule Gate 2 — supervisor-only dump_judgment / record_delta", () => {
  it("dump_judgment returns the ordered ledger (by loop_id and by session_id)", async () => {
    const r = await rig();
    const byLoop = await sendControl(r.address, { cmd: "dump_judgment", loop_id: r.loopId });
    expect(byLoop.ok).toBe(true);
    expect(byLoop.count).toBe(2);
    const turns = byLoop.turns as Array<Record<string, unknown>>;
    expect((turns[0]!.verdict as Record<string, unknown>).source).toBe("bind");
    expect((turns[1]!.verdict as Record<string, unknown>).source).toBe("scope_gate");

    const bySession = await sendControl(r.address, { cmd: "dump_judgment", session_id: r.sessionId });
    expect(bySession.ok).toBe(true);
    expect(bySession.count).toBe(2);
  });

  it("a supervisor can attach a delta to an existing turn in Verified Context Mode", async () => {
    const r = await rig({ privacy: "verified_context" });
    const dump = await sendControl(r.address, { cmd: "dump_judgment", loop_id: r.loopId });
    const turnRef = (dump.turns as Array<Record<string, unknown>>)[0]!.turn_ref as string;

    const rec = await sendControl(r.address, {
      cmd: "record_delta",
      loop_id: r.loopId,
      turn_ref: turnRef,
      delta: { settled: ["checkout fix written"], next_actions: ["open follow-up"] }
    });
    expect(rec.ok).toBe(true);
    expect(rec.declared_delta).toEqual({ settled: ["checkout fix written"], next_actions: ["open follow-up"] });

    // It surfaces in a Verified Context dump.
    const vc = await sendControl(r.address, { cmd: "dump_judgment", loop_id: r.loopId, mode: "verified-context" });
    const t0 = (vc.turns as Array<Record<string, unknown>>)[0]!;
    expect(t0.declared_delta).toEqual({ settled: ["checkout fix written"], next_actions: ["open follow-up"] });
  });

  it("record_delta is during-run only: it fails closed after the supervisor closes the loop", async () => {
    const r = await rig({ privacy: "verified_context" });
    // Before close: a delta attaches (during-run sidecar).
    const dump = await sendControl(r.address, { cmd: "dump_judgment", loop_id: r.loopId });
    const turnRef = (dump.turns as Array<Record<string, unknown>>)[0]!.turn_ref as string;
    const before = await sendControl(r.address, { cmd: "record_delta", loop_id: r.loopId, turn_ref: turnRef, delta: { settled: ["during-run delta"] } });
    expect(before.ok).toBe(true);

    // Supervisor closes/seals the loop.
    const closed = await sendControl(r.address, { cmd: "close", session_id: r.sessionId, outcome: "COMPLETED", reason: "done" });
    expect(closed).toMatchObject({ ok: true, sealed: true });

    // After close: the sidecar is sealed with the loop. A delta on a VALID prior turn_ref is
    // refused — addressed by loop_id AND by the retained post-close session lookup.
    const afterByLoop = await sendControl(r.address, { cmd: "record_delta", loop_id: r.loopId, turn_ref: turnRef, delta: { settled: ["POST-CLOSE-DELTA"] } });
    expect(afterByLoop.ok).toBe(false);
    expect(String(afterByLoop.error)).toMatch(/during-run only/);
    const afterBySession = await sendControl(r.address, { cmd: "record_delta", session_id: r.sessionId, turn_ref: turnRef, delta: { settled: ["POST-CLOSE-DELTA"] } });
    expect(afterBySession.ok).toBe(false);

    // The ledger the export consumes carries ONLY the during-run delta — no post-close mutation.
    const vc = await sendControl(r.address, { cmd: "dump_judgment", loop_id: r.loopId, mode: "verified-context" });
    expect(JSON.stringify(vc.turns)).not.toContain("POST-CLOSE-DELTA");
    const t0 = (vc.turns as Array<Record<string, unknown>>)[0]!;
    expect(t0.declared_delta).toEqual({ settled: ["during-run delta"] });
  });

  it("record_delta fails closed for an unknown turn_ref and a malformed delta", async () => {
    const r = await rig({ privacy: "verified_context" });
    const unknown = await sendControl(r.address, { cmd: "record_delta", loop_id: r.loopId, turn_ref: "turn_v1:nope", delta: { settled: ["x"] } });
    expect(unknown.ok).toBe(false);

    const dump = await sendControl(r.address, { cmd: "dump_judgment", loop_id: r.loopId });
    const turnRef = (dump.turns as Array<Record<string, unknown>>)[0]!.turn_ref as string;
    const malformed = await sendControl(r.address, { cmd: "record_delta", loop_id: r.loopId, turn_ref: turnRef, delta: { bogus_field: ["x"] } });
    expect(malformed.ok).toBe(false);
  });

  it("record_delta is refused on a Proof Mode loop (Verified Context only)", async () => {
    const r = await rig({ privacy: "proof" });
    const dump = await sendControl(r.address, { cmd: "dump_judgment", loop_id: r.loopId });
    const turnRef = (dump.turns as Array<Record<string, unknown>>)[0]!.turn_ref as string;
    const rec = await sendControl(r.address, { cmd: "record_delta", loop_id: r.loopId, turn_ref: turnRef, delta: { settled: ["x"] } });
    expect(rec.ok).toBe(false);
    expect(String(rec.error)).toMatch(/Verified Context Mode only/);
  });

  it("a Proof Mode dump exposes no plaintext deltas even when a VC loop recorded one", async () => {
    const r = await rig({ privacy: "verified_context" });
    const dump = await sendControl(r.address, { cmd: "dump_judgment", loop_id: r.loopId });
    const turnRef = (dump.turns as Array<Record<string, unknown>>)[0]!.turn_ref as string;
    await sendControl(r.address, { cmd: "record_delta", loop_id: r.loopId, turn_ref: turnRef, delta: { settled: ["SENSITIVE-PLAINTEXT"] } });

    // A proof-mode projection (explicitly requested, or the default for a proof loop) strips deltas.
    const proof = await sendControl(r.address, { cmd: "dump_judgment", loop_id: r.loopId, mode: "proof" });
    expect(proof.mode).toBe("proof");
    expect(JSON.stringify(proof.turns)).not.toContain("SENSITIVE-PLAINTEXT");
    for (const t of proof.turns as Array<Record<string, unknown>>) {
      expect(t.declared_delta).toBeUndefined();
    }
  });

  it("the verbs fail closed when no judgment recorder is configured", async () => {
    const r = await rig({ privacy: "verified_context", withJudgmentVerbs: false });
    const dump = await sendControl(r.address, { cmd: "dump_judgment", loop_id: r.loopId });
    expect(dump.ok).toBe(false);
    const rec = await sendControl(r.address, { cmd: "record_delta", loop_id: r.loopId, turn_ref: "turn_v1:x", delta: { settled: ["x"] } });
    expect(rec.ok).toBe(false);
  });

  it("the agent MCP path can neither dump_judgment nor record_delta (they are control-channel verbs only)", async () => {
    const r = await rig({ privacy: "verified_context" });
    // The agent holds ONLY the per-session MCP URL. Its surface is tools/list + tools/call; there is
    // no record_delta / dump_judgment verb on it, and it never reaches the control socket. We assert
    // the agent's only effect on the ledger was APPENDING turns it cannot itself read or mutate.
    const agent = await connectStreamableHttpUpstream(r.standing.sessionUrl(r.sessionId));
    try {
      const tools = await agent.client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).not.toContain("dump_judgment");
      expect(names).not.toContain("record_delta");
    } finally {
      await agent.close().catch(() => undefined);
    }
    // The ledger is reachable only via the control channel.
    const dump = await sendControl(r.address, { cmd: "dump_judgment", loop_id: r.loopId });
    expect(dump.ok).toBe(true);
  });
});

describe("Capsule Gate 2 — supervisor-only dump_claims", () => {
  it("returns the agent's recorded claims (by loop_id and by session_id) in VC mode", async () => {
    const r = await rig({ privacy: "verified_context" });
    const byLoop = await sendControl(r.address, { cmd: "dump_claims", loop_id: r.loopId });
    expect(byLoop.ok).toBe(true);
    expect(byLoop.count).toBe(1);
    expect((byLoop.claims as Array<Record<string, unknown>>)[0]).toMatchObject({ system: "gmail", action: "send", user_facing: true });

    const bySession = await sendControl(r.address, { cmd: "dump_claims", session_id: r.sessionId });
    expect(bySession.ok).toBe(true);
    expect(bySession.count).toBe(1);
  });

  it("fails closed for a proof-mode loop (plaintext claims are Verified-Context only)", async () => {
    const r = await rig({ privacy: "proof" });
    const dump = await sendControl(r.address, { cmd: "dump_claims", loop_id: r.loopId });
    expect(dump.ok).toBe(false);
    expect(String(dump.error)).toMatch(/Verified Context Mode only/);
  });

  it("fails closed when no claim source is configured", async () => {
    const r = await rig({ privacy: "verified_context", withClaimVerbs: false });
    const dump = await sendControl(r.address, { cmd: "dump_claims", loop_id: r.loopId });
    expect(dump.ok).toBe(false);
    expect(String(dump.error)).toMatch(/not enabled/);
  });

  it("requires a loop_id or a known session_id", async () => {
    const r = await rig({ privacy: "verified_context" });
    const dump = await sendControl(r.address, { cmd: "dump_claims" });
    expect(dump.ok).toBe(false);
    expect(String(dump.error)).toMatch(/requires a `loop_id`/);
  });

  it("is a control-channel verb only — the agent MCP path never exposes it", async () => {
    const r = await rig({ privacy: "verified_context" });
    const agent = await connectStreamableHttpUpstream(r.standing.sessionUrl(r.sessionId));
    try {
      const names = (await agent.client.listTools()).map((t) => t.name);
      expect(names).not.toContain("dump_claims");
    } finally {
      await agent.close().catch(() => undefined);
    }
  });
});

describe("end-to-end claimed-vs-actual capture (agent path → dump_claims)", () => {
  it("the agent records a claim via the wired record_claim tool, and dump_claims returns it", async () => {
    const r = await rig({ privacy: "verified_context" });
    const agent = await connectStreamableHttpUpstream(r.standing.sessionUrl(r.sessionId));
    try {
      const names = (await agent.client.listTools()).map((t) => t.name);
      expect(names).toContain("record_claim"); // injected on the live agent surface
      const result = (await agent.client.callTool({
        toolName: "record_claim",
        arguments: { system: "google_drive", action: "create_file", result: "created the doc", user_facing: true }
      })) as { isError?: boolean };
      expect(result.isError).toBeUndefined();
    } finally {
      await agent.close().catch(() => undefined);
    }
    const dump = await sendControl(r.address, { cmd: "dump_claims", loop_id: r.loopId });
    expect(dump.ok).toBe(true);
    // The rig seeds one claim; the agent added a second through the wired record_claim tool.
    expect(dump.count).toBe(2);
    expect((dump.claims as Array<Record<string, unknown>>).map((c) => c.system)).toContain("google_drive");
  });
});

describe("record_claim is during-run only (no post-close claim injection)", () => {
  it("an agent retaining the URL cannot append claims after the supervisor closes the loop", async () => {
    const r = await rig({ privacy: "verified_context" });

    // Agent records a claim while the loop is OPEN.
    const agent = await connectStreamableHttpUpstream(r.standing.sessionUrl(r.sessionId));
    try {
      await agent.client.callTool({ toolName: "record_claim", arguments: { system: "google_drive", action: "create_file" } });
    } finally {
      await agent.close().catch(() => undefined);
    }
    const before = await sendControl(r.address, { cmd: "dump_claims", loop_id: r.loopId });
    const countBefore = before.count as number; // rig seed (1) + agent (1)

    // Supervisor closes/seals the loop.
    const closed = await sendControl(r.address, { cmd: "close", session_id: r.sessionId, outcome: "COMPLETED", reason: "done" });
    expect(closed).toMatchObject({ ok: true, sealed: true });

    // Agent retains the old URL and tries to record again — it must NOT append a post-close claim.
    const stale = await connectStreamableHttpUpstream(r.standing.sessionUrl(r.sessionId));
    try {
      await stale.client.callTool({ toolName: "record_claim", arguments: { system: "POST_CLOSE", action: "x" } }).catch(() => undefined);
    } finally {
      await stale.close().catch(() => undefined);
    }

    const after = await sendControl(r.address, { cmd: "dump_claims", loop_id: r.loopId });
    expect(after.count).toBe(countBefore); // unchanged across the close boundary
    expect(JSON.stringify(after.claims)).not.toContain("POST_CLOSE");
  });
});

describe("claim capture is Verified-Context only on the agent surface", () => {
  it("does not expose record_claim on a proof-mode loop (claims would be plaintext in a content-blind loop)", async () => {
    const r = await rig({ privacy: "proof" });
    const agent = await connectStreamableHttpUpstream(r.standing.sessionUrl(r.sessionId));
    try {
      const names = (await agent.client.listTools()).map((t) => t.name);
      expect(names).not.toContain("record_claim");
    } finally {
      await agent.close().catch(() => undefined);
    }
  });
});
