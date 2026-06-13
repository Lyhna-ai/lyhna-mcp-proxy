// Agent-claim recorder — the append-only, per-loop store for an agent's own CLAIMS about what it
// did ("I sent the email"). This is the net-new half of claimed-vs-actual: the content-blind
// judgment ledger (judgment-recorder.ts) records what ACTUALLY crossed the wire; this records what
// the agent SAYS it did, so the witness can compare the two. It is parallel to the judgment recorder,
// with three deliberate differences that preserve the trust model:
//
//   - VOICE: a claim is the AGENT'S self-report, recorded through the agent-facing `record_claim`
//     tool — not a supervisor declaration like declared_delta. That is the whole point: the claim is
//     the thing being audited, so it must come from the narrator under audit.
//   - VERIFIED CONTEXT ONLY: a claim is free-text/plaintext, so it is a Verified-Context sidecar. It
//     NEVER enters a turn_ref, a signed receipt, or a Proof-Mode pack (the same content-blindness
//     floor that keeps declared_delta out of the signed spine).
//   - NON-AUTHORITATIVE: recording a claim grants nothing and gates nothing. The agent can WRITE a
//     claim but can never READ or alter the witnessed ledger (supervisor-only), so it cannot forge
//     the "actual" side. Claims are read back ONLY through the supervisor `dump_claims` verb.
//
// APPEND-ONLY: one ordered list per loop_id; claim_index is contiguous from 0 so a claim pairs with
// the witnessed turn at the same ordinal (the witness pairs positionally), with an optional explicit
// turn_ref override when the agent wants to bind a claim to a specific witnessed turn. FAIL CLOSED:
// a claim with no loop_id or no claimed system is rejected rather than silently stored.

/** What the agent-facing `record_claim` tool hands the recorder (claim_index is recorder-assigned). */
export interface AgentClaimInput {
  loop_id: string;
  /** The system the agent claims it used, e.g. "gmail", "google_drive". Required. */
  system: string;
  /** The action the agent claims it took, e.g. "send", "create_document". */
  action?: string;
  /** The result the agent claims it got, e.g. "sent the follow-up to the prospect". */
  result?: string;
  /** A route/intermediary the agent discloses, if any (e.g. "zapier"). Absence is itself auditable. */
  via?: string;
  /** Whether this step is reported to a human or sent outward — drives DO_NOT_SEND when unsupported. */
  user_facing?: boolean;
  /** Optional explicit correlation to a witnessed judgment turn; otherwise paired by ordinal. */
  turn_ref?: string;
}

/** A recorded claim: the input plus the recorder-owned contiguous ordinal. */
export interface AgentClaim extends AgentClaimInput {
  claim_index: number;
}

/** Read side — what the supervisor control `dump_claims` verb consumes. */
export interface AgentClaimSource {
  /** Ordered claims recorded for a loop_id (claim 0 .. N-1). A copy of the array. */
  claimsForLoop(loop_id: string): AgentClaim[];
  /** Every loop_id that has at least one recorded claim. */
  knownLoopIds(): string[];
}

export type AgentClaimRecorder = AgentClaimSource & {
  /**
   * Append a claim for `loop_id`. The recorder owns ordering: claim_index = current list length.
   * Fail-closed on a missing loop_id or a blank claimed system.
   */
  record(input: AgentClaimInput): AgentClaim;
};

function requireNonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`record_claim: '${field}' is required and must be a non-empty string (fail closed).`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error("record_claim: claim fields must be strings when present (fail closed).");
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createClaimRecorder(): AgentClaimRecorder {
  const byLoop = new Map<string, AgentClaim[]>();

  return {
    record(input: AgentClaimInput): AgentClaim {
      const loop_id = requireNonBlank(input.loop_id, "loop_id");
      const system = requireNonBlank(input.system, "system");

      const list = byLoop.get(loop_id) ?? [];
      const claim: AgentClaim = {
        loop_id,
        claim_index: list.length,
        system
      };
      const action = optionalString(input.action);
      const result = optionalString(input.result);
      const via = optionalString(input.via);
      const turn_ref = optionalString(input.turn_ref);
      if (action !== undefined) claim.action = action;
      if (result !== undefined) claim.result = result;
      if (via !== undefined) claim.via = via;
      if (turn_ref !== undefined) claim.turn_ref = turn_ref;
      if (input.user_facing !== undefined) claim.user_facing = Boolean(input.user_facing);

      if (list.length === 0) {
        byLoop.set(loop_id, [claim]);
      } else {
        list.push(claim);
      }
      return claim;
    },

    claimsForLoop(loop_id: string): AgentClaim[] {
      // Return a copy of the ARRAY so callers cannot reorder/extend the recorded claims; the claim
      // objects inside are the originals (read-only by contract).
      return [...(byLoop.get(loop_id) ?? [])];
    },

    knownLoopIds(): string[] {
      return [...byLoop.keys()];
    }
  };
}
