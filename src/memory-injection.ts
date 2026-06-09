// memory-injection.json — the portable, verified memory capsule (Capsule Gate 2).
//
// This is the handoff object an external memory/context system ingests: it points at the verified
// judgment ledger and proof pack so the NEXT agent starts from the capsule, not a transcript. It is
// an EXPORT object only — no external integration, no connector. The Verified Context version may
// carry the supervisor-declared settled/open/next plaintext; the Proof Mode version is content-blind
// (those arrays are empty), exactly mirroring the reduced state it is built from.

import type { ReducedJudgmentState } from "./judgment-reducer.js";

export const MEMORY_INJECTION_VERSION = "1.0.0";

export type MemoryInjection = {
  type: "lyhna_verified_memory_capsule";
  version: string;
  loop_id: string;
  /** Content-blind identity of the continuation capsule this memory was folded from. */
  capsule_ref: string;
  scope_ref: string;
  final_turn_ref: string | null;
  // Plaintext sidecar — populated in Verified Context Mode, empty in Proof Mode (content-blind).
  settled: string[];
  open_questions: string[];
  next_actions: string[];
  changed: string[];
  // Pointers into the proof pack (relative file names; no external integration).
  judgment_ledger_file: "judgment-ledger.json";
  proof_bundle_file: "bundle.json";
  receipts_file: "receipts.json";
  graph_node_file: "graph-node.json";
  verify_instructions_file: "verify-instructions.md";
};

export function buildMemoryInjection(input: {
  loop_id: string;
  capsule_ref: string;
  scope_ref: string;
  reduced: ReducedJudgmentState;
}): MemoryInjection {
  // The reduced state is already privacy-mode-gated (Proof Mode reduction carries no settled/open/
  // next/changed), so reading from it directly keeps memory-injection content-blind in Proof Mode.
  const r = input.reduced;
  return {
    type: "lyhna_verified_memory_capsule",
    version: MEMORY_INJECTION_VERSION,
    loop_id: input.loop_id,
    capsule_ref: input.capsule_ref,
    scope_ref: input.scope_ref,
    final_turn_ref: r.final_turn_ref,
    settled: r.settled ? [...r.settled] : [],
    open_questions: r.open_questions ? [...r.open_questions] : [],
    next_actions: r.next_actions ? [...r.next_actions] : [],
    changed: r.changed ? [...r.changed] : [],
    judgment_ledger_file: "judgment-ledger.json",
    proof_bundle_file: "bundle.json",
    receipts_file: "receipts.json",
    graph_node_file: "graph-node.json",
    verify_instructions_file: "verify-instructions.md"
  };
}
