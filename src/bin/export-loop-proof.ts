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
//   <out>/proof-card.md             one-page human summary
//   <out>/verify-instructions.md    how to cold-verify the pack
//
// Usage:
//   export-loop-proof <receipts.json> --out <dir> [--source-env <env>]
//                     [--verdict <lyhna-verify-json>] [--exported-at <iso>]
//                     [--scope-capsule <sealed-scope.json>] [--continuation <continuation.json>]
//                     [--scope-events <events.json>] [--mode proof|verified-context]
//
// Additive packaging only: receipts are never reshaped. The standalone verifier consumes
// <out>/receipts.json with zero adaptation.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildLoopProofBundle, type ProofReceipt } from "../loop-proof-bundle.js";
import type { ContinuationCapsule } from "../continuation-capsule.js";
import type { ScopePrivacyMode, SealedScope } from "../scope-capsule.js";
import type { ScopeEvent } from "../scope-event-recorder.js";

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
        "[--mode proof|verified-context]\n"
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
    capsule = { mode: args.mode, sealed_scope, scope_history, continuation, scope_events };
  }

  const built = buildLoopProofBundle({
    receipts,
    receipts_text,
    source_env: args.sourceEnv,
    exported_at: args.exportedAt,
    advisory_verdict,
    capsule
  });

  mkdirSync(args.out, { recursive: true });
  // receipts.json is written VERBATIM from the digested bytes — the verifier input.
  writeFileSync(path.join(args.out, "receipts.json"), built.receipts_json);
  writeFileSync(path.join(args.out, "bundle.json"), JSON.stringify(built.bundle, null, 2) + "\n");
  writeFileSync(path.join(args.out, "graph-node.json"), JSON.stringify(built.graph_node, null, 2) + "\n");
  writeFileSync(path.join(args.out, "graph-node.md"), built.graph_node_markdown);

  let capsuleNote = "";
  if (built.scope_capsule) {
    writeFileSync(
      path.join(args.out, "scope-capsule.json"),
      JSON.stringify(built.scope_capsule, null, 2) + "\n"
    );
    writeFileSync(
      path.join(args.out, "continuation-capsule.json"),
      JSON.stringify(built.continuation_capsule, null, 2) + "\n"
    );
    if (built.scope_events && built.scope_events.length > 0) {
      writeFileSync(
        path.join(args.out, "scope-events.json"),
        JSON.stringify(built.scope_events, null, 2) + "\n"
      );
    }
    if (built.proof_card_markdown) {
      writeFileSync(path.join(args.out, "proof-card.md"), built.proof_card_markdown);
    }
    if (built.verify_instructions_markdown) {
      writeFileSync(path.join(args.out, "verify-instructions.md"), built.verify_instructions_markdown);
    }
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
