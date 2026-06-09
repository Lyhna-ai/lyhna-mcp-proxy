// Continuation Capsule — the Capsule Gate 1 back-half, emitted at loop close.
//
// The product mechanism closes here: "Scope Capsule in -> loop runs -> proof throughout ->
// Continuation Capsule out." The Continuation Capsule INHERITS from the Scope Capsule
// (loop_id, scope_ref, goal_hash), records settled / open / next, surfaces WHAT CHANGED (scope
// amendments), and lists the attested scope events (refusals / escalations).
//
// It is a SIDECAR / human-facing artifact (Section 4.2: the plaintext projection is for the
// human, supervisor, runtime UI, export surface, and Continuation Capsule). It is ADDITIVE
// adapter-side output — NEVER a core receipt and NEVER a canonical-receipt field (no
// Continuation Capsule field moves into receipt core).
//
//   - The STRUCTURAL core (loop_id, scope_ref, goal_hash, sealed, action_count, structural
//     amendment diffs, scope-event refs by hash) is always present and content-blind.
//   - The PLAINTEXT sidecar (settled / open_questions / next_actions) is carried ONLY in
//     Verified Context Mode. Proof Mode projects it away so the content-blind pack stays blind.

import { canonicalScopeJson, type ScopePrivacyMode, type SealedScope } from "./scope-capsule.js";
import type { ScopeEvent } from "./scope-event-recorder.js";
import { JUDGMENT_LEDGER_VERSION, type JudgmentVerdictKind, type JudgmentVerdictSource } from "./judgment-ledger.js";
import type { ReducedJudgmentState, RefusedStepRef } from "./judgment-reducer.js";

export const CONTINUATION_CAPSULE_VERSION = "continuation-capsule/v1";

/**
 * Structural summary of the judgment ledger (Capsule Gate 2), folded by the reducer. Content-blind:
 * counts, structural refs, and hashes only — it SUMMARIZES the ledger (it does not replace it; the
 * full ordered turns live in judgment-ledger.json). Present in both Proof and Verified Context
 * continuation capsules.
 */
export type ContinuationJudgmentSection = {
  judgment_ledger_version: string;
  final_turn_ref: string | null;
  turn_count: number;
  verdict_counts: Record<JudgmentVerdictKind, number>;
  source_counts: Record<JudgmentVerdictSource, number>;
  receipt_refs: string[];
  scope_event_refs: string[];
  runtime_result_hashes: string[];
  runtime_error_hashes: string[];
  refused_steps: RefusedStepRef[];
};

/** Structural record of one scope amendment (what changed), content-blind. */
export type ScopeAmendmentRecord = {
  from_scope_ref: string | null;
  to_scope_ref: string;
  sealed_at: string;
  /** Top-level structural fields that differ between the two sealed versions. */
  changed_fields: string[];
};

/** Structural reference to one attested scope event (no plaintext). */
export type ScopeEventRef = {
  event_hash: string;
  event_type: ScopeEvent["event_type"];
  decision: ScopeEvent["decision"];
  scope_ref: string;
  prior_receipt_id: string | null;
  matched_rule?: string;
};

export type ContinuationCapsule = {
  capsule_type: "continuation_capsule";
  capsule_version: string;
  loop_id: string;
  goal_hash: string;
  /** Final scope_ref after any amendments. */
  scope_ref: string;
  /** The original Scope Capsule this loop inherited from. */
  inherits_from: { scope_ref: string };
  sealed: boolean;
  action_count: number;
  closed_at: string;
  /** Scope amendments, in order. Empty when the scope was never amended. */
  what_changed: ScopeAmendmentRecord[];
  /** Attested scope refusals / escalations, by structural reference. */
  scope_events: ScopeEventRef[];
  // --- Capsule Gate 2 judgment ledger (structural; present when a reduced ledger was supplied) ---
  /** The final judgment turn_ref the loop settled at (structural, both modes). */
  final_turn_ref?: string | null;
  /** Structural summary of the folded judgment ledger (counts, refs, refused steps). */
  judgment?: ContinuationJudgmentSection;
  // --- plaintext sidecar (Verified Context Mode only) ---
  settled?: string[];
  open_questions?: string[];
  next_actions?: string[];
  /** Items the run changed (folded from supervisor deltas). Verified Context Mode only. */
  changed?: string[];
  /** Human-readable handoff prompt for the next agent / memory system. Verified Context only. */
  continuation_prompt?: string;
};

export type BuildContinuationCapsuleInput = {
  /** Seal history: [original, ...amendments]. Must contain at least the original. */
  scope_history: SealedScope[];
  scope_events: ScopeEvent[];
  loop: { loop_id: string; goal_hash: string; sealed: boolean; action_count: number };
  settled?: string[];
  open_questions?: string[];
  next_actions?: string[];
  closed_at?: string;
  mode: ScopePrivacyMode;
  /**
   * Capsule Gate 2 (optional): the reduced judgment-ledger state. When supplied, the continuation
   * capsule carries the structural judgment summary (both modes) and — in Verified Context Mode —
   * sources settled/open/next/changed from the fold (preferred over the explicit fields above).
   */
  reduced?: ReducedJudgmentState;
};

/** Diff two sealed scopes' STRUCTURAL projections; return the changed top-level field names. */
export function diffStructural(prior: SealedScope, next: SealedScope): string[] {
  const a = prior.structural as unknown as Record<string, unknown>;
  const b = next.structural as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (canonicalScopeJson(a[key]) !== canonicalScopeJson(b[key])) changed.push(key);
  }
  return changed.sort();
}

export function buildContinuationCapsule(input: BuildContinuationCapsuleInput): ContinuationCapsule {
  if (input.scope_history.length === 0) {
    throw new Error("buildContinuationCapsule requires at least the original sealed scope.");
  }
  const original = input.scope_history[0]!;
  const final = input.scope_history[input.scope_history.length - 1]!;

  const what_changed: ScopeAmendmentRecord[] = [];
  for (let i = 1; i < input.scope_history.length; i += 1) {
    const prior = input.scope_history[i - 1]!;
    const next = input.scope_history[i]!;
    what_changed.push({
      from_scope_ref: next.prior_scope_ref ?? prior.scope_ref,
      to_scope_ref: next.scope_ref,
      sealed_at: next.sealed_at,
      changed_fields: diffStructural(prior, next)
    });
  }

  const scope_events: ScopeEventRef[] = input.scope_events.map((e) => ({
    event_hash: e.event_hash,
    event_type: e.event_type,
    decision: e.decision,
    scope_ref: e.scope_ref,
    prior_receipt_id: e.prior_receipt_id,
    matched_rule: e.matched_rule
  }));

  const capsule: ContinuationCapsule = {
    capsule_type: "continuation_capsule",
    capsule_version: CONTINUATION_CAPSULE_VERSION,
    loop_id: input.loop.loop_id,
    goal_hash: input.loop.goal_hash,
    scope_ref: final.scope_ref,
    inherits_from: { scope_ref: original.scope_ref },
    sealed: input.loop.sealed,
    action_count: input.loop.action_count,
    closed_at: input.closed_at ?? new Date().toISOString(),
    what_changed,
    scope_events
  };

  // Capsule Gate 2: fold the reduced judgment ledger in. The STRUCTURAL summary (counts, refs,
  // refused steps, final_turn_ref) is content-blind and carried in BOTH modes.
  if (input.reduced) {
    capsule.final_turn_ref = input.reduced.final_turn_ref;
    capsule.judgment = projectJudgmentSection({
      judgment_ledger_version: JUDGMENT_LEDGER_VERSION,
      final_turn_ref: input.reduced.final_turn_ref,
      turn_count: input.reduced.turn_count,
      verdict_counts: input.reduced.verdict_counts,
      source_counts: input.reduced.source_counts,
      receipt_refs: input.reduced.receipt_refs,
      scope_event_refs: input.reduced.scope_event_refs,
      runtime_result_hashes: input.reduced.runtime_result_hashes,
      runtime_error_hashes: input.reduced.runtime_error_hashes,
      refused_steps: input.reduced.refused_steps
    });
  }

  if (input.mode === "verified_context") {
    // Prefer the reducer's fold (the supervisor-declared deltas folded over the turns); fall back to
    // explicitly supplied settled/open/next for callers that build the continuation directly.
    const settled = input.reduced?.settled ?? input.settled;
    const open_questions = input.reduced?.open_questions ?? input.open_questions;
    const next_actions = input.reduced?.next_actions ?? input.next_actions;
    const changed = input.reduced?.changed;
    if (settled) capsule.settled = settled;
    if (open_questions) capsule.open_questions = open_questions;
    if (next_actions) capsule.next_actions = next_actions;
    if (changed) capsule.changed = changed;
    // The continuation prompt is a Capsule Gate 2 handoff artifact (it cites final_turn_ref / the
    // judgment ledger), so emit it only when a reduced ledger was folded in — a Gate 1 continuation
    // (no `reduced`) keeps its exact prior VC shape.
    if (input.reduced) capsule.continuation_prompt = buildContinuationPrompt(capsule);
  }
  return capsule;
}

/** Rebuild a judgment section from its explicit (structural) allowlist — never spread JSON input. */
function projectJudgmentSection(section: ContinuationJudgmentSection): ContinuationJudgmentSection {
  return {
    judgment_ledger_version: section.judgment_ledger_version,
    final_turn_ref: section.final_turn_ref ?? null,
    turn_count: section.turn_count,
    verdict_counts: {
      APPROVED: section.verdict_counts.APPROVED,
      ESCALATED: section.verdict_counts.ESCALATED,
      REFUSED: section.verdict_counts.REFUSED
    },
    source_counts: {
      bind: section.source_counts.bind,
      scope_gate: section.source_counts.scope_gate,
      loop_bound: section.source_counts.loop_bound
    },
    receipt_refs: [...section.receipt_refs],
    scope_event_refs: [...section.scope_event_refs],
    runtime_result_hashes: [...section.runtime_result_hashes],
    runtime_error_hashes: [...section.runtime_error_hashes],
    refused_steps: section.refused_steps.map((s) => {
      const ref: RefusedStepRef = {
        turn_index: s.turn_index,
        turn_ref: s.turn_ref,
        kind: s.kind,
        source: s.source,
        corrected: s.corrected
      };
      if (s.reason_code !== undefined) ref.reason_code = s.reason_code;
      if (s.scope_event_hash !== undefined) ref.scope_event_hash = s.scope_event_hash;
      if (s.receipt_id !== undefined) ref.receipt_id = s.receipt_id;
      return ref;
    })
  };
}

/**
 * A short, human-readable handoff prompt for the next agent / memory system (Verified Context only).
 * Carries the settled/open/next plaintext the supervisor already declared — never any new content.
 */
function buildContinuationPrompt(capsule: ContinuationCapsule): string {
  const lines = [
    `You are continuing loop ${capsule.loop_id} under scope ${capsule.scope_ref}.`,
    `Start from the verified judgment ledger (final_turn_ref ${capsule.final_turn_ref ?? "—"}), not a transcript.`
  ];
  if (capsule.settled?.length) lines.push(`Settled: ${capsule.settled.join("; ")}.`);
  if (capsule.open_questions?.length) lines.push(`Open questions: ${capsule.open_questions.join("; ")}.`);
  if (capsule.next_actions?.length) lines.push(`Next actions: ${capsule.next_actions.join("; ")}.`);
  return lines.join(" ");
}

/**
 * Project a (possibly Verified-Context) continuation capsule down to its content-blind
 * structural core for a Proof Mode pack. Strips the plaintext sidecar fields.
 */
export function projectContinuationProofMode(capsule: ContinuationCapsule): ContinuationCapsule {
  // Content-blind projection by EXPLICIT allowlist — never spread the (JSON-loaded) capsule. Beyond the
  // plaintext sidecar fields (settled / open_questions / next_actions), a stale or tampered continuation
  // can carry arbitrary extra keys (e.g. `notes`, `plan`); a spread would leak them into the content-blind
  // continuation-capsule.json. Nested records are likewise reconstructed from their known structural
  // fields so no unknown sub-key rides along.
  const projected: ContinuationCapsule = {
    capsule_type: "continuation_capsule",
    capsule_version: capsule.capsule_version,
    loop_id: capsule.loop_id,
    goal_hash: capsule.goal_hash,
    scope_ref: capsule.scope_ref,
    inherits_from: { scope_ref: capsule.inherits_from.scope_ref },
    sealed: capsule.sealed,
    action_count: capsule.action_count,
    closed_at: capsule.closed_at,
    what_changed: capsule.what_changed.map((a) => ({
      from_scope_ref: a.from_scope_ref,
      to_scope_ref: a.to_scope_ref,
      sealed_at: a.sealed_at,
      changed_fields: [...a.changed_fields]
    })),
    scope_events: capsule.scope_events.map((e) => {
      const ref: ScopeEventRef = {
        event_hash: e.event_hash,
        event_type: e.event_type,
        decision: e.decision,
        scope_ref: e.scope_ref,
        prior_receipt_id: e.prior_receipt_id
      };
      if (e.matched_rule !== undefined) ref.matched_rule = e.matched_rule;
      return ref;
    })
  };
  // Capsule Gate 2: the judgment summary is STRUCTURAL (counts, refs, hashes, structural refused-step
  // codes), so it is carried in the content-blind Proof Mode projection. The plaintext sidecar
  // (settled / open_questions / next_actions / changed / continuation_prompt) is omitted by the
  // explicit allowlist above — never spread — so it can never leak into a Proof Mode pack.
  if (capsule.final_turn_ref !== undefined) projected.final_turn_ref = capsule.final_turn_ref;
  if (capsule.judgment) projected.judgment = projectJudgmentSection(capsule.judgment);
  return projected;
}

export function renderContinuationCardMarkdown(capsule: ContinuationCapsule): string {
  const lines = [
    `# Continuation Capsule`,
    ``,
    `| field | value |`,
    `| --- | --- |`,
    `| loop_id | \`${capsule.loop_id}\` |`,
    `| scope_ref | \`${capsule.scope_ref}\` |`,
    `| inherits_from | \`${capsule.inherits_from.scope_ref}\` |`,
    `| goal_hash | \`${capsule.goal_hash}\` |`,
    `| sealed | **${capsule.sealed ? "SEALED ✓" : "UNSEALED ✗"}** |`,
    `| action_count | ${capsule.action_count} |`,
    `| amendments | ${capsule.what_changed.length} |`,
    `| attested scope events | ${capsule.scope_events.length} |`,
    `| closed_at | \`${capsule.closed_at}\` |`,
    ``
  ];
  if (capsule.what_changed.length > 0) {
    lines.push(`## What changed (scope amendments)`, ``);
    for (const a of capsule.what_changed) {
      lines.push(`- \`${a.from_scope_ref ?? "—"}\` → \`${a.to_scope_ref}\` (fields: ${a.changed_fields.join(", ") || "—"})`);
    }
    lines.push(``);
  }
  if (capsule.scope_events.length > 0) {
    lines.push(`## Attested scope events`, ``);
    for (const e of capsule.scope_events) {
      lines.push(`- **${e.decision}** ${e.event_type} (rule: ${e.matched_rule ?? "—"}) — \`${e.event_hash}\` anchored to \`${e.prior_receipt_id ?? "loop-open"}\``);
    }
    lines.push(``);
  }
  if (capsule.judgment) {
    const j = capsule.judgment;
    lines.push(
      `## Judgment ledger (structural summary)`,
      ``,
      `| field | value |`,
      `| --- | --- |`,
      `| final_turn_ref | \`${j.final_turn_ref ?? "—"}\` |`,
      `| turns | ${j.turn_count} |`,
      `| verdicts | APPROVED ${j.verdict_counts.APPROVED} / ESCALATED ${j.verdict_counts.ESCALATED} / REFUSED ${j.verdict_counts.REFUSED} |`,
      `| sources | bind ${j.source_counts.bind} / scope_gate ${j.source_counts.scope_gate} / loop_bound ${j.source_counts.loop_bound} |`,
      `| receipt refs | ${j.receipt_refs.length} |`,
      `| scope-event refs | ${j.scope_event_refs.length} |`,
      `| runtime hashes | ${j.runtime_result_hashes.length} result / ${j.runtime_error_hashes.length} error |`,
      ``
    );
    if (j.refused_steps.length > 0) {
      lines.push(`### Refused / corrected steps`, ``);
      for (const s of j.refused_steps) {
        lines.push(
          `- turn ${s.turn_index} **${s.kind}** (${s.source}${s.reason_code ? `, ${s.reason_code}` : ""}) — ${s.corrected ? "corrected (later approval)" : "not corrected"}`
        );
      }
      lines.push(``);
    }
  }
  if (capsule.settled || capsule.open_questions || capsule.next_actions || capsule.changed) {
    lines.push(`## Settled / Open / Next (sidecar)`, ``);
    if (capsule.settled?.length) lines.push(`**Settled:**`, ...capsule.settled.map((s) => `- ${s}`), ``);
    if (capsule.open_questions?.length) lines.push(`**Open:**`, ...capsule.open_questions.map((s) => `- ${s}`), ``);
    if (capsule.next_actions?.length) lines.push(`**Next:**`, ...capsule.next_actions.map((s) => `- ${s}`), ``);
    if (capsule.changed?.length) lines.push(`**Changed:**`, ...capsule.changed.map((s) => `- ${s}`), ``);
  }
  if (capsule.continuation_prompt) {
    lines.push(`## Continuation prompt`, ``, capsule.continuation_prompt, ``);
  }
  return lines.join("\n");
}
