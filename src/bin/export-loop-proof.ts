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
// Usage:
//   export-loop-proof <receipts.json> --out <dir> [--source-env <env>]
//                     [--verdict <lyhna-verify-json>] [--exported-at <iso>]
//
// Additive packaging only: receipts are never reshaped. The standalone verifier consumes
// <out>/receipts.json with zero adaptation.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildLoopProofBundle, type ProofReceipt } from "../loop-proof-bundle.js";

type Args = {
  receiptsPath?: string;
  out?: string;
  sourceEnv: string;
  verdictPath?: string;
  exportedAt?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { sourceEnv: "unspecified" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--source-env") args.sourceEnv = argv[++i] ?? args.sourceEnv;
    else if (a === "--verdict") args.verdictPath = argv[++i];
    else if (a === "--exported-at") args.exportedAt = argv[++i];
    else if (!a.startsWith("-")) args.receiptsPath = a;
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.receiptsPath || !args.out) {
    process.stderr.write(
      "usage: export-loop-proof <receipts.json> --out <dir> [--source-env <env>] [--verdict <json>] [--exported-at <iso>]\n"
    );
    process.exit(1);
  }

  const receipts = JSON.parse(readFileSync(args.receiptsPath, "utf8")) as ProofReceipt[];
  if (!Array.isArray(receipts)) {
    throw new Error("Input must be a JSON array of receipts (the side-car shape).");
  }
  const advisory_verdict = args.verdictPath
    ? JSON.parse(readFileSync(args.verdictPath, "utf8"))
    : undefined;

  const built = buildLoopProofBundle({
    receipts,
    source_env: args.sourceEnv,
    exported_at: args.exportedAt,
    advisory_verdict
  });

  mkdirSync(args.out, { recursive: true });
  // receipts.json is written VERBATIM from the digested bytes — the verifier input.
  writeFileSync(path.join(args.out, "receipts.json"), built.receipts_json);
  writeFileSync(path.join(args.out, "bundle.json"), JSON.stringify(built.bundle, null, 2) + "\n");
  writeFileSync(path.join(args.out, "graph-node.json"), JSON.stringify(built.graph_node, null, 2) + "\n");
  writeFileSync(path.join(args.out, "graph-node.md"), built.graph_node_markdown);

  process.stderr.write(
    `[export-loop-proof] wrote bundle to ${args.out}\n` +
      `  loop=${built.bundle.loop.loop_id} scope=${built.bundle.scope} ` +
      `sealed=${built.bundle.loop.sealed} action_count=${built.bundle.loop.action_count}\n` +
      `  trust_root=${built.bundle.trust_root.key_id} digest=sha256:${built.bundle.export.content_digest.value}\n` +
      `  verify: lyhna-verify --chain ${path.join(args.out, "receipts.json")}\n`
  );
}

main();
