// Lane B — the canonical "came through the live loop" receipt.
//
// Everything else in the witness story can be hand-authored; THIS one cannot. This script drives the
// REAL standing-service loop end to end with CLAIM CAPTURE ON (the in-process equivalent of starting
// the HTTP proxy with LYHNA_PROXY_CLAIM_CAPTURE=1), lets an agent route real MCP tool calls AND record
// its own claims about what it did, then runs the supervisor-side `export-pack` — the same code path the
// product ships — to emit `witness-input.json`. That file is the proxy half of claimed-vs-actual; the
// sibling `lyhna-witness` renders it into the human receipt. We commit the emitted witness-input.json as
// the canonical proof that the receipt is produced by the loop, not typed by hand.
//
// Real surfaces exercised (mirrors tests/supervisor-cli.test.ts, nothing live):
//   standing HTTP MCP transport (agent holds ONLY a per-session URL) · supervisor-only control channel
//   (unix socket) · the LoopSession spine + scope gate · the agent-facing record_claim capture · the
//   judgment ledger · runExportPack (dump → dump_judgment → dump_claims → assembleWitnessInput).
//
// HONESTY / V1 CEILING. The witness is action-level only: it witnesses what crossed the tool boundary
// and compares it to what the agent claimed. The scenario below is deliberately mixed so the receipt
// shows its teeth honestly:
//   - the file write and the test run were BOTH witnessed crossing the wire AND claimed → SUPPORTED;
//   - the agent ALSO claimed it emailed the client the corrected invoice, but made no email tool call,
//     so the witness saw nothing → UNSUPPORTED / DO_NOT_SEND (the dangerous "claimed but never seen").
// The upstream tool bodies are synthetic and the demo bind is UNSIGNED — same posture as the
// golden-path demo. What is REAL is the path the claims and events take to become a receipt.

import { mkdirSync, mkdtempSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { connect as netConnect } from "node:net";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_INDEX = join(ROOT, "dist", "src", "index.js");
const DEFAULT_OUT = join(ROOT, "examples", "live-loop");
const TSCONFIG = join(ROOT, "tsconfig.json");
const SRC_ENTRY = join(ROOT, "src", "index.ts");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");

// Keep this runnable from a clean checkout. `npm test` runs vitest WITHOUT `npm run build`, and the
// standalone demo may also run before a build — so if the built library is missing but the TS sources
// are present, build it once here; fail clearly if neither dist nor sources exist (e.g. a packed
// install). Mirrors scripts/demo-golden-path.mjs's ensureDist. A present dist makes this a no-op.
function ensureDist(log) {
  if (existsSync(DIST_INDEX)) return;
  if (!(existsSync(TSCONFIG) && existsSync(SRC_ENTRY))) {
    throw new Error(`built library not found at ${DIST_INDEX} and no TS sources to build — run \`npm run build\`.`);
  }
  log("dist not found — building from source (tsc -p tsconfig.json)...");
  execFileSync(process.execPath, [TSC, "-p", TSCONFIG], { stdio: "inherit" });
  if (!existsSync(DIST_INDEX)) throw new Error("build did not produce dist; run `npm run build` and retry.");
}

const SESSION_ID = "live-loop-session";
const LOOP_ID = "loop-checkout-fix";
const GOAL = "Fix the checkout total rounding bug, run the tests, and confirm with the client";
const FIX_TARGET = "/checkout/total.ts";

const targetHash = (t) => "sha256:" + createHash("sha256").update(t, "utf8").digest("hex");

// MCP-namespaced tool names (mcp__<server>__<tool>) so the witness derives a real system+action from
// the wire name (filesystem.write_file, test_runner.run_tests) and a matching claim reads as SUPPORTED
// instead of a spurious system mismatch.
const WRITE_TOOL = "mcp__filesystem__write_file";
const TEST_TOOL = "mcp__test_runner__run_tests";

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
    target_descriptor_hashes: [targetHash(FIX_TARGET)],
    targetless_action_classes: ["run_tests"]
  },
  sidecar: { goal_summary: "Fix the checkout total rounding bug and confirm the fix with the client" }
};
const SCOPE_CLASS_MAP = { [WRITE_TOOL]: "write", [TEST_TOOL]: "run_tests" };

// In-process synthetic upstream: a filesystem write tool and a test runner. Deterministic, no child
// process, no network — only the loop machinery around them is real.
function syntheticUpstream() {
  return {
    async listTools() {
      return [
        { name: WRITE_TOOL, description: "write a file", inputSchema: { type: "object" } },
        { name: TEST_TOOL, description: "run a test suite", inputSchema: { type: "object" } }
      ];
    },
    async callTool(call) {
      return {
        content: [{ type: "text", text: `ok:${call.toolName}` }],
        structuredContent: { tool: call.toolName }
      };
    }
  };
}

// Supervisor control client: one connection per command, newline-delimited JSON.
function sendControl(socketPath, command) {
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
        resolve(JSON.parse(buffer.slice(0, nl)));
      }
    });
    socket.on("error", reject);
  });
}

/**
 * Drive the real loop and run export-pack into `packDir`; return the witness-input.json path.
 * `packDir` receives the full proof pack; the caller decides what to keep as the committed artifact.
 */
export async function produceLiveLoopReceipt({ packDir, log = () => {} } = {}) {
  ensureDist(log);
  const {
    LoopSessionRegistry,
    serveStandingHttpProxy,
    serveControlChannel,
    connectStreamableHttpUpstream,
    createSyntheticDemoBindClient,
    createReceiptRecorder,
    createScopeEventRecorder,
    createJudgmentRecorder,
    createClaimRecorder,
    runExportPack
  } = await import(DIST_INDEX);

  const recorder = createReceiptRecorder();
  const scopeEvents = createScopeEventRecorder();
  const judgment = createJudgmentRecorder();
  const claims = createClaimRecorder(); // CLAIM CAPTURE ON (== LYHNA_PROXY_CLAIM_CAPTURE=1 in the HTTP bin)
  const bindClient = recorder.wrap(createSyntheticDemoBindClient());
  const registry = new LoopSessionRegistry(
    (r) => bindClient.bind(r),
    { graceMs: 2000, retryDelayMs: 50 },
    scopeEvents,
    judgment
  );

  const standing = await serveStandingHttpProxy({
    upstream: syntheticUpstream(),
    bindClient,
    registry,
    claims,
    host: "127.0.0.1",
    port: 0,
    path: "/mcp"
  });
  const socketPath = join(tmpdir(), `lyhna-live-loop-${process.pid}-${Date.now()}.sock`);
  const control = await serveControlChannel({
    transport: "unix",
    socketPath,
    registry,
    receiptSource: recorder,
    scopeEventSource: scopeEvents,
    judgmentRecorder: judgment,
    claimSource: claims
  });

  try {
    // 1) SUPERVISOR opens the scoped loop (the agent never reaches the control channel).
    const opened = await sendControl(socketPath, {
      cmd: "open",
      session_id: SESSION_ID,
      loop_id: LOOP_ID,
      goal: GOAL,
      scope_capsule: SCOPE_CAPSULE,
      scope_class_map: SCOPE_CLASS_MAP
    });
    if (!opened.ok) throw new Error(`open failed: ${JSON.stringify(opened)}`);
    log(`  [supervisor] open  loop=${LOOP_ID}`);

    // 2) AGENT holds ONLY the per-session URL: routes its real tool calls AND records its own claims.
    const agent = await connectStreamableHttpUpstream(standing.sessionUrl(SESSION_ID));
    try {
      // — witnessed work, in order —
      await agent.client.callTool({ toolName: WRITE_TOOL, arguments: { path: FIX_TARGET, contents: "// rounding fix" } });
      await agent.client.callTool({ toolName: TEST_TOOL, arguments: { suite: "checkout" } });

      // — the agent's claims about what it did (record_claim is captured locally, never forwarded
      //   upstream, and the agent can never read the witnessed ledger back). Sequential = the V1
      //   contract: claim i pairs with witnessed turn i.
      await agent.client.callTool({
        toolName: "record_claim",
        arguments: { system: "filesystem", action: "write_file", result: "patched the checkout rounding bug" }
      });
      await agent.client.callTool({
        toolName: "record_claim",
        arguments: { system: "test_runner", action: "run_tests", result: "all checkout tests pass" }
      });
      // The dangerous one: the agent SAYS it emailed the client, but never made an email tool call.
      await agent.client.callTool({
        toolName: "record_claim",
        arguments: { system: "gmail", action: "send", result: "emailed the client the corrected invoice", user_facing: true }
      });
      log(`  [agent] routed 2 witnessed tool calls + recorded 3 claims (1 with no matching call)`);
    } finally {
      await agent.close().catch(() => undefined);
    }

    // 3) SUPERVISOR settles the file fix on its witnessed turn (folds into the handoff continuation).
    const pre = await sendControl(socketPath, { cmd: "dump_judgment", loop_id: LOOP_ID, mode: "verified-context" });
    const approved = (pre.turns ?? []).filter((t) => t.verdict.source === "bind" && t.verdict.kind === "APPROVED");
    if (approved.length === 0) throw new Error("expected at least one approved bind turn to settle");
    const delta = await sendControl(socketPath, {
      cmd: "record_delta",
      loop_id: LOOP_ID,
      turn_ref: approved[0].turn_ref,
      delta: { settled: ["checkout total rounding bug patched"], changed: [FIX_TARGET] }
    });
    if (!delta.ok) throw new Error(`record_delta failed: ${JSON.stringify(delta)}`);

    // 4) SUPERVISOR closes (seals the chain), then export-pack emits the proof pack + witness-input.json.
    const closed = await sendControl(socketPath, { cmd: "close", session_id: SESSION_ID, outcome: "COMPLETED", reason: "done" });
    if (closed.sealed !== true) throw new Error(`close did not seal: ${JSON.stringify(closed)}`);
    log(`  [supervisor] close sealed=true`);

    mkdirSync(packDir, { recursive: true });
    const out = [];
    const rc = await runExportPack(
      ["--loop", LOOP_ID, "--out", packDir, "--socket", socketPath],
      { stdout: (t) => out.push(t), stderr: (t) => out.push(t) },
      {}
    );
    if (rc !== 0) throw new Error(`export-pack failed (rc=${rc}):\n${out.join("")}`);
    const witnessInputPath = join(packDir, "witness-input.json");
    if (!existsSync(witnessInputPath)) {
      throw new Error(`export-pack did not emit witness-input.json:\n${out.join("")}`);
    }
    log(`  [supervisor] export-pack -> ${packDir} (witness-input.json emitted)`);
    return { witnessInputPath, packDir, loopId: LOOP_ID };
  } finally {
    await control.close().catch(() => undefined);
    await standing.close().catch(() => undefined);
  }
}

// --- standalone CLI: regenerate the committed canonical artifact -------------------------------------

async function main() {
  const log = (s) => process.stdout.write(s + "\n");
  log("=== Lyhna — canonical live-loop receipt (Lane B) ===\n");
  log("open scoped loop -> agent routes tool calls + records claims -> settle -> close -> export-pack\n");

  // Export the full proof pack to a scratch dir, then keep ONLY witness-input.json as the committed
  // canonical artifact (the proxy half). The signed/proof-pack files are reproducible by re-running
  // this script; the witness repo renders the committed witness-input.json into the human receipt.
  const scratch = mkdtempSync(join(tmpdir(), "lyhna-live-loop-pack-"));
  const { witnessInputPath } = await produceLiveLoopReceipt({ packDir: scratch, log });

  mkdirSync(DEFAULT_OUT, { recursive: true });
  const dest = join(DEFAULT_OUT, "witness-input.json");
  copyFileSync(witnessInputPath, dest);
  log(`\nCanonical artifact written: ${dest}`);
  log("Render the human receipt with the sibling package:");
  log(`  lyhna-witness ${dest} <outDir>`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`\nLIVE-LOOP FATAL: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  });
}
