// Proof-pack file writer — the ONE place that lays a BuiltLoopProofBundle onto disk, shared by
// the export-loop-proof CLI and `lyhna-mcp export-pack`. Writing is mechanical: receipts.json is
// the exact digested bytes (never re-serialized), every other artifact is written iff the build
// produced it. No validation happens here — buildLoopProofBundle already failed closed upstream.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { BuiltLoopProofBundle } from "./loop-proof-bundle.js";

/**
 * Every file name this writer can ever produce. Before writing, ALL of these are removed from
 * the target directory so a re-export can never leave a stale optional artifact (an old
 * proof-card.md / HANDOFF.md / scope-events.json from a previous chain) sitting next to a fresh
 * receipts.json. Only these names are touched — anything else in the directory is left alone.
 */
const PACK_FILE_NAMES = [
  "receipts.json",
  "bundle.json",
  "graph-node.json",
  "graph-node.md",
  "scope-capsule.json",
  "continuation-capsule.json",
  "scope-events.json",
  "proof-card.md",
  "HANDOFF.md",
  "verify-instructions.md",
  "judgment-ledger.json",
  "judgment-ledger.md",
  "memory-injection.json"
] as const;

function writeJson(outDir: string, name: string, value: unknown): void {
  writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2) + "\n");
}

/** Write the full side-car pack; returns the list of file names written. */
export function writeProofPackFiles(outDir: string, built: BuiltLoopProofBundle): string[] {
  mkdirSync(outDir, { recursive: true });
  for (const name of PACK_FILE_NAMES) {
    rmSync(path.join(outDir, name), { force: true });
  }
  const written: string[] = [];
  const put = (name: string, write: () => void): void => {
    write();
    written.push(name);
  };

  // receipts.json is written VERBATIM from the digested bytes — the verifier input.
  put("receipts.json", () => writeFileSync(path.join(outDir, "receipts.json"), built.receipts_json));
  put("bundle.json", () => writeJson(outDir, "bundle.json", built.bundle));
  put("graph-node.json", () => writeJson(outDir, "graph-node.json", built.graph_node));
  put("graph-node.md", () => writeFileSync(path.join(outDir, "graph-node.md"), built.graph_node_markdown));

  if (built.scope_capsule) {
    put("scope-capsule.json", () => writeJson(outDir, "scope-capsule.json", built.scope_capsule));
    put("continuation-capsule.json", () => writeJson(outDir, "continuation-capsule.json", built.continuation_capsule));
    if (built.scope_events && built.scope_events.length > 0) {
      put("scope-events.json", () => writeJson(outDir, "scope-events.json", built.scope_events));
    }
    if (built.proof_card_markdown) {
      put("proof-card.md", () => writeFileSync(path.join(outDir, "proof-card.md"), built.proof_card_markdown!));
    }
    if (built.handoff_markdown) {
      put("HANDOFF.md", () => writeFileSync(path.join(outDir, "HANDOFF.md"), built.handoff_markdown!));
    }
    if (built.verify_instructions_markdown) {
      put("verify-instructions.md", () =>
        writeFileSync(path.join(outDir, "verify-instructions.md"), built.verify_instructions_markdown!)
      );
    }
    if (built.judgment_ledger) {
      put("judgment-ledger.json", () => writeJson(outDir, "judgment-ledger.json", built.judgment_ledger));
    }
    if (built.judgment_ledger_markdown) {
      put("judgment-ledger.md", () => writeFileSync(path.join(outDir, "judgment-ledger.md"), built.judgment_ledger_markdown!));
    }
    if (built.memory_injection) {
      put("memory-injection.json", () => writeJson(outDir, "memory-injection.json", built.memory_injection));
    }
  }
  return written;
}
