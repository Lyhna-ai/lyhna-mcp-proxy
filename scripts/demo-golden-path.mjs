// Deterministic local golden-path demo for the Lyhna Loop Proof Adapter for MCP.
//
// Exercises the WHOLE adapter flow against the REAL product surfaces, with nothing live:
//
//   start adapter -> open loop -> route synthetic MCP call -> supervisor close loop
//     -> dump sealed chain -> export LoopProofBundle -> verify COLD
//
// Real surfaces exercised: the standing HTTP MCP transport (agent holds ONLY a per-session
// URL), the supervisor-only control channel (unix socket: open / close / dump), the
// LoopSession spine, the observe-only receipt recorder, the export CLI, and the standalone
// `lyhna-verify`. Synthetic-only pieces: the bind (unsigned demo receipts) and the upstream
// tool body (an in-process echo). No Chione/Hermes/Keryke, no live bind, no network bind.
//
// HONESTY: the demo receipts are UNSIGNED. Cold verify therefore reports structural-pass +
// `all_receipts_verified:false` (crypto fail-by-absence) — that is the EXPECTED, asserted
// outcome here and in CI Leg 0. Full-green signed proof remains the static corpus (Leg 2).
//
// This module exports `produceGoldenPathBundle` and `assertSyntheticColdVerify` so CI's
// verify-legs Leg 0 drives the exact same producer. Running it directly performs the demo
// end to end and prints the four bundle artifacts plus the cold-verify verdict line.

import { execFileSync } from "node:child_process";
import { connect as netConnect } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_INDEX = join(ROOT, "dist", "src", "index.js");
const EXPORT_CLI = join(ROOT, "dist", "src", "bin", "export-loop-proof.js");
const VERIFY_REPO = "https://github.com/Lyhna-ai/Lyhna-ai-lyhna-verify";

const SESSION_ID = "demo-session-1";
const LOOP_ID = "loop-demo-golden-path";
const GOAL = "Lyhna Loop Proof Adapter — deterministic local golden-path demo";
const CALLS = 3;

// --- the producer: open -> route -> close -> dump -> export -------------------

/**
 * Run the adapter golden path through the real surfaces and export a LoopProofBundle into
 * `outDir`. Returns { receiptsPath, outDir, loopId, actionCount, receiptCount }.
 *
 * `exportCli` lets the caller (verify-legs) point at its own built CLI path; defaults to
 * this repo's dist export CLI.
 */
export async function produceGoldenPathBundle({ outDir, exportCli = EXPORT_CLI, log = () => {} } = {}) {
  if (!existsSync(DIST_INDEX)) {
    throw new Error(`built library not found at ${DIST_INDEX} — run \`npm run build\` first.`);
  }
  const lib = await import(DIST_INDEX);
  const {
    LoopSessionRegistry,
    serveStandingHttpProxy,
    serveControlChannel,
    connectStreamableHttpUpstream,
    createSyntheticDemoBindClient,
    createReceiptRecorder
  } = lib;

  // Observe-only recorder wrapping the synthetic demo bind. The same wrapped client backs
  // both the in-loop path and the close path, so the recorded chain is complete and ordered.
  const recorder = createReceiptRecorder();
  const bindClient = recorder.wrap(createSyntheticDemoBindClient());
  const registry = new LoopSessionRegistry((r) => bindClient.bind(r), { graceMs: 2000, retryDelayMs: 50 });

  const standing = await serveStandingHttpProxy({
    upstream: syntheticUpstream(),
    bindClient,
    registry,
    host: "127.0.0.1",
    port: 0,
    path: "/mcp"
  });
  const socketPath = join(tmpdir(), `lyhna-demo-control-${process.pid}-${Date.now()}.sock`);
  const control = await serveControlChannel({ transport: "unix", socketPath, registry, receiptSource: recorder });

  log(`  adapter up: agent MCP=${standing.url}/<session_id>  control(unix)=${socketPath}`);

  try {
    // 1) SUPERVISOR opens the loop on the control channel (the agent cannot).
    const opened = await sendControl(socketPath, { cmd: "open", session_id: SESSION_ID, loop_id: LOOP_ID, goal: GOAL });
    if (!opened.ok) throw new Error(`open failed: ${JSON.stringify(opened)}`);
    log(`  [supervisor] open  session=${SESSION_ID} loop=${LOOP_ID}`);

    // 2) AGENT holds ONLY the per-session URL and routes synthetic MCP calls.
    const agent = await connectStreamableHttpUpstream(standing.sessionUrl(SESSION_ID));
    try {
      await agent.client.listTools();
      for (let i = 0; i < CALLS; i += 1) {
        await agent.client.callTool({ toolName: "echo", arguments: { message: `demo-${i}` } });
      }
    } finally {
      await agent.close().catch(() => undefined);
    }
    log(`  [agent] routed ${CALLS} synthetic tools/call over the session URL`);

    // 3) SUPERVISOR closes the loop — seals the terminal loop_close.
    const closed = await sendControl(socketPath, { cmd: "close", session_id: SESSION_ID, outcome: "COMPLETED", reason: "demo_done" });
    if (!closed.ok || closed.sealed !== true) throw new Error(`supervisor close did not seal: ${JSON.stringify(closed)}`);
    log(`  [supervisor] close session=${SESSION_ID} sealed=true receipt=${closed.receipt_id}`);

    // 4) SUPERVISOR dumps the sealed chain (read-only control verb; agent can't reach it).
    const dumped = await sendControl(socketPath, { cmd: "dump", loop_id: LOOP_ID });
    if (!dumped.ok || !Array.isArray(dumped.receipts)) throw new Error(`dump failed: ${JSON.stringify(dumped)}`);
    log(`  [supervisor] dump  loop=${LOOP_ID} receipts=${dumped.count}`);

    // 5) Orchestrator writes receipts.json, then the export CLI packages the bundle.
    //    (Proxy proved; supervisor packages — receipts are never reshaped.)
    mkdirSync(outDir, { recursive: true });
    const srcDir = mkdtempSync(join(tmpdir(), "lyhna-demo-src-"));
    const srcReceipts = join(srcDir, "receipts.json");
    writeFileSync(srcReceipts, JSON.stringify(dumped.receipts, null, 2));
    execFileSync("node", [exportCli, srcReceipts, "--out", outDir, "--source-env", "demo-golden-path"], { stdio: "pipe" });
    rmSync(srcDir, { recursive: true, force: true });
    log(`  exported bundle -> ${outDir} (receipts.json, bundle.json, graph-node.json, graph-node.md)`);

    return {
      receiptsPath: join(outDir, "receipts.json"),
      outDir,
      loopId: LOOP_ID,
      actionCount: CALLS,
      receiptCount: dumped.count
    };
  } finally {
    await control.close().catch(() => undefined);
    await standing.close().catch(() => undefined);
  }
}

/**
 * Assert the cold-verify verdict for a SYNTHETIC bundle, BOTH directions REQUIRED:
 *   - structural invariants must all pass (sealed, continuity, loop/goal consistency, count);
 *   - all_receipts_verified MUST be false (synthetic must NOT verify as signed).
 * Returns { ok, detail }. A true `all_receipts_verified`, or any structural miss, is ok:false.
 */
export function assertSyntheticColdVerify(json) {
  if (!json || json.mode !== "chain" || !Array.isArray(json.chains) || json.chains.length !== 1) {
    return { ok: false, detail: "verifier did not consume the bare side-car as a single chain (shape adaptation would be required)" };
  }
  const c = json.chains[0];
  const structuralOk =
    c.sealed === true &&
    c.continuity_ok === true &&
    c.loop_id_consistent === true &&
    c.goal_hash_consistent === true &&
    c.action_count_ok === true;
  if (!structuralOk) {
    return {
      ok: false,
      detail: `structural invariants did not all pass: ${JSON.stringify({
        sealed: c.sealed, continuity_ok: c.continuity_ok, loop_id_consistent: c.loop_id_consistent,
        goal_hash_consistent: c.goal_hash_consistent, action_count_ok: c.action_count_ok
      })}`
    };
  }
  if (c.all_receipts_verified !== false) {
    return {
      ok: false,
      detail: `synthetic chain reported all_receipts_verified=${JSON.stringify(c.all_receipts_verified)} — synthetic must NOT verify as signed (would be synthetic masquerading as signed)`
    };
  }
  return { ok: true, detail: "structural pass + crypto fail-by-absence (all_receipts_verified:false)" };
}

// --- helpers -----------------------------------------------------------------

// In-process synthetic upstream: a single `echo` tool. Keeps the demo self-contained (no
// child upstream process), so it is deterministic and cross-platform. The bind APPROVES,
// so each call forwards here and returns.
function syntheticUpstream() {
  return {
    async listTools() {
      return [
        {
          name: "echo",
          description: "echo (synthetic demo upstream)",
          inputSchema: { type: "object", properties: { message: { type: "string" } } }
        }
      ];
    },
    async callTool(call) {
      const message = String(call.arguments?.message ?? "");
      return { content: [{ type: "text", text: message }], structuredContent: { message } };
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

// --- standalone CLI ----------------------------------------------------------

async function main() {
  const log = (s) => process.stdout.write(s + "\n");
  if (!existsSync(EXPORT_CLI)) {
    throw new Error(`export CLI not found at ${EXPORT_CLI} — run \`npm run build\` first.`);
  }
  const work = mkdtempSync(join(tmpdir(), "lyhna-demo-"));
  try {
    log("=== Lyhna Loop Proof Adapter for MCP — local golden-path demo ===\n");
    log("start adapter -> open -> route synthetic call -> supervisor close -> dump -> export -> verify cold\n");

    const outDir = join(work, "loop-proof-bundle");
    const produced = await produceGoldenPathBundle({ outDir, exportCli: EXPORT_CLI, log });

    log("\nCold-verifying the exported bundle with the real, standalone lyhna-verify...");
    const verifyDir = resolveVerifyDir(work, log);
    const { json } = runVerifier(verifyDir, produced.receiptsPath);
    const verdict = assertSyntheticColdVerify(json);

    log("");
    if (!verdict.ok) {
      log(`  ✗ DEMO cold-verify FAILED: ${verdict.detail}`);
      process.exitCode = 1;
      return;
    }
    log(`  ✓ DEMO cold-verify: ${verdict.detail}`);
    log("");
    log(`Bundle written to: ${outDir}`);
    log(`  receipts.json    — the verifier input (bare receipt array)`);
    log(`  bundle.json      — additive envelope (trust root, scheme, digest, advisory verdict)`);
    log(`  graph-node.json  — Authority Context Graph node`);
    log(`  graph-node.md    — the node, rendered`);
    log("");
    log("This demo is SYNTHETIC and UNSIGNED on purpose: structural truth holds, crypto is");
    log("absent. Full-green signed proof comes from the static signed corpus (CI Leg 2).");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`\nDEMO FATAL: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  });
}
