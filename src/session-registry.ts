// Loop-session registry for the STANDING proxy service.
//
// Phase 5a generalizes the single process-global LoopSession (one loop per process,
// sealed on SIGTERM) into a registry keyed by session_id so one standing proxy can run
// many concurrent loops at once — each with its own independent receipt chain.
//
// This module is strictly ADDITIVE and COMPOSITIONAL. It does not touch the LoopSession
// spine, the bind() contract, the prior_receipt_id chain advance, or verifyLoopChain.
// open/close are the only new verbs; close still rides bind() via constraints.loop_close
// exactly as today (it goes through closeLoopWithRetry -> LoopSession.close).
//
// CRITICAL ISOLATION PROPERTY: open/close are invoked ONLY by the supervisor control
// channel (see control-channel.ts), never on the agent's MCP path. The agent path can
// only route tools/call to an already-open session via `get()`; it can neither open nor
// close a loop. If the governed agent could close its own loop, the proof collapses
// (self-attestation). That boundary is enforced topologically: the MCP transport never
// reaches openLoop/closeLoop.

import {
  closeLoopWithRetry,
  createLoopContext,
  LoopSession,
  type LoopBindFn,
  type LoopCloseResult,
  type LoopCloseTuning
} from "./loop.js";

export type OpenLoopInput = {
  session_id: string;
  loop_id: string;
  goal: string;
};

export type CloseLoopInput = {
  session_id: string;
  outcome: string;
  reason: string;
};

export type SessionSummary = {
  session_id: string;
  loop_id: string;
  action_count: number;
  closed: boolean;
};

/**
 * Holds the live LoopSessions for a standing proxy, keyed by session_id.
 *
 * The registry owns lifecycle (open/close) only. Per-call chain advance stays inside
 * LoopSession's mutex — the registry never reaches into the spine. The provided `bind`
 * is the same hosted bind() the proxy already calls; the registry just routes each
 * session's close through it via closeLoopWithRetry.
 */
export class LoopSessionRegistry {
  private readonly sessions = new Map<string, LoopSession>();
  // In-flight close per session_id. Overlapping closes coalesce onto the same promise
  // so only ONE terminal loop_close is ever emitted (see closeLoop).
  private readonly closing = new Map<string, Promise<LoopCloseResult>>();
  // Every loop_id opened in this process (active AND already-closed). A loop_id identifies
  // exactly one loop instance (canonical: a unique minted id). The receipt recorder keys
  // captured receipts by loop_id, and it retains them past close so the supervisor can dump
  // a sealed chain — so reusing a loop_id (concurrently OR after close) would merge two
  // distinct chains into one bucket and corrupt the exported proof. Reject reuse at open
  // time so one loop_id maps to one chain, ever.
  private readonly seenLoopIds = new Set<string>();

  constructor(
    private readonly bind: LoopBindFn,
    private readonly tuning: LoopCloseTuning
  ) {}

  /**
   * Open a new loop for `session_id`. Supervisor-only. Refuses to overwrite an already
   * open session (fail closed: silently replacing a session would orphan an unsealed
   * chain). goal_hash is derived canonically inside createLoopContext.
   */
  openLoop(input: OpenLoopInput): LoopSession {
    const sessionId = input.session_id?.trim();
    if (!sessionId) {
      throw new Error("openLoop requires a non-empty session_id.");
    }
    if (!input.loop_id?.trim()) {
      throw new Error("openLoop requires a non-empty loop_id.");
    }
    if (input.goal === undefined || input.goal.length === 0) {
      throw new Error("openLoop requires a non-empty goal.");
    }
    if (this.sessions.has(sessionId)) {
      throw new Error(`Loop session already open: ${sessionId}`);
    }
    if (this.seenLoopIds.has(input.loop_id)) {
      throw new Error(
        `Loop id already used: ${input.loop_id}. A loop_id identifies exactly one loop; reusing it would merge distinct chains in the recorded dump.`
      );
    }

    const session = new LoopSession(
      createLoopContext({ loop_id: input.loop_id, goal: input.goal })
    );
    this.sessions.set(sessionId, session);
    this.seenLoopIds.add(input.loop_id);
    return session;
  }

  /**
   * Resolve the LoopSession for `session_id`, or undefined if no loop is open for it.
   * This is the ONLY method on the agent's hot path (tools/call routing). It cannot
   * mutate lifecycle — it only reads.
   */
  get(session_id: string): LoopSession | undefined {
    return this.sessions.get(session_id);
  }

  has(session_id: string): boolean {
    return this.sessions.has(session_id);
  }

  get size(): number {
    return this.sessions.size;
  }

  activeSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  summaries(): SessionSummary[] {
    return [...this.sessions.entries()].map(([session_id, session]) => ({
      session_id,
      loop_id: session.loopId,
      action_count: session.actionCount,
      closed: session.closed
    }));
  }

  /**
   * Seal the loop for `session_id`. Supervisor-only. Emits the terminal loop_close bind
   * (via closeLoopWithRetry -> LoopSession.close), retrying within the grace window. On
   * a sealed result the session is removed from the active map, so any further agent
   * tools/call for that session resolves to no session and fails closed. On an unsealed
   * result the session is left in place (detectably unsealed) so the supervisor can
   * observe and retry.
   */
  async closeLoop(input: CloseLoopInput): Promise<LoopCloseResult> {
    // Coalesce overlapping closes for the same session so exactly ONE terminal
    // loop_close is ever emitted. Two close paths can race — a supervisor retry sending
    // two `close` lines, or a control `close` racing the SIGTERM closeAll sweep — and
    // both could read the same LoopSession before the first deletes it. Without this
    // guard both would await closeLoopWithRetry and emit a second terminal close, which
    // invalidates the chain (verifyLoopChain rejects multiple terminals). The claim is
    // registered synchronously before the first await, so a concurrent caller observes it
    // and returns the same in-flight result instead of starting a second close.
    const inflight = this.closing.get(input.session_id);
    if (inflight) {
      return inflight;
    }

    const session = this.sessions.get(input.session_id);
    if (!session) {
      throw new Error(`No open loop for session: ${input.session_id}`);
    }

    const task = (async () => {
      const result = await closeLoopWithRetry(session, this.bind, {
        outcome: input.outcome,
        termination_reason: input.reason,
        graceMs: this.tuning.graceMs,
        retryDelayMs: this.tuning.retryDelayMs
      });

      // A sealed result removes the session so later agent tools/call fail closed. An
      // unsealed result is left in place (detectably unsealed) so the supervisor can retry.
      if (result.sealed) {
        this.sessions.delete(input.session_id);
      }

      return result;
    })();

    this.closing.set(input.session_id, task);
    try {
      return await task;
    } finally {
      this.closing.delete(input.session_id);
    }
  }

  /**
   * Seal every open loop. Used by the supervisor at standing-service shutdown (SIGTERM
   * is itself a supervisor signal, on the same side of the isolation boundary as the
   * control channel). Sessions that seal are removed; sessions that fail to seal within
   * the grace window are left detectably unsealed.
   */
  async closeAll(reason: string): Promise<Map<string, LoopCloseResult>> {
    const results = new Map<string, LoopCloseResult>();
    for (const session_id of this.activeSessionIds()) {
      results.set(
        session_id,
        await this.closeLoop({ session_id, outcome: "COMPLETED", reason })
      );
    }
    return results;
  }
}
