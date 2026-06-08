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
import type { ProxyScopeContext } from "./proxy-core.js";
import {
  amendScope,
  sealScopeCapsule,
  type ScopeCapsule,
  type SealedScope
} from "./scope-capsule.js";
import type { ScopeEventRecorder } from "./scope-event-recorder.js";

export type OpenLoopInput = {
  session_id: string;
  loop_id: string;
  goal: string;
  // Optional Capsule Gate 1 scope material, sealed at open by this supervisor-only boundary.
  // The agent's MCP path never reaches openLoop, so the agent cannot seal its own scope.
  scope_capsule?: ScopeCapsule;
  /** Optional tool-name -> action-class map for the structural gate. */
  scope_class_map?: Record<string, string>;
};

/** Per-session scope state: the sealed scope seal-history (original + amendments) + class map. */
type SessionScopeState = {
  session_id: string;
  loop_id: string;
  history: SealedScope[];
  classMap?: Record<string, string>;
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
  // Capsule Gate 1 scope state. Keyed by BOTH session_id (the agent hot-path / gate lookup) and
  // loop_id (the supervisor dump_scope / continuation lookup), pointing at the SAME state object.
  // Retained past close (like recorded receipts) so the supervisor can build the Continuation
  // Capsule. Only populated when a loop opens WITH a scope capsule.
  private readonly scopeBySession = new Map<string, SessionScopeState>();
  private readonly scopeByLoop = new Map<string, SessionScopeState>();

  constructor(
    private readonly bind: LoopBindFn,
    private readonly tuning: LoopCloseTuning,
    // Optional shared scope-event recorder. Required for the scope gate to attest refusals.
    private readonly scopeEventRecorder?: ScopeEventRecorder
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
    // FAIL CLOSED: a scoped loop without a scope-event recorder has no attestation sink, so a
    // scope refusal could not be recorded/proved. Refuse to open it rather than silently degrade
    // the scoped session to an ungated one. (Checked before any state mutation.)
    if (input.scope_capsule && !this.scopeEventRecorder) {
      throw new Error(
        "Cannot open a scoped loop without a scope-event recorder: scope refusals must be attestable (fail closed)."
      );
    }

    const context = createLoopContext({ loop_id: input.loop_id, goal: input.goal });

    // Seal the Scope Capsule BEFORE mutating any registry state (supervisor boundary). goal_hash
    // is bound to the loop's canonical goal_hash so the capsule cannot declare a different goal
    // than the loop. Sealing can throw (bad capsule type, plaintext leak, unenforceable bound);
    // doing it first means a rejected capsule leaves NO half-opened session that would otherwise
    // resolve as scoped-but-ungated. Registry writes below are atomic w.r.t. seal success.
    let scopeState: SessionScopeState | undefined;
    if (input.scope_capsule) {
      const structural = {
        ...input.scope_capsule.structural,
        loop_id: input.loop_id,
        goal_hash: context.goal_hash
      };
      const sealed = sealScopeCapsule({ capsule: { structural, sidecar: input.scope_capsule.sidecar } });
      scopeState = {
        session_id: sessionId,
        loop_id: input.loop_id,
        history: [sealed],
        classMap: input.scope_class_map
      };
    }

    const session = new LoopSession(context);
    this.sessions.set(sessionId, session);
    this.seenLoopIds.add(input.loop_id);
    if (scopeState) {
      this.scopeBySession.set(sessionId, scopeState);
      this.scopeByLoop.set(input.loop_id, scopeState);
    }
    return session;
  }

  /**
   * Resolve the scope context for the agent hot path / gate, or undefined when the session has
   * no sealed scope (baseline, ungated) or no scope-event recorder is configured. Read-only.
   */
  getScope(session_id: string): ProxyScopeContext | undefined {
    const state = this.scopeBySession.get(session_id);
    if (!state || !this.scopeEventRecorder) return undefined;
    const sealed = state.history[state.history.length - 1]!;
    return {
      sealed,
      mode: sealed.structural.privacy_mode,
      recorder: this.scopeEventRecorder,
      classMap: state.classMap
    };
  }

  /**
   * Amend the scope for an OPEN session. SUPERVISOR-ONLY (control channel `amend` verb). Seals a
   * NEW scope_ref version chained to the prior and appends it to the seal history. Never silent —
   * the new version surfaces in the Continuation Capsule under what changed.
   */
  amendLoop(input: { session_id: string; scope_capsule: ScopeCapsule }): SealedScope {
    const state = this.scopeBySession.get(input.session_id);
    if (!state) {
      throw new Error(`No sealed scope to amend for session: ${input.session_id}`);
    }
    if (!this.sessions.has(input.session_id)) {
      throw new Error(`Cannot amend scope for a closed session: ${input.session_id}`);
    }
    const prior = state.history[state.history.length - 1]!;
    const structural = {
      ...input.scope_capsule.structural,
      loop_id: state.loop_id,
      goal_hash: prior.structural.goal_hash
    };
    const sealed = amendScope(prior, { structural, sidecar: input.scope_capsule.sidecar });
    state.history.push(sealed);
    return sealed;
  }

  /** The full seal history (original + amendments) for a loop, for Continuation Capsule build. */
  scopeHistoryForLoop(loop_id: string): SealedScope[] {
    const state = this.scopeByLoop.get(loop_id);
    return state ? [...state.history] : [];
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
