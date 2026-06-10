// `lyhna-mcp ctl` + `lyhna-mcp export-pack` — the supervisor-side CLI over the control channel.
//
// End-to-end against the REAL standing surfaces (standing HTTP proxy, control channel, synthetic
// bind): open a scoped loop, run in-lane + out-of-scope calls, record deltas, close — then export
// the full capsule trio with ONE command and check the pack on disk. Mirrors the deterministic
// demo flow; nothing live.

import { connect as netConnect } from "node:net";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CliIo, ControlChannelHandle, StandingHttpProxy } from "../src/index.js";
import {
  connectStreamableHttpUpstream,
  createJudgmentRecorder,
  createReceiptRecorder,
  createScopeEventRecorder,
  createSyntheticDemoBindClient,
  LoopSessionRegistry,
  resolveControlTarget,
  runCtl,
  runExportPack,
  serveControlChannel,
  serveStandingHttpProxy
} from "../src/index.js";

const SESSION_ID = "supervisor-cli-session";
const LOOP_ID = "loop-supervisor-cli";
const GOAL = "fix checkout bug";
const TARGET = "/checkout/cart.ts";
const targetHash = (t: string) => "sha256:" + createHash("sha256").update(t, "utf8").digest("hex");

const SCOPE_CAPSULE = {
  structural: {
    capsule_type: "scope_capsule",
    capsule_version: "scope-capsule/v1",
    loop_id: LOOP_ID,
    goal_hash: "",
    privacy_mode: "verified_context",
    allowed_action_classes: ["write", "run_tests"],
    allowed_targets: ["/checkout/**"],
    forbidden_targets: ["/billing/**"],
    target_descriptor_hashes: [targetHash(TARGET)],
    targetless_action_classes: ["run_tests"]
  },
  sidecar: { goal_summary: "fix checkout bug" }
};
const SCOPE_CLASS_MAP = { write_file: "write", run_tests: "run_tests" };

function syntheticUpstream() {
  return {
    async listTools() {
      return [
        { name: "write_file", description: "write", inputSchema: { type: "object" } },
        { name: "run_tests", description: "test", inputSchema: { type: "object" } }
      ];
    },
    async callTool(call: { toolName: string }) {
      return { content: [{ type: "text" as const, text: `ok:${call.toolName}` }], structuredContent: { tool: call.toolName } };
    }
  };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIo = { stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
  return { cli, out, err };
}

function sendControl(socketPath: string, command: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(command) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>);
      }
    });
    socket.on("error", reject);
  });
}

describe("resolveControlTarget precedence", () => {
  const env = {
    LYHNA_PROXY_CONTROL_SOCKET: "/env/control.sock",
    LYHNA_PROXY_CONTROL_PORT: "9000",
    LYHNA_PROXY_CONTROL_HOST: "127.0.0.2"
  };

  it("explicit --socket wins over everything", () => {
    expect(resolveControlTarget({ socket: "/flag.sock", port: "8000" }, env)).toEqual({ socketPath: "/flag.sock" });
  });

  it("explicit --port wins over the env socket", () => {
    expect(resolveControlTarget({ port: "8000" }, env)).toEqual({ host: "127.0.0.2", port: 8000 });
    expect(resolveControlTarget({ port: "8000", host: "127.0.0.5" }, env)).toEqual({ host: "127.0.0.5", port: 8000 });
  });

  it("falls back to the env socket, then the env port", () => {
    expect(resolveControlTarget({}, env)).toEqual({ socketPath: "/env/control.sock" });
    expect(resolveControlTarget({}, { LYHNA_PROXY_CONTROL_PORT: "9000" })).toEqual({ host: "127.0.0.1", port: 9000 });
    expect(resolveControlTarget({}, {})).toBeNull();
  });

  it("rejects an invalid explicit port instead of silently using the env socket", () => {
    expect(resolveControlTarget({ port: "not-a-port" }, env)).toBeNull();
  });

  it("--host alone declares TCP intent: env port pairs with it, the env socket never does", () => {
    // With an env port available, --host pairs with it (and never resolves the env socket).
    expect(resolveControlTarget({ host: "127.0.0.5" }, env)).toEqual({ host: "127.0.0.5", port: 9000 });
    // With no env port, an incomplete TCP target is refused — not silently downgraded to the socket.
    expect(resolveControlTarget({ host: "127.0.0.5" }, { LYHNA_PROXY_CONTROL_SOCKET: "/env/control.sock" })).toBeNull();
  });
});

describe("flag parsing refuses a missing value (never falls back to env)", () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    const cli: CliIo = { stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
    return { cli, out, err };
  }

  it("ctl with a bare --socket fails parsing instead of driving the env-configured proxy", async () => {
    const { cli, err } = io();
    // An exported env target is present — a missing --socket value must NOT fall back to it.
    const rc = await runCtl([JSON.stringify({ cmd: "status" }), "--socket"], cli, {
      LYHNA_PROXY_CONTROL_SOCKET: "/env/control.sock"
    });
    expect(rc).toBe(1);
    expect(err.join("")).toContain("--socket requires a value");
  });

  it("ctl with a bare --file fails parsing", async () => {
    const { cli, err } = io();
    const rc = await runCtl(["--file"], cli, {});
    expect(rc).toBe(1);
    expect(err.join("")).toContain("--file requires a value");
  });

  it("export-pack with bare value flags fails parsing", async () => {
    for (const flag of ["--loop", "--out", "--mode", "--source-env", "--port", "--host"]) {
      const { cli, err } = io();
      const rc = await runExportPack([flag], cli, { LYHNA_PROXY_CONTROL_SOCKET: "/env/control.sock" });
      expect(rc, `${flag} must be refused without a value`).toBe(1);
      expect(err.join("")).toContain(`${flag} requires a value`);
    }
  });
});

describe("lyhna-mcp ctl / export-pack (supervisor CLI e2e)", () => {
  const cleanups: Array<() => Promise<unknown> | unknown> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  async function runScopedLoop() {
    const recorder = createReceiptRecorder();
    const scopeEvents = createScopeEventRecorder();
    const judgment = createJudgmentRecorder();
    const bindClient = recorder.wrap(createSyntheticDemoBindClient());
    const registry = new LoopSessionRegistry((r) => bindClient.bind(r), { graceMs: 2000, retryDelayMs: 50 }, scopeEvents, judgment);

    const standing: StandingHttpProxy = await serveStandingHttpProxy({
      upstream: syntheticUpstream(),
      bindClient,
      registry,
      host: "127.0.0.1",
      port: 0,
      path: "/mcp"
    });
    cleanups.push(() => standing.close());

    const socketPath = join(tmpdir(), `lyhna-supervisor-cli-${process.pid}-${Date.now()}.sock`);
    const control: ControlChannelHandle = await serveControlChannel({
      transport: "unix",
      socketPath,
      registry,
      receiptSource: recorder,
      scopeEventSource: scopeEvents,
      judgmentRecorder: judgment
    });
    cleanups.push(() => control.close());

    const opened = await sendControl(socketPath, {
      cmd: "open",
      session_id: SESSION_ID,
      loop_id: LOOP_ID,
      goal: GOAL,
      scope_capsule: SCOPE_CAPSULE,
      scope_class_map: SCOPE_CLASS_MAP
    });
    expect(opened.ok).toBe(true);

    const agent = await connectStreamableHttpUpstream(standing.sessionUrl(SESSION_ID));
    try {
      await agent.client.callTool({ toolName: "write_file", arguments: { path: TARGET, contents: "// fix" } });
      await expect(
        agent.client.callTool({ toolName: "write_file", arguments: { path: "/billing/x.sql", contents: "no" } })
      ).rejects.toThrow();
      await agent.client.callTool({ toolName: "run_tests", arguments: { suite: "checkout" } });
    } finally {
      await agent.close().catch(() => undefined);
    }

    // Supervisor declares a delta on the first approved turn (control-channel verb).
    const pre = await sendControl(socketPath, { cmd: "dump_judgment", loop_id: LOOP_ID, mode: "verified-context" });
    const approved = (pre.turns as Array<{ verdict: { kind: string; source: string }; turn_ref: string }>).filter(
      (t) => t.verdict.source === "bind" && t.verdict.kind === "APPROVED"
    );
    const delta = await sendControl(socketPath, {
      cmd: "record_delta",
      loop_id: LOOP_ID,
      turn_ref: approved[0]!.turn_ref,
      delta: { settled: ["checkout fix written"], changed: [TARGET] }
    });
    expect(delta.ok).toBe(true);

    const closed = await sendControl(socketPath, { cmd: "close", session_id: SESSION_ID, outcome: "COMPLETED", reason: "done" });
    expect(closed.sealed).toBe(true);

    return { socketPath };
  }

  it("ctl sends one supervisor command and prints the JSON response", async () => {
    const { socketPath } = await runScopedLoop();
    const { cli, out } = io();
    const rc = await runCtl([JSON.stringify({ cmd: "status" }), "--socket", socketPath], cli, {});
    expect(rc).toBe(0);
    const response = JSON.parse(out.join(""));
    expect(response.ok).toBe(true);
  });

  it("ctl fails closed (no hang) when the control socket closes without a response", async () => {
    const deadPath = join(tmpdir(), `lyhna-dead-control-${process.pid}-${Date.now()}.sock`);
    const { createServer } = await import("node:net");
    // Drain (resume) the read side, then FIN: an unconsumed readable would keep the server-side
    // socket alive and hang server.close() in cleanup.
    const dead = createServer((socket) => {
      socket.resume();
      socket.end();
    });
    await new Promise<void>((resolve, reject) => {
      dead.once("error", reject);
      dead.listen(deadPath, resolve);
    });
    cleanups.push(() => new Promise((resolve) => dead.close(resolve)));

    const { cli, err } = io();
    const rc = await runCtl([JSON.stringify({ cmd: "status" }), "--socket", deadPath], cli, {});
    expect(rc).toBe(1);
    expect(err.join("")).toContain("closed before sending a complete response");
  });

  it("ctl propagates a not-ok response as a non-zero exit", async () => {
    const { socketPath } = await runScopedLoop();
    const { cli } = io();
    const rc = await runCtl([JSON.stringify({ cmd: "dump" }), "--socket", socketPath], cli, {});
    expect(rc).toBe(1);
  });

  it("export-pack writes the full capsule trio from a closed loop in one command", async () => {
    const { socketPath } = await runScopedLoop();
    const outDir = mkdtempSync(join(tmpdir(), "lyhna-export-pack-"));
    cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));

    const { cli, out } = io();
    const rc = await runExportPack(["--loop", LOOP_ID, "--out", outDir, "--socket", socketPath], cli, {});
    expect(rc).toBe(0);

    for (const f of [
      "receipts.json",
      "bundle.json",
      "proof-card.md",
      "HANDOFF.md",
      "continuation-capsule.json",
      "scope-capsule.json",
      "scope-events.json",
      "judgment-ledger.json",
      "judgment-ledger.md",
      "memory-injection.json",
      "verify-instructions.md"
    ]) {
      expect(existsSync(join(outDir, f)), `missing ${f}`).toBe(true);
    }
    const card = readFileSync(join(outDir, "proof-card.md"), "utf8");
    expect(card).toContain("✅ SEALED");
    expect(card).toContain("npx lyhna-verify --chain receipts.json");
    // Default mode follows the sealed scope (verified_context here): the folded delta is present.
    const handoff = readFileSync(join(outDir, "HANDOFF.md"), "utf8");
    expect(handoff).toContain("checkout fix written");
    expect(out.join("")).toContain("SEALED");
  });

  it("export-pack --mode proof downgrades the same loop to a content-blind pack", async () => {
    const { socketPath } = await runScopedLoop();
    const outDir = mkdtempSync(join(tmpdir(), "lyhna-export-pack-proof-"));
    cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));

    const { cli } = io();
    const rc = await runExportPack(["--loop", LOOP_ID, "--out", outDir, "--mode", "proof", "--socket", socketPath], cli, {});
    expect(rc).toBe(0);
    for (const f of ["proof-card.md", "HANDOFF.md", "judgment-ledger.md", "memory-injection.json"]) {
      const text = readFileSync(join(outDir, f), "utf8");
      expect(text, `${f} must be content-blind`).not.toContain("checkout fix written");
      expect(text, `${f} must be content-blind`).not.toContain(TARGET);
      expect(text, `${f} must be content-blind`).not.toContain(GOAL);
    }
  });

  it("export-pack fails closed with no control channel configured", async () => {
    const { cli, err } = io();
    const rc = await runExportPack(["--loop", LOOP_ID, "--out", "/tmp/nope"], cli, {});
    expect(rc).toBe(1);
    expect(err.join("")).toContain("no control channel configured");
  });

  it("export-pack fails closed (does not silently downgrade) when dump_judgment is unavailable", async () => {
    // A standing service WITHOUT a judgment recorder: dump_judgment answers ok:false. The export
    // must refuse rather than emit a judgment-less pack that drops refused turns / runtime hashes.
    const recorder = createReceiptRecorder();
    const scopeEvents = createScopeEventRecorder();
    const bindClient = recorder.wrap(createSyntheticDemoBindClient());
    const registry = new LoopSessionRegistry((r) => bindClient.bind(r), { graceMs: 2000, retryDelayMs: 50 }, scopeEvents);

    const standing: StandingHttpProxy = await serveStandingHttpProxy({
      upstream: syntheticUpstream(),
      bindClient,
      registry,
      host: "127.0.0.1",
      port: 0,
      path: "/mcp"
    });
    cleanups.push(() => standing.close());

    const socketPath = join(tmpdir(), `lyhna-supervisor-cli-nojudg-${process.pid}-${Date.now()}.sock`);
    const control: ControlChannelHandle = await serveControlChannel({
      transport: "unix",
      socketPath,
      registry,
      receiptSource: recorder,
      scopeEventSource: scopeEvents
    });
    cleanups.push(() => control.close());

    const opened = await sendControl(socketPath, {
      cmd: "open",
      session_id: SESSION_ID,
      loop_id: LOOP_ID,
      goal: GOAL,
      scope_capsule: SCOPE_CAPSULE,
      scope_class_map: SCOPE_CLASS_MAP
    });
    expect(opened.ok).toBe(true);

    const agent = await connectStreamableHttpUpstream(standing.sessionUrl(SESSION_ID));
    try {
      await agent.client.callTool({ toolName: "write_file", arguments: { path: TARGET, contents: "// fix" } });
    } finally {
      await agent.close().catch(() => undefined);
    }
    const closed = await sendControl(socketPath, { cmd: "close", session_id: SESSION_ID, outcome: "COMPLETED", reason: "done" });
    expect(closed.sealed).toBe(true);

    const outDir = mkdtempSync(join(tmpdir(), "lyhna-export-pack-nojudg-"));
    cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));
    const { cli, err } = io();
    const rc = await runExportPack(["--loop", LOOP_ID, "--out", outDir, "--socket", socketPath], cli, {});
    expect(rc).toBe(1);
    expect(err.join("")).toContain("dump_judgment failed");
    expect(existsSync(join(outDir, "bundle.json"))).toBe(false);
  });

  it("export-pack fails closed when the ledger dumps EMPTY for a loop whose receipts prove bind turns", async () => {
    // A real loop is captured first (receipts + sealed scope from the live surfaces), then a
    // CANNED control server replays everything faithfully EXCEPT dump_judgment, which answers
    // ok:true with turns:[] — simulating lost/cleared judgment-recorder state. The empty array
    // must flow into the export validator and fail the receipt<->judgment cross-check, never
    // silently produce a judgment-less pack.
    const { socketPath } = await runScopedLoop();
    const dumped = await sendControl(socketPath, { cmd: "dump", loop_id: LOOP_ID });
    const dumpedScope = await sendControl(socketPath, { cmd: "dump_scope", loop_id: LOOP_ID });

    const cannedPath = join(tmpdir(), `lyhna-canned-control-${process.pid}-${Date.now()}.sock`);
    const { createServer } = await import("node:net");
    const canned = createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;
        const command = JSON.parse(buffer.slice(0, nl)) as { cmd: string };
        const response =
          command.cmd === "dump"
            ? dumped
            : command.cmd === "dump_scope"
              ? dumpedScope
              : command.cmd === "dump_judgment"
                ? { ok: true, loop_id: LOOP_ID, mode: "verified_context", count: 0, turns: [] }
                : { ok: false, error: `unexpected ${command.cmd}` };
        socket.end(JSON.stringify(response) + "\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      canned.once("error", reject);
      canned.listen(cannedPath, resolve);
    });
    cleanups.push(() => new Promise((resolve) => canned.close(resolve)));

    const outDir = mkdtempSync(join(tmpdir(), "lyhna-export-pack-emptyledger-"));
    cleanups.push(() => rmSync(outDir, { recursive: true, force: true }));
    const { cli, err } = io();
    const rc = await runExportPack(["--loop", LOOP_ID, "--out", outDir, "--socket", cannedPath], cli, {});
    expect(rc).toBe(1);
    expect(err.join("")).toContain("does not match in-loop receipt count");
    expect(existsSync(join(outDir, "bundle.json"))).toBe(false);
  });
});
