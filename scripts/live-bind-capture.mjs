// Live-Bind Gate — supervisor-side capture driver (WS-A).
//
// Drives the SUPERVISOR half of one live Chione/Hermes loop against an ALREADY-RUNNING
// standing adapter (started in http bind mode against the hosted Lyhna tenant — see
// docs/LIVE-BIND-GATE.md). It connects to the adapter's supervisor control channel ONLY;
// it never touches the agent's MCP path. The topology it enforces is exactly the gate's:
//
//   [this driver / supervisor]            [Chione on Hermes / agent]
//        control channel                      per-session MCP URL
//        open ──────────────► adapter ◄────── tools/call (drives the loop)
//        close (authoritative) ─────►
//        dump ──────────────►
//        export ► tests/fixtures/live/chione-hermes/
//
// Invariants this driver upholds (the same the registry guarantees, exercised live):
//   - EXPLICIT supervisor close is authoritative for the terminal outcome semantics;
//   - the agent path has NO close verb — only this control channel closes the loop;
//   - SIGTERM on the adapter is the fail-safe seal (handled by the adapter, not here);
//   - exactly ONE terminal receipt; no open-loop leak (verified at capture + by Leg 3).
//
// This driver performs NO bind itself and holds NO signing keys — signing is the hosted
// Lyhna tenant's, captured through the adapter's observe-only recorder. It writes the
// exported artifacts to the live fixture dir so CI Leg 3 can cold-verify them.
//
// Inputs (env):
//   LYHNA_PROXY_CONTROL_SOCKET            unix control socket of the running adapter, OR
//   LYHNA_PROXY_CONTROL_HOST/PORT         tcp control listener of the running adapter
//   LYHNA_BIND_GATE_SESSION_ID            default "chione-hermes-live"
//   LYHNA_BIND_GATE_LOOP_ID               REQUIRED — a fresh, single-use loop id (uuid)
//   LYHNA_BIND_GATE_GOAL                  REQUIRED — the loop goal (goal_hash is derived hosted-side)
//   LYHNA_BIND_GATE_OUTCOME               default "COMPLETED" (the EXPLICIT, authoritative outcome)
//   LYHNA_BIND_GATE_REASON                default "explicit_supervisor_close"
//   LYHNA_BIND_GATE_OUT                   default tests/fixtures/live/chione-hermes
//   LYHNA_BIND_GATE_AUTOCLOSE             if "1", close immediately after open (e.g. a zero-action
//                                         smoke loop); otherwise wait for ENTER on stdin so the
//                                         operator can let Chione drive the loop first.

import { execFileSync } from "node:child_process";
import { connect as netConnect } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXPORT_CLI = join(ROOT, "dist", "src", "bin", "export-loop-proof.js");
const DEFAULT_OUT = join(ROOT, "tests", "fixtures", "live", "chione-hermes");

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`${name} is required (see docs/LIVE-BIND-GATE.md).`);
  }
  return v;
}

function controlConnector() {
  const socketPath = process.env.LYHNA_PROXY_CONTROL_SOCKET?.trim();
  if (socketPath) {
    return { describe: `unix:${socketPath}`, connect: () => netConnect(socketPath) };
  }
  const host = process.env.LYHNA_PROXY_CONTROL_HOST?.trim() ?? "127.0.0.1";
  const port = Number(process.env.LYHNA_PROXY_CONTROL_PORT?.trim());
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      "Set LYHNA_PROXY_CONTROL_SOCKET (unix) or LYHNA_PROXY_CONTROL_HOST/PORT (tcp) to the running adapter's control listener."
    );
  }
  return { describe: `tcp:${host}:${port}`, connect: () => netConnect(port, host) };
}

// One connection per command, newline-delimited JSON — the control channel's wire format.
function sendControl(connect, command) {
  return new Promise((resolve, reject) => {
    const socket = connect();
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(command) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const i = buffer.indexOf("\n");
      if (i !== -1) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, i)));
      }
    });
    socket.on("error", reject);
  });
}

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function main() {
  const log = (s) => process.stdout.write(s + "\n");
  const { describe, connect } = controlConnector();

  const sessionId = process.env.LYHNA_BIND_GATE_SESSION_ID?.trim() || "chione-hermes-live";
  const loopId = requireEnv("LYHNA_BIND_GATE_LOOP_ID");
  const goal = requireEnv("LYHNA_BIND_GATE_GOAL");
  const outcome = process.env.LYHNA_BIND_GATE_OUTCOME?.trim() || "COMPLETED";
  const reason = process.env.LYHNA_BIND_GATE_REASON?.trim() || "explicit_supervisor_close";
  const outDir = process.env.LYHNA_BIND_GATE_OUT?.trim() || DEFAULT_OUT;

  log("=== Live-Bind Gate — supervisor capture (Chione/Hermes through hosted Lyhna) ===");
  log(`  control channel: ${describe}`);

  // 1) SUPERVISOR opens the loop. The agent cannot do this.
  const opened = await sendControl(connect, { cmd: "open", session_id: sessionId, loop_id: loopId, goal });
  if (!opened.ok) throw new Error(`open failed: ${JSON.stringify(opened)}`);
  log(`  [supervisor] open session=${sessionId} loop=${loopId}`);

  // 2) AGENT (Chione on Hermes) drives tools/call over the per-session MCP URL printed by
  //    the running adapter. This driver does NOT drive the agent — that is the agent's half.
  if (process.env.LYHNA_BIND_GATE_AUTOCLOSE !== "1") {
    log(`  Point Chione (Hermes URL MCP server) at the adapter's session URL: <adapter_url>/${sessionId}`);
    await waitForEnter("  Press ENTER once Chione has finished driving the loop to seal it... ");
  }

  // 3) SUPERVISOR closes the loop — EXPLICIT and AUTHORITATIVE for the terminal outcome.
  const closed = await sendControl(connect, { cmd: "close", session_id: sessionId, outcome, reason });
  if (!closed.ok || closed.sealed !== true) throw new Error(`explicit close did not seal: ${JSON.stringify(closed)}`);
  log(`  [supervisor] close session=${sessionId} sealed=true outcome=${outcome} receipt=${closed.receipt_id}`);

  // 4) SUPERVISOR dumps the sealed chain (read-only control verb; the agent cannot reach it).
  const dumped = await sendControl(connect, { cmd: "dump", loop_id: loopId });
  if (!dumped.ok || !Array.isArray(dumped.receipts)) throw new Error(`dump failed: ${JSON.stringify(dumped)}`);
  log(`  [supervisor] dump loop=${loopId} receipts=${dumped.count}`);

  // 5) Export the sealed chain to the live fixture dir. Receipts are packaged, never reshaped:
  //    receipts.json is byte-preserved; the export adds the additive envelope/graph node.
  mkdirSync(outDir, { recursive: true });
  const srcDir = mkdtempSync(join(tmpdir(), "lyhna-live-src-"));
  const srcReceipts = join(srcDir, "receipts.json");
  writeFileSync(srcReceipts, JSON.stringify(dumped.receipts, null, 2));
  execFileSync("node", [EXPORT_CLI, srcReceipts, "--out", outDir, "--source-env", "live-bind-gate"], { stdio: "pipe" });
  rmSync(srcDir, { recursive: true, force: true });

  log(`  exported live bundle -> ${outDir}`);
  log("    receipts.json  bundle.json  graph-node.json  graph-node.md");
  log("");
  log("Next: `npm run build && npm run verify:legs` — Leg 3 must go FULL GREEN cold (real Ed25519).");
  log("If the captured receipts are NOT Ed25519-signed, Leg 3 STOPS and reports the mismatch — do not adapt around it.");
}

main().catch((e) => {
  process.stderr.write(`\nLIVE CAPTURE FAILED: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
