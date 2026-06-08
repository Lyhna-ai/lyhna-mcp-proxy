// Scope-event recorder — the SUPERVISOR-ONLY sidecar attestation store for scope refusals /
// escalations (Capsule Gate 1, Option B).
//
// A scope refusal happens ADAPTER-SIDE, PRE-BIND: the adapter catches an out-of-lane step
// before any bind() call, so there is no signed core receipt for it and the adapter holds no
// signing key. Rather than change the canonical receipt schema (forbidden), the halt is recorded
// here as a sidecar-attested event:
//
//   - PROVENANCE: events are produced adapter-side and read back ONLY through the supervisor
//     control channel (parallel to receipt-recorder.ts / the `dump` verb). The agent's MCP path
//     never reaches this store — it can neither write nor read scope events.
//   - INTEGRITY: each event carries an `event_hash` over its structural fields.
//   - CHAIN-ANCHORING: each event cites the `prior_receipt_id` it was blocked against, anchoring
//     the halt to the signed receipt chain.
//
// The Proof Pack references each `event_hash` from bundle.json; the signed receipts.json chain is
// untouched, so cold verification stays green. The halt is therefore VISIBLE and VERIFIABLE in
// the Proof Pack and is not an unproven UI message — with no core / schema change.

import { createHash } from "node:crypto";

import { canonicalScopeJson } from "./scope-capsule.js";

export type ScopeEventType = "scope_refusal" | "scope_escalation";
export type ScopeEventDecision = "REFUSED" | "ESCALATED";

/** The attempted step, structurally described. `target` (plaintext) is Verified-Context only. */
export type ScopeEventAttempt = {
  action_class?: string;
  tool_name?: string;
  /** sha256 hash or structural class — never plaintext. Always safe to export. */
  target_descriptor?: string | null;
  /** Plaintext target — Verified Context Mode sidecar only; stripped in Proof Mode export. */
  target?: string;
};

export type ScopeEvent = {
  event_type: ScopeEventType;
  loop_id: string;
  scope_ref: string;
  attempted: ScopeEventAttempt;
  matched_rule?: string;
  decision: ScopeEventDecision;
  prior_receipt_id: string | null;
  ts: string;
  /** sha256 over the canonical structural event (excludes plaintext `target` and itself). */
  event_hash: string;
};

export type RecordScopeEventInput = {
  event_type: ScopeEventType;
  loop_id: string;
  scope_ref: string;
  attempted: ScopeEventAttempt;
  matched_rule?: string;
  decision: ScopeEventDecision;
  prior_receipt_id: string | null;
  ts?: string;
};

/** Read side — what the supervisor control `dump_scope` verb consumes. */
export interface ScopeEventSource {
  scopeEventsForLoop(loop_id: string): ScopeEvent[];
  knownLoopIds(): string[];
}

export type ScopeEventRecorder = ScopeEventSource & {
  record(input: RecordScopeEventInput): ScopeEvent;
};

/**
 * Compute the content-blind `event_hash`: a sha256 over the event's STRUCTURAL fields. The
 * plaintext `target` is deliberately excluded, so the hash is identical in Proof Mode and
 * Verified Context Mode and is itself safe to publish in a content-blind pack.
 */
export function deriveScopeEventHash(input: {
  event_type: ScopeEventType;
  loop_id: string;
  scope_ref: string;
  attempted: ScopeEventAttempt;
  matched_rule?: string;
  decision: ScopeEventDecision;
  prior_receipt_id: string | null;
  ts: string;
}): string {
  const structural = {
    event_type: input.event_type,
    loop_id: input.loop_id,
    scope_ref: input.scope_ref,
    attempted: {
      action_class: input.attempted.action_class,
      tool_name: input.attempted.tool_name,
      target_descriptor: input.attempted.target_descriptor ?? null
    },
    matched_rule: input.matched_rule,
    decision: input.decision,
    prior_receipt_id: input.prior_receipt_id,
    ts: input.ts
  };
  return `sha256:${createHash("sha256").update(canonicalScopeJson(structural), "utf8").digest("hex")}`;
}

export function createScopeEventRecorder(): ScopeEventRecorder {
  const byLoop = new Map<string, ScopeEvent[]>();

  return {
    record(input: RecordScopeEventInput): ScopeEvent {
      const ts = input.ts ?? new Date().toISOString();
      const event_hash = deriveScopeEventHash({ ...input, ts });
      const event: ScopeEvent = {
        event_type: input.event_type,
        loop_id: input.loop_id,
        scope_ref: input.scope_ref,
        attempted: input.attempted,
        matched_rule: input.matched_rule,
        decision: input.decision,
        prior_receipt_id: input.prior_receipt_id,
        ts,
        event_hash
      };
      const list = byLoop.get(input.loop_id);
      if (list) {
        list.push(event);
      } else {
        byLoop.set(input.loop_id, [event]);
      }
      return event;
    },

    scopeEventsForLoop(loop_id: string): ScopeEvent[] {
      return [...(byLoop.get(loop_id) ?? [])];
    },

    knownLoopIds(): string[] {
      return [...byLoop.keys()];
    }
  };
}

/**
 * Project a scope event for export under a privacy mode. Proof Mode strips the plaintext
 * `target` (content-blind); Verified Context Mode retains it for the tenant-visible pack.
 * `event_hash` is unaffected (it never covered the plaintext target).
 */
export function projectScopeEvent(event: ScopeEvent, mode: "proof" | "verified_context"): ScopeEvent {
  if (mode === "verified_context") return event;
  const { target: _drop, ...attempted } = event.attempted;
  return { ...event, attempted };
}
