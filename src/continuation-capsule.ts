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

export const CONTINUATION_CAPSULE_VERSION = "continuation-capsule/v1";

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
  // --- plaintext sidecar (Verified Context Mode only) ---
  settled?: string[];
  open_questions?: string[];
  next_actions?: string[];
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

  if (input.mode === "verified_context") {
    if (input.settled) capsule.settled = input.settled;
    if (input.open_questions) capsule.open_questions = input.open_questions;
    if (input.next_actions) capsule.next_actions = input.next_actions;
  }
  return capsule;
}

/**
 * Project a (possibly Verified-Context) continuation capsule down to its content-blind
 * structural core for a Proof Mode pack. Strips the plaintext sidecar fields.
 */
export function projectContinuationProofMode(capsule: ContinuationCapsule): ContinuationCapsule {
  const { settled: _s, open_questions: _o, next_actions: _n, ...structural } = capsule;
  return structural;
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
  if (capsule.settled || capsule.open_questions || capsule.next_actions) {
    lines.push(`## Settled / Open / Next (sidecar)`, ``);
    if (capsule.settled?.length) lines.push(`**Settled:**`, ...capsule.settled.map((s) => `- ${s}`), ``);
    if (capsule.open_questions?.length) lines.push(`**Open:**`, ...capsule.open_questions.map((s) => `- ${s}`), ``);
    if (capsule.next_actions?.length) lines.push(`**Next:**`, ...capsule.next_actions.map((s) => `- ${s}`), ``);
  }
  return lines.join("\n");
}
