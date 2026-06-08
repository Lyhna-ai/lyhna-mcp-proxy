import type { BindClient, BindRequest, BindResponse } from "./bind.js";
import { buildBindRequest } from "./bind.js";
import { decideForward, type ForwardDecision } from "./enforcement.js";
import { mergeScopeConstraint, type LoopSession, type ScopeConstraint } from "./loop.js";
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
      if (options.scope) {
        const { sealed, mode, recorder } = options.scope;
        const decision = checkScopeStructural(call, sealed, {
          mode,
          classMap: options.scope.classMap,
          // Steps already taken in this loop, for the declared max_steps bound (best-effort
          // pre-bind read; consequential steps are serialized in Gate 1, so it is exact there).
          steps: options.loopSession?.actionCount
        });

        if (decision.decision !== "IN_SCOPE") {
          const event = recorder.record({
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
            decision: decision.decision === "ESCALATED" ? "ESCALATED" : "REFUSED",
            // Best-effort anchor for the (off-chain) attestation: the last receipt the loop saw.
            prior_receipt_id: options.loopSession?.priorReceiptId ?? sealed.structural.prior_receipt_ref ?? null
          });
          // Refuse before execution: bind is never called, the tool never runs.
          throw new ScopeGateError(decision, event);
        }

        scopeStamp = {
          scope_ref: sealed.scope_ref,
          action_class: decision.descriptor.action_class,
          tool_name: decision.descriptor.tool_name,
          target_descriptor: decision.descriptor.target_descriptor
        };
      }

      let bindResponse: BindResponse;

      try {
        bindResponse = options.loopSession
          ? // Loop path: bindToolCall stamps constraints.loop AND constraints.scope under one
            // mutex with a single prior_receipt_id (see LoopSession.bindToolCall).
            await options.loopSession.bindToolCall(
              bindRequest,
              (request) => options.bindClient.bind(request),
              scopeStamp
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
        throw new BindGateError(
          "FAIL_CLOSED",
          "Bind failed before upstream execution; call was not forwarded.",
          undefined,
          { cause: error }
        );
      }

      const decision = decideForward(bindResponse);

      if (decision === "FORWARD") {
        return options.upstream.callTool(call);
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
