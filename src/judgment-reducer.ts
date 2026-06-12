// Judgment Ledger Reducer — folds the ordered JudgmentTurn[] of a run into the final capsule
// state that the Continuation Capsule and the memory-injection object carry (Capsule Gate 2).
//
// This is the MIDDLE made portable: many live verdicts -> one settled/open/next state, with the
// structural proof refs (signed receipts, attested scope events, runtime hashes) that anchor it.
//
// The reducer ONLY FOLDS structural facts. It does NOT:
//   - infer hidden cognition or agent belief,
//   - judge agent / business quality,
//   - interpret whether a runtime result is true (it carries the runtime HASHES, nothing more).
// It applies the verdict, attaches the proof/scope/runtime refs, and — in Verified Context Mode
// ONLY — folds the supervisor-declared deltas into settled/open/next/changed. Proof Mode strips the
// plaintext deltas (the turns are projected content-blind before folding), so the reduced state is
// content-blind too.
//
// FAIL CLOSED: the reducer rejects a broken prior-turn chain, a non-contiguous turn_index, or a
// turn missing its proof anchor (a bind turn with no receipt_id, or a scope/loop-bound turn with no
// scope_event_hash) — it will not emit a reduced state over an unverifiable ledger.

import {
  assertValidDelta,
  projectTurn,
  validateJudgmentChain,
  type JudgmentDelta,
  type JudgmentTurn,
  type JudgmentVerdictKind,
  type JudgmentVerdictSource
} from "./judgment-ledger.js";
import type { ScopePrivacyMode } from "./scope-capsule.js";

/** One refused / escalated step, described structurally (no plaintext, no inference). */
export type RefusedStepRef = {
  turn_index: number;
  turn_ref: string;
  kind: JudgmentVerdictKind; // REFUSED or ESCALATED
  source: JudgmentVerdictSource;
  reason_code?: string;
  scope_event_hash?: string;
  receipt_id?: string;
  /**
   * Structural correction signal: true iff a LATER turn resolved APPROVED. This is a position-only
   * fact (a refusal followed by a continued, approved move) — NOT a semantic claim that the later
   * move fixed this one.
   */
  corrected: boolean;
};

export type ReducedJudgmentState = {
  loop_id: string;
  /** The final scope_ref the capsule settles under. */
  scope_ref: string;
  final_turn_ref: string | null;
  turn_count: number;
  verdict_counts: Record<JudgmentVerdictKind, number>;
  source_counts: Record<JudgmentVerdictSource, number>;
  /** Signed receipt ids anchoring the bind verdicts, in order. */
  receipt_refs: string[];
  /** Attested scope-event hashes anchoring the scope-gate / loop-bound verdicts, in order. */
  scope_event_refs: string[];
  /** Distinct scope_refs the turns cited (covers amendments mid-loop). */
  scope_refs: string[];
  /** Runtime result/error HASHES (linked, never interpreted). */
  runtime_result_hashes: string[];
  runtime_error_hashes: string[];
  /** Refused / escalated steps, structurally identified. */
  refused_steps: RefusedStepRef[];
  // --- plaintext sidecar (Verified Context Mode only; absent / empty in Proof Mode) ---
  settled?: string[];
  open_questions?: string[];
  next_actions?: string[];
  changed?: string[];
};

export type ReduceJudgmentLedgerInput = {
  loop_id: string;
  /** The final scope_ref the loop settled under (e.g. the final sealed scope version). */
  scope_ref: string;
  turns: readonly JudgmentTurn[];
  mode: ScopePrivacyMode;
  /**
   * Optional inherited state seed (lineage passthrough): the PRIOR loop's settled/open/next/changed,
   * folded in BEFORE this loop's own turn deltas (append-only lineage order — Loop 1's state comes
   * first, then Loop 2 extends it). VERIFIED CONTEXT ONLY: Proof Mode ignores the seed entirely — a
   * Proof reduction carries no plaintext, and the prior loop's Proof pack carries no plaintext state
   * to seed from, so the content-blind reduction stays content-blind. A malformed seed fails closed.
   */
  seed?: JudgmentDelta;
};

export function reduceJudgmentLedger(input: ReduceJudgmentLedgerInput): ReducedJudgmentState {
  // 1) Validate the chain as append-only / contiguous / hash-linked. Fail closed on any break.
  const chain = validateJudgmentChain(input.turns);
  if (!chain.valid) {
    throw new Error(`Cannot reduce a broken judgment ledger: ${chain.reason} (fail closed).`);
  }
  if (chain.loop_id !== null && chain.loop_id !== input.loop_id) {
    throw new Error(
      `Judgment ledger loop_id ${chain.loop_id} does not match the reduced loop_id ${input.loop_id} (fail closed).`
    );
  }

  // 2) Project each turn under the privacy mode BEFORE folding, so a Proof Mode reduction never even
  // observes a plaintext declared_delta (content-blind by construction).
  const turns = input.turns.map((t) => projectTurn(t, input.mode));

  const verdict_counts: Record<JudgmentVerdictKind, number> = { APPROVED: 0, ESCALATED: 0, REFUSED: 0 };
  const source_counts: Record<JudgmentVerdictSource, number> = { bind: 0, scope_gate: 0, loop_bound: 0 };
  const receipt_refs: string[] = [];
  const scope_event_refs: string[] = [];
  const scopeRefsSeen = new Set<string>();
  const runtime_result_hashes: string[] = [];
  const runtime_error_hashes: string[] = [];
  const refused_steps: RefusedStepRef[] = [];

  const settled: string[] = [];
  const open_questions: string[] = [];
  const next_actions: string[] = [];
  const changed: string[] = [];

  // Lineage passthrough (Verified Context only): seed the fold with the PRIOR loop's inherited state
  // BEFORE this loop's turn deltas, so the reduced state reads Loop 1's settled/open/next/changed
  // first and Loop 2 extends it (append-only). Proof Mode never folds the seed (content-blind).
  if (input.mode === "verified_context" && input.seed) {
    assertValidDelta(input.seed); // fail closed on a malformed seed (unknown field / non-string array)
    if (input.seed.settled) settled.push(...input.seed.settled);
    if (input.seed.open_questions) open_questions.push(...input.seed.open_questions);
    if (input.seed.next_actions) next_actions.push(...input.seed.next_actions);
    if (input.seed.changed) changed.push(...input.seed.changed);
  }

  // A later-approval lookup for the structural "corrected" signal.
  const hasLaterApproval = (afterIndex: number): boolean =>
    turns.some((t) => t.turn_index > afterIndex && t.verdict.kind === "APPROVED");

  for (const turn of turns) {
    verdict_counts[turn.verdict.kind] += 1;
    source_counts[turn.verdict.source] += 1;
    scopeRefsSeen.add(turn.scope_ref);

    // FAIL CLOSED (proof anchoring): a bind verdict MUST anchor a signed receipt; a scope-gate /
    // loop-bound verdict MUST anchor an attested scope event. A turn missing its anchor cannot be
    // folded into a verified capsule.
    if (turn.verdict.source === "bind") {
      if (!turn.verdict.receipt_id) {
        throw new Error(`Bind turn ${turn.turn_index} has no receipt_id anchor (fail closed).`);
      }
      receipt_refs.push(turn.verdict.receipt_id);
    } else {
      if (!turn.verdict.scope_event_hash) {
        throw new Error(
          `${turn.verdict.source} turn ${turn.turn_index} has no scope_event_hash anchor (fail closed).`
        );
      }
      scope_event_refs.push(turn.verdict.scope_event_hash);
    }

    if (turn.runtime_report?.result_hash) runtime_result_hashes.push(turn.runtime_report.result_hash);
    if (turn.runtime_report?.error_hash) runtime_error_hashes.push(turn.runtime_report.error_hash);

    if (turn.verdict.kind === "REFUSED" || turn.verdict.kind === "ESCALATED") {
      const ref: RefusedStepRef = {
        turn_index: turn.turn_index,
        turn_ref: turn.turn_ref,
        kind: turn.verdict.kind,
        source: turn.verdict.source,
        corrected: hasLaterApproval(turn.turn_index)
      };
      if (turn.verdict.reason_code !== undefined) ref.reason_code = turn.verdict.reason_code;
      if (turn.verdict.scope_event_hash !== undefined) ref.scope_event_hash = turn.verdict.scope_event_hash;
      if (turn.verdict.receipt_id !== undefined) ref.receipt_id = turn.verdict.receipt_id;
      refused_steps.push(ref);
    }

    // Verified Context Mode only: fold the supervisor-declared deltas. (Proof Mode projection above
    // already stripped declared_delta, so this is naturally empty there.)
    if (turn.declared_delta) {
      if (turn.declared_delta.settled) settled.push(...turn.declared_delta.settled);
      if (turn.declared_delta.open_questions) open_questions.push(...turn.declared_delta.open_questions);
      if (turn.declared_delta.next_actions) next_actions.push(...turn.declared_delta.next_actions);
      if (turn.declared_delta.changed) changed.push(...turn.declared_delta.changed);
    }
  }

  const reduced: ReducedJudgmentState = {
    loop_id: input.loop_id,
    scope_ref: input.scope_ref,
    final_turn_ref: chain.final_turn_ref,
    turn_count: turns.length,
    verdict_counts,
    source_counts,
    receipt_refs,
    scope_event_refs,
    scope_refs: [...scopeRefsSeen],
    runtime_result_hashes,
    runtime_error_hashes,
    refused_steps
  };

  // Carry the plaintext sidecar ONLY in Verified Context Mode (and only when non-empty).
  if (input.mode === "verified_context") {
    if (settled.length > 0) reduced.settled = settled;
    if (open_questions.length > 0) reduced.open_questions = open_questions;
    if (next_actions.length > 0) reduced.next_actions = next_actions;
    if (changed.length > 0) reduced.changed = changed;
  }

  return reduced;
}
