import type { BindClient, BindRequest, BindResponse } from "./bind.js";
import { buildBindRequest } from "./bind.js";
import { decideForward, type ForwardDecision } from "./enforcement.js";
import { LoopStepBoundError, mergeScopeConstraint, type LoopSession, type ScopeConstraint } from "./loop.js";
import {
  hashRuntimeError,
  hashRuntimeResult,
  type JudgmentProposedMove,
  type JudgmentTurn
} from "./judgment-ledger.js";
import type { JudgmentLedgerRecorder } from "./judgment-recorder.js";
import type { McpToolCall, McpToolResult, UpstreamMcpClient } from "./mcp.js";
import {
  checkScopeStructural,
  type ScopeDecision,
  type ScopePrivacyMode,
  type SealedScope
} from "./scope-capsule.js";
import type { ScopeEvent, ScopeEventRecorder } from "./scope-event-recorder.js";

/**
 * Capsule Gate 1 scope context for the adapter-side, PRE-BIND structural check. When present,
 * every consequential tools/call is checked against the sealed Scope Capsule's structural
 * projection BEFORE bind(); in-lane calls are stamped with `constraints.scope` (citing
 * `scope_ref` + the prior receipt), out-of-lane calls are refused before execution and attested
 * as a sidecar scope event. When absent, the proxy behaves exactly as the baseline bind gate.
 */
export type ProxyScopeContext = {
  sealed: SealedScope;
  mode: ScopePrivacyMode;
  recorder: ScopeEventRecorder;
  classMap?: Record<string, string>;
  // Capsule Gate 2 (optional): the append-only judgment-ledger recorder. When present (and a loop
  // session is in play), every consequential verdict — scope refusal, step-bound refusal, and bind
  // outcome — is captured as an ordered judgment turn, serialized against the receipt chain.
  judgment?: JudgmentLedgerRecorder;
};

export type ProxyCoreOptions = {
  upstream: UpstreamMcpClient;
  bindClient: BindClient;
  buildRequest?: (call: McpToolCall) => BindRequest;
  // Optional loop-context threading. When present, every tools/call bind is stamped
  // with `constraints.loop` and the receipt chain advances under the session mutex.
  // When absent, the proxy behaves exactly as the baseline bind gate.
  loopSession?: LoopSession;
  // Optional Capsule Gate 1 scope context (adapter-side pre-bind structural check).
  scope?: ProxyScopeContext;
};

export class BindGateError extends Error {
  readonly decision: Exclude<ForwardDecision, "FORWARD">;
  readonly bindResponse?: BindResponse;

  constructor(
    decision: Exclude<ForwardDecision, "FORWARD">,
    message: string,
    bindResponse?: BindResponse,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "BindGateError";
    this.decision = decision;
    this.bindResponse = bindResponse;
  }
}

/**
 * A consequential step left the declared structural lane. Thrown PRE-BIND, so the tool is never
 * executed and no bind() is called. The refusal is attested as a sidecar scope event (referenced
 * here) — the halt is visible/verifiable in the Proof Pack with no core/schema change.
 */
export class ScopeGateError extends Error {
  readonly decision: Exclude<ForwardDecision, "FORWARD">;
  readonly scopeDecision: ScopeDecision;
  readonly scopeEvent: ScopeEvent;

  constructor(scopeDecision: ScopeDecision, scopeEvent: ScopeEvent) {
    super(`Scope gate ${scopeDecision.decision} before execution: ${scopeDecision.reason}`);
    this.name = "ScopeGateError";
    // A scope REFUSED fails closed; a scope ESCALATED holds awaiting resolution.
    this.decision = scopeDecision.decision === "ESCALATED" ? "HOLD_AWAIT_RESOLUTION" : "FAIL_CLOSED";
    this.scopeDecision = scopeDecision;
    this.scopeEvent = scopeEvent;
  }
}

export function createProxyCore(options: ProxyCoreOptions): UpstreamMcpClient {
  const buildRequest = options.buildRequest ?? buildBindRequest;

  return {
    listTools() {
      return options.upstream.listTools();
    },

    async callTool(call: McpToolCall): Promise<McpToolResult> {
      const bindRequest = buildRequest(call);

      // Capsule Gate 1: adapter-side, PRE-BIND structural scope check. Runs BEFORE bind() and
      // before any upstream execution. An out-of-lane step is refused here (no bind, no forward)
      // and attested as a sidecar scope event; an in-lane step is stamped with `constraints.scope`
      // citing scope_ref + the prior receipt it was checked against.
      //
      // The scope DECISION (descriptor) is independent of the chain position, so it is computed
      // here. The `prior_receipt_id` ANCHOR, however, is stamped inside the loop mutex (passed to
      // bindToolCall) so it always cites the same predecessor as constraints.loop — never a stale
      // value under concurrent scoped calls.
      let scopeStamp: Omit<ScopeConstraint, "prior_receipt_id"> | undefined;
      // Capsule Gate 2: the structural move proposed this turn (action_class / tool_name / target
      // HASH), derived from the SAME scope decision the gate made — never plaintext, never inferred.
      let proposed: JudgmentProposedMove | undefined;
      // Judgment capture is engaged only on the serialized loop path (the mutex that orders the
      // receipt chain). Absent a loop session there is no chain to serialize against, so turns would
      // have no defined order — skip recording rather than produce an unordered ledger.
      const judgmentRecorder = options.loopSession ? options.scope?.judgment : undefined;

      if (options.scope) {
        const { sealed, mode, recorder } = options.scope;
        const decision = checkScopeStructural(call, sealed, {
          mode,
          classMap: options.scope.classMap
        });

        if (decision.decision !== "IN_SCOPE") {
          const eventDecision = decision.decision === "ESCALATED" ? "ESCALATED" : "REFUSED";
          // Record the attested scope event AND its judgment turn anchored to the SAME predecessor.
          // When there is a loop, do BOTH inside one serialized section (runInLoopOrder) so the
          // event's prior_receipt_id and the turn's inherited prior_receipt_id cannot diverge under a
          // concurrent bind's chain advance — the event anchor and the ledger position stay coherent.
          const recordRefusal = (prior_receipt_id: string | null): ScopeEvent => {
            const e = recorder.record({
              event_type: decision.decision === "ESCALATED" ? "scope_escalation" : "scope_refusal",
              loop_id: sealed.structural.loop_id,
              scope_ref: sealed.scope_ref,
              attempted: {
                action_class: decision.descriptor.action_class,
                tool_name: decision.descriptor.tool_name,
                target_descriptor: decision.descriptor.target_descriptor,
                // Verified Context Mode only: plaintext target is retained in the sidecar event
                // (Proof Mode resolves no plaintext, so this is naturally absent).
                ...(decision.target_plaintext !== undefined ? { target: decision.target_plaintext } : {})
              },
              matched_rule: decision.matched_rule,
              decision: eventDecision,
              prior_receipt_id
            });
            if (judgmentRecorder) {
              judgmentRecorder.append({
                loop_id: sealed.structural.loop_id,
                scope_ref: sealed.scope_ref,
                prior_receipt_id,
                proposed: proposedFrom(decision.descriptor),
                verdict: {
                  kind: eventDecision,
                  source: "scope_gate",
                  scope_event_hash: e.event_hash,
                  ...(decision.matched_rule !== undefined ? { reason_code: decision.matched_rule } : {})
                }
              });
            }
            return e;
          };
          const event = options.loopSession
            ? await options.loopSession.runInLoopOrder(recordRefusal)
            : recordRefusal(sealed.structural.prior_receipt_ref ?? null);
          // Refuse before execution: bind is never called, the tool never runs.
          throw new ScopeGateError(decision, event);
        }

        scopeStamp = {
          scope_ref: sealed.scope_ref,
          action_class: decision.descriptor.action_class,
          tool_name: decision.descriptor.tool_name,
          target_descriptor: decision.descriptor.target_descriptor,
          ...(decision.descriptor.target_descriptors ? { target_descriptors: decision.descriptor.target_descriptors } : {})
        };
        proposed = proposedFrom(decision.descriptor);
      }

      let bindResponse: BindResponse;

      // Declared step bound, enforced INSIDE the loop mutex (authoritative serialized count).
      const maxSteps = options.scope?.sealed.structural.bounds?.max_steps;

      // FAIL CLOSED: max_steps is only enforceable against a loop's serialized count. A scoped
      // call with a declared step bound but NO loop session cannot honor that bound, so it must be
      // refused rather than silently ignore the sealed constraint.
      if (maxSteps != null && !options.loopSession) {
        throw new BindGateError(
          "FAIL_CLOSED",
          "Scoped max_steps requires a loop session to enforce the step bound; refusing a scoped no-loop call (fail closed)."
        );
      }

      // Capsule Gate 2: capture the bind judgment turn appended INSIDE the loop mutex (so it sits in
      // receipt order). Held here so the post-forward runtime report can be attached by its turn_ref.
      let boundTurn: JudgmentTurn | undefined;

      // Capsule Gate 2: a step-bound refusal is DECIDED inside the loop mutex. Record its scope event
      // and its loop_bound judgment turn IN that same critical section (via onStepBound) — so they sit
      // in order with the surrounding verdicts and can never be reordered behind a concurrently-queued
      // bind that runs after the throw releases the mutex. The event is read back here for the
      // ScopeGateError. onStepBound runs inside runExclusive, so it appends synchronously (no
      // re-entrant mutex acquisition) and reads the predecessor at decision time.
      let stepBoundEvent: ScopeEvent | undefined;
      const onStepBound =
        options.scope && scopeStamp
          ? () => {
              const { sealed, recorder } = options.scope!;
              const event = recorder.record({
                event_type: "scope_refusal",
                loop_id: sealed.structural.loop_id,
                scope_ref: sealed.scope_ref,
                attempted: {
                  action_class: scopeStamp!.action_class,
                  tool_name: scopeStamp!.tool_name,
                  target_descriptor: scopeStamp!.target_descriptor
                },
                matched_rule: "max_steps",
                decision: "REFUSED",
                prior_receipt_id: options.loopSession?.priorReceiptId ?? null
              });
              stepBoundEvent = event;
              if (judgmentRecorder && proposed) {
                judgmentRecorder.append({
                  loop_id: sealed.structural.loop_id,
                  scope_ref: sealed.scope_ref,
                  prior_receipt_id: options.loopSession?.priorReceiptId ?? null,
                  proposed,
                  verdict: { kind: "REFUSED", source: "loop_bound", scope_event_hash: event.event_hash, reason_code: "max_steps" }
                });
              }
            }
          : undefined;

      try {
        bindResponse = options.loopSession
          ? // Loop path: bindToolCall stamps constraints.loop AND constraints.scope under one
            // mutex with a single prior_receipt_id, and enforces max_steps against the serialized
            // count before binding (see LoopSession.bindToolCall).
            await options.loopSession.bindToolCall(
              bindRequest,
              (request) => options.bindClient.bind(request),
              scopeStamp,
              maxSteps,
              judgmentRecorder && proposed
                ? {
                    recorder: judgmentRecorder,
                    scope_ref: options.scope!.sealed.scope_ref,
                    proposed,
                    onTurn: (turn) => {
                      boundTurn = turn;
                    }
                  }
                : undefined,
              onStepBound
            )
          : // No-loop path: no chain to advance, so stamp the scope anchor from the declared
            // prior reference (if any) and bind directly.
            await options.bindClient.bind(
              scopeStamp
                ? mergeScopeConstraint(bindRequest, {
                    ...scopeStamp,
                    prior_receipt_id: options.scope!.sealed.structural.prior_receipt_ref ?? null
                  })
                : bindRequest
            );
      } catch (error) {
        // A step-bound violation is a SCOPE refusal discovered under the mutex: its scope event +
        // loop_bound judgment turn were recorded IN-MUTEX by onStepBound (above); surface it as a
        // ScopeGateError (the tool never executed).
        if (error instanceof LoopStepBoundError && options.scope && scopeStamp) {
          const { sealed } = options.scope;
          const stepDecision: ScopeDecision = {
            decision: "REFUSED",
            reason: error.message,
            matched_rule: "max_steps",
            descriptor: {
              action_class: scopeStamp.action_class ?? "",
              tool_name: scopeStamp.tool_name ?? "",
              target_descriptor: scopeStamp.target_descriptor ?? null
            }
          };
          // Reuse the in-mutex event; defensively record one only if onStepBound somehow did not run.
          const event =
            stepBoundEvent ??
            options.scope.recorder.record({
              event_type: "scope_refusal",
              loop_id: sealed.structural.loop_id,
              scope_ref: sealed.scope_ref,
              attempted: { action_class: scopeStamp.action_class, tool_name: scopeStamp.tool_name, target_descriptor: scopeStamp.target_descriptor },
              matched_rule: "max_steps",
              decision: "REFUSED",
              prior_receipt_id: options.loopSession?.priorReceiptId ?? null
            });
          throw new ScopeGateError(stepDecision, event);
        }
        throw new BindGateError(
          "FAIL_CLOSED",
          "Bind failed before upstream execution; call was not forwarded.",
          undefined,
          { cause: error }
        );
      }

      const decision = decideForward(bindResponse);

      if (decision === "FORWARD") {
        // Forward the EXACT payload (never mutated). Capsule Gate 2: hash the runtime result/error
        // and attach it to the approved bind turn (additive; does not change turn_ref). The result
        // is HASHED, never interpreted as true and never stored raw — so a Proof Mode pack carries
        // no runtime plaintext. Hashing reads a copy; the result returned to the agent is unchanged.
        //
        // The upstream call is the ONLY thing that decides what the agent sees: its result is
        // returned and its error is thrown VERBATIM. The judgment-ledger attach is OBSERVE-ONLY
        // bookkeeping isolated below so it can never replace a completed result nor mask the real
        // upstream error (recordRuntimeReport swallows its own failure — a missing hash only omits
        // an optional anchor, it must not break the gate path).
        let result: McpToolResult;
        try {
          result = await options.upstream.callTool(call);
        } catch (error) {
          recordRuntimeReport(judgmentRecorder, boundTurn, { returned: false, error_hash: hashRuntimeError(error) });
          throw error;
        }
        recordRuntimeReport(judgmentRecorder, boundTurn, { returned: true, result_hash: hashRuntimeResult(result) });
        return result;
      }

      if (decision === "HOLD_AWAIT_RESOLUTION") {
        throw new BindGateError(
          decision,
          "Bind escalated; call is held and was not forwarded.",
          bindResponse
        );
      }

      throw new BindGateError(
        decision,
        "Bind refused or did not allow forwarding; call was not forwarded.",
        bindResponse
      );
    }
  };
}

/**
 * Attach a runtime report to a captured bind turn — OBSERVE-ONLY bookkeeping. Swallows its own
 * failure: the judgment ledger must never break or mask the agent-facing forward (a missing hash
 * only omits an optional anchor). No-op when there is no turn / recorder.
 */
function recordRuntimeReport(
  recorder: JudgmentLedgerRecorder | undefined,
  turn: JudgmentTurn | undefined,
  report: { returned: boolean; result_hash?: string; error_hash?: string }
): void {
  if (!recorder || !turn) return;
  try {
    recorder.attachRuntimeReport(turn.loop_id, turn.turn_ref, report);
  } catch {
    // Observe-only: a bookkeeping failure must not affect the forwarded result/error.
  }
}

/**
 * Derive the Capsule Gate 2 proposed-move descriptor from the gate's structural scope descriptor.
 * Carries only structural fields / target HASHES — never plaintext (the gate already hashed the
 * target; the plaintext, if any, stays in the Verified-Context sidecar scope event, not here).
 */
function proposedFrom(descriptor: ScopeDecision["descriptor"]): JudgmentProposedMove {
  return {
    action_class: descriptor.action_class,
    tool_name: descriptor.tool_name,
    target_descriptor: descriptor.target_descriptor ?? null,
    ...(descriptor.target_descriptors ? { target_descriptors: descriptor.target_descriptors } : {})
  };
}
