// Lyhna Reliability Gauntlet — parameterized real-loop driver.
//
// This is the canonical single-scenario driver (scripts/live-loop-receipt.mjs) generalized so a test
// harness can run MANY scenarios through the REAL standing-service loop and collect the emitted
// `witness-input.json` for each. It changes nothing about the proof spine, the receipt shape, or
// export-pack — it only DRIVES the existing machinery with varied, deterministic inputs:
//
//   open scoped loop -> agent routes tool calls + records claims -> close (seal) -> export-pack
//
// What is real (mirrors scripts/live-loop-receipt.mjs): the standing HTTP MCP transport, the
// supervisor-only control channel, the LoopSession spine + scope gate, the agent-facing record_claim
// capture, the judgment ledger, and runExportPack (dump -> dump_judgment -> dump_claims ->
// assembleWitnessInput). Only the upstream tool bodies and the bind verdict are synthetic test doubles
// — the same posture the golden-path and live-loop demos already use.
//
// Two synthetic doubles let a scenario choose the witnessed outcome of each call:
//   - programmableBind: APPROVED by default (so the loop open/close bind always succeeds); per-tool
//     overrides return ESCALATED / REFUSED. (The synthetic demo bind only ever APPROVES, and the scope
//     gate only REFUSES — so a programmable bind is the only way to drive ESCALATED through the loop.)
//   - configurableUpstream: throws for tools flagged to fail, so an APPROVED call records
//     runtime_report.returned:false + error_hash (a tool that ran but failed).
// Scope REFUSED is driven the orthogonal, production-faithful way: by calling a tool whose action
// class is not allowed by the sealed scope capsule.
//
// CONTENT-BLIND NOTE: the judgment ledger stores only the tool NAME, never arguments — so the emitted
// witness-input.json events carry no `arguments`. This is the real v1 boundary; the harness asserts on
// exactly what production emits.

import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIST_INDEX = join(ROOT, "dist", "src", "index.js");
const TSCONFIG = join(ROOT, "tsconfig.json");
const SRC_ENTRY = join(ROOT, "src", "index.ts");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");

// Keep this runnable from a clean checkout. `npm test` runs vitest WITHOUT `npm run build`, so if the
// built library is missing but the TS sources are present, build it once here (mirrors
// scripts/live-loop-receipt.mjs's ensureDist). A present dist makes this a no-op.
async function loadProxy(log = () => {}) {
  if (!existsSync(DIST_INDEX)) {
    if (!(existsSync(TSCONFIG) && existsSync(SRC_ENTRY))) {
      throw new Error(`built library not found at ${DIST_INDEX} and no TS sources to build — run \`npm run build\`.`);
    }
    log("dist not found — building from source (tsc -p tsconfig.json)...");
    execFileSync(process.execPath, [TSC, "-p", TSCONFIG], { stdio: "inherit" });
    if (!existsSync(DIST_INDEX)) throw new Error("build did not produce dist; run `npm run build` and retry.");
  }
  return import(DIST_INDEX);
}

// Supervisor control client: one connection per command, newline-delimited JSON. (Mirrors
// scripts/live-loop-receipt.mjs.)
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
 * A bind client that APPROVES by default but returns a per-tool override outcome (ESCALATED/REFUSED)
 * keyed off the tool name carried in the bind request's action_payload. Defaulting to APPROVED is what
 * keeps the loop open/close binds (which carry no tool_name) working.
 */
function programmableBind(createSyntheticDemoBindClient, toolOutcomes) {
  const base = createSyntheticDemoBindClient();
  return {
    async bind(request) {
      const receipt = await base.bind(request);
      const toolName = request?.action_payload?.tool_name;
      const want = toolName ? toolOutcomes[toolName] : undefined;
      if (want && want !== "APPROVED") return { ...receipt, outcome: want };
      return receipt;
    }
  };
}

/**
 * Synthetic upstream: advertises the scenario's tools through `listTools` (so the proxy's mirrored
 * tool surface matches the calls being routed, not just the injected record_claim), and returns ok —
 * or throws for any tool whose name is in `failTools`.
 */
function configurableUpstream(failTools, advertisedTools = []) {
  return {
    async listTools() {
      return advertisedTools.map((name) => ({
        name,
        description: `gauntlet synthetic tool ${name}`,
        inputSchema: { type: "object" }
      }));
    },
    async callTool(call) {
      if (failTools.has(call.toolName)) {
        throw new Error(`synthetic upstream failure for ${call.toolName}`);
      }
      return {
        content: [{ type: "text", text: `ok:${call.toolName}` }],
        structuredContent: { tool: call.toolName }
      };
    }
  };
}

/**
 * Drive ONE scenario through the real loop and return the emitted witness-input.json (parsed).
 *
 * @param {object} scenario
 * @param {string}   scenario.id              stable scenario id (used for loop_id + temp dirs).
 * @param {string}   scenario.objective       loop goal / objective.
 * @param {Array<{toolName:string, arguments?:object}>} scenario.calls   tool calls the agent routes, in order.
 * @param {Array<{system:string, action?:string, result?:string, user_facing?:boolean}>} scenario.claims
 *                                             record_claim calls the agent makes, in order (ordinal-paired
 *                                             to the witnessed turns by the proxy's witness-bridge).
 * @param {Record<string,"APPROVED"|"ESCALATED"|"REFUSED">} [scenario.toolOutcomes]  per-tool bind override.
 * @param {string[]} [scenario.failTools]     tool names whose APPROVED upstream call should throw.
 * @param {Record<string,string>} [scenario.classMap]  tool -> scope action class. Tools absent here have
 *                                             no class and are REFUSED by the scope gate (a way to drive a
 *                                             production-faithful scope refusal).
 * @param {string[]} [scenario.allowedActionClasses]   classes the sealed scope allows + treats as targetless.
 *                                             Default: the distinct values of classMap.
 * @param {string[]} [scenario.settled] @param {string[]} [scenario.open_questions]
 * @param {string[]} [scenario.next_actions]  forwarded to export-pack / the witness payload.
 * @param {(s:string)=>void} [log]
 * @returns {Promise<{witnessInput:object, sealed:boolean, exportRc:number}>}
 */
export async function runScenario(scenario, log = () => {}) {
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
  } = await loadProxy(log);

  const calls = scenario.calls ?? [];
  const claims = scenario.claims ?? [];
  const toolOutcomes = scenario.toolOutcomes ?? {};
  const failTools = new Set(scenario.failTools ?? []);
  const classMap = scenario.classMap ?? {};
  const allowedTools = Object.keys(classMap);
  const allowedClasses = scenario.allowedActionClasses ?? [...new Set(Object.values(classMap))];

  // FAIL CLOSED: a scenario that routes calls but declares no scope (empty classMap) would seal empty
  // allow-lists, which checkScopeStructural treats as "no rule" — so every call would forward as
  // APPROVED instead of the intended scope-refused behavior, silently corrupting refusal cases. Refuse
  // to run such a scenario rather than report a misconfigured pass. (A no-call scenario — e.g. a pure
  // claimed-but-never-witnessed loop — legitimately declares no tools.)
  if (calls.length > 0 && allowedTools.length === 0) {
    throw new Error(
      `scenario ${scenario.id} routes ${calls.length} call(s) but declares no scope (empty classMap); ` +
        `declare each called tool's action class in classMap, or the sealed scope would not restrict anything (fail closed).`
    );
  }

  // Advertise every tool the scenario declares or routes, so the proxy's mirrored tool surface matches
  // the calls being made (a discovery flow would otherwise see only record_claim).
  const advertisedTools = [...new Set([...allowedTools, ...calls.map((c) => c.toolName)])];

  const recorder = createReceiptRecorder();
  const scopeEvents = createScopeEventRecorder();
  const judgment = createJudgmentRecorder();
  const claimRec = createClaimRecorder(); // CLAIM CAPTURE ON (== LYHNA_PROXY_CLAIM_CAPTURE=1)
  const bindClient = recorder.wrap(programmableBind(createSyntheticDemoBindClient, toolOutcomes));
  const registry = new LoopSessionRegistry(
    (r) => bindClient.bind(r),
    { graceMs: 2000, retryDelayMs: 50 },
    scopeEvents,
    judgment
  );

  const standing = await serveStandingHttpProxy({
    upstream: configurableUpstream(failTools, advertisedTools),
    bindClient,
    registry,
    claims: claimRec,
    host: "127.0.0.1",
    port: 0,
    path: "/mcp"
  });
  const socketPath = join(
    tmpdir(),
    `lyhna-gauntlet-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`
  );
  const control = await serveControlChannel({
    transport: "unix",
    socketPath,
    registry,
    receiptSource: recorder,
    scopeEventSource: scopeEvents,
    judgmentRecorder: judgment,
    claimSource: claimRec
  });

  const SESSION = `gauntlet-${scenario.id}`;
  const LOOP = `loop-${scenario.id}`;
  const scopeCapsule = {
    structural: {
      capsule_type: "scope_capsule",
      capsule_version: "scope-capsule/v1",
      loop_id: LOOP,
      goal_hash: "",
      privacy_mode: "verified_context",
      allowed_action_classes: allowedClasses,
      allowed_tools: allowedTools,
      allowed_targets: [],
      forbidden_targets: [],
      target_descriptor_hashes: [],
      // Treat every allowed class as targetless so a call with arbitrary arguments still passes the
      // gate on class alone — target shape is not what these scenarios exercise.
      targetless_action_classes: allowedClasses
    },
    sidecar: { goal_summary: scenario.objective ?? scenario.id }
  };

  const packDir = mkdtempSync(join(tmpdir(), `lyhna-gauntlet-pack-${scenario.id}-`));
  try {
    const opened = await sendControl(socketPath, {
      cmd: "open",
      session_id: SESSION,
      loop_id: LOOP,
      goal: scenario.objective ?? scenario.id,
      scope_capsule: scopeCapsule,
      scope_class_map: classMap
    });
    if (!opened.ok) throw new Error(`open failed: ${JSON.stringify(opened)}`);

    const agent = await connectStreamableHttpUpstream(standing.sessionUrl(SESSION));
    try {
      // Route the witnessed tool calls in order. A REFUSED / ESCALATED / failed call throws to the
      // agent — that is the real client experience; the judgment turn is still recorded.
      for (const call of calls) {
        try {
          await agent.client.callTool(call);
        } catch {
          /* expected for blocked/failed calls */
        }
      }
      // Then the agent's claims, in order. Sequential record_claim is the v1 contract: the proxy's
      // witness-bridge pairs claim i with witnessed turn i.
      for (const claim of claims) {
        await agent.client.callTool({ toolName: "record_claim", arguments: claim });
      }
    } finally {
      await agent.close().catch(() => undefined);
    }

    const delta = {};
    if (scenario.settled) delta.settled = scenario.settled;
    if (scenario.open_questions) delta.open_questions = scenario.open_questions;
    if (scenario.next_actions) delta.next_actions = scenario.next_actions;
    if (Object.keys(delta).length > 0) {
      const preJudgment = await sendControl(socketPath, { cmd: "dump_judgment", loop_id: LOOP, mode: "verified-context" });
      if (!preJudgment.ok || !Array.isArray(preJudgment.turns)) {
        throw new Error(`dump_judgment failed before record_delta: ${JSON.stringify(preJudgment)}`);
      }
      const turn = [...preJudgment.turns].reverse().find((t) => typeof t?.turn_ref === "string");
      if (!turn) throw new Error(`scenario ${scenario.id} declared continuation fields but produced no judgment turn`);
      const recorded = await sendControl(socketPath, {
        cmd: "record_delta",
        loop_id: LOOP,
        turn_ref: turn.turn_ref,
        delta
      });
      if (!recorded.ok) throw new Error(`record_delta failed: ${JSON.stringify(recorded)}`);
    }

    const closed = await sendControl(socketPath, {
      cmd: "close",
      session_id: SESSION,
      outcome: "COMPLETED",
      reason: "gauntlet"
    });

    const out = [];
    const exportRc = await runExportPack(
      ["--loop", LOOP, "--out", packDir, "--socket", socketPath],
      { stdout: (t) => out.push(t), stderr: (t) => out.push(t) },
      {}
    );
    const witnessInputPath = join(packDir, "witness-input.json");
    if (!existsSync(witnessInputPath)) {
      throw new Error(`export-pack did not emit witness-input.json (rc=${exportRc}):\n${out.join("")}`);
    }
    const witnessInput = JSON.parse(readFileSync(witnessInputPath, "utf8"));

    log(`  [${scenario.id}] sealed=${closed.sealed} exportRc=${exportRc} steps=${witnessInput.steps.length}`);
    return { witnessInput, sealed: closed.sealed === true, exportRc };
  } finally {
    await control.close().catch(() => undefined);
    await standing.close().catch(() => undefined);
    rmSync(packDir, { recursive: true, force: true });
  }
}
