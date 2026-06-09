// Deterministic local demo for Capsule Gate 1 (Scope Capsule -> Continuation Capsule).
//
// Exercises the WHOLE capsule flow against the REAL adapter surfaces, nothing live:
//
//   open loop WITH a Scope Capsule -> in-lane call -> OUT-OF-SCOPE attempt (blocked PRE-BIND,
//   attested) -> corrected in-lane call -> supervisor close -> dump receipts + dump_scope ->
//   build Continuation Capsule -> export Proof Pack -> cold-verify
//
// Real surfaces: standing HTTP MCP transport (agent holds ONLY a per-session URL), the
// supervisor-only control channel (open/close/dump/amend/dump_scope), the LoopSession spine,
// the observe-only receipt recorder, the supervisor-only scope-event recorder, the export CLI,
// and the standalone lyhna-verify. Synthetic-only: the bind (unsigned demo receipts) and the
// upstream tool body. The demo gate runs in Verified Context Mode (so the out-of-scope file path
// is caught by the forbidden-target check) but exports in whichever mode is requested — Proof
// Mode export is structural-only.
//
// HONESTY: demo receipts are UNSIGNED — cold verify reports structural-pass +
// all_receipts_verified:false (crypto fail-by-absence), exactly like the golden-path demo.

import { execFileSync } from "node:child_process";
import { connect as netConnect } from "node:net";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_INDEX = join(ROOT, "dist", "src", "index.js");
const EXPORT_CLI = join(ROOT, "dist", "src", "bin", "export-loop-proof.js");
const TSCONFIG = join(ROOT, "tsconfig.json");
const SRC_ENTRY = join(ROOT, "src", "index.ts");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");
const VERIFY_REPO = "https://github.com/Lyhna-ai/Lyhna-ai-lyhna-verify";

const SESSION_ID = "capsule-session-1";
const LOOP_ID = "loop-capsule-gate-1";
const GOAL = "fix checkout bug";

// The concrete in-lane target the agent writes. Its content-blind hash is declared in the capsule
// so the EXPORT can re-validate the target lane (globs alone are runtime-only — see below).
const CHECKOUT_TARGET = "/checkout/cart.ts";
const targetHash = (t) => "sha256:" + createHash("sha256").update(t, "utf8").digest("hex");

// The Scope Capsule the supervisor seals at open. Structural projection is content-blind; the
// sidecar carries the human plan (Verified Context Mode export only).
//
// TARGET-LANE GUARANTEES (the load-bearing distinction):
//   - allowed_targets / forbidden_targets globs are RUNTIME-GATE guarantees: the adapter sees the
//     plaintext target pre-bind and enforces them before execution (incl. the /billing refusal).
//   - target_descriptor_hashes are EXPORT-PROOF guarantees: content-blind export can re-validate
//     exact hash membership but cannot re-evaluate globs over plaintext it no longer holds, so an
//     export-verifiable target lane must enumerate the concrete in-lane target hash(es).
const SCOPE_CAPSULE = {
  structural: {
    capsule_type: "scope_capsule",
    capsule_version: "scope-capsule/v1",
    loop_id: LOOP_ID,
    goal_hash: "", // filled by the supervisor boundary at open from the loop's canonical goal_hash
    privacy_mode: "verified_context",
    allowed_action_classes: ["read", "write", "run_tests"],
    allowed_targets: ["/checkout/**", "/payments/types.ts"],
    forbidden_targets: ["/billing/migrations/**"],
    target_descriptor_hashes: [targetHash(CHECKOUT_TARGET)],
    // run_tests legitimately operates without a file target; declare it targetless so the
    // fail-closed "unresolved target" rule does not refuse it.
    targetless_action_classes: ["run_tests"]
  },
  sidecar: {
    goal_summary: "fix checkout bug",
    planned_steps: ["edit /checkout", "run tests", "export proof pack"],
    open_questions: ["does the cart total rounding need a separate fix?"],
    next_actions: ["land the checkout fix", "open follow-up if rounding recurs"],
    success_criteria: ["checkout tests pass", "no out-of-lane writes"]
  }
};
const SCOPE_CLASS_MAP = { write_file: "write", read_file: "read", run_tests: "run_tests" };

function ensureDist(log) {
  if (existsSync(DIST_INDEX) && existsSync(EXPORT_CLI)) return;
  if (!(existsSync(TSCONFIG) && existsSync(SRC_ENTRY))) {
    throw new Error("The capsule demo is only supported from a source checkout. Run npm install, then npm run build.");
  }
  log("dist not found — building from source (tsc -p tsconfig.json)...");
  execFileSync(process.execPath, [TSC, "-p", TSCONFIG], { stdio: "inherit" });
  if (!(existsSync(DIST_INDEX) && existsSync(EXPORT_CLI))) {
    throw new Error("Build did not produce dist; run `npm run build` and retry.");
  }
}

/**
 * Run the capsule gate flow through the real surfaces and capture the material (receipts, sealed
 * scope, scope events, continuation). Returns { material, summary } — export is a separate step so
 * the same captured material can be exported in BOTH modes (Verified Context + Proof) without
 * re-running the gate.
 */
export async function captureCapsuleGateLoop({ log = () => {} } = {}) {
  if (!existsSync(DIST_INDEX)) throw new Error(`built library not found at ${DIST_INDEX} — run \`npm run build\` first.`);
  const lib = await import(DIST_INDEX);
  const {
    LoopSessionRegistry,
    serveStandingHttpProxy,
    serveControlChannel,
    connectStreamableHttpUpstream,
    createSyntheticDemoBindClient,
    createReceiptRecorder,
    createScopeEventRecorder,
    buildContinuationCapsule
  } = lib;

  const recorder = createReceiptRecorder();
  const scopeEvents = createScopeEventRecorder();
  const bindClient = recorder.wrap(createSyntheticDemoBindClient());
  const registry = new LoopSessionRegistry((r) => bindClient.bind(r), { graceMs: 2000, retryDelayMs: 50 }, scopeEvents);

  const standing = await serveStandingHttpProxy({
    upstream: syntheticUpstream(),
    bindClient,
    registry,
    host: "127.0.0.1",
    port: 0,
    path: "/mcp"
  });

  const onWindows = process.platform === "win32";
  const socketPath = join(tmpdir(), `lyhna-capsule-control-${process.pid}-${Date.now()}.sock`);
  const control = await serveControlChannel(
    onWindows
      ? { transport: "tcp", host: "127.0.0.1", port: 0, registry, receiptSource: recorder, scopeEventSource: scopeEvents }
      : { transport: "unix", socketPath, registry, receiptSource: recorder, scopeEventSource: scopeEvents }
  );
  const connectControl = onWindows
    ? () => {
        const i = control.address.lastIndexOf(":");
        return netConnect(Number(control.address.slice(i + 1)), control.address.slice(0, i));
      }
    : () => netConnect(socketPath);

  log(`  adapter up: agent MCP=${standing.url}/<session_id>  control(${control.transport})=${control.address}`);

  try {
    // 1) SUPERVISOR opens the loop WITH the Scope Capsule (the agent cannot seal its own scope).
    const opened = await sendControl(connectControl, {
      cmd: "open",
      session_id: SESSION_ID,
      loop_id: LOOP_ID,
      goal: GOAL,
      scope_capsule: SCOPE_CAPSULE,
      scope_class_map: SCOPE_CLASS_MAP
    });
    if (!opened.ok) throw new Error(`open failed: ${JSON.stringify(opened)}`);
    log(`  [supervisor] open  session=${SESSION_ID} loop=${LOOP_ID} scope_ref=${opened.scope_ref}`);

    // 2) AGENT holds ONLY the per-session URL.
    const agent = await connectStreamableHttpUpstream(standing.sessionUrl(SESSION_ID));
    let blockedAttempt = false;
    try {
      await agent.client.listTools();

      // 2a) In-lane write to an allowed target — forwarded.
      await agent.client.callTool({ toolName: "write_file", arguments: { path: "/checkout/cart.ts", contents: "// fix" } });
      log(`  [agent] in-lane  write_file /checkout/cart.ts -> APPROVED & forwarded`);

      // 2b) OUT-OF-SCOPE attempt — the gate catches it BEFORE execution.
      try {
        await agent.client.callTool({
          toolName: "write_file",
          arguments: { path: "/billing/migrations/2026_ledger.sql", contents: "DROP?" }
        });
        log(`  [agent] !! out-of-scope write was NOT blocked (UNEXPECTED)`);
      } catch {
        blockedAttempt = true;
        log(`  [agent] out-of-scope write_file /billing/migrations/2026_ledger.sql -> BLOCKED pre-execution (attested)`);
      }

      // 2c) Corrected in-lane action — forwarded.
      await agent.client.callTool({ toolName: "run_tests", arguments: { suite: "checkout" } });
      log(`  [agent] corrected run_tests checkout -> APPROVED & forwarded`);
    } finally {
      await agent.close().catch(() => undefined);
    }
    if (!blockedAttempt) throw new Error("expected the out-of-scope attempt to be blocked, but it was not");

    // 3) SUPERVISOR closes the loop.
    const closed = await sendControl(connectControl, { cmd: "close", session_id: SESSION_ID, outcome: "COMPLETED", reason: "capsule_demo_done" });
    if (!closed.ok || closed.sealed !== true) throw new Error(`supervisor close did not seal: ${JSON.stringify(closed)}`);
    log(`  [supervisor] close session=${SESSION_ID} sealed=true receipt=${closed.receipt_id}`);

    // 4) SUPERVISOR dumps the sealed chain + the scope history / attested scope events.
    const dumped = await sendControl(connectControl, { cmd: "dump", loop_id: LOOP_ID });
    if (!dumped.ok || !Array.isArray(dumped.receipts)) throw new Error(`dump failed: ${JSON.stringify(dumped)}`);
    const dumpedScope = await sendControl(connectControl, { cmd: "dump_scope", loop_id: LOOP_ID });
    if (!dumpedScope.ok) throw new Error(`dump_scope failed: ${JSON.stringify(dumpedScope)}`);
    log(`  [supervisor] dump  loop=${LOOP_ID} receipts=${dumped.count} scope_events=${dumpedScope.scope_events.length}`);

    // 5) SUPERVISOR builds the Continuation Capsule (settled/open/next come from the supervisor).
    const sealedScope = dumpedScope.scope_history[dumpedScope.scope_history.length - 1];
    const continuation = buildContinuationCapsule({
      scope_history: dumpedScope.scope_history,
      scope_events: dumpedScope.scope_events,
      loop: { loop_id: LOOP_ID, goal_hash: sealedScope.structural.goal_hash, sealed: true, action_count: dumped.count - 1 },
      settled: ["checkout fix written to /checkout/cart.ts", "checkout tests run"],
      open_questions: ["does the cart total rounding need a separate fix?"],
      next_actions: ["land the checkout fix", "open follow-up if rounding recurs"],
      mode: "verified_context"
    });

    return {
      material: {
        receiptsText: JSON.stringify(dumped.receipts, null, 2),
        sealedScope,
        scopeHistory: dumpedScope.scope_history,
        continuation,
        scopeEvents: dumpedScope.scope_events
      },
      summary: {
        loopId: LOOP_ID,
        scopeRef: opened.scope_ref,
        actionCount: dumped.count - 1,
        receiptCount: dumped.count,
        scopeEventCount: dumpedScope.scope_events.length
      }
    };
  } finally {
    await control.close().catch(() => undefined);
    await standing.close().catch(() => undefined);
  }
}

/**
 * Export a captured capsule loop into a Proof Pack at `outDir` in the requested mode
 * ("proof" | "verified-context"). Uses the real export CLI (receipts never reshaped).
 */
export function exportCapsulePack({ material, outDir, mode = "verified-context", exportCli = EXPORT_CLI }) {
  mkdirSync(outDir, { recursive: true });
  const srcDir = mkdtempSync(join(tmpdir(), "lyhna-capsule-src-"));
  try {
    const receiptsPath = join(srcDir, "receipts.json");
    const scopePath = join(srcDir, "scope.json");
    const historyPath = join(srcDir, "scope-history.json");
    const continuationPath = join(srcDir, "continuation.json");
    const eventsPath = join(srcDir, "events.json");
    writeFileSync(receiptsPath, material.receiptsText);
    writeFileSync(scopePath, JSON.stringify(material.sealedScope, null, 2));
    writeFileSync(historyPath, JSON.stringify(material.scopeHistory ?? [material.sealedScope], null, 2));
    writeFileSync(continuationPath, JSON.stringify(material.continuation, null, 2));
    writeFileSync(eventsPath, JSON.stringify(material.scopeEvents, null, 2));
    execFileSync(
      "node",
      [
        exportCli, receiptsPath, "--out", outDir, "--source-env", "demo-capsule-gate",
        "--scope-capsule", scopePath, "--scope-history", historyPath, "--continuation", continuationPath,
        "--scope-events", eventsPath, "--mode", mode
      ],
      { stdio: "pipe" }
    );
  } finally {
    rmSync(srcDir, { recursive: true, force: true });
  }
  return { outDir, receiptsPath: join(outDir, "receipts.json") };
}

/**
 * Full producer: capture the gate loop, then export a pack in `mode`. Used by the CLI and by the
 * verify-legs capsule leg.
 */
export async function produceCapsuleGateBundle({ outDir, exportCli = EXPORT_CLI, mode = "verified-context", log = () => {} } = {}) {
  const { material, summary } = await captureCapsuleGateLoop({ log });
  const { receiptsPath } = exportCapsulePack({ material, outDir, mode, exportCli });
  return { ...summary, outDir, receiptsPath, material };
}

// --- helpers -----------------------------------------------------------------

function syntheticUpstream() {
  return {
    async listTools() {
      return [
        { name: "write_file", description: "write a file (synthetic demo upstream)", inputSchema: { type: "object" } },
        { name: "read_file", description: "read a file (synthetic demo upstream)", inputSchema: { type: "object" } },
        { name: "run_tests", description: "run tests (synthetic demo upstream)", inputSchema: { type: "object" } }
      ];
    },
    async callTool(call) {
      return { content: [{ type: "text", text: `ok:${call.toolName}` }], structuredContent: { tool: call.toolName } };
    }
  };
}

function sendControl(connect, command) {
  return new Promise((resolve, reject) => {
    const socket = connect();
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(command) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        socket.end();
        resolve(JSON.parse(line));
      }
    });
    socket.on("error", reject);
  });
}

function resolveVerifyDir(workDir, log) {
  const dir = process.env.LYHNA_VERIFY_DIR;
  if (dir && existsSync(join(dir, "bin", "lyhna-verify.mjs"))) {
    log(`Using existing lyhna-verify checkout: ${dir}`);
    return dir;
  }
  const dest = join(workDir, "lyhna-verify");
  log(`Cloning lyhna-verify (read-only) -> ${dest}`);
  execFileSync("git", ["clone", "--depth", "1", VERIFY_REPO, dest], { stdio: "inherit" });
  return dest;
}

function runVerifier(verifyDir, receiptsPath) {
  const bin = join(verifyDir, "bin", "lyhna-verify.mjs");
  try {
    const out = execFileSync("node", [bin, "--chain", receiptsPath, "--json"], { encoding: "utf8" });
    return { exitCode: 0, json: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout ? e.stdout.toString() : "";
    let json = null;
    try {
      json = JSON.parse(out);
    } catch {
      json = null;
    }
    return { exitCode: typeof e.status === "number" ? e.status : 1, json };
  }
}

/** Assert a synthetic capsule chain cold-verifies structurally and does NOT verify as signed. */
export function assertSyntheticColdVerify(json) {
  if (!json || json.mode !== "chain" || !Array.isArray(json.chains) || json.chains.length !== 1) {
    return { ok: false, detail: "verifier did not consume the bare side-car as a single chain" };
  }
  const c = json.chains[0];
  const structuralOk =
    c.sealed === true && c.continuity_ok === true && c.loop_id_consistent === true &&
    c.goal_hash_consistent === true && c.action_count_ok === true;
  if (!structuralOk) {
    return { ok: false, detail: `structural invariants did not all pass: ${JSON.stringify(c)}` };
  }
  if (c.all_receipts_verified !== false) {
    return { ok: false, detail: `synthetic chain reported all_receipts_verified=${JSON.stringify(c.all_receipts_verified)} — must NOT verify as signed` };
  }
  return { ok: true, detail: "structural pass + crypto fail-by-absence (all_receipts_verified:false)" };
}

// --- standalone CLI ----------------------------------------------------------

async function main() {
  const log = (s) => process.stdout.write(s + "\n");
  ensureDist(log);
  const scratch = mkdtempSync(join(tmpdir(), "lyhna-capsule-"));
  const outDir = join(tmpdir(), "lyhna-capsule-proof-pack");
  try {
    log("=== Lyhna Capsule Gate 1 — deterministic local demo ===\n");
    log("open(scope) -> in-lane -> out-of-scope BLOCKED & attested -> corrected -> close -> dump -> continuation -> export -> verify cold\n");

    const produced = await produceCapsuleGateBundle({ outDir, exportCli: EXPORT_CLI, mode: "verified-context", log });

    log("\nCold-verifying the exported capsule pack with the real, standalone lyhna-verify...");
    const verifyDir = resolveVerifyDir(scratch, log);
    const { json } = runVerifier(verifyDir, produced.receiptsPath);
    const verdict = assertSyntheticColdVerify(json);

    log("");
    if (!verdict.ok) {
      log(`  ✗ DEMO cold-verify FAILED: ${verdict.detail}`);
      process.exitCode = 1;
      return;
    }
    log(`  ✓ DEMO cold-verify: ${verdict.detail}`);
    log(`  ✓ scope_ref=${produced.scopeRef}  attested scope events=${produced.scopeEventCount}  action_count=${produced.actionCount}`);
    log("");
    log(`Proof Pack written to: ${outDir}  (preserved after exit)`);
    log(`  scope-capsule.json        — sealed Scope Capsule (Verified Context: structural + sidecar)`);
    log(`  proof-card.md             — one-page human summary`);
    log(`  receipts.json             — the verifier input (bare receipt array)`);
    log(`  bundle.json               — additive envelope (+ capsule refs by hash)`);
    log(`  graph-node.json / .md     — Authority Context Graph node`);
    log(`  continuation-capsule.json — settled/open/next + what changed`);
    log(`  scope-events.json         — attested scope refusal(s)`);
    log(`  verify-instructions.md    — how to cold-verify`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`\nCAPSULE DEMO FATAL: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  });
}
