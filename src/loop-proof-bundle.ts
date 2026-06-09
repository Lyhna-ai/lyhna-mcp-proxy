// LoopProofBundle — the buyer-facing export of a sealed loop receipt chain.
//
// This is ADDITIVE PACKAGING on top of existing output. It does NOT change the receipt
// shape, the proxy core, the LoopSession spine, the bind() contract, or lyhna-core. It
// reads a sealed loop receipt array (the standing-service path's output) and wraps an
// envelope AROUND it — never mutating a receipt.
//
// SIDE-CAR SHAPE (the load-bearing design choice): the bare receipt array stays the
// loadable top-level object (`receipts.json`), and the envelope metadata lives ALONGSIDE
// it (`bundle.json`). The standalone, trust-no-one `lyhna-verify` therefore consumes
// `receipts.json` UNCHANGED — `lyhna-verify --chain receipts.json` — with zero
// verifier-side work. The envelope is buyer-facing context; it is never the verification
// input.
//
// Buyer-facing invariants:
//   - EXTERNAL scope only: receipts carry `tenant_hash`, NEVER the internal `tenant_id`.
//   - Content-blind: `goal_hash` only, never the plaintext goal.
//   - The cryptographic verdict is the independent verifier's; the envelope's embedded
//     verdict is explicitly marked ADVISORY (re-run the verifier to trust it).

import { createHash } from "node:crypto";

import { verifyLoopChain, type LoopChainLink } from "./loop.js";
import {
  assertBoundsEnforceable,
  assertScopeCapsuleStructuralOnly,
  assertScopeStructuralClosed,
  assertScopeStructuralContentBlind,
  canonicalScopeJson,
  deriveScopeRef,
  deriveSidecarHash,
  hashTarget,
  projectScopeCapsuleForExport,
  type ScopeCapsuleExport,
  type ScopePrivacyMode,
  type SealedScope
} from "./scope-capsule.js";
import { deriveScopeEventHash, projectScopeEvent, type ScopeEvent } from "./scope-event-recorder.js";
import {
  diffStructural,
  projectContinuationProofMode,
  type ContinuationCapsule,
  type ContinuationJudgmentSection
} from "./continuation-capsule.js";
import {
  JUDGMENT_LEDGER_VERSION,
  projectTurn,
  renderJudgmentLedgerMarkdown,
  validateJudgmentChain,
  type JudgmentTurn
} from "./judgment-ledger.js";
import { reduceJudgmentLedger, type ReducedJudgmentState } from "./judgment-reducer.js";
import { buildMemoryInjection, type MemoryInjection } from "./memory-injection.js";

/** A signed receipt payload (loose — we read fields, never reshape them). */
export type ProofReceipt = Record<string, unknown> & {
  receipt_id?: unknown;
  public_key?: unknown;
  action_type?: unknown;
  tenant_id?: unknown;
  tenant_hash?: unknown;
  constraints?: { loop?: unknown; loop_close?: unknown } & Record<string, unknown>;
};

export type TrustRoot = {
  /** Raw 32-byte Ed25519 public key, hex — the single signer pinned for this bundle. */
  ed25519_public_key: string;
  /** Deterministic short fingerprint of the key, for human/graph reference. */
  key_id: string;
};

export type ContentDigest = {
  algorithm: "sha256";
  /** Hex digest over the exact UTF-8 bytes of `receipts.json` (no trailing newline). */
  value: string;
  over: "receipts.json";
};

export type LoopSummary = {
  loop_id: string;
  goal_hash: string;
  action_count: number;
  sealed: boolean;
  receipt_count: number;
};

export type AdvisoryVerdict = {
  advisory: true;
  verifier: {
    name: "lyhna-verify";
    independent: true;
    reproduce: string;
  };
  /** The verifier's own `--json` output, verbatim, or null if not yet run. */
  result: unknown;
};

export type LoopProofBundle = {
  bundle_version: "loop-proof-bundle/v1";
  format: "side-car";
  /** The loadable top-level object the verifier consumes UNCHANGED. */
  receipts_file: "receipts.json";
  scope: "external";
  trust_root: TrustRoot;
  scheme: {
    receipt_version: string;
    canonicalization: string;
    signing_scheme: string;
  };
  loop: LoopSummary;
  export: {
    exported_at: string;
    source_env: string;
    content_digest: ContentDigest;
  };
  verdict: AdvisoryVerdict;
  graph_node_file: "graph-node.json";
  /**
   * Capsule Gate 1 references (ADDITIVE; present only for a scoped loop). The scope capsule and
   * continuation capsule live in sibling files; scope refusals/escalations are referenced by
   * `event_hash`. The signed `receipts.json` chain is untouched — cold verification is unaffected.
   */
  capsule?: BundleCapsuleSection;
};

export type BundleCapsuleSection = {
  mode: ScopePrivacyMode;
  scope_ref: string;
  scope_capsule_file: "scope-capsule.json";
  continuation_capsule_file: "continuation-capsule.json";
  /** Attested scope events, referenced by hash (the halt is visible/verifiable here). */
  scope_events: { count: number; event_hashes: string[] };
  /**
   * Capsule Gate 2 judgment ledger references (ADDITIVE; present only when judgment turns were
   * supplied). The full middle object lives in judgment-ledger.json; the portable handoff in
   * memory-injection.json. Turns are referenced by final_turn_ref + count (content-blind).
   */
  judgment?: {
    judgment_ledger_file: "judgment-ledger.json";
    judgment_ledger_markdown_file: "judgment-ledger.md";
    memory_injection_file: "memory-injection.json";
    final_turn_ref: string | null;
    turn_count: number;
  };
};

/** judgment-ledger.json — the full middle object: the reduced fold plus the (projected) ordered turns. */
export type JudgmentLedgerExport = {
  judgment_ledger_version: string;
  loop_id: string;
  scope_ref: string;
  mode: ScopePrivacyMode;
  final_turn_ref: string | null;
  turn_count: number;
  reduced: ReducedJudgmentState;
  turns: JudgmentTurn[];
};

export type AuthorityContextGraphNode = {
  id: string;
  type: "loop_proof";
  loop_id: string;
  goal_hash: string;
  action_count: number;
  sealed: boolean;
  scope: "external";
  trust_root: TrustRoot;
  receipt_count: number;
  content_digest: ContentDigest;
  exported_at: string;
  source_env: string;
};

export type BuildLoopProofBundleInput = {
  receipts: ProofReceipt[];
  source_env: string;
  exported_at?: string;
  /** The standalone verifier's `--json` output for `receipts.json`, if already run. */
  advisory_verdict?: unknown;
  /**
   * The exact source bytes of the receipt array. When provided, they are preserved
   * VERBATIM as `receipts.json` (digested and written byte-for-byte), so the exported
   * side-car is byte-identical to the signed source artifact. Must parse to `receipts`.
   * When omitted, the canonical `serializeReceipts(receipts)` form is used.
   */
  receipts_text?: string;
  /**
   * Optional Capsule Gate 1 material (ADDITIVE). When present, the build emits the scope capsule
   * + continuation capsule projections (mode-appropriate), references scope events by hash, and
   * renders proof-card.md / verify-instructions.md. When absent, output is byte-for-byte the
   * legacy 4-artifact bundle.
   */
  capsule?: {
    mode: ScopePrivacyMode;
    sealed_scope: SealedScope;
    /**
     * The full sealed scope/amendment history (original ... final). Each entry is independently
     * hash-verifiable and chains via prior_scope_ref; the export derives the VERIFIED set of valid
     * scope_refs from this, never from the unsigned continuation. Omit for a single-version
     * (un-amended) loop — then the single `sealed_scope` is the whole chain.
     */
    scope_history?: SealedScope[];
    continuation: ContinuationCapsule;
    scope_events?: ScopeEvent[];
    /**
     * Capsule Gate 2 (ADDITIVE): the ordered judgment ledger dumped for this loop. When supplied,
     * the build validates the judgment chain, cross-checks it against the receipts (every in-loop
     * receipt maps to a bind turn) and the scope events (every scope event maps to a scope/loop-bound
     * turn), folds it via the reducer, and emits judgment-ledger.json/.md + memory-injection.json.
     * Omit for a Capsule Gate 1 (judgment-less) pack — the output is then byte-for-byte unchanged.
     */
    judgment_turns?: JudgmentTurn[];
  };
};

export type BuiltLoopProofBundle = {
  bundle: LoopProofBundle;
  /** Exact bytes written to receipts.json — the verifier input, digested verbatim. */
  receipts_json: string;
  graph_node: AuthorityContextGraphNode;
  graph_node_markdown: string;
  // --- Capsule Gate 1 artifacts (present only when input.capsule was supplied) ---
  scope_capsule?: ScopeCapsuleExport;
  continuation_capsule?: ContinuationCapsule;
  scope_events?: ScopeEvent[];
  proof_card_markdown?: string;
  verify_instructions_markdown?: string;
  // --- Capsule Gate 2 artifacts (present only when input.capsule.judgment_turns was supplied) ---
  judgment_ledger?: JudgmentLedgerExport;
  judgment_ledger_markdown?: string;
  memory_injection?: MemoryInjection;
};

const RECEIPT_VERSION = "LYHNA_RECEIPT_V2";
const CANONICALIZATION = "recursive sorted-key, no whitespace (JSON.stringify scalars)";
const SIGNING_SCHEME =
  "Ed25519; shape keyed on action_type (standard | authority_resolution); signed over the hex canonical_hash";

/**
 * Serialize the receipt array to the canonical side-car bytes. The verifier consumes
 * exactly this; the content digest is computed over exactly this.
 */
export function serializeReceipts(receipts: ProofReceipt[]): string {
  return JSON.stringify(receipts, null, 2);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * EXTERNAL-scope selection / enforcement. A buyer-facing bundle must carry `tenant_hash`
 * and must NEVER carry the internal `tenant_id`. Fail closed on any internal-scope leak.
 */
export function assertExternalScope(receipts: ProofReceipt[]): void {
  if (receipts.length === 0) {
    throw new Error("LoopProofBundle requires at least one receipt.");
  }
  receipts.forEach((r, i) => {
    if (r.tenant_id !== undefined) {
      throw new Error(
        `Receipt ${describe(r, i)} carries internal tenant_id; external-scope bundles must not leak it.`
      );
    }
    if (typeof r.tenant_hash !== "string" || r.tenant_hash.length === 0) {
      throw new Error(`Receipt ${describe(r, i)} is missing external-scope tenant_hash.`);
    }
  });
}

// Keys that carry the plaintext goal (the invariant is goal_hash ONLY). `intent` is
// included because the loop_close bind defaults its `intent` to the raw goal
// (buildLoopCloseRequest), and a free-text `goal` is an explicit leak. The structured
// derivatives `goal_hash` / `intent_version` are NOT goal-bearing and are not matched.
// `goal` / `intent` carry the plaintext goal. The compound `*_steps` / `*_questions` / etc. keys
// are unambiguous plaintext PLAN markers (Scope Capsule sidecar fields) that must never appear in
// a signed receipt — adding them extends content-blindness from "no goal" to "no plan" on the
// gate/core path (criterion 15.8). They cannot occur in a normal external receipt, so this adds
// no false positives.
const PLAINTEXT_GOAL_KEYS = new Set([
  "goal",
  "intent",
  "goal_summary",
  "planned_steps",
  "settled_decisions",
  "open_questions",
  "next_actions",
  "success_criteria",
  "source_pointers"
]);

/**
 * Content-blind enforcement — the content counterpart to external-scope identity
 * enforcement (tenant_hash, never tenant_id). A buyer-facing bundle carries `goal_hash`
 * only; the plaintext goal must never appear. The check is DEEP (a goal-bearing key
 * ANYWHERE in the receipt is a leak, not just at the top level), so nested plaintext
 * cannot slip through. We cannot strip a leaking field (it would invalidate the
 * signature), so the correct posture is to fail closed: reject the export, never writing
 * receipts.json.
 *
 * External-scope receipts are content-blind BY CONSTRUCTION (lyhna-core reduces the goal
 * to goal_hash); this guard is the fail-closed FLOOR that refuses anything that isn't.
 */
export function assertContentBlind(receipts: ProofReceipt[]): void {
  receipts.forEach((r, i) => {
    const leak = findPlaintextGoalKey(r);
    if (leak) {
      throw new Error(
        `Receipt ${describe(r, i)} carries plaintext at "${leak}"; a content-blind bundle carries goal_hash only (fail closed).`
      );
    }
  });
}

/** Deep scan for a goal-bearing key anywhere in a receipt; returns its path, or null. */
function findPlaintextGoalKey(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findPlaintextGoalKey(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const here = path ? `${path}.${key}` : key;
      if (PLAINTEXT_GOAL_KEYS.has(key)) return here;
      const hit = findPlaintextGoalKey(child, here);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Pin the single Ed25519 signer for the bundle. Every receipt must share one public_key;
 * a mixed-key chain is rejected (fail closed). key_id is a deterministic fingerprint.
 */
export function pinTrustRoot(receipts: ProofReceipt[]): TrustRoot {
  const keys = new Set<string>();
  receipts.forEach((r, i) => {
    if (typeof r.public_key !== "string" || r.public_key.length === 0) {
      throw new Error(`Receipt ${describe(r, i)} is missing a public_key; cannot pin a trust root.`);
    }
    keys.add(r.public_key.toLowerCase());
  });
  if (keys.size !== 1) {
    throw new Error(`Bundle spans ${keys.size} distinct signing keys; a proof bundle pins exactly one.`);
  }
  const ed25519_public_key = [...keys][0]!;
  return { ed25519_public_key, key_id: deriveKeyId(ed25519_public_key) };
}

/** key_id = "ed25519:" + first 16 hex of sha256(raw key bytes). Deterministic, content-free. */
export function deriveKeyId(publicKeyHex: string): string {
  const raw = Buffer.from(publicKeyHex, "hex");
  return `ed25519:${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

/**
 * Derive the loop summary from the receipts using the repo's structural verifier
 * (verifyLoopChain) — a read-only cross-check over the chain. This is structural only;
 * the authoritative cryptographic verdict is the standalone verifier's (advisory here).
 */
export function deriveLoopSummary(receipts: ProofReceipt[]): LoopSummary {
  const links = toLinks(receipts);
  const result = verifyLoopChain(links);

  const goalHashes = new Set<string>();
  for (const link of links) {
    const g = link.loop?.goal_hash ?? link.loop_close?.goal_hash;
    if (typeof g === "string") goalHashes.add(g);
  }
  if (goalHashes.size !== 1) {
    throw new Error(`Chain has ${goalHashes.size} distinct goal_hash values; expected exactly one.`);
  }

  const loopId = result.valid ? result.loop_id : firstLoopId(links);
  if (!loopId) {
    throw new Error("Chain has no resolvable loop_id.");
  }

  const actionCount = result.valid
    ? result.action_count
    : terminalActionCount(receipts);

  return {
    loop_id: loopId,
    goal_hash: [...goalHashes][0]!,
    action_count: actionCount,
    sealed: result.valid && result.sealed,
    receipt_count: receipts.length
  };
}

export function buildLoopProofBundle(input: BuildLoopProofBundleInput): BuiltLoopProofBundle {
  assertExternalScope(input.receipts);
  assertContentBlind(input.receipts);
  const trust_root = pinTrustRoot(input.receipts);
  const loop = deriveLoopSummary(input.receipts);
  const receipts_json = resolveReceiptsJson(input);
  const exported_at = input.exported_at ?? new Date().toISOString();

  const content_digest: ContentDigest = {
    algorithm: "sha256",
    value: sha256Hex(receipts_json),
    over: "receipts.json"
  };

  const verdict: AdvisoryVerdict = {
    advisory: true,
    verifier: {
      name: "lyhna-verify",
      independent: true,
      reproduce: "lyhna-verify --chain receipts.json"
    },
    result: input.advisory_verdict ?? null
  };

  const bundle: LoopProofBundle = {
    bundle_version: "loop-proof-bundle/v1",
    format: "side-car",
    receipts_file: "receipts.json",
    scope: "external",
    trust_root,
    scheme: {
      receipt_version: RECEIPT_VERSION,
      canonicalization: CANONICALIZATION,
      signing_scheme: SIGNING_SCHEME
    },
    loop,
    export: { exported_at, source_env: input.source_env, content_digest },
    verdict,
    graph_node_file: "graph-node.json"
  };

  // Capsule Gate 1 (additive): project the scope + continuation capsules and reference the
  // attested scope events. Only runs when capsule material was supplied, so the legacy
  // 4-artifact bundle is byte-for-byte unchanged for a non-scoped loop.
  let scope_capsule: ScopeCapsuleExport | undefined;
  let continuation_capsule: ContinuationCapsule | undefined;
  let scope_events: ScopeEvent[] | undefined;
  let proof_card_markdown: string | undefined;
  let verify_instructions_markdown: string | undefined;
  let judgment_ledger: JudgmentLedgerExport | undefined;
  let judgment_ledger_markdown: string | undefined;
  let memory_injection: MemoryInjection | undefined;

  if (input.capsule) {
    const mode = input.capsule.mode;
    const sealed = input.capsule.sealed_scope;
    const continuation = input.capsule.continuation;

    // The VERIFIED scope/amendment chain. The set of valid scope_refs is derived ONLY from the
    // sealed scope history (each entry independently hash-verifiable), NEVER from the unsigned
    // continuation's claims — so a tampered continuation cannot whitelist arbitrary receipt stamps.
    // When no history is supplied, the single final sealed scope is the whole chain.
    const history = input.capsule.scope_history ?? [sealed];
    if (history.length === 0) {
      throw new Error("Capsule scope_history must contain at least the sealed scope (fail closed).");
    }

    // FAIL CLOSED (per-version hash integrity + loop binding): every history entry's scope_ref /
    // sidecar_hash must recompute from its own projections (so a tampered JSON cannot keep a legit
    // ref while mutating rules), and every version must belong to THIS loop.
    for (const entry of history) {
      // Re-apply the SEAL-TIME structural validation: the export reads scope material from JSON
      // (bypassing sealScopeCapsule), so recomputing scope_ref alone proves only hash-consistency,
      // not that the projection is safe to publish. Re-run the closed allowlist + content-blind +
      // bounds checks so a hash-consistent but unsafe structural projection (e.g. a stray
      // `description` key) can never ride into scope_ref or the content-blind Proof Mode export.
      assertScopeStructuralClosed(entry.structural);
      assertScopeStructuralContentBlind(entry.structural);
      assertBoundsEnforceable(entry.structural.bounds);
      if (deriveScopeRef(entry.structural) !== entry.scope_ref) {
        throw new Error(
          `Sealed scope_ref ${entry.scope_ref} does not match the hash of its structural projection; ` +
            `the scope material was tampered or is stale (fail closed).`
        );
      }
      if (deriveSidecarHash(entry.sidecar) !== entry.sidecar_hash) {
        throw new Error(`Sealed sidecar_hash for ${entry.scope_ref} does not match its sidecar projection (fail closed).`);
      }
      if (entry.structural.loop_id !== loop.loop_id || entry.structural.goal_hash !== loop.goal_hash) {
        throw new Error(
          `Sealed scope ${entry.scope_ref} does not belong to the receipt chain (loop_id/goal_hash mismatch); fail closed.`
        );
      }
    }

    // FAIL CLOSED (anchored + contiguous amendment chain): the first version is a root
    // (prior_scope_ref null) and each subsequent version chains to its predecessor's scope_ref.
    if ((history[0]!.prior_scope_ref ?? null) !== null) {
      throw new Error("Scope history does not start at a root (history[0].prior_scope_ref must be null); fail closed.");
    }
    for (let k = 1; k < history.length; k += 1) {
      if ((history[k]!.prior_scope_ref ?? null) !== history[k - 1]!.scope_ref) {
        throw new Error(`Scope history is not contiguous at version ${k} (prior_scope_ref does not chain); fail closed.`);
      }
    }
    const original = history[0]!;
    const finalScope = history[history.length - 1]!;
    const chainRefs = new Set<string>(history.map((h) => h.scope_ref));
    const byRef = new Map(history.map((h) => [h.scope_ref, h]));

    // FAIL CLOSED (identity binding): the declared sealed scope must BE the verified final version,
    // the continuation must inherit from the verified original and end at the verified final, its
    // amendments must all reference verified versions, and scope events must belong to this loop.
    const mismatches: string[] = [];
    if (sealed.scope_ref !== finalScope.scope_ref) {
      mismatches.push(`sealed_scope is not the final history version`);
    }
    if (continuation.loop_id !== loop.loop_id) {
      mismatches.push(`continuation loop_id ${continuation.loop_id} != receipts loop_id ${loop.loop_id}`);
    }
    if (continuation.goal_hash !== loop.goal_hash) {
      mismatches.push(`continuation goal_hash != receipts goal_hash`);
    }
    if (continuation.scope_ref !== finalScope.scope_ref) {
      mismatches.push(`continuation scope_ref != final sealed scope_ref`);
    }
    if (continuation.inherits_from.scope_ref !== original.scope_ref) {
      mismatches.push(`continuation inherits_from != original scope_ref`);
    }
    // The continuation's amendment list must reproduce the VERIFIED history EXACTLY (every
    // amendment, in order) — not merely a subset that happens to end at the right scope_ref.
    // Otherwise an omitted/reordered `what_changed` could report fewer amendments than actually
    // occurred while the verified history changed scope.
    const expectedAmendments = history.length - 1;
    if (continuation.what_changed.length !== expectedAmendments) {
      mismatches.push(
        `continuation what_changed has ${continuation.what_changed.length} amendment(s) but the verified history has ${expectedAmendments}`
      );
    } else {
      for (let k = 1; k < history.length; k += 1) {
        const a = continuation.what_changed[k - 1]!;
        if (a.from_scope_ref !== history[k - 1]!.scope_ref || a.to_scope_ref !== history[k]!.scope_ref) {
          mismatches.push(`continuation amendment ${k} does not match the verified history (from/to scope_ref)`);
          break;
        }
        // RECOMPUTE the amendment record from the verified history — a correct from/to pair must
        // not be allowed to falsify what changed. changed_fields must equal the actual structural
        // diff and sealed_at must match the sealed version, so the continuation/proof card cannot
        // under-report an amendment (e.g. hide an allowed_targets expansion with changed_fields: []).
        const expectedFields = diffStructural(history[k - 1]!, history[k]!);
        const gotFields = [...(a.changed_fields ?? [])].sort();
        if (JSON.stringify(gotFields) !== JSON.stringify(expectedFields)) {
          mismatches.push(`continuation amendment ${k} changed_fields do not match the verified history diff`);
          break;
        }
        if (a.sealed_at !== history[k]!.sealed_at) {
          mismatches.push(`continuation amendment ${k} sealed_at does not match the verified history`);
          break;
        }
      }
    }
    for (const e of input.capsule.scope_events ?? []) {
      if (e.loop_id !== loop.loop_id) {
        mismatches.push(`scope event ${e.event_hash} loop_id ${e.loop_id} != receipts loop_id ${loop.loop_id}`);
        break;
      }
    }
    if (mismatches.length > 0) {
      throw new Error(
        `Capsule material does not belong to the receipt chain (fail closed): ${mismatches.join("; ")}.`
      );
    }

    // FAIL CLOSED (scope-event integrity): recompute every supplied scope event's hash from its
    // contents and reject any mismatch, so a tampered scope-events.json (changed decision /
    // matched_rule / attempted / scope_ref while keeping the old hash) can't publish a sidecar event
    // whose contents are not committed by its event_hash. Each event's scope_ref must also be in the
    // verified chain (the refusal happened under a real scope version).
    for (const [idx, e] of (input.capsule.scope_events ?? []).entries()) {
      const recomputed = deriveScopeEventHash({
        event_type: e.event_type,
        loop_id: e.loop_id,
        scope_ref: e.scope_ref,
        attempted: e.attempted,
        matched_rule: e.matched_rule,
        decision: e.decision,
        prior_receipt_id: e.prior_receipt_id,
        ts: e.ts
      });
      if (recomputed !== e.event_hash) {
        throw new Error(`Scope event ${idx} event_hash does not match its contents (tampered or stale); fail closed.`);
      }
      if (!chainRefs.has(e.scope_ref)) {
        throw new Error(`Scope event ${idx} references scope_ref ${e.scope_ref} outside the verified history; fail closed.`);
      }
      // FAIL CLOSED (retained-plaintext binding): `event_hash` deliberately covers only the structural
      // `target_descriptor` (a hash), NOT the plaintext `attempted.target`, so the hash is identical in
      // Proof and Verified Context modes. That means a tampered scope-events.json can keep the same
      // descriptor/event_hash while swapping ONLY the plaintext `attempted.target`. In Verified Context
      // Mode that false plaintext would be published in the tenant-visible sidecar, so when a plaintext
      // target is RETAINED (verified_context) it must hash to its committed descriptor — exactly the
      // gate's invariant at record time (`target_descriptor = hashTarget(target)`). Proof Mode strips
      // the plaintext at projection, so it is never published and needs no binding here.
      if (mode === "verified_context" && typeof e.attempted.target === "string") {
        const boundDescriptor = e.attempted.target_descriptor;
        if (typeof boundDescriptor !== "string" || hashTarget(e.attempted.target) !== boundDescriptor) {
          throw new Error(
            `Scope event ${idx} retains a plaintext target that does not hash to its committed ` +
              `target_descriptor; the verified-context sidecar would publish an unattested plaintext target (fail closed).`
          );
        }
      }
    }

    // FAIL CLOSED (continuation event-ref binding): the human-facing proof card renders its per-event
    // list from `continuation.scope_events` (an unsigned ScopeEventRef[]), while `bundle.json` advertises
    // the VERIFIED event hashes derived from `input.capsule.scope_events` (recomputed above). A stale or
    // tampered `--continuation` could omit/alter its own refs and so under-report attested scope halts in
    // the card even though the pack carries them. Require the continuation's refs to reproduce the verified
    // events EXACTLY — same count, and in order the same structural ref fields — so the card can never
    // diverge from the pack. (Refs are content-blind, so this holds identically in Proof and VC modes.)
    const verifiedEvents = input.capsule.scope_events ?? [];
    const contRefs = continuation.scope_events ?? [];
    if (contRefs.length !== verifiedEvents.length) {
      throw new Error(
        `Continuation lists ${contRefs.length} scope event(s) but the verified pack carries ${verifiedEvents.length}; ` +
          `the continuation/proof card would misreport attested scope halts (fail closed).`
      );
    }
    for (let k = 0; k < verifiedEvents.length; k += 1) {
      const want = verifiedEvents[k]!;
      const got = contRefs[k]!;
      if (
        got.event_hash !== want.event_hash ||
        got.event_type !== want.event_type ||
        got.decision !== want.decision ||
        got.scope_ref !== want.scope_ref ||
        (got.prior_receipt_id ?? null) !== (want.prior_receipt_id ?? null) ||
        (got.matched_rule ?? undefined) !== (want.matched_rule ?? undefined)
      ) {
        throw new Error(
          `Continuation scope event ${k} does not match the verified scope event ` +
            `(event_hash/event_type/decision/scope_ref/prior_receipt_id/matched_rule); the continuation/proof card ` +
            `would misreport an attested scope halt (fail closed).`
        );
      }
    }


    // consequential receipt must carry a `constraints.scope.scope_ref` in the VERIFIED chain, AND
    // the stamped descriptor (action_class / tool_name / target_descriptor) must actually be IN-LANE
    // for THAT referenced scope version's structural rules — not merely point at a valid scope_ref.
    // Otherwise a receipt stamped with the right scope_ref but an out-of-scope tool/target could be
    // packaged as an in-scope proof. A consequential receipt with NO scope stamp also fails closed
    // (a legacy/no-scope chain can't be dressed up with a capsule). The terminal `loop_close` is
    // exempt (it may be intentionally unstamped); if it does carry a stamp it is still re-validated.
    // FAIL CLOSED (max_steps hard bound): count FORWARDED (executed) in-loop steps and re-check each
    // against its governing scope version's bounds.max_steps. The runtime budgets max_steps on forwarded
    // outcomes only — a held (ESCALATED) / refused (REFUSED) bind never reaches the upstream and does not
    // consume the scope (loop.ts) — so the export mirrors that: only an APPROVED in-loop receipt counts.
    // The i-th forwarded step requires its version's max_steps >= i (a tampered/imported chain that runs
    // more executed steps than the sealed bound allows must not export as a valid scoped proof).
    let inLoopStepCount = 0;
    input.receipts.forEach((r, i) => {
      const c = r.constraints as
        | {
            loop?: { prior_receipt_id?: unknown };
            loop_close?: unknown;
            scope?: { scope_ref?: unknown; action_class?: unknown; tool_name?: unknown; target_descriptor?: unknown; target_descriptors?: unknown; prior_receipt_id?: unknown };
          }
        | undefined;
      const isTerminal = isRecord(c?.loop_close);
      const isInLoop = isRecord(c?.loop) && !isTerminal;
      // Only a FORWARDED (APPROVED) in-loop bind consumes the execution budget — matches the runtime.
      const isForwardedStep = isInLoop && (r as Record<string, unknown>).outcome === "APPROVED";
      if (isForwardedStep) inLoopStepCount += 1;
      const stamp = c?.scope;
      const sref = stamp?.scope_ref;
      if (typeof sref === "string") {
        const version = byRef.get(sref);
        if (!version) {
          throw new Error(
            `Receipt ${describe(r, i)} carries scope_ref ${sref} outside the exported scope/amendment ` +
              `chain; the receipts were authorized under a scope this pack does not present (fail closed).`
          );
        }
        // FAIL CLOSED (per-step scope anchoring): the scope stamp must cite the SAME predecessor as the
        // signed `constraints.loop`. The runtime stamps both inside one loop mutex with the same
        // `prior_receipt_id` (loop.ts), so a scope anchor pointing at a different predecessor than the
        // signed loop constraint is stale or forged — refuse rather than package a misanchored per-step
        // proof. Only enforced when a loop constraint is present (the predecessor source of truth).
        if (isRecord(c?.loop)) {
          const loopPrior = c!.loop!.prior_receipt_id ?? null;
          const scopePrior = stamp?.prior_receipt_id ?? null;
          if (scopePrior !== loopPrior) {
            throw new Error(
              `Receipt ${describe(r, i)} scope stamp is anchored to prior_receipt_id ${JSON.stringify(scopePrior)} ` +
                `but the signed loop predecessor is ${JSON.stringify(loopPrior)}; the per-step scope anchor is stale ` +
                `or forged (fail closed).`
            );
          }
        }
        // FAIL CLOSED (max_steps hard bound): the i-th FORWARDED in-loop step requires its governing
        // scope version to permit at least i steps. Held/refused binds don't count (they never ran),
        // mirroring the runtime budget. A chain that runs more executed steps than the sealed bound
        // allows must not export as a valid scoped proof (it would misrepresent a violated hard bound).
        if (isForwardedStep) {
          const maxSteps = version.structural.bounds?.max_steps;
          if (maxSteps != null && inLoopStepCount > maxSteps) {
            throw new Error(
              `Receipt ${describe(r, i)} is forwarded in-loop step ${inLoopStepCount} but scope ${sref} declares ` +
                `bounds.max_steps ${maxSteps}; the chain exceeds the sealed hard step bound (fail closed).`
            );
          }
        }
        // Re-validate the stamped descriptor against the referenced version's structural lane.
        const s = version.structural;
        const action_class = typeof stamp?.action_class === "string" ? stamp.action_class : undefined;
        const tool_name = typeof stamp?.tool_name === "string" ? stamp.tool_name : undefined;
        const target_descriptor = typeof stamp?.target_descriptor === "string" ? stamp.target_descriptor : null;
        // Per-target hashes for membership re-validation. Prefer the explicit per-target array
        // (multi-target tools); fall back to the single descriptor for single-target stamps.
        // Per-target hashes for membership. Use the per-target ARRAY only when it has ≥1 valid
        // entry (multi-target tools; the single `target_descriptor` is a set DIGEST, not a member).
        // Otherwise fall back to the single descriptor — so an EMPTY/malformed `target_descriptors`
        // array can never HIDE a stamped `target_descriptor` (which would let a targetless exemption
        // skip membership for a real target).
        const arrayHashes = Array.isArray(stamp?.target_descriptors)
          ? (stamp!.target_descriptors as unknown[]).filter((h): h is string => typeof h === "string")
          : [];
        const stampedTargetHashes: string[] =
          arrayHashes.length > 0 ? arrayHashes : target_descriptor !== null ? [target_descriptor] : [];

        if (s.allowed_tools && s.allowed_tools.length > 0) {
          if (tool_name === undefined || !s.allowed_tools.includes(tool_name)) {
            throw new Error(
              `Receipt ${describe(r, i)} stamped tool_name ${JSON.stringify(tool_name)} is not allowed under ` +
                `scope ${sref} (fail closed).`
            );
          }
        }
        if (s.allowed_action_classes && s.allowed_action_classes.length > 0) {
          if (action_class === undefined || !s.allowed_action_classes.includes(action_class)) {
            throw new Error(
              `Receipt ${describe(r, i)} stamped action_class ${JSON.stringify(action_class)} is not allowed under ` +
                `scope ${sref} (fail closed).`
            );
          }
        }
        // Content-blind target re-validation (Option B). The receipt only carries target HASHES, so
        // the export can prove EXACT hash membership but cannot re-evaluate plaintext globs from a
        // hash. Therefore an export-verifiable target lane REQUIRES `target_descriptor_hashes`:
        //   - allowed_targets / forbidden_targets globs are RUNTIME-GATE guarantees (the adapter saw
        //     the plaintext target pre-bind);
        //   - target_descriptor_hashes are EXPORT-PROOF guarantees (re-checkable content-blind).
        // The targetless exemption applies ONLY when the stamp names NO target; a targetless step
        // that still carries a target hash is re-validated like any other (round 18 #1). Multi-target
        // stamps are validated member-by-member via the per-target hashes (round 18 #2). A scope that
        // constrains targets only via globs (no hashes) cannot be re-validated and FAILS CLOSED.
        const targetless = action_class !== undefined && (s.targetless_action_classes ?? []).includes(action_class);
        const declaresTargetRules =
          (s.allowed_targets?.length ?? 0) > 0 ||
          (s.forbidden_targets?.length ?? 0) > 0 ||
          (s.target_descriptor_hashes?.length ?? 0) > 0;
        const mustValidateTarget = declaresTargetRules && (stampedTargetHashes.length > 0 || !targetless);
        if (mustValidateTarget) {
          if ((s.target_descriptor_hashes?.length ?? 0) === 0) {
            throw new Error(
              `Receipt ${describe(r, i)} runs under target-constrained scope ${sref} that declares only ` +
                `plaintext target globs (no target_descriptor_hashes); content-blind export cannot re-validate ` +
                `a target from a hash — declare target_descriptor_hashes for an export-verifiable target lane (fail closed).`
            );
          }
          if (stampedTargetHashes.length === 0) {
            throw new Error(
              `Receipt ${describe(r, i)} runs under target-constrained scope ${sref} but stamps no target ` +
                `descriptor and is not a declared-targetless action (fail closed).`
            );
          }
          for (const h of stampedTargetHashes) {
            if (!s.target_descriptor_hashes!.includes(h)) {
              throw new Error(
                `Receipt ${describe(r, i)} stamped target_descriptor ${h} is not a declared member under scope ${sref} (fail closed).`
              );
            }
          }
        }
      } else if (isInLoop) {
        throw new Error(
          `Receipt ${describe(r, i)} is an in-loop consequential step with no constraints.scope.scope_ref; ` +
            `a scoped export requires every consequential receipt to be scope-stamped (terminal loop_close ` +
            `exempt). Fail closed.`
        );
      }
    });

    // FAIL CLOSED (mode contract): an export mode must never be MORE permissive than the sealed
    // scope declared. A Verified Context (plaintext-sidecar) export is permitted ONLY when the
    // sealed scope declared EXACTLY "verified_context" — any other value (proof, or a malformed
    // privacy_mode that slipped through) blocks it, so an operator --mode typo (or a capsule typo)
    // can never turn a content-blind pack into a plaintext one. Downgrading to a Proof pack is
    // always safe (strictly more restrictive) and remains allowed.
    //
    // This is checked against the VERIFIED `finalScope` (hash-validated history entry), NOT the raw
    // `sealed` input. With --scope-history the `sealed` object's `structural` is never hash-checked —
    // only `sealed.scope_ref === finalScope.scope_ref` is enforced above — so a caller could supply a
    // `sealed_scope` whose scope_ref matches the proof-mode final version while its `structural`
    // claims `privacy_mode: "verified_context"`. Trusting `sealed` here would emit the verified final
    // scope's plaintext sidecar despite the verified scope being content-blind. `finalScope` is the
    // version actually projected below, so the mode contract must be judged on it.
    if (mode === "verified_context" && finalScope.structural.privacy_mode !== "verified_context") {
      throw new Error(
        `Cannot export in Verified Context Mode: the verified final scope's privacy_mode is ` +
          `${JSON.stringify(finalScope.structural.privacy_mode)}, not "verified_context"; refusing to ` +
          `emit a plaintext sidecar (fail closed).`
      );
    }

    // Project the VERIFIED final scope version (hash + closed-allowlist validated above), NOT the
    // raw `sealed_scope` input — with --scope-history the input projection is otherwise unvalidated
    // and could differ from / be unsafe relative to the verified final version.
    scope_capsule = projectScopeCapsuleForExport(finalScope, mode);
    continuation_capsule =
      mode === "verified_context" ? continuation : projectContinuationProofMode(continuation);
    scope_events = (input.capsule.scope_events ?? []).map((e) => projectScopeEvent(e, mode));

    // Proof Mode is content-blind: the scope-capsule.json must be structural-only. Fail closed.
    if (mode === "proof") {
      assertScopeCapsuleStructuralOnly(scope_capsule);
    }

    // Capsule Gate 2 (ADDITIVE): when the judgment ledger was dumped, validate it against the
    // receipts + scope events, fold it, and emit judgment-ledger.json/.md + memory-injection.json.
    if (input.capsule.judgment_turns) {
      const built = buildJudgmentArtifacts({
        loop_id: loop.loop_id,
        scope_ref: finalScope.scope_ref,
        mode,
        receipts: input.receipts,
        scope_events: input.capsule.scope_events ?? [],
        turns: input.capsule.judgment_turns,
        continuation
      });
      judgment_ledger = built.ledger;
      judgment_ledger_markdown = built.markdown;
      memory_injection = built.memory;
    }

    bundle.capsule = {
      mode,
      // Use the VERIFIED final version's scope_ref (proven equal to sealed.scope_ref above), so the
      // pack advertises the hash-validated scope, never the untrusted sealed input.
      scope_ref: finalScope.scope_ref,
      scope_capsule_file: "scope-capsule.json",
      continuation_capsule_file: "continuation-capsule.json",
      scope_events: {
        count: scope_events.length,
        event_hashes: scope_events.map((e) => e.event_hash)
      },
      ...(judgment_ledger
        ? {
            judgment: {
              judgment_ledger_file: "judgment-ledger.json" as const,
              judgment_ledger_markdown_file: "judgment-ledger.md" as const,
              memory_injection_file: "memory-injection.json" as const,
              final_turn_ref: judgment_ledger.final_turn_ref,
              turn_count: judgment_ledger.turn_count
            }
          }
        : {})
    };

    proof_card_markdown = renderProofCardMarkdown(bundle, continuation_capsule);
    verify_instructions_markdown = renderVerifyInstructionsMarkdown(bundle);
  }

  const graph_node = buildGraphNode(bundle);
  const graph_node_markdown = renderGraphNodeMarkdown(graph_node);

  return {
    bundle,
    receipts_json,
    graph_node,
    graph_node_markdown,
    scope_capsule,
    continuation_capsule,
    scope_events,
    proof_card_markdown,
    verify_instructions_markdown,
    judgment_ledger,
    judgment_ledger_markdown,
    memory_injection
  };
}

/** A structural runtime hash must be sha256-shaped (no plaintext, never an interpreted verdict). */
const RUNTIME_HASH = /^sha256:[0-9a-f]{64}$/;

/**
 * Capsule Gate 2 export validation + fold. Validates the dumped judgment ledger as an append-only,
 * contiguous, hash-linked chain and cross-checks it against the signed receipts and attested scope
 * events, then folds it (reducer) and projects the privacy-mode artifacts. Fail-closed throughout:
 * a chain break, an unanchored verdict, or a receipt/scope-event that does NOT map to a judgment
 * turn (or vice versa) rejects the export.
 */
function buildJudgmentArtifacts(input: {
  loop_id: string;
  scope_ref: string;
  mode: ScopePrivacyMode;
  receipts: ProofReceipt[];
  scope_events: ScopeEvent[];
  turns: JudgmentTurn[];
  continuation: ContinuationCapsule;
}): { ledger: JudgmentLedgerExport; markdown: string; memory: MemoryInjection } {
  const { loop_id, scope_ref, mode, turns, continuation } = input;

  // 1) Append-only / contiguous / hash-linked chain (no duplicate / missing turn_ref).
  const chain = validateJudgmentChain(turns);
  if (!chain.valid) {
    throw new Error(`Judgment ledger is not a valid chain: ${chain.reason} (fail closed).`);
  }
  if (chain.loop_id !== null && chain.loop_id !== loop_id) {
    throw new Error(`Judgment ledger loop_id ${chain.loop_id} does not match the receipts loop_id ${loop_id} (fail closed).`);
  }

  // 2) Receipts <-> bind turns, POSITIONALLY and by outcome. The in-loop receipts are in chain
  // order (the receipt recorder captures each bind in order); the bind judgment turns are appended
  // in that SAME order (in-mutex, right after each chain advance). So the i-th bind turn must anchor
  // the i-th in-loop receipt AND its verdict.kind must equal the signed receipt outcome. A set/count
  // check alone would let a stale/tampered ledger swap r1/r2 or relabel an APPROVED receipt REFUSED.
  const inLoopReceipts: { id: string; outcome: unknown; scope: Record<string, unknown> | undefined }[] = [];
  input.receipts.forEach((r, i) => {
    const c = r.constraints;
    const isTerminal = isRecord(c?.loop_close);
    const isInLoop = isRecord(c?.loop) && !isTerminal;
    if (isInLoop) {
      if (typeof r.receipt_id !== "string") {
        throw new Error(`In-loop receipt ${describe(r, i)} is missing a string receipt_id (fail closed).`);
      }
      inLoopReceipts.push({
        id: r.receipt_id,
        outcome: (r as Record<string, unknown>).outcome,
        scope: isRecord((c as { scope?: unknown }).scope) ? ((c as { scope: Record<string, unknown> }).scope) : undefined
      });
    }
  });
  const bindTurns = turns.filter((t) => t.verdict.source === "bind");
  if (bindTurns.length !== inLoopReceipts.length) {
    throw new Error(
      `Bind judgment turn count (${bindTurns.length}) does not match in-loop receipt count ` +
        `(${inLoopReceipts.length}); every in-loop receipt must map to exactly one bind turn (fail closed).`
    );
  }
  for (let i = 0; i < bindTurns.length; i += 1) {
    const t = bindTurns[i]!;
    const r = inLoopReceipts[i]!;
    if (!t.verdict.receipt_id) {
      throw new Error(`Bind judgment turn ${t.turn_index} has no signed receipt anchor (fail closed).`);
    }
    if (t.verdict.receipt_id !== r.id) {
      throw new Error(
        `Bind judgment turn ${t.turn_index} anchors receipt ${t.verdict.receipt_id} but the in-loop receipt at ` +
          `chain position ${i} is ${r.id}; the judgment order diverges from the signed receipt order (fail closed).`
      );
    }
    if (t.verdict.kind !== r.outcome) {
      throw new Error(
        `Bind judgment turn ${t.turn_index} verdict ${t.verdict.kind} does not match signed receipt ${r.id} ` +
          `outcome ${JSON.stringify(r.outcome)} (fail closed).`
      );
    }
    // Bind the turn's proposed descriptor to the SIGNED constraints.scope stamp on the receipt. The
    // stamp (action_class / tool_name / target hash) is part of the signed bind request, so a tampered
    // ledger cannot recompute turn_ref with a different proposed move and still pass: the signed
    // receipt commits what action was actually authorized. (Scoped in-loop receipts always carry the
    // stamp — the Capsule Gate 1 per-receipt check above already enforced its presence.)
    if (!r.scope) {
      throw new Error(`In-loop receipt ${r.id} has no signed constraints.scope stamp to bind its bind turn descriptor to (fail closed).`);
    }
    const sAction = typeof r.scope.action_class === "string" ? r.scope.action_class : undefined;
    const sTool = typeof r.scope.tool_name === "string" ? r.scope.tool_name : undefined;
    const sTarget = typeof r.scope.target_descriptor === "string" ? r.scope.target_descriptor : null;
    if (
      t.proposed.action_class !== sAction ||
      t.proposed.tool_name !== sTool ||
      (t.proposed.target_descriptor ?? null) !== sTarget
    ) {
      throw new Error(
        `Bind judgment turn ${t.turn_index} proposed descriptor (${t.proposed.action_class}/${t.proposed.tool_name}/` +
          `${t.proposed.target_descriptor ?? "—"}) does not match the signed constraints.scope stamp on receipt ${r.id} (fail closed).`
      );
    }
  }

  // 3) Scope events <-> scope_gate / loop_bound turns, by CONTENT. The event_hash commits the event's
  // decision, event_type, matched_rule, and attempted descriptor (deriveScopeEventHash), so anchoring a
  // hash is not enough: the turn's verdict kind/source/reason_code and proposed descriptor must match
  // the attested event — else a turn could anchor a real REFUSED event but claim APPROVED, or label a
  // max_steps (loop_bound) halt as scope_gate. Each attested event must be anchored by exactly one turn.
  const eventHashes = input.scope_events.map((e) => e.event_hash);
  const eventByHash = new Map(input.scope_events.map((e) => [e.event_hash, e]));
  const anchoredEvents = new Set<string>();
  for (const t of turns) {
    if (t.verdict.source !== "scope_gate" && t.verdict.source !== "loop_bound") continue;
    const h = t.verdict.scope_event_hash;
    if (!h) {
      throw new Error(`Scope/loop-bound judgment turn ${t.turn_index} has no scope_event_hash anchor (fail closed).`);
    }
    const event = eventByHash.get(h);
    if (!event) {
      throw new Error(`Judgment turn ${t.turn_index} anchors scope_event_hash ${h}, which is not an attested scope event (fail closed).`);
    }
    if (anchoredEvents.has(h)) {
      throw new Error(`Attested scope event ${h} is anchored by more than one judgment turn (fail closed).`);
    }
    if (t.verdict.kind !== event.decision) {
      throw new Error(
        `Judgment turn ${t.turn_index} verdict ${t.verdict.kind} does not match attested scope event ${h} decision ` +
          `${event.decision} (fail closed).`
      );
    }
    // A max_steps event is a loop_bound halt; every other attested scope event is a scope_gate refusal.
    const expectedSource = event.matched_rule === "max_steps" ? "loop_bound" : "scope_gate";
    if (t.verdict.source !== expectedSource) {
      throw new Error(
        `Judgment turn ${t.turn_index} source ${t.verdict.source} does not match attested scope event ${h} ` +
          `(matched_rule ${JSON.stringify(event.matched_rule)} implies ${expectedSource}); fail closed.`
      );
    }
    if ((t.verdict.reason_code ?? null) !== (event.matched_rule ?? null)) {
      throw new Error(
        `Judgment turn ${t.turn_index} reason_code ${JSON.stringify(t.verdict.reason_code)} does not match attested ` +
          `scope event ${h} matched_rule ${JSON.stringify(event.matched_rule)} (fail closed).`
      );
    }
    if (
      t.proposed.action_class !== event.attempted.action_class ||
      t.proposed.tool_name !== event.attempted.tool_name ||
      (t.proposed.target_descriptor ?? null) !== (event.attempted.target_descriptor ?? null)
    ) {
      throw new Error(
        `Judgment turn ${t.turn_index} proposed descriptor does not match the descriptor committed by attested ` +
          `scope event ${h} (fail closed).`
      );
    }
    // The event_hash also commits the event's prior_receipt_id, and the live path records the event +
    // turn in one serialized section (same predecessor). Require the turn's inherited prior to equal
    // the attested event's anchor, so a tampered ledger cannot reposition a scope-gate turn against a
    // predecessor different from the one the attested event was anchored to.
    if ((t.prior_receipt_id ?? null) !== (event.prior_receipt_id ?? null)) {
      throw new Error(
        `Judgment turn ${t.turn_index} inherits prior_receipt_id ${JSON.stringify(t.prior_receipt_id ?? null)} but ` +
          `attested scope event ${h} is anchored to ${JSON.stringify(event.prior_receipt_id ?? null)} (fail closed).`
      );
    }
    anchoredEvents.add(h);
  }
  for (const h of eventHashes) {
    if (!anchoredEvents.has(h)) {
      throw new Error(`Attested scope event ${h} has no matching judgment turn (fail closed).`);
    }
  }

  // 4) Runtime hashes are structural only (sha256-shaped) — never interpreted, never plaintext.
  for (const t of turns) {
    const rr = t.runtime_report;
    if (rr?.result_hash && !RUNTIME_HASH.test(rr.result_hash)) {
      throw new Error(`Judgment turn ${t.turn_index} runtime result_hash is not a structural sha256 hash (fail closed).`);
    }
    if (rr?.error_hash && !RUNTIME_HASH.test(rr.error_hash)) {
      throw new Error(`Judgment turn ${t.turn_index} runtime error_hash is not a structural sha256 hash (fail closed).`);
    }
  }

  // 5) Fold + project under the privacy mode.
  const reduced = reduceJudgmentLedger({ loop_id, scope_ref, turns, mode });
  const projectedTurns = turns.map((t) => projectTurn(t, mode));

  // Proof Mode is content-blind: no projected turn may carry a plaintext delta.
  if (mode === "proof") {
    for (const t of projectedTurns) {
      if (t.declared_delta !== undefined) {
        throw new Error(`Proof Mode judgment turn ${t.turn_index} carries a plaintext declared_delta (fail closed).`);
      }
    }
  }

  // FAIL CLOSED (continuation binding): when the continuation carries a judgment summary, it must
  // match the VERIFIED reduced fold — so a tampered/stale continuation cannot under-report verdicts,
  // refs, or the final turn while the pack carries the real ledger.
  if (continuation.final_turn_ref !== undefined && (continuation.final_turn_ref ?? null) !== (reduced.final_turn_ref ?? null)) {
    throw new Error(`Continuation final_turn_ref does not match the verified judgment ledger (fail closed).`);
  }
  if (continuation.judgment) {
    // Compare the ENTIRE judgment summary the continuation will publish (continuation-capsule.json
    // copies capsule.judgment verbatim) against the section rebuilt from the VERIFIED reduced fold —
    // including refused_steps and the runtime hash lists, not just the counts/refs. A field-subset
    // comparison would let a stale/tampered continuation hide a REFUSED step, flip a `corrected` flag,
    // or fake runtime hashes while the structural totals still matched. Canonical (sorted-key) JSON so
    // key order is irrelevant; the section is mode-independent (purely structural).
    const expected: ContinuationJudgmentSection = {
      judgment_ledger_version: JUDGMENT_LEDGER_VERSION,
      final_turn_ref: reduced.final_turn_ref,
      turn_count: reduced.turn_count,
      verdict_counts: reduced.verdict_counts,
      source_counts: reduced.source_counts,
      receipt_refs: reduced.receipt_refs,
      scope_event_refs: reduced.scope_event_refs,
      runtime_result_hashes: reduced.runtime_result_hashes,
      runtime_error_hashes: reduced.runtime_error_hashes,
      refused_steps: reduced.refused_steps
    };
    if (canonicalScopeJson(continuation.judgment) !== canonicalScopeJson(expected)) {
      throw new Error(`Continuation judgment summary does not match the verified judgment ledger (fail closed).`);
    }
  }

  const ledger: JudgmentLedgerExport = {
    judgment_ledger_version: JUDGMENT_LEDGER_VERSION,
    loop_id,
    scope_ref,
    mode,
    final_turn_ref: reduced.final_turn_ref,
    turn_count: projectedTurns.length,
    reduced,
    turns: projectedTurns
  };
  const markdown = renderJudgmentLedgerMarkdown(loop_id, projectedTurns, mode);
  const capsule_ref = deriveContinuationRef(continuation);
  const memory = buildMemoryInjection({ loop_id, capsule_ref, scope_ref, reduced });
  return { ledger, markdown, memory };
}

/** Content-blind, mode-independent identity of a continuation capsule (over its structural projection). */
function deriveContinuationRef(continuation: ContinuationCapsule): string {
  return `cap_v1:${sha256Hex(canonicalScopeJson(projectContinuationProofMode(continuation)))}`;
}

/** Authority Context Graph node describing this one verified loop. */
export function buildGraphNode(bundle: LoopProofBundle): AuthorityContextGraphNode {
  return {
    id: `acg:loop:${bundle.scope}:${bundle.loop.loop_id}`,
    type: "loop_proof",
    loop_id: bundle.loop.loop_id,
    goal_hash: bundle.loop.goal_hash,
    action_count: bundle.loop.action_count,
    sealed: bundle.loop.sealed,
    scope: bundle.scope,
    trust_root: bundle.trust_root,
    receipt_count: bundle.loop.receipt_count,
    content_digest: bundle.export.content_digest,
    exported_at: bundle.export.exported_at,
    source_env: bundle.export.source_env
  };
}

export function renderGraphNodeMarkdown(node: AuthorityContextGraphNode): string {
  const verdict = node.sealed ? "SEALED ✓" : "UNSEALED ✗";
  return [
    `# Authority Context Graph — Loop Proof Node`,
    ``,
    `**\`${node.id}\`**`,
    ``,
    `| field | value |`,
    `| --- | --- |`,
    `| type | \`${node.type}\` |`,
    `| loop_id | \`${node.loop_id}\` |`,
    `| goal_hash | \`${node.goal_hash}\` |`,
    `| action_count | ${node.action_count} |`,
    `| sealed | **${verdict}** |`,
    `| scope | \`${node.scope}\` |`,
    `| receipt_count | ${node.receipt_count} |`,
    `| trust_root.key_id | \`${node.trust_root.key_id}\` |`,
    `| trust_root.ed25519_public_key | \`${node.trust_root.ed25519_public_key}\` |`,
    `| content_digest | \`sha256:${node.content_digest.value}\` (over \`${node.content_digest.over}\`) |`,
    `| source_env | \`${node.source_env}\` |`,
    `| exported_at | \`${node.exported_at}\` |`,
    ``,
    `> Content-blind: only \`goal_hash\` is carried — never the plaintext goal.`,
    `> The sealed verdict above is advisory; verify independently with`,
    `> \`lyhna-verify --chain receipts.json\` (trusts only the pinned public key).`,
    ``
  ].join("\n");
}

/**
 * proof-card.md — a one-page human summary of the proof pack (Capsule Gate 1). Content-blind:
 * carries goal_hash, scope_ref, structural counts, and attested scope-event hashes — never the
 * plaintext goal or plan.
 */
export function renderProofCardMarkdown(
  bundle: LoopProofBundle,
  continuation: ContinuationCapsule
): string {
  const cap = bundle.capsule;
  const lines = [
    `# Loop Proof Card`,
    ``,
    `| field | value |`,
    `| --- | --- |`,
    `| loop_id | \`${bundle.loop.loop_id}\` |`,
    `| goal_hash | \`${bundle.loop.goal_hash}\` |`,
    `| sealed | **${bundle.loop.sealed ? "SEALED ✓" : "UNSEALED ✗"}** |`,
    `| action_count | ${bundle.loop.action_count} |`,
    `| receipt_count | ${bundle.loop.receipt_count} |`,
    `| scope_ref | \`${cap?.scope_ref ?? "—"}\` |`,
    `| mode | \`${cap?.mode ?? "—"}\` |`,
    `| attested scope events | ${cap?.scope_events.count ?? 0} |`,
    `| amendments | ${continuation.what_changed.length} |`,
    `| trust_root.key_id | \`${bundle.trust_root.key_id}\` |`,
    `| content_digest | \`sha256:${bundle.export.content_digest.value}\` |`,
    ``,
    `> Content-blind: only \`goal_hash\` / \`scope_ref\` / hashes are carried — never the`,
    `> plaintext goal or plan. Verify independently: see \`verify-instructions.md\`.`,
    ``
  ];
  if ((cap?.scope_events.count ?? 0) > 0) {
    lines.push(`## Attested scope refusals / escalations`, ``);
    for (const e of continuation.scope_events) {
      lines.push(`- **${e.decision}** ${e.event_type} (rule: ${e.matched_rule ?? "—"}) — \`${e.event_hash}\``);
    }
    lines.push(``);
  }
  return lines.join("\n");
}

/** verify-instructions.md — how to cold-verify the pack with the independent verifier. */
export function renderVerifyInstructionsMarkdown(bundle: LoopProofBundle): string {
  const lines = [
    `# Verify Instructions`,
    ``,
    `This proof pack is verified by the independent, trust-no-one \`lyhna-verify\`. The adapter's`,
    `embedded verdict is advisory; re-run the verifier to trust it.`,
    ``,
    `## 1. Cold-verify the signed receipt chain`,
    ``,
    `\`\`\``,
    `lyhna-verify --chain receipts.json --json`,
    `\`\`\``,
    ``,
    `Expect a single chain with \`sealed: true\`, continuity/loop_id/goal_hash consistency, and`,
    `\`all_receipts_verified: true\` for a real signed chain (a synthetic/unsigned chain reports`,
    `\`all_receipts_verified: false\` — crypto fail-by-absence, by design).`,
    ``,
    `## 2. Confirm the content digest`,
    ``,
    `\`bundle.json\`'s \`export.content_digest.value\` is sha256 over the exact bytes of`,
    `\`receipts.json\` (\`${bundle.export.content_digest.value}\`).`,
    ``
  ];
  if (bundle.capsule) {
    lines.push(
      `## 3. Capsule Gate 1 scope artifacts`,
      ``,
      `- \`scope-capsule.json\` — the sealed Scope Capsule (\`scope_ref: ${bundle.capsule.scope_ref}\`).`,
      bundle.capsule.mode === "proof"
        ? `  In Proof Mode this is STRUCTURAL-ONLY (no plaintext plan).`
        : `  In Verified Context Mode this also carries the plaintext sidecar.`,
      `- \`continuation-capsule.json\` — settled / open / next + what changed, inheriting \`scope_ref\`.`,
      `- Scope refusals/escalations are attested by \`event_hash\` under \`bundle.json\` ->`,
      `  \`capsule.scope_events.event_hashes\` (${bundle.capsule.scope_events.count} event(s)).`,
      ...(bundle.capsule.judgment
        ? [
            `- \`judgment-ledger.json\` — the verified judgment path (Capsule Gate 2): ${bundle.capsule.judgment.turn_count}`,
            `  ordered turn(s), final_turn_ref \`${bundle.capsule.judgment.final_turn_ref ?? "—"}\`. Each turn is`,
            `  hash-linked (prior_turn_ref) and anchored to a signed receipt (bind verdicts) or an attested`,
            `  scope event (scope/loop-bound refusals). Runtime results are HASHED, never interpreted.`,
            `  \`judgment-ledger.md\` is the human-readable projection; \`memory-injection.json\` is the portable`,
            `  handoff object. In Proof Mode all three are content-blind (no plaintext deltas).`
          ]
        : []),
      ``,
      `### Target-lane guarantees (what this proof does and does not assert)`,
      ``,
      `- \`allowed_targets\` / \`forbidden_targets\` globs are **runtime-gate** guarantees: the adapter`,
      `  saw the plaintext target before execution and enforced them pre-bind.`,
      `- \`target_descriptor_hashes\` are **export-proof** guarantees: every consequential receipt's`,
      `  stamped target hash is re-validated here as exact membership.`,
      `- Content-blind export can prove exact hash membership, NOT arbitrary glob semantics over`,
      `  plaintext it no longer holds — so an export-verifiable target lane requires`,
      `  \`target_descriptor_hashes\`; a globs-only scope fails closed at export.`,
      ``,
      `### Trust boundary (what governs enforcement, and what this proof does NOT assert)`,
      ``,
      `- The classifier (\`class_map\`: tool_name -> action_class) is SEALED into \`scope_ref\` and`,
      `  appears in the verified scope history, so the exact policy that governed \`deriveActionClass()\``,
      `  at the gate is hash-bound and auditable in this pack.`,
      `- Capsule Gate 1 trusts the **adapter** as the supervisor-side enforcement point. The adapter`,
      `  derives each step's descriptor (action_class / tool_name / target hash) from the live payload`,
      `  pre-bind and the hosted bind service signs that stamp. The content-blind pack does NOT carry`,
      `  the plaintext \`action_payload\`, and the signed receipt commits no payload hash, so this proof`,
      `  does NOT independently re-bind a stamp to its \`action_payload\`. Such a binding would require a`,
      `  core-signed payload commitment (a canonical-receipt change) or carrying plaintext payload`,
      `  (weakening content-blind Proof Mode) — both outside Capsule Gate 1's scope. The gate defends`,
      `  the agent, continuation, export, and tampered-JSON paths; a malicious adapter forging its own`,
      `  stamps is outside this threat model.`,
      ``
    );
  }
  return lines.join("\n");
}

// --- internal helpers --------------------------------------------------------

/**
 * Resolve the exact bytes written to `receipts.json` and digested. When the caller
 * supplies the original source text, preserve it VERBATIM (byte-identical provenance) —
 * guarding that it actually parses to the validated receipts. Otherwise use the canonical
 * serialization. Signatures verify either way (the verifier canonicalizes), but only the
 * verbatim path keeps `receipts.json` byte-identical to the signed source artifact.
 */
function resolveReceiptsJson(input: BuildLoopProofBundleInput): string {
  if (input.receipts_text === undefined) {
    return serializeReceipts(input.receipts);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.receipts_text);
  } catch (error) {
    throw new Error(`receipts_text is not valid JSON: ${(error as Error).message}`);
  }
  if (JSON.stringify(parsed) !== JSON.stringify(input.receipts)) {
    throw new Error("receipts_text does not parse to the provided receipts (provenance guard).");
  }
  // Soundness of verbatim preservation: validation runs on the PARSED object, but we write
  // the RAW bytes. JSON.parse keeps only the last of duplicate keys, so a discarded
  // duplicate branch (e.g. an early `constraints` carrying plaintext goal/intent, followed
  // by a clean one) is invisible to assertExternalScope/assertContentBlind yet survives in
  // the bytes. Reject any duplicate key so the written bytes contain nothing the validators
  // did not see. (Whitespace/number-format differences carry no content and are allowed.)
  assertNoDuplicateKeys(input.receipts_text);
  return input.receipts_text;
}

/**
 * Reject JSON text that contains a duplicate key within any object. The input is already
 * known to be valid JSON (parsed above); this scan tracks the key set per object scope and
 * throws on the first repeat. Duplicate keys are the only way the written bytes can carry
 * content the parsed-object validators never saw, so a duplicate is a fail-closed reject.
 */
export function assertNoDuplicateKeys(text: string): void {
  type Frame = { object: boolean; keys: Set<string>; expectKey: boolean };
  const stack: Frame[] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < n) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      const top = stack[stack.length - 1];
      if (top?.object && top.expectKey) {
        const key = JSON.parse(text.slice(start, i)) as string;
        if (top.keys.has(key)) {
          throw new Error(
            `receipts_text contains a duplicate JSON key "${key}"; refusing (a discarded duplicate branch could carry hidden plaintext).`
          );
        }
        top.keys.add(key);
        top.expectKey = false;
      }
      continue;
    }
    if (ch === "{") {
      stack.push({ object: true, keys: new Set(), expectKey: true });
    } else if (ch === "[") {
      stack.push({ object: false, keys: new Set(), expectKey: false });
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    } else if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top?.object) top.expectKey = true;
    }
    // ':' , whitespace, numbers, and literals carry no key; skip.
    i += 1;
  }
}

function toLinks(receipts: ProofReceipt[]): LoopChainLink[] {
  return receipts.map((r, i) => {
    if (typeof r.receipt_id !== "string") {
      throw new Error(`Receipt ${describe(r, i)} is missing a string receipt_id.`);
    }
    return {
      receipt_id: r.receipt_id,
      loop: (r.constraints?.loop as LoopChainLink["loop"]) ?? null,
      loop_close: (r.constraints?.loop_close as LoopChainLink["loop_close"]) ?? null
    };
  });
}

function firstLoopId(links: LoopChainLink[]): string | null {
  for (const link of links) {
    const id = link.loop?.loop_id ?? link.loop_close?.loop_id;
    if (typeof id === "string") return id;
  }
  return null;
}

function terminalActionCount(receipts: ProofReceipt[]): number {
  for (const r of receipts) {
    const close = r.constraints?.loop_close as { action_count?: unknown } | undefined;
    if (close && typeof close.action_count === "number") return close.action_count;
  }
  return Math.max(0, receipts.length - 1);
}

function describe(r: ProofReceipt, i: number): string {
  return typeof r.receipt_id === "string" ? `"${r.receipt_id}"` : `at index ${i}`;
}
