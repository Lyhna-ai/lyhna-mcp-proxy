// Loop-context threading for the Lyhna MCP adapter.
//
// This module mirrors the loop mechanism defined in lyhna-bind/src/loop.ts:
//   - additive `constraints.loop` merge (never clobbering server-appended fields)
//   - `prior_receipt_id` chain advance after every bind (root prior is null)
//   - terminal `constraints.loop_close` field set on controlled shutdown
//
// It is client-side and additive. The hosted bind() gate stays frozen: this code
// only shapes the request the proxy already sends and serializes the chain so that
// concurrent tools/call cannot fork it. The agent operates inside the loop; the
// PROXY boundary closes the loop on controlled shutdown; Lyhna signs the proof.
//
// Reconciled against the canonical @lyhna/bind loop chain (loop.ts v0.3.9):
//   - goal_hash = sha256(utf8(goal)) hex, no normalization/trim — derived here via
//     node:crypto (byte-equivalent to the canonical's @noble/hashes computeGoalHash).
//   - in-loop bind: constraints.loop = { loop_id, prior_receipt_id, goal_hash }, layered
//     additively over caller constraints as a distinct key.
//   - loop_close bind: action_type "loop_close"; action_payload { loop_id, action_count };
//     intent defaults to the goal, intent_version "loop_v1"; constraints carries BOTH
//     loop and loop_close (goal_hash in both).
// These spine fields must stay byte-compatible with the lyhna-bind producer.

import { createHash } from "node:crypto";

import type { BindRequest, BindResponse } from "./bind.js";

/** Immutable loop identity injected at proxy start (via env). */
export type LoopContext = {
  loop_id: string;
  goal: string;
  goal_hash: string;
};

/** Per-tools/call loop stamp merged additively under `constraints.loop`. */
export type LoopConstraint = {
  loop_id: string;
  prior_receipt_id: string | null;
  goal_hash: string;
};

/** Terminal close stamp merged under `constraints.loop_close`. */
export type LoopCloseConstraint = {
  loop_id: string;
  goal_hash: string;
  action_count: number;
  outcome: string;
  prior_receipt_id: string | null;
  termination_reason: string;
};

export type LoopCloseFields = {
  action_count: number;
  prior_receipt_id: string | null;
  outcome: string;
  termination_reason: string;
  // intent / intent_version default to the loop protocol markers (goal / "loop_v1")
  // but may be overridden, exactly as in the canonical close(). They do not affect tier
  // resolution, which keys on action_type ("loop_close").
  intent?: string;
  intent_version?: string;
};

export type LoopBindFn = (request: BindRequest) => Promise<BindResponse>;

export type LoopCloseResult =
  | { sealed: true; receipt: BindResponse }
  | { sealed: false; error: unknown };

const LOOP_CLOSE_ACTION_TYPE = "loop_close";
const LOOP_INTENT_VERSION = "loop_v1";

/**
 * goal_hash is sha256(utf8(goal)) hex-encoded, with NO normalization or trimming —
 * byte-equivalent to the canonical @lyhna/bind computeGoalHash. It is carried (and
 * signed) inside every link's constraints.loop so verifiers can confirm a chain
 * shares one goal.
 */
export function deriveGoalHash(goal: string): string {
  return createHash("sha256").update(goal, "utf8").digest("hex");
}

/** Build a loop context from the raw goal, deriving goal_hash canonically. */
export function createLoopContext(input: { loop_id: string; goal: string }): LoopContext {
  return {
    loop_id: input.loop_id,
    goal: input.goal,
    goal_hash: deriveGoalHash(input.goal)
  };
}

/**
 * Remove any caller-supplied `authority_tier` from a bind request (top level and
 * nested under `constraints`). The server resolves authority; the caller never does.
 * Returns a shallow clone; the input is not mutated.
 */
export function stripAuthorityTier(request: BindRequest): BindRequest {
  const clone: Record<string, unknown> = { ...request };
  delete clone.authority_tier;

  if (isRecord(clone.constraints)) {
    const constraints = { ...clone.constraints };
    delete constraints.authority_tier;
    clone.constraints = constraints;
  }

  return clone as BindRequest;
}

/**
 * Merge a loop stamp additively into `request.constraints.loop`.
 *
 * - Preserves any caller/server-appended fields already present on `constraints`
 *   and on `constraints.loop` (never clobbers server-appended fields).
 * - Sets the three canonical loop spine fields authoritatively.
 * - Strips caller-supplied `authority_tier`.
 * - Never touches `action_payload` (forwarded payload identity is preserved).
 */
export function mergeLoopConstraint(request: BindRequest, loop: LoopConstraint): BindRequest {
  const stripped = stripAuthorityTier(request);
  const constraints = isRecord(stripped.constraints) ? { ...stripped.constraints } : {};

  // `loop` is a distinct key layered ON TOP of caller constraints (canonical
  // v0.3.9): it owns exactly the three linkage fields and cannot clobber — nor be
  // clobbered by — server-appended sibling keys (resolved_by / original_escalation).
  constraints.loop = loop;

  return { ...stripped, constraints };
}

/** Build the terminal loop_close bind request carrying `constraints.loop_close`. */
export function buildLoopCloseRequest(
  context: LoopContext,
  fields: LoopCloseFields
): BindRequest {
  // The terminal carries BOTH the chain link (so it resolves to the last in-loop
  // receipt) and the terminal summary — matching canonical close() exactly.
  const loop: LoopConstraint = {
    loop_id: context.loop_id,
    prior_receipt_id: fields.prior_receipt_id,
    goal_hash: context.goal_hash
  };

  const loopClose: LoopCloseConstraint = {
    loop_id: context.loop_id,
    outcome: fields.outcome,
    termination_reason: fields.termination_reason,
    action_count: fields.action_count,
    prior_receipt_id: fields.prior_receipt_id,
    goal_hash: context.goal_hash
  };

  return {
    action_type: LOOP_CLOSE_ACTION_TYPE,
    action_payload: {
      loop_id: context.loop_id,
      action_count: fields.action_count
    },
    intent: fields.intent ?? context.goal,
    intent_version: fields.intent_version ?? LOOP_INTENT_VERSION,
    constraints: { loop, loop_close: loopClose }
  };
}

/**
 * Serializes the receipt chain for a single loop.
 *
 * The critical section read-prior -> bind -> set-prior runs under an internal mutex
 * so concurrent tools/call cannot fork the chain. `prior_receipt_id` starts null
 * (root) and advances to `receipt.receipt_id` after every bind. The terminal close
 * runs in the same mutex, so it always seals the most-recently-advanced link.
 */
export class LoopSession {
  private readonly context: LoopContext;
  private priorReceiptIdValue: string | null = null;
  private actionCountValue = 0;
  private closedFlag = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(context: LoopContext) {
    this.context = context;
  }

  get loopId(): string {
    return this.context.loop_id;
  }

  get goalHash(): string {
    return this.context.goal_hash;
  }

  get priorReceiptId(): string | null {
    return this.priorReceiptIdValue;
  }

  get actionCount(): number {
    return this.actionCountValue;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  /**
   * Stamp an in-loop tools/call bind request and advance the chain under the mutex.
   * The provided `bind` runs inside the critical section so the read-prior ->
   * bind -> set-prior sequence is atomic with respect to concurrent calls.
   */
  bindToolCall(request: BindRequest, bind: LoopBindFn): Promise<BindResponse> {
    return this.runExclusive(async () => {
      if (this.closedFlag) {
        throw new Error("Loop already closed; refusing in-loop bind (fail closed).");
      }

      const stamped = mergeLoopConstraint(request, {
        loop_id: this.context.loop_id,
        prior_receipt_id: this.priorReceiptIdValue,
        goal_hash: this.context.goal_hash
      });

      const response = await bind(stamped);

      this.priorReceiptIdValue = response.receipt_id;
      this.actionCountValue += 1;

      return response;
    });
  }

  /**
   * Emit the terminal loop_close bind under the mutex. Advances the chain to the
   * close receipt and marks the loop sealed. Throws if the bind fails (so callers
   * can retry within the grace window); the loop stays unsealed until it succeeds.
   */
  close(
    bind: LoopBindFn,
    fields: { outcome: string; termination_reason: string; intent?: string; intent_version?: string }
  ): Promise<LoopCloseResult> {
    return this.runExclusive(async () => {
      const request = buildLoopCloseRequest(this.context, {
        action_count: this.actionCountValue,
        prior_receipt_id: this.priorReceiptIdValue,
        outcome: fields.outcome,
        termination_reason: fields.termination_reason,
        intent: fields.intent,
        intent_version: fields.intent_version
      });

      const response = await bind(request);

      this.priorReceiptIdValue = response.receipt_id;
      this.closedFlag = true;

      return { sealed: true as const, receipt: response };
    });
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    // Keep the chain alive even if one section rejects; swallow only on the tail.
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/**
 * Emit the terminal loop_close, retrying within a grace window. On ultimate failure
 * the loop is left unsealed (detectable via verifyLoopChain) rather than throwing.
 */
export async function closeLoopWithRetry(
  session: LoopSession,
  bind: LoopBindFn,
  options: {
    outcome: string;
    termination_reason: string;
    graceMs: number;
    retryDelayMs: number;
  }
): Promise<LoopCloseResult> {
  const deadline = Date.now() + Math.max(0, options.graceMs);
  let lastError: unknown;

  for (;;) {
    try {
      return await session.close(bind, {
        outcome: options.outcome,
        termination_reason: options.termination_reason
      });
    } catch (error) {
      lastError = error;
      if (Date.now() + options.retryDelayMs >= deadline) {
        return { sealed: false, error: lastError };
      }
      await delay(options.retryDelayMs);
    }
  }
}

/** A reconstructed link in a loop receipt chain, for verification. */
export type LoopChainLink = {
  receipt_id: string;
  loop?: LoopConstraint | null;
  loop_close?: LoopCloseConstraint | null;
};

export type LoopChainVerification =
  | { valid: true; sealed: boolean; loop_id: string | null; action_count: number }
  | { valid: false; reason: string };

/**
 * Verify a loop receipt chain. REJECTS a chain that has in-loop links but no
 * terminal loop_close (an unsealed chain), and also rejects broken `prior_receipt_id`
 * continuity, mismatched loop_id, a non-terminal close, multiple closes, or an
 * action_count that disagrees with the number of in-loop links.
 */
export function verifyLoopChain(links: readonly LoopChainLink[]): LoopChainVerification {
  const terminals = links.filter(
    (link): link is LoopChainLink & { loop_close: LoopCloseConstraint } => isRecord(link.loop_close)
  );
  // The terminal close link carries BOTH loop and loop_close (canonical v0.3.9), so a
  // link bearing loop_close is the terminal — never counted as an in-loop action link.
  const inLoop = links.filter(
    (link): link is LoopChainLink & { loop: LoopConstraint } =>
      isRecord(link.loop) && !isRecord(link.loop_close)
  );

  if (terminals.length === 0) {
    if (inLoop.length === 0) {
      return { valid: true, sealed: true, loop_id: null, action_count: 0 };
    }
    return {
      valid: false,
      reason: "unsealed: in-loop links present without a terminal loop_close"
    };
  }

  if (terminals.length > 1) {
    return { valid: false, reason: "multiple terminal loop_close links in chain" };
  }

  const terminal = terminals[0]!.loop_close;
  const loopId = terminal.loop_id;

  if (!isRecord(links[links.length - 1]?.loop_close)) {
    return { valid: false, reason: "loop_close is not the terminal (last) link in the chain" };
  }

  let expectedPrior: string | null = null;
  for (const link of inLoop) {
    if (link.loop.loop_id !== loopId) {
      return { valid: false, reason: `loop_id mismatch on in-loop link ${link.receipt_id}` };
    }
    if ((link.loop.prior_receipt_id ?? null) !== expectedPrior) {
      return {
        valid: false,
        reason: `broken prior_receipt_id chain at in-loop link ${link.receipt_id}`
      };
    }
    expectedPrior = link.receipt_id;
  }

  if ((terminal.prior_receipt_id ?? null) !== expectedPrior) {
    return {
      valid: false,
      reason: "loop_close prior_receipt_id does not seal the last in-loop link"
    };
  }

  // The terminal also carries its own constraints.loop link; it must seal the same prior.
  const terminalLoop = terminals[0]!.loop;
  if (isRecord(terminalLoop) && (terminalLoop.prior_receipt_id ?? null) !== expectedPrior) {
    return {
      valid: false,
      reason: "terminal constraints.loop prior_receipt_id does not seal the last in-loop link"
    };
  }

  if (terminal.action_count !== inLoop.length) {
    return {
      valid: false,
      reason: `loop_close action_count (${terminal.action_count}) does not match in-loop link count (${inLoop.length})`
    };
  }

  return { valid: true, sealed: true, loop_id: loopId, action_count: terminal.action_count };
}

export type LoopCloseTuning = {
  graceMs: number;
  retryDelayMs: number;
};

/**
 * Read the optional loop identity from the environment. Returns undefined when no
 * loop context is configured (the adapter then runs as a plain bind gate). Requires
 * both fields together so a partially-configured loop never threads a half-chain.
 */
export function loadLoopContextFromEnv(env: NodeJS.ProcessEnv = process.env): LoopContext | undefined {
  const loop_id = env.LYHNA_PROXY_LOOP_ID?.trim();
  // The raw goal is the load-bearing input: goal_hash is derived from it (sha256,
  // no trim/normalization), matching the canonical. The goal value itself is never
  // trimmed — only checked for presence.
  const goal = env.LYHNA_PROXY_GOAL;
  const hasGoal = goal !== undefined && goal.length > 0;

  if (!loop_id && !hasGoal) {
    return undefined;
  }

  if (!loop_id || !hasGoal) {
    throw new Error(
      "Loop-context threading requires both LYHNA_PROXY_LOOP_ID and LYHNA_PROXY_GOAL."
    );
  }

  return createLoopContext({ loop_id, goal });
}

/** Grace-window tuning for the shutdown close POST. SIGTERM is the only trigger. */
export function loadLoopCloseTuning(env: NodeJS.ProcessEnv = process.env): LoopCloseTuning {
  return {
    graceMs: parsePositiveInt(env.LYHNA_PROXY_LOOP_CLOSE_GRACE_MS, 5000),
    retryDelayMs: parsePositiveInt(env.LYHNA_PROXY_LOOP_CLOSE_RETRY_MS, 250)
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, received "${value}".`);
  }
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
