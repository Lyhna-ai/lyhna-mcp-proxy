// Receipt recorder — an OBSERVE-ONLY bind-client decorator that captures each receipt a
// bind() returns, keyed by loop_id, so a supervisor can later read back a loop's sealed
// chain and package it into a LoopProofBundle.
//
// This is the runtime producer that was missing between the live loop and the export: the
// proxy core and LoopSession advance `prior_receipt_id` but discard the receipt objects
// themselves. The recorder wraps whatever bind client is in use (stub, http/real, or the
// synthetic demo client) and snapshots every response. In real (http) mode it records the
// real signed receipts; in demo mode it records the synthetic unsigned receipts. Either
// way the supervisor `dump` verb reads from here.
//
// CRITICAL INVARIANT (observe-only): the recorder NEVER mutates a receipt. It stores the
// exact object the inner bind() returned and hands back shallow copies of the per-loop
// ARRAY (the receipt objects inside are the same references, untouched). "Do not mutate
// receipts before verification" holds by construction — the recorder only reads.
//
// ATTRIBUTION: the loop_id is read from the bind REQUEST's `constraints.loop` (in-loop
// links) or `constraints.loop_close` (the terminal). A bind with no loop constraint is not
// part of any chain and is not recorded.

import type { BindClient, BindRequest } from "./bind.js";

/** A recorded receipt is the bind response, verbatim — read, never reshaped. */
export type RecordedReceipt = Record<string, unknown>;

/** Read side of the recorder — what the supervisor control `dump` verb consumes. */
export interface ReceiptSource {
  /** Ordered receipts recorded for a loop_id (in-loop links, then the terminal close). */
  receiptsForLoop(loop_id: string): RecordedReceipt[];
  /** Every loop_id that has at least one recorded receipt. */
  knownLoopIds(): string[];
}

export type ReceiptRecorder = ReceiptSource & {
  /**
   * Wrap a bind client so every returned receipt is recorded (keyed by the request's
   * loop_id). Observe-only: the response is recorded and returned unchanged.
   */
  wrap(inner: BindClient): BindClient;
};

export function createReceiptRecorder(): ReceiptRecorder {
  const byLoop = new Map<string, RecordedReceipt[]>();

  return {
    wrap(inner: BindClient): BindClient {
      return {
        async bind(request: BindRequest) {
          const response = await inner.bind(request);
          const loopId = loopIdOf(request);
          if (loopId) {
            const list = byLoop.get(loopId);
            // Store the response object AS RETURNED (no clone, no mutation).
            if (list) {
              list.push(response as RecordedReceipt);
            } else {
              byLoop.set(loopId, [response as RecordedReceipt]);
            }
          }
          return response;
        }
      };
    },

    receiptsForLoop(loop_id: string): RecordedReceipt[] {
      // Return a copy of the ARRAY so callers cannot reorder/extend the recorded chain;
      // the receipt objects inside are the originals, untouched.
      return [...(byLoop.get(loop_id) ?? [])];
    },

    knownLoopIds(): string[] {
      return [...byLoop.keys()];
    }
  };
}

/** Resolve the loop_id a bind request belongs to, or undefined if it is not in a loop. */
function loopIdOf(request: BindRequest): string | undefined {
  const constraints = request.constraints;
  if (!constraints) {
    return undefined;
  }
  const loop = constraints.loop as { loop_id?: unknown } | undefined;
  if (loop && typeof loop.loop_id === "string" && loop.loop_id.length > 0) {
    return loop.loop_id;
  }
  const close = constraints.loop_close as { loop_id?: unknown } | undefined;
  if (close && typeof close.loop_id === "string" && close.loop_id.length > 0) {
    return close.loop_id;
  }
  return undefined;
}
