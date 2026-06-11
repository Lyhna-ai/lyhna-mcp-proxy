// Supervisor-side CLI verbs — `lyhna-mcp ctl` and `lyhna-mcp export-pack`.
//
// Both speak the standing service's SUPERVISOR control channel (newline-delimited JSON over the
// owner-only unix socket / loopback TCP port). They are supervisor tooling by construction: the
// governed agent holds only its per-session MCP URL and can never reach this channel, so adding
// convenience verbs on the supervisor side changes nothing about the agent/supervisor boundary.
//
//   ctl          — send ONE control command (open/close/status/dump/...) and print the response.
//   export-pack  — the dump -> continuation -> export dance as one command: read the sealed
//                  chain + scope history + judgment ledger over the control channel, fold the
//                  continuation, and write the full proof pack (the capsule trio) to a directory.
//
// export-pack is ADDITIVE packaging: it reuses the exact reducer / continuation / bundle builders
// the export CLI uses, so every fail-closed export validation still runs. Receipts are never
// reshaped; the bytes written to receipts.json are the bytes digested.

import { connect as netConnect, type Socket } from "node:net";
import { readFileSync } from "node:fs";

import type { CliIo } from "./capsule-cli.js";
import { buildContinuationCapsule } from "./continuation-capsule.js";
import { reduceJudgmentLedger } from "./judgment-reducer.js";
import { buildLoopProofBundle, deriveLoopSummary, type ProofReceipt } from "./loop-proof-bundle.js";
import { writeProofPackFiles } from "./proof-pack-io.js";
import type { ScopePrivacyMode, SealedScope } from "./scope-capsule.js";
import type { ScopeEvent } from "./scope-event-recorder.js";
import type { JudgmentTurn } from "./judgment-ledger.js";

export const CTL_USAGE =
  "usage: lyhna-mcp ctl --file <command.json>      (recommended — shell-quoting-safe, incl. PowerShell)\n" +
  "       lyhna-mcp ctl '<json-command>'\n" +
  "                [--socket <path> | --host <host> --port <port>]\n" +
  "  Sends ONE supervisor control command (open / amend / close / status / dump / dump_scope /\n" +
  "  dump_judgment / record_delta) to a standing lyhna-mcp proxy and prints the JSON response.\n" +
  '  Example: write {"cmd":"status"} to cmd.json, then: lyhna-mcp ctl --file cmd.json\n' +
  "  Defaults to LYHNA_PROXY_CONTROL_SOCKET / LYHNA_PROXY_CONTROL_HOST+PORT from the environment.\n";

export const EXPORT_PACK_USAGE =
  "usage: lyhna-mcp export-pack --loop <loop_id> --out <dir> [--mode proof|verified-context]\n" +
  "                [--source-env <env>] [--socket <path> | --host <host> --port <port>]\n" +
  "  Reads a closed loop's sealed chain, scope history, and judgment ledger over the supervisor\n" +
  "  control channel, folds the continuation capsule, and writes the full proof pack (receipts,\n" +
  "  bundle, proof-card.md, HANDOFF.md, judgment ledger, memory-injection.json) to <dir>.\n" +
  "  Default --mode is the scope's sealed privacy_mode (downgrading to proof is always allowed).\n";

export type ControlTarget = { socketPath: string } | { host: string; port: number };

/**
 * Resolve the control-channel address. EXPLICIT FLAGS ALWAYS WIN over environment defaults:
 * a shell that keeps LYHNA_PROXY_CONTROL_SOCKET exported must still be able to target a
 * different standing proxy with `--port` (otherwise the command would silently drive the
 * wrong proxy). Precedence: --socket, then --port (+ --host), then the env socket, then the
 * env port.
 */
export function resolveControlTarget(
  flags: { socket?: string; host?: string; port?: string },
  env: NodeJS.ProcessEnv
): ControlTarget | null {
  const toTcp = (portRaw: string, host: string): ControlTarget | null => {
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  };
  if (flags.socket) return { socketPath: flags.socket };
  if (flags.port) return toTcp(flags.port, flags.host ?? env.LYHNA_PROXY_CONTROL_HOST?.trim() ?? "127.0.0.1");
  const envPort = env.LYHNA_PROXY_CONTROL_PORT?.trim();
  if (flags.host) {
    // An explicit --host declares a TCP intent: it must NEVER fall through to an exported env
    // SOCKET (that would drive a different proxy than the one named). Pair it with the env port
    // when one is exported; otherwise refuse the incomplete target (fail closed).
    return envPort ? toTcp(envPort, flags.host) : null;
  }
  const envSocket = env.LYHNA_PROXY_CONTROL_SOCKET?.trim();
  if (envSocket) return { socketPath: envSocket };
  if (envPort) return toTcp(envPort, env.LYHNA_PROXY_CONTROL_HOST?.trim() ?? "127.0.0.1");
  return null;
}

const CONTROL_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Send one newline-delimited JSON command to the control channel; resolve its one-line response.
 * FAIL CLOSED on every non-response: a socket that accepts then closes without a complete line
 * (a stale/wrong supervisor socket, a crashing control server) rejects immediately, and a silent
 * peer rejects after a timeout — the CLI must never hang indefinitely.
 */
export function controlRequest(
  target: ControlTarget,
  command: unknown,
  timeoutMs: number = CONTROL_REQUEST_TIMEOUT_MS
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket: Socket =
      "socketPath" in target ? netConnect(target.socketPath) : netConnect(target.port, target.host);
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      action();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`control channel did not respond within ${timeoutMs}ms (fail closed).`)));
    }, timeoutMs);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(command) + "\n"));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        finish(() => {
          try {
            resolve(JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>);
          } catch (error) {
            reject(new Error(`control channel returned non-JSON: ${(error as Error).message}`));
          }
        });
      }
    });
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("close", () => {
      finish(() => reject(new Error("control channel closed before sending a complete response (fail closed).")));
    });
  });
}

type CommonFlags = { socket?: string; host?: string; port?: string };

/**
 * Read the value of a value-taking flag, REQUIRING a non-empty, non-flag token. A bare
 * `--socket` (value forgotten) must be a parse error, never a silent `undefined` that lets
 * resolveControlTarget fall back to an exported env target — that could drive a supervisor
 * command (e.g. `close`) against the wrong standing proxy.
 */
function takeFlagValue(argv: string[], i: number): string | null {
  const value = argv[i + 1];
  if (value === undefined || value.length === 0 || value.startsWith("-")) return null;
  return value;
}

const COMMON_FLAG_NAMES = new Set(["--socket", "--host", "--port"]);

type CommonFlagParse = { next: number } | { error: string } | null;

function takeCommonFlag(flags: CommonFlags, argv: string[], i: number): CommonFlagParse {
  const a = argv[i]!;
  if (!COMMON_FLAG_NAMES.has(a)) return null;
  const value = takeFlagValue(argv, i);
  if (value === null) return { error: `${a} requires a value` };
  if (a === "--socket") flags.socket = value;
  else if (a === "--host") flags.host = value;
  else flags.port = value;
  return { next: i + 1 };
}

const NO_TARGET =
  "no control channel configured — pass --socket/--port or set LYHNA_PROXY_CONTROL_SOCKET / " +
  "LYHNA_PROXY_CONTROL_PORT (the standing proxy prints its control address at startup).\n";

/** `lyhna-mcp ctl '<json>'` — one supervisor command, one JSON response on stdout. */
export async function runCtl(argv: string[], io: CliIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const flags: CommonFlags = {};
  let raw: string | undefined;
  let file: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const common = takeCommonFlag(flags, argv, i);
    if (common !== null) {
      if ("error" in common) {
        io.stderr(`${common.error}.\n${CTL_USAGE}`);
        return 1;
      }
      i = common.next;
      continue;
    }
    if (a === "--file") {
      const value = takeFlagValue(argv, i);
      if (value === null) {
        io.stderr(`--file requires a value.\n${CTL_USAGE}`);
        return 1;
      }
      file = value;
      i += 1;
    } else if (a === "--help" || a === "-h") {
      io.stdout(CTL_USAGE);
      return 0;
    } else if (a.startsWith("-")) {
      io.stderr(`unknown flag ${a}\n${CTL_USAGE}`);
      return 1;
    } else raw = a;
  }
  if (file !== undefined && raw !== undefined) {
    io.stderr(`pass the command either inline or via --file, not both.\n${CTL_USAGE}`);
    return 1;
  }
  if (file !== undefined) raw = readFileSync(file, "utf8");
  if (raw === undefined) {
    io.stderr(`a JSON command is required.\n${CTL_USAGE}`);
    return 1;
  }
  let command: unknown;
  try {
    command = JSON.parse(raw);
  } catch (error) {
    io.stderr(`command is not valid JSON: ${(error as Error).message}\n`);
    return 1;
  }
  const target = resolveControlTarget(flags, env);
  if (!target) {
    io.stderr(NO_TARGET);
    return 1;
  }
  let response: Record<string, unknown>;
  try {
    response = await controlRequest(target, command);
  } catch (error) {
    io.stderr(`control channel request failed: ${(error as Error).message}\n`);
    return 1;
  }
  io.stdout(JSON.stringify(response, null, 2) + "\n");
  return response.ok === true ? 0 : 1;
}

function normalizeMode(value: string | undefined): ScopePrivacyMode | undefined {
  if (value === undefined) return undefined;
  if (value === "proof") return "proof";
  if (value === "verified-context" || value === "verified_context") return "verified_context";
  throw new Error(`--mode must be "proof" or "verified-context", received "${value}".`);
}

/** `lyhna-mcp export-pack` — dump + fold + export in one supervisor command. */
export async function runExportPack(argv: string[], io: CliIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const flags: CommonFlags = {};
  let loopId: string | undefined;
  let outDir: string | undefined;
  let modeFlag: ScopePrivacyMode | undefined;
  let sourceEnv = "lyhna-mcp export-pack";
  const VALUE_FLAGS = new Set(["--loop", "--out", "--mode", "--source-env"]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const common = takeCommonFlag(flags, argv, i);
    if (common !== null) {
      if ("error" in common) {
        io.stderr(`${common.error}.\n${EXPORT_PACK_USAGE}`);
        return 1;
      }
      i = common.next;
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      const value = takeFlagValue(argv, i);
      if (value === null) {
        io.stderr(`${a} requires a value.\n${EXPORT_PACK_USAGE}`);
        return 1;
      }
      i += 1;
      if (a === "--loop") loopId = value;
      else if (a === "--out") outDir = value;
      else if (a === "--mode") modeFlag = normalizeMode(value);
      else sourceEnv = value;
    } else if (a === "--help" || a === "-h") {
      io.stdout(EXPORT_PACK_USAGE);
      return 0;
    } else {
      io.stderr(`unknown argument ${a}\n${EXPORT_PACK_USAGE}`);
      return 1;
    }
  }
  if (!loopId || !outDir) {
    io.stderr(`--loop and --out are required.\n${EXPORT_PACK_USAGE}`);
    return 1;
  }
  const target = resolveControlTarget(flags, env);
  if (!target) {
    io.stderr(NO_TARGET);
    return 1;
  }

  // Control-channel requests fail closed with a readable message (timeout / closed socket /
  // connection error) instead of an unhandled rejection or an indefinite hang.
  const request = async (command: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    try {
      return await controlRequest(target, command);
    } catch (error) {
      io.stderr(`control channel request failed (${String(command.cmd)}): ${(error as Error).message}\n`);
      return null;
    }
  };

  // 1) Dump the recorded chain + scope material + judgment ledger (supervisor-only verbs).
  const dumped = await request({ cmd: "dump", loop_id: loopId });
  if (dumped === null) return 1;
  if (dumped.ok !== true || !Array.isArray(dumped.receipts) || dumped.receipts.length === 0) {
    io.stderr(`dump failed for loop ${loopId}: ${JSON.stringify(dumped)}\n`);
    return 1;
  }
  const receipts = dumped.receipts as ProofReceipt[];

  const dumpedScope = await request({ cmd: "dump_scope", loop_id: loopId });
  if (dumpedScope === null) return 1;
  if (dumpedScope.ok !== true) {
    io.stderr(`dump_scope failed for loop ${loopId}: ${JSON.stringify(dumpedScope)}\n`);
    return 1;
  }
  const scopeHistory = (dumpedScope.scope_history as SealedScope[] | undefined) ?? [];
  const scopeEvents = (dumpedScope.scope_events as ScopeEvent[] | undefined) ?? [];

  // The summary (sealed verdict, action_count, goal_hash) is DERIVED from the dumped chain via
  // the structural verifier — never asserted. An unsealed chain exports honestly as UNSEALED.
  const summary = deriveLoopSummary(receipts);
  const receiptsText = JSON.stringify(receipts, null, 2);

  // No scope capsule -> the legacy 4-artifact bundle (no trio); say so rather than half-emit.
  if (scopeHistory.length === 0) {
    const bare = buildLoopProofBundle({ receipts, receipts_text: receiptsText, source_env: sourceEnv });
    const files = writeProofPackFiles(outDir, bare);
    io.stderr(
      `[lyhna] loop ${loopId} has no sealed scope capsule, so this is a bare bundle (no proof card / ` +
        `handoff / judgment artifacts). Open loops with a scope_capsule to export the full capsule trio.\n`
    );
    io.stdout(`wrote ${files.length} file(s) to ${outDir}: ${files.join(", ")}\n`);
    io.stdout(`verify: npx -y lyhna-verify --chain ${outDir}/receipts.json\n`);
    return 0;
  }

  // FAIL CLOSED (sealed-only trio): the handoff/continuation describe the settled state of a
  // CLOSED loop. An unsealed chain (no terminal loop_close yet) has no final word — exporting
  // the trio from it would hand the next agent a "closed" continuation built from non-final
  // state. Close the loop first; there is no downgrade path here on purpose.
  if (!summary.sealed) {
    io.stderr(
      `loop ${loopId} is not sealed (no terminal loop_close in the recorded chain); the capsule trio ` +
        `describes a CLOSED loop, so exporting now would hand off non-final state. Close the loop first ` +
        `(e.g. lyhna-mcp ctl '{"cmd":"close","session_id":"<id>","outcome":"COMPLETED","reason":"done"}') ` +
        `and re-run export-pack (fail closed).\n`
    );
    return 1;
  }

  const finalScope = scopeHistory[scopeHistory.length - 1]!;
  const sealedMode = finalScope.structural.privacy_mode === "verified_context" ? "verified_context" : "proof";
  // Default to the scope's sealed mode; downgrading to proof is always allowed. Upgrading is not:
  // the export's mode contract fails closed, but refuse here with a readable message instead.
  const mode: ScopePrivacyMode = modeFlag ?? sealedMode;
  if (mode === "verified_context" && sealedMode !== "verified_context") {
    io.stderr(
      `loop ${loopId} sealed its scope in proof (content-blind) mode; a verified-context export is not ` +
        `available for it (fail closed). Re-run without --mode or with --mode proof.\n`
    );
    return 1;
  }

  // The control channel projects judgment turns under min(requested, sealed) mode server-side.
  // FAIL CLOSED on a dump error: silently exporting without the judgment artifacts would drop
  // refused turns and runtime hashes from the requested pack — an empty LEDGER is fine (a
  // judgment-less loop), a failed DUMP is not.
  const dumpedJudgment = await request({
    cmd: "dump_judgment",
    loop_id: loopId,
    mode: mode === "verified_context" ? "verified-context" : "proof"
  });
  if (dumpedJudgment === null) return 1;
  if (dumpedJudgment.ok !== true || !Array.isArray(dumpedJudgment.turns)) {
    io.stderr(`dump_judgment failed for loop ${loopId} (fail closed): ${JSON.stringify(dumpedJudgment)}\n`);
    return 1;
  }
  const judgmentTurns = dumpedJudgment.turns as JudgmentTurn[];

  // 2) Fold the continuation from the dumped material (the same builders the demo/export use;
  // every fail-closed export validation still runs inside buildLoopProofBundle). The dumped
  // ledger is passed through AS IS — including an empty array — so the receipt<->judgment
  // cross-check always runs: a loop whose receipts prove bind turns the ledger fails to report
  // (lost/empty recorder state) fails closed instead of exporting a judgment-less pack. A truly
  // judgment-less loop (no in-loop receipts) still validates green with the empty ledger.
  let files: string[];
  try {
    const reduced = reduceJudgmentLedger({
      loop_id: loopId,
      scope_ref: finalScope.scope_ref,
      turns: judgmentTurns,
      mode
    });
    const continuation = buildContinuationCapsule({
      scope_history: scopeHistory,
      scope_events: scopeEvents,
      loop: {
        loop_id: summary.loop_id,
        goal_hash: summary.goal_hash,
        sealed: summary.sealed,
        action_count: summary.action_count
      },
      mode,
      reduced
    });

    const built = buildLoopProofBundle({
      receipts,
      receipts_text: receiptsText,
      source_env: sourceEnv,
      capsule: {
        mode,
        sealed_scope: finalScope,
        scope_history: scopeHistory,
        continuation,
        scope_events: scopeEvents,
        judgment_turns: judgmentTurns
      }
    });

    files = writeProofPackFiles(outDir, built);
  } catch (error) {
    // Fail-closed export validation (the same checks the export CLI runs). All validation
    // happens in buildLoopProofBundle BEFORE the first write, so a refused export writes nothing.
    io.stderr(`export refused for loop ${loopId} (fail closed): ${(error as Error).message}\n`);
    return 1;
  }
  io.stdout(
    `exported loop ${summary.loop_id} (${summary.sealed ? "SEALED" : "UNSEALED"}, ` +
      `${summary.action_count} action(s), mode ${mode}) -> ${outDir}\n` +
      `  ${files.join(", ")}\n` +
      `verify: npx -y lyhna-verify --chain ${outDir}/receipts.json\n`
  );
  return 0;
}
