// HANDOFF.md — THE HANDOFF: the next-agent-facing, human-readable face of the capsule.
//
// Every closed loop already emits a machine-facing seed (memory-injection.json). This module
// surfaces the SAME verified continuation as a first-class, paste-into-the-next-session artifact:
// HANDOFF.md in every capsule export, plus the `handoff` CLI verb that prints it.
//
// The differentiator (and the honesty line): a hand-written "handoff doc" is authored by the
// agent about itself after the fact. This one is ASSEMBLED from the sealed during-run judgment
// ledger — the agent cannot author its own report card. Nothing here is new content: the prompt
// carries only what the verified continuation capsule already carries.
//
// Privacy: the renderer reads the ALREADY-PROJECTED continuation (the export projects per mode
// before rendering), so a Proof Mode handoff is structural-only — loop / scope / final_turn_ref /
// verdict counts, with the plaintext explicitly declared withheld. It never reconstructs or
// invents settled/open/next text the projection stripped.

import type { ContinuationCapsule } from "./continuation-capsule.js";

/**
 * The paste-ready handoff prompt for the next agent session.
 *
 * Verified Context capsules carry `continuation_prompt` (assembled at close from the reduced
 * judgment ledger) — use it verbatim. For a content-blind capsule (Proof Mode, or a Gate 1
 * capsule with no judgment fold) build the structural equivalent, stating plainly that the
 * plaintext sidecar is withheld rather than pretending it does not exist.
 */
export function buildHandoffPrompt(continuation: ContinuationCapsule): string {
  if (continuation.continuation_prompt) {
    return continuation.continuation_prompt;
  }
  const lines = [
    `You are continuing loop ${continuation.loop_id} under scope ${continuation.scope_ref}.`,
    continuation.final_turn_ref !== undefined
      ? `Start from the verified judgment ledger (final_turn_ref ${continuation.final_turn_ref ?? "—"}), not a transcript.`
      : `Start from the verified continuation capsule, not a transcript.`,
    `This pack is content-blind: the settled/open/next plaintext is withheld by design.`,
    continuation.judgment
      ? `Read the structural judgment summary from continuation-capsule.json and the turn-by-turn ` +
        `path from judgment-ledger.json; a Verified Context export of the same loop carries the plaintext.`
      : `Read the structural summary from continuation-capsule.json; a Verified Context export of the ` +
        `same loop carries the plaintext.`
  ];
  return lines.join(" ");
}

/** HANDOFF.md — the handoff prompt plus what anchors it, sized for a person to act on. */
export function renderHandoffMarkdown(continuation: ContinuationCapsule): string {
  const j = continuation.judgment;
  const lines = [
    `# HANDOFF — verified continuation for the next agent`,
    ``,
    `This handoff was assembled from the loop's sealed judgment ledger, captured DURING the run`,
    `inside the receipt-chain mutex — the agent did not write its own report card.`,
    ``,
    `## Paste this into the next agent session`,
    ``,
    "```text",
    buildHandoffPrompt(continuation),
    "```",
    ``
  ];

  if (continuation.settled?.length || continuation.open_questions?.length || continuation.next_actions?.length || continuation.changed?.length) {
    lines.push(`## State of the work (supervisor-declared, folded from the ledger)`, ``);
    if (continuation.settled?.length) lines.push(`**Settled**`, ...continuation.settled.map((s) => `- ${s}`), ``);
    if (continuation.open_questions?.length) lines.push(`**Open**`, ...continuation.open_questions.map((s) => `- ${s}`), ``);
    if (continuation.next_actions?.length) lines.push(`**Next**`, ...continuation.next_actions.map((s) => `- ${s}`), ``);
    if (continuation.changed?.length) lines.push(`**Changed**`, ...continuation.changed.map((s) => `- ${s}`), ``);
  }

  lines.push(
    `## What anchors this handoff`,
    ``,
    `| field | value |`,
    `| --- | --- |`,
    `| loop | \`${continuation.loop_id}\` |`,
    `| scope_ref | \`${continuation.scope_ref}\` (inherits \`${continuation.inherits_from.scope_ref}\`) |`,
    ...(continuation.inherits_loop
      ? [
          `| opened from prior loop | capsule \`${continuation.inherits_loop.capsule_ref}\` · scope \`${continuation.inherits_loop.scope_ref}\` · final turn \`${continuation.inherits_loop.final_turn_ref}\` |`
        ]
      : []),
    `| sealed | **${continuation.sealed ? "SEALED ✓" : "UNSEALED ✗"}** — ${continuation.action_count} action(s) |`,
    ...(continuation.final_turn_ref !== undefined ? [`| final_turn_ref | \`${continuation.final_turn_ref ?? "—"}\` |`] : []),
    ...(j
      ? [
          `| judgment turns | ${j.turn_count} (✓ ${j.verdict_counts.APPROVED} · ⛔ ${j.verdict_counts.REFUSED} · ⏸ ${j.verdict_counts.ESCALATED}) |`
        ]
      : []),
    `| amendments | ${continuation.what_changed.length} |`,
    `| attested scope events | ${continuation.scope_events.length} |`,
    `| closed_at | \`${continuation.closed_at}\` |`,
    ``,
    ...(j
      ? [
          `Machine-ingestable version of this handoff: \`memory-injection.json\`. Full judgment path:`,
          `\`judgment-ledger.json\` / \`.md\`. Verify the chain this handoff is folded from:`
        ]
      : [`Verify the chain this handoff is folded from:`]),
    ``,
    "```",
    `npx -y lyhna-verify --chain receipts.json`,
    "```",
    ``
  );
  return lines.join("\n");
}
