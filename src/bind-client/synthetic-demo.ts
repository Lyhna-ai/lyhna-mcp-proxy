// Synthetic demo bind client — the deterministic, OFFLINE bind for the local golden-path
// demo. It exists so a developer can run the full adapter flow (open -> route -> close ->
// dump -> export -> verify cold) with ZERO live bind, zero hosted contract, zero network.
//
// HONESTY BOUNDARY (non-negotiable, enforced BY CONSTRUCTION):
//   - The signature is an OBVIOUS STUB (base64("stub")), never a real Ed25519 signature.
//     A cold run of the real `lyhna-verify` over these receipts therefore reports
//     `all_receipts_verified:false` (crypto fail-by-absence). CI Leg 0 REQUIRES that false:
//     a synthetic chain that ever verified as signed would red the build. Synthetic can
//     never masquerade as signed because it carries no signature that could pass.
//   - Full-green signed proof remains the static signed corpus (verify-legs Leg 2). This
//     client is structural truth only.
//
// SHAPE: it returns a FULL external-scope receipt (the same shape lyhna-core emits and the
// LoopProofBundle export consumes), echoing the stamped `constraints` so the loop chain is
// real (continuity, loop_id/goal_hash consistency, action_count) — only the crypto is
// absent. It is content-blind (goal_hash only; it NEVER echoes `request.intent`, which the
// loop_close request defaults to the raw goal) and external-scope (tenant_hash, never
// tenant_id).

import type { BindClient, BindRequest, BindResponse } from "../bind.js";

/** base64("stub"). An obvious non-signature — this is what keeps synthetic honest. */
const STUB_SIGNATURE = "c3R1Yg==";
const RECEIPT_VERSION = "LYHNA_RECEIPT_V2";

// Default demo trust root: the same public key the verify-legs synthetic/real legs pin, so
// the bundle's single-signer trust-root pinning behaves identically. The signature is the
// stub, so receipts can never verify against it.
const DEFAULT_PUBLIC_KEY =
  "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
const DEFAULT_TENANT_HASH = "55b966349a28aaaa";

export type SyntheticDemoBindOptions = {
  /** Pinned single-signer public key carried on every receipt (hex). */
  publicKey?: string;
  /** External-scope tenant hash carried on every receipt (never tenant_id). */
  tenantHash?: string;
  /** Prefix for the deterministic receipt_id counter. */
  receiptIdPrefix?: string;
};

/**
 * A bind client that returns deterministic, full-shaped, UNSIGNED external receipts.
 * receipt_id advances on a per-instance counter, so a chain has distinct ids and the
 * `prior_receipt_id` continuity the loop spine relies on holds. `constraints` (which carry
 * goal_hash only) are echoed verbatim from the stamped request; nothing else from the
 * request crosses into the receipt — in particular `intent` (the raw goal on loop_close)
 * is dropped, keeping the receipt content-blind.
 */
export function createSyntheticDemoBindClient(
  options: SyntheticDemoBindOptions = {}
): BindClient {
  const public_key = options.publicKey ?? DEFAULT_PUBLIC_KEY;
  const tenant_hash = options.tenantHash ?? DEFAULT_TENANT_HASH;
  const prefix = options.receiptIdPrefix ?? "lrv2_demo";
  let n = 0;

  return {
    async bind(request: BindRequest): Promise<BindResponse> {
      n += 1;
      const receipt: BindResponse = {
        version: RECEIPT_VERSION,
        receipt_id: `${prefix}_${String(n).padStart(4, "0")}`,
        public_key,
        tenant_hash,
        action_type: request.action_type,
        outcome: "APPROVED",
        // OBVIOUS STUB — never a real signature. See HONESTY BOUNDARY above.
        signature: STUB_SIGNATURE,
        // Echo only the stamped constraints (goal_hash only — content-blind). Never echo
        // request.intent / a raw goal into the receipt.
        ...(request.constraints ? { constraints: request.constraints } : {})
      };
      return receipt;
    }
  };
}
