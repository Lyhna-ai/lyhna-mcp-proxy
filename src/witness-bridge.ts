// Witness bridge — assemble a `witness-input.json` from the two halves of claimed-vs-actual:
// the agent's recorded CLAIMS (claim-recorder.ts) and the witnessed judgment ledger
// (judgment-recorder.ts). The output is exactly the payload the sibling `lyhna-witness` package's
// `runFromWitnessedEvents({ objective, steps:[{claim, event}] })` consumes — the proxy emits this at
// loop close and invokes the witness to render the handoff (Integration Option A: neither package
// imports the other's internals; the witness stays the canonical owner of the trust labels).
//
// Two deliberate v1 boundaries:
//   - CONTENT-BLIND: a JudgmentTurn stores `proposed.tool_name` but NOT `call.arguments` (the ledger
//     discards plaintext). `event.call` therefore carries only the tool name. That is sufficient for
//     the universal single-system path (the witness's splitToolName needs only the name); cracking a
//     wrapper-family call open (Zapier `execute_zapier_<app>_action` → app/action) needs arguments and
//     is a deferred follow-on that must capture them in a Verified-Context sidecar, never the signed pack.
//   - POSITIONAL PAIRING: a claim pairs with the witnessed turn at the same ordinal, with an optional
//     explicit `turn_ref` override. A claim with no matching turn becomes `event: null` (the dangerous
//     "claimed but never witnessed"); a turn with no claim becomes `claim: null` (observed, supported).

import type { JudgmentTurn } from "./judgment-ledger.js";
import type { AgentClaim } from "./claim-recorder.js";

/** The witness's per-step claim half (a structural subset of AgentClaim; correlation fields dropped). */
export interface WitnessClaim {
  system: string;
  action?: string;
  result?: string;
  via?: string;
  user_facing?: boolean;
}

/** The witness's per-step witnessed half — a JudgmentTurn projected to the event vocabulary. */
export interface WitnessEvent {
  call: { toolName: string };
  verdict: { kind: string };
  runtime_report?: { returned: boolean; result_hash?: string; error_hash?: string };
}

export interface WitnessStep {
  claim: WitnessClaim | null;
  event: WitnessEvent | null;
}

export interface WitnessInput {
  objective: string;
  steps: WitnessStep[];
  settled?: string[];
  open_questions?: string[];
  next_actions?: string[];
  do_not_re_litigate?: string[];
  proof_refs?: Record<string, unknown> | null;
}

export interface AssembleWitnessInputParams {
  objective: string;
  claims: AgentClaim[];
  turns: JudgmentTurn[];
  settled?: string[];
  open_questions?: string[];
  next_actions?: string[];
  do_not_re_litigate?: string[];
  proof_refs?: Record<string, unknown> | null;
}

function toWitnessClaim(c: AgentClaim): WitnessClaim {
  const claim: WitnessClaim = { system: c.system };
  if (c.action !== undefined) claim.action = c.action;
  if (c.result !== undefined) claim.result = c.result;
  if (c.via !== undefined) claim.via = c.via;
  if (c.user_facing !== undefined) claim.user_facing = c.user_facing;
  return claim;
}

function toWitnessEvent(turn: JudgmentTurn): WitnessEvent {
  const event: WitnessEvent = {
    call: { toolName: turn.proposed.tool_name },
    verdict: { kind: turn.verdict.kind }
  };
  if (turn.runtime_report !== undefined) {
    const rr: WitnessEvent["runtime_report"] = { returned: turn.runtime_report.returned };
    if (turn.runtime_report.result_hash !== undefined) rr.result_hash = turn.runtime_report.result_hash;
    if (turn.runtime_report.error_hash !== undefined) rr.error_hash = turn.runtime_report.error_hash;
    event.runtime_report = rr;
  }
  return event;
}

/**
 * Pair claims with witnessed turns into a witness-input payload. Claims are paired by ordinal
 * (claim i ↔ turn i), with an explicit `turn_ref` taking precedence; any witnessed turn no claim
 * matched is appended as an observed (claim: null) step so the handoff never under-reports what the
 * witness actually saw.
 */
export function assembleWitnessInput(params: AssembleWitnessInputParams): WitnessInput {
  const { objective, claims, turns } = params;
  const byRef = new Map(turns.map((t) => [t.turn_ref, t]));
  const matchedRefs = new Set<string>();
  const steps: WitnessStep[] = [];

  claims.forEach((c, i) => {
    let turn: JudgmentTurn | undefined;
    if (c.turn_ref !== undefined) {
      // An explicit turn_ref is a HARD binding. If it is missing from the ledger or already matched,
      // leave the claim unmatched (event: null) — never fall back to an unrelated ordinal turn, or a
      // claim could read as supported by a turn it never referenced, hiding the very mismatch this
      // bridge exists to expose.
      if (byRef.has(c.turn_ref) && !matchedRefs.has(c.turn_ref)) turn = byRef.get(c.turn_ref);
    } else {
      const ordinal = turns[i];
      if (ordinal !== undefined && !matchedRefs.has(ordinal.turn_ref)) turn = ordinal;
    }
    if (turn !== undefined) matchedRefs.add(turn.turn_ref);
    steps.push({ claim: toWitnessClaim(c), event: turn ? toWitnessEvent(turn) : null });
  });

  for (const turn of turns) {
    if (!matchedRefs.has(turn.turn_ref)) {
      steps.push({ claim: null, event: toWitnessEvent(turn) });
    }
  }

  const input: WitnessInput = { objective, steps };
  if (params.settled !== undefined) input.settled = params.settled;
  if (params.open_questions !== undefined) input.open_questions = params.open_questions;
  if (params.next_actions !== undefined) input.next_actions = params.next_actions;
  if (params.do_not_re_litigate !== undefined) input.do_not_re_litigate = params.do_not_re_litigate;
  if (params.proof_refs !== undefined) input.proof_refs = params.proof_refs;
  return input;
}
