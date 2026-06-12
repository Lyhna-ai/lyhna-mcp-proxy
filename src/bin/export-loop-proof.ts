#!/usr/bin/env node
// export-loop-proof — package a sealed loop receipt chain into a LoopProofBundle.
//
// Reads a bare receipt array (the loadable side-car shape), optionally an advisory
// verdict (the `lyhna-verify --json` output), and writes the side-car bundle:
//
//   <out>/receipts.json     the bare receipt array, UNCHANGED (the verifier input)
//   <out>/bundle.json       the additive envelope (trust root, scheme, digest, verdict)
//   <out>/graph-node.json   the Authority Context Graph node
//   <out>/graph-node.md     the same node, rendered
//
// CAPSULE GATE 1 (additive, optional). When --scope-capsule is supplied, ALSO writes:
//
//   <out>/scope-capsule.json        the sealed Scope Capsule (structural-only in Proof Mode)
//   <out>/continuation-capsule.json the Continuation Capsule (settled/open/next + what changed)
//   <out>/scope-events.json         attested scope refusals/escalations (if any)
//   <out>/proof-card.md             THE CARD — one-page human summary (PR-comment ready)
//   <out>/HANDOFF.md                THE HANDOFF — paste-ready next-agent continuation
//   <out>/verify-instructions.md    how to cold-verify the pack
//
// CAPSULE GATE 2 (additive, optional). When --judgment is also supplied, ALSO writes:
//
//   <out>/judgment-ledger.json      the full middle object (reduced fold + projected ordered turns)
//   <out>/judgment-ledger.md        human-readable judgment path (respects privacy mode)
//   <out>/memory-injection.json     portable verified-memory capsule for external memory systems
//
// Usage:
//   export-loop-proof <receipts.json> --out <dir> [--source-env <env>]
//                     [--verdict <lyhna-verify-json>] [--exported-at <iso>]
//                     [--scope-capsule <sealed-scope.json>] [--continuation <continuation.json>]
//                     [--scope-events <events.json>] [--mode proof|verified-context]
//                     [--prior-pack <dir>]   (cross-loop lineage: the PRIOR loop's exported pack;
//                                             binds the sealed inherits_loop edge + seeds VC state)
//
// Additive packaging only: receipts are never reshaped. The standalone verifier consumes
// <out>/receipts.json with zero adaptation.

import { readFileSync } from "node:fs";
import path from "node:path";

import { buildLoopProofBundle, type ProofReceipt } from "../loop-proof-bundle.js";
import { writeProofPackFiles } from "../proof-pack-io.js";
import type { ContinuationCapsule } from "../continuation-capsule.js";
import type { ScopePrivacyMode, SealedScope } from "../scope-capsule.js";
import type { ScopeEvent } from "../scope-event-recorder.js";
import type { JudgmentTurn } from "../judgment-ledger.js";

type Args = {
  receiptsPath?: string;
  out?: string;
  sourceEnv: string;
  verdictPath?: string;
  exportedAt?: string;
  scopeCapsulePath?: string;
  scopeHistoryPath?: string;
  continuationPath?: string;
  scopeEventsPath?: string;
  judgmentPath?: string;
  priorPackDir?: string;
  mode: ScopePrivacyMode;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { sourceEnv: "unspecified", mode: "proof" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--source-env") args.sourceEnv = argv[++i] ?? args.sourceEnv;
    else if (a === "--verdict") args.verdictPath = argv[++i];
    else if (a === "--exported-at") args.exportedAt = argv[++i];
    else if (a === "--scope-capsule") args.scopeCapsulePath = argv[++i];
    else if (a === "--scope-history") args.scopeHistoryPath = argv[++i];
    else if (a === "--continuation") args.continuationPath = argv[++i];
    else if (a === "--scope-events") args.scopeEventsPath = argv[++i];
    else if (a === "--judgment") args.judgmentPath = argv[++i];
    else if (a === "--prior-pack") args.priorPackDir = argv[++i];
    else if (a === "--mode") args.mode = normalizeMode(argv[++i]);
    else if (a && !a.startsWith("-")) args.receiptsPath = a;
  }
  return args;
}

function normalizeMode(value: string | undefined): ScopePrivacyMode {
  if (value === "verified-context" || value === "verified_context") return "verified_context";
  if (value === "proof" || value === undefined) return "proof";
  throw new Error(`--mode must be "proof" or "verified-context", received "${value}".`);
}

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.receiptsPath || !args.out) {
    process.stderr.write(
      "usage: export-loop-proof <receipts.json> --out <dir> [--source-env <env>] [--verdict <json>] " +
        "[--exported-at <iso>] [--scope-capsule <json>] [--continuation <json>] [--scope-events <json>] " +
        "[--judgment <judgment-turns.json>] [--prior-pack <dir>] [--mode proof|verified-context]\n"
    );
    process.exit(1);
  }

  // Read the source bytes once and carry them through verbatim, so the exported
  // receipts.json is byte-identical to the source artifact (provenance preserved).
  const receipts_text = readFileSync(args.receiptsPath, "utf8");
  const receipts = JSON.parse(receipts_text) as ProofReceipt[];
  if (!Array.isArray(receipts)) {
    throw new Error("Input must be a JSON array of receipts (the side-car shape).");
  }
  const advisory_verdict = args.verdictPath
    ? JSON.parse(readFileSync(args.verdictPath, "utf8"))
    : undefined;

  // Optional Capsule Gate 1 material. When --scope-capsule is provided, --continuation is required
  // (the continuation capsule inherits from the scope capsule and records settled/open/next).
  let capsule: Parameters<typeof buildLoopProofBundle>[0]["capsule"];
  if (args.scopeCapsulePath) {
    if (!args.continuationPath) {
      throw new Error("--scope-capsule requires --continuation (the Continuation Capsule).");
    }
    const sealed_scope = readJson<SealedScope>(args.scopeCapsulePath);
    const scope_history = args.scopeHistoryPath ? readJson<SealedScope[]>(args.scopeHistoryPath) : undefined;
    const continuation = readJson<ContinuationCapsule>(args.continuationPath);
    const scope_events = args.scopeEventsPath ? readJson<ScopeEvent[]>(args.scopeEventsPath) : [];
    const judgment_turns = args.judgmentPath ? readJson<JudgmentTurn[]>(args.judgmentPath) : undefined;
    capsule = { mode: args.mode, sealed_scope, scope_history, continuation, scope_events, judgment_turns };

    // Cross-loop lineage (--prior-pack): read the PRIOR loop's continuation-capsule.json and derive
    // the inherited seed FROM it (never from a bare caller-supplied delta). The builder fail-closes
    // unless the prior capsule binds to the sealed inherits_loop edge (capsule_ref / scope_ref /
    // final_turn_ref) and — in Verified Context — the seed equals the prior capsule's verified state.
    if (args.priorPackDir) {
      const prior_continuation = readJson<ContinuationCapsule>(
        path.join(args.priorPackDir, "continuation-capsule.json")
      );
      capsule.prior_continuation = prior_continuation;
      const inherited_state = {
        ...(prior_continuation.settled?.length ? { settled: prior_continuation.settled } : {}),
        ...(prior_continuation.open_questions?.length ? { open_questions: prior_continuation.open_questions } : {}),
        ...(prior_continuation.next_actions?.length ? { next_actions: prior_continuation.next_actions } : {}),
        ...(prior_continuation.changed?.length ? { changed: prior_continuation.changed } : {})
      };
      if (Object.keys(inherited_state).length > 0) capsule.inherited_state = inherited_state;
    }
  }

  const built = buildLoopProofBundle({
    receipts,
    receipts_text,
    source_env: args.sourceEnv,
    exported_at: args.exportedAt,
    advisory_verdict,
    capsule
  });

  writeProofPackFiles(args.out, built);

  let capsuleNote = "";
  if (built.scope_capsule) {
    capsuleNote =
      `  capsule: scope_ref=${built.bundle.capsule?.scope_ref} mode=${built.bundle.capsule?.mode} ` +
      `scope_events=${built.bundle.capsule?.scope_events.count}\n`;
  }

  process.stderr.write(
    `[export-loop-proof] wrote bundle to ${args.out}\n` +
      `  loop=${built.bundle.loop.loop_id} scope=${built.bundle.scope} ` +
      `sealed=${built.bundle.loop.sealed} action_count=${built.bundle.loop.action_count}\n` +
      capsuleNote +
      `  trust_root=${built.bundle.trust_root.key_id} digest=sha256:${built.bundle.export.content_digest.value}\n` +
      `  verify: lyhna-verify --chain ${path.join(args.out, "receipts.json")}\n`
  );
}

main();
