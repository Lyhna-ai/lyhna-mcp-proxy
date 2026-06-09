// Judgment-ledger recorder — the append-only, per-loop store for ordered judgment turns
// (Capsule Gate 2). It is the runtime PRODUCER of the middle layer, parallel to
// receipt-recorder.ts (signed receipts) and scope-event-recorder.ts (attested refusals).
//
//   - PROVENANCE: turns are appended adapter-side INSIDE the loop mutex (so judgment order
//     can never diverge from receipt order) and read back ONLY through the supervisor control
//     channel (the `dump_judgment` verb). The agent's MCP path never reaches this store — it
//     can neither append nor read judgment turns, exactly like the receipt/scope-event stores.
//   - APPEND-ONLY: one ordered ledger per loop_id, keyed by loop_id. turn_index is contiguous;
//     each appended turn derives a deterministic turn_ref and links to the prior turn via
//     prior_turn_ref. History is never mutated — the only post-append writes are the ADDITIVE
//     runtime_report (attached after the forward) and supervisor declared_delta (Verified
//     Context only), neither of which changes a turn's committed turn_ref.
//   - FAIL CLOSED: an unknown/duplicate turn_ref, a malformed delta, or a malformed runtime
//     report is rejected rather than silently absorbed.

import {
  assertValidDelta,
  assertValidRuntimeReport,
  deriveTurnRef,
  mergeDelta,
  normalizeDelta,
  normalizeProposed,
  normalizeVerdict,
  type JudgmentDelta,
  type JudgmentRuntimeReport,
  type JudgmentTurn,
  type JudgmentTurnInput
} from "./judgment-ledger.js";

/** Read side — what the supervisor control `dump_judgment` verb consumes. */
export interface JudgmentLedgerSource {
  /** Ordered judgment turns recorded for a loop_id (turn 0 .. N-1). A copy of the array. */
  judgmentLedgerForLoop(loop_id: string): JudgmentTurn[];
  /** Every loop_id that has at least one recorded judgment turn. */
  knownLoopIds(): string[];
}

export type JudgmentLedgerRecorder = JudgmentLedgerSource & {
  /**
   * Append a judgment turn for `loop_id`. The recorder owns ordering: turn_index = current
   * ledger length, prior_turn_ref = the prior turn's turn_ref (null for the first), and
   * turn_ref is derived deterministically from the judgment core. MUST be called inside the
   * loop's serializing mutex so judgment order matches receipt order.
   */
  append(input: JudgmentTurnInput): JudgmentTurn;
  /**
   * Attach the structural runtime report to an existing turn (additive; does not change
   * turn_ref). Fail-closed on an unknown turn_ref or a turn that already carries a report.
   */
  attachRuntimeReport(loop_id: string, turn_ref: string, report: JudgmentRuntimeReport): JudgmentTurn;
  /**
   * Attach a supervisor-declared delta to an existing turn (additive merge; does not change
   * turn_ref). Fail-closed on an unknown turn_ref or a malformed delta.
   */
  attachDelta(loop_id: string, turn_ref: string, delta: JudgmentDelta): JudgmentTurn;
};

export function createJudgmentRecorder(): JudgmentLedgerRecorder {
  const byLoop = new Map<string, JudgmentTurn[]>();

  function findTurn(loop_id: string, turn_ref: string): JudgmentTurn | undefined {
    return byLoop.get(loop_id)?.find((t) => t.turn_ref === turn_ref);
  }

  return {
    append(input: JudgmentTurnInput): JudgmentTurn {
      const ledger = byLoop.get(input.loop_id) ?? [];
      const turn_index = ledger.length;
      const prior_turn_ref = ledger.length > 0 ? ledger[ledger.length - 1]!.turn_ref : null;

      const core = {
        loop_id: input.loop_id,
        turn_index,
        prior_turn_ref,
        prior_receipt_id: input.prior_receipt_id ?? null,
        scope_ref: input.scope_ref,
        proposed: normalizeProposed(input.proposed),
        verdict: normalizeVerdict(input.verdict)
      };
      const turn_ref = deriveTurnRef(core);

      // Defensive: turn_ref embeds the unique-per-loop turn_index, so a duplicate cannot arise
      // through this path — but assert it rather than trust the invariant (fail closed).
      if (ledger.some((t) => t.turn_ref === turn_ref)) {
        throw new Error(`Judgment turn_ref ${turn_ref} already exists in loop ${input.loop_id} (fail closed).`);
      }

      const turn: JudgmentTurn = { ...core, turn_ref };
      if (ledger.length === 0) {
        byLoop.set(input.loop_id, [turn]);
      } else {
        ledger.push(turn);
      }
      return turn;
    },

    attachRuntimeReport(loop_id: string, turn_ref: string, report: JudgmentRuntimeReport): JudgmentTurn {
      assertValidRuntimeReport(report);
      const turn = findTurn(loop_id, turn_ref);
      if (!turn) {
        throw new Error(`No judgment turn ${turn_ref} in loop ${loop_id} to attach a runtime report (fail closed).`);
      }
      if (turn.runtime_report !== undefined) {
        throw new Error(`Judgment turn ${turn_ref} already carries a runtime report; refusing to overwrite (fail closed).`);
      }
      const rr: JudgmentRuntimeReport = { returned: report.returned };
      if (report.result_hash !== undefined) rr.result_hash = report.result_hash;
      if (report.error_hash !== undefined) rr.error_hash = report.error_hash;
      turn.runtime_report = rr;
      return turn;
    },

    attachDelta(loop_id: string, turn_ref: string, delta: JudgmentDelta): JudgmentTurn {
      assertValidDelta(delta);
      const turn = findTurn(loop_id, turn_ref);
      if (!turn) {
        throw new Error(`No judgment turn ${turn_ref} in loop ${loop_id} to attach a delta (fail closed).`);
      }
      // Additive only: merge the new delta into any existing one; never replace history.
      turn.declared_delta = mergeDelta(turn.declared_delta, normalizeDelta(delta));
      return turn;
    },

    judgmentLedgerForLoop(loop_id: string): JudgmentTurn[] {
      // Return a copy of the ARRAY so callers cannot reorder/extend the recorded ledger; the
      // turn objects inside are the originals (read-only by contract).
      return [...(byLoop.get(loop_id) ?? [])];
    },

    knownLoopIds(): string[] {
      return [...byLoop.keys()];
    }
  };
}
