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
  deriveInheritsStateHash,
  deriveScopeRef,
  deriveSidecarHash,
  hashTarget,
  projectScopeCapsuleForExport,
  type ScopeCapsuleExport,
  type ScopeInheritsLoop,
  type ScopePrivacyMode,
  type SealedScope
} from "./scope-capsule.js";
import { deriveScopeEventHash, projectScopeEvent, type ScopeEvent } from "./scope-event-recorder.js";
import {
  buildContinuationPrompt,
  diffStructural,
  projectContinuationProofMode,
  type ContinuationCapsule,
  type ContinuationJudgmentSection
} from "./continuation-capsule.js";
import { renderHandoffMarkdown } from "./handoff.js";
import {
  JUDGMENT_LEDGER_VERSION,
  projectTurn,
  renderJudgmentLedgerMarkdown,
  validateJudgmentChain,
  type JudgmentDelta,
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
  /** The next-agent handoff artifact (THE HANDOFF face of the capsule trio). */
  handoff_file: "HANDOFF.md";
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
    /**
     * Capsule Gate 2 lineage passthrough (ADDITIVE, Verified Context only): the PRIOR loop's
     * settled/open/next/changed, folded into the reduced state BEFORE this loop's turn deltas so the
     * continuation / memory seed carry the inherited state extended by this loop. The supplied
     * continuation MUST already be folded over the same seed (the export re-folds and binds the
     * continuation's plaintext to it). Proof Mode ignores it (content-blind).
     *
     * BINDING REQUIRED: a state-bearing seed is published ONLY when `prior_continuation` is also
     * supplied and binds — the prior capsule's recomputed capsule_ref must equal the sealed
     * inherits_loop.capsule_ref and the seed must equal the prior capsule's verified state (fail
     * closed otherwise). Omit both for a non-inheriting loop — output is then byte-for-byte unchanged.
     */
    inherited_state?: JudgmentDelta;
    /**
     * The PRIOR loop's continuation capsule (its pack's continuation-capsule.json). Identity-bound
     * to the sealed inherits_loop edge: recomputed capsule_ref, scope_ref, and final_turn_ref must
     * all equal the sealed triple (fail closed). In Verified Context Mode a state-bearing
     * inherited_state must equal this capsule's settled/open/next/changed — the seed is never
     * trusted bare.
     */
    prior_continuation?: ContinuationCapsule;
    /**
     * The PRIOR loop's ordered judgment turns (its pack's judgment-ledger.json `turns`). REQUIRED
     * for a state-bearing Verified Context seed: the prior ledger is chain-validated and RE-FOLDED
     * with the same reducer semantics, and BOTH the seed AND the prior continuation's plaintext must
     * equal that re-fold — so the value binding is never the continuation sidecar compared to itself
     * (fail closed on any mismatch). The re-folded chain's final_turn_ref must also equal the sealed
     * edge's final_turn_ref.
     */
    prior_judgment_turns?: JudgmentTurn[];
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
  handoff_markdown?: string;
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
      reproduce: "npx -y lyhna-verify --chain receipts.json"
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
  let handoff_markdown: string | undefined;
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

    // FAIL CLOSED (lineage immutability backstop): the cross-loop `inherits_loop` edge is open-time,
    // immutable provenance. The amendment boundary (amendScope) already rejects any change, but the
    // export reads scope material from JSON and could be handed an imported/tampered history. The
    // public `scope-capsule.json` is projected from `finalScope`, while the continuation / HANDOFF /
    // memory seed claim the ORIGINAL's edge — so EVERY verified history version (especially
    // finalScope) must carry the byte-identical edge sealed in the original, else the final capsule
    // would omit or contradict the edge the rest of the pack publishes. (No scope-history artifact is
    // added; finalScope's capsule itself substantiates the edge.)
    const originalEdge = canonicalScopeJson(original.structural.inherits_loop ?? null);
    const originalStateHash = original.structural.inherits_state_hash ?? null;
    for (const entry of history) {
      if (canonicalScopeJson(entry.structural.inherits_loop ?? null) !== originalEdge) {
        throw new Error(
          `Scope version ${entry.scope_ref} carries a different inherits_loop than the original; the ` +
            `cross-loop lineage edge is immutable across amendments and the final scope capsule must ` +
            `substantiate it (fail closed).`
        );
      }
      if ((entry.structural.inherits_state_hash ?? null) !== originalStateHash) {
        throw new Error(
          `Scope version ${entry.scope_ref} carries a different inherits_state_hash than the original; ` +
            `the inherited-state commitment is immutable across amendments (fail closed).`
        );
      }
    }

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
    // The cross-loop edge the continuation publishes must be EXACTLY the one sealed into the
    // VERIFIED original scope's structural projection (hash-validated above) — PRESENT IFF SEALED
    // (compared by key presence, so a JSON-loaded `inherits_loop: null` is a malformed PRESENT
    // value, not "absent" — a VC export emits the continuation verbatim and must never publish a
    // null edge), and equal member-by-member. A stale/tampered continuation could otherwise claim
    // a false prior loop (or hide a declared one) while scope-capsule.json carries the truth.
    const contEdge = (continuation as Record<string, unknown>).inherits_loop;
    const sealedEdge = original.structural.inherits_loop;
    if (contEdge !== undefined || sealedEdge !== undefined) {
      if (
        contEdge === undefined ||
        sealedEdge === undefined ||
        canonicalScopeJson(contEdge) !== canonicalScopeJson(sealedEdge)
      ) {
        mismatches.push(`continuation inherits_loop != the edge sealed into the original scope (present iff sealed, exact triple)`);
      }
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
    // Count in-loop receipts that carry a signed scope stamp citing a presented scope version. A
    // stateful lineage claim (below) requires at least one — otherwise this loop's commitment-bearing
    // scope_ref is stamped into NO signed receipt and the "bound to the signed chain" claim is vacuous.
    let inLoopScopeStamps = 0;
    // Of those, how many stamp the FINAL scope_ref specifically. A stateful lineage commitment is
    // sealed into the final scope_ref, so the binding "commitment is bound to the signed chain" holds
    // only when a signed in-loop receipt stamps the FINAL version — not merely some earlier amendment
    // version. (A pack whose final scope_ref is unstamped because a TRAILING amendment followed the
    // last governed action fails closed here, at the amendment boundary, so it can never be produced;
    // the offline two-pack checker enforces the same rule read-side.)
    let finalScopeStamps = 0;
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
        if (isInLoop) {
          inLoopScopeStamps += 1;
          if (sref === finalScope.scope_ref) finalScopeStamps += 1;
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

    // FAIL CLOSED (stateful lineage must be chain-stamped on the FINAL scope_ref): a sealed
    // inherits_state_hash is committed into the FINAL scope_ref, so "the inherited state is bound to
    // the signed chain" holds only when a signed in-loop receipt stamps THAT final scope_ref. Two
    // ways this fails:
    //   (1) no in-loop scope stamp at all (only the exempt terminal loop_close) — a caller could pair
    //       a genuine terminal chain with a rewritten sealed scope/continuation pointing at an
    //       arbitrary prior pack; OR
    //   (2) the only in-loop stamps cite an EARLIER amendment version because a TRAILING amendment
    //       followed the last governed action, leaving the final scope_ref unstamped.
    // Both are refused HERE, at the amendment boundary, so a pack the offline two-pack checker would
    // reject (it enforces the same final-scope_ref stamp rule, and packs ship no scope-history to
    // re-derive earlier versions) can never be produced in the first place.
    //
    // MODE-AGNOSTIC (architect ruling): the guard's predicate is the COMMITMENT's presence, not the
    // privacy mode. inherits_state_hash seals into the final scope_ref in BOTH modes; a lineage claim
    // no signed receipt stamps is equally vacuous in either, and the offline checker enforces the
    // final-scope_ref stamp mode-agnostically. Proof Mode only removes plaintext STATE — it does NOT
    // exempt a stateful lineage commitment. Gating this on verified_context would let Proof Mode
    // produce the exact shape the checker rejects.
    if (original.structural.inherits_state_hash !== undefined && finalScopeStamps === 0) {
      const trailingAmendment = inLoopScopeStamps > 0;
      throw new Error(
        `This export seals a stateful lineage commitment (inherits_state_hash) bound to the signed chain, but ` +
          `no signed in-loop receipt stamps the FINAL scope_ref ${finalScope.scope_ref}` +
          (trailingAmendment
            ? ` — the final scope version was produced by a TRAILING amendment after the last governed action, so ` +
              `the commitment is anchored to no signature. Remedy: perform a governed action AFTER the amendment ` +
              `(so a signed receipt stamps the final scope_ref) before close, avoid amending after the last action, ` +
              `or remove the stateful inheritance claim (inherits_state_hash); then re-export (fail closed).`
            : ` — only the exempt terminal loop_close is present (no governed in-loop action), so the commitment is ` +
              `anchored to no signature. Remedy: perform a governed action before close so a signed receipt stamps ` +
              `the final scope_ref, or remove the stateful inheritance claim (inherits_state_hash); then re-export ` +
              `(fail closed).`)
      );
    }

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
    // FAIL CLOSED (no unverified lineage claim): a sealed inherits_state_hash claims committed
    // inherited state, which only the judgment path can verify (prior pack + ledger re-fold +
    // commitment hash, inside buildJudgmentArtifacts). A Verified Context Gate 1 export (no
    // judgment_turns) would skip that binding entirely while still publishing the commitment as if
    // verified. Refuse the contradictory shape. (A Proof Mode Gate 1 export remains valid: it
    // publishes no state and its verify instructions claim no state verification — the commitment
    // is sealed, content-blind, and checked by VC exports / the Stage E two-pack check.)
    if (mode === "verified_context" && original.structural.inherits_state_hash !== undefined && !input.capsule.judgment_turns) {
      throw new Error(
        `Verified Context export: the sealed scope commits inherited state (inherits_state_hash) but no ` +
          `judgment ledger was supplied, so the lineage binding cannot run; refusing to emit a pack that ` +
          `claims verified inherited state it never verified (fail closed).`
      );
    }

    if (input.capsule.judgment_turns) {
      const built = buildJudgmentArtifacts({
        loop_id: loop.loop_id,
        scope_ref: finalScope.scope_ref,
        mode,
        receipts: input.receipts,
        scope_events: input.capsule.scope_events ?? [],
        turns: input.capsule.judgment_turns,
        continuation,
        // Cross-loop edge from the VERIFIED original scope (hash-validated above), never the
        // unsigned continuation — the memory seed carries only verified refs.
        inherits_loop: original.structural.inherits_loop,
        // The SEALED inherited-state commitment: the supplied prior state must hash to it.
        inherits_state_hash: original.structural.inherits_state_hash,
        // Lineage passthrough: the prior loop's inherited state, folded before this loop's deltas.
        inherited_state: input.capsule.inherited_state,
        // The prior loop's continuation, identity-bound to the sealed edge before any state folds.
        prior_continuation: input.capsule.prior_continuation,
        // The prior loop's ledger turns: the seed's value binding re-folds these (never sidecar-vs-itself).
        prior_judgment_turns: input.capsule.prior_judgment_turns
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
      handoff_file: "HANDOFF.md",
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
    // THE HANDOFF renders from the PROJECTED continuation (mode-appropriate), so a Proof Mode
    // handoff is structural-only by construction — it never sees the plaintext sidecar.
    handoff_markdown = renderHandoffMarkdown(continuation_capsule);
    verify_instructions_markdown = renderVerifyInstructionsMarkdown(bundle, scope_capsule);
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
    handoff_markdown,
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
  /** Cross-loop edge from the VERIFIED original sealed scope (structural refs; both modes). */
  inherits_loop?: ScopeInheritsLoop;
  /** SEALED inherited-state commitment from the verified original scope (sha256 over prior state). */
  inherits_state_hash?: string;
  /** Lineage passthrough seed (Verified Context only): the prior loop's settled/open/next/changed. */
  inherited_state?: JudgmentDelta;
  /** The prior loop's continuation capsule — identity-bound to the sealed edge (fail closed). */
  prior_continuation?: ContinuationCapsule;
  /** The prior loop's judgment turns — re-folded to bind the seed's VALUES (fail closed). */
  prior_judgment_turns?: JudgmentTurn[];
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
    // The signed stamp also carries the authoritative scope_ref (the scope VERSION this step ran
    // under); bind it so a tampered ledger cannot recompute turn_ref under a different scope version
    // and have the reduced `scope_refs` misreport which version actually authorized the move.
    const sScopeRef = typeof r.scope.scope_ref === "string" ? r.scope.scope_ref : undefined;
    if (t.scope_ref !== sScopeRef) {
      throw new Error(
        `Bind judgment turn ${t.turn_index} cites scope_ref ${JSON.stringify(t.scope_ref)} but the signed ` +
          `constraints.scope stamp on receipt ${r.id} cites ${JSON.stringify(sScopeRef)} (fail closed).`
      );
    }
    // For multi-target tools the signed stamp carries the authoritative per-target hash list
    // (`target_descriptors`), which is ALSO part of the turn's proposed move (and thus turn_ref).
    // Bind it canonically (order-independent) so a tampered ledger cannot alter the individual target
    // hashes for the authorized move while the receipt proves a different list. Both absent is a match.
    const canonTargets = (v: unknown): string | undefined =>
      Array.isArray(v) ? JSON.stringify([...(v as unknown[])].map((x) => String(x)).sort()) : undefined;
    if (canonTargets(r.scope.target_descriptors) !== canonTargets(t.proposed.target_descriptors)) {
      throw new Error(
        `Bind judgment turn ${t.turn_index} proposed target_descriptors do not match the signed constraints.scope ` +
          `stamp's per-target hash list on receipt ${r.id} (fail closed).`
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
    // The event_hash also commits the event's scope_ref (the scope VERSION the refusal happened
    // under). Bind it so a tampered ledger cannot keep the real event hash while altering the turn's
    // scope_ref to publish the refusal under a false scope version.
    if (t.scope_ref !== event.scope_ref) {
      throw new Error(
        `Judgment turn ${t.turn_index} cites scope_ref ${JSON.stringify(t.scope_ref)} but attested scope event ${h} ` +
          `commits scope_ref ${JSON.stringify(event.scope_ref)} (fail closed).`
      );
    }
    anchoredEvents.add(h);
  }
  for (const h of eventHashes) {
    if (!anchoredEvents.has(h)) {
      throw new Error(`Attested scope event ${h} has no matching judgment turn (fail closed).`);
    }
  }

  // 4) Runtime reports exist on EXACTLY the FORWARDED calls — i.e. every APPROVED bind turn, and
  // nothing else (decideForward forwards on APPROVED only):
  //   - REQUIRED on every APPROVED bind turn. Runtime hashing is TOTAL at the adapter (cycles,
  //     BigInt, Errors, etc. reduce to a deterministic tagged form), so "runtime outputs/errors are
  //     hashed but not interpreted" is unconditional — a forwarded turn with no runtime_report is a
  //     stale/tampered ledger, not an accepted gap (fail closed).
  //   - FORBIDDEN anywhere else. Since runtime_report is excluded from turn_ref, a tampered ledger
  //     could otherwise bolt a result/error hash onto a REFUSED / ESCALATED / scope-gate /
  //     loop-bound turn and have the reducer publish a runtime result that never happened.
  //   - Shape-bound: `returned` is a boolean and EXACTLY the hash matching `returned` is present
  //     (returned=true => result_hash only; false => error_hash only), sha256-shaped.
  for (const t of turns) {
    const rr = t.runtime_report;
    if (!rr) {
      if (t.verdict.source === "bind" && t.verdict.kind === "APPROVED") {
        throw new Error(
          `Judgment turn ${t.turn_index} is an APPROVED (forwarded) bind turn but carries no runtime_report; ` +
            `every forwarded call must anchor its hashed runtime result/error (fail closed).`
        );
      }
      continue;
    }
    if (t.verdict.source !== "bind" || t.verdict.kind !== "APPROVED") {
      throw new Error(
        `Judgment turn ${t.turn_index} carries a runtime_report but is not an APPROVED bind turn; only a forwarded ` +
          `call returns a runtime result/error (fail closed).`
      );
    }
    if (typeof rr.returned !== "boolean") {
      throw new Error(`Judgment turn ${t.turn_index} runtime_report.returned must be a boolean (fail closed).`);
    }
    if (rr.returned) {
      if (typeof rr.result_hash !== "string" || !RUNTIME_HASH.test(rr.result_hash)) {
        throw new Error(`Judgment turn ${t.turn_index} runtime_report returned=true requires a structural result_hash (fail closed).`);
      }
      if (rr.error_hash !== undefined) {
        throw new Error(`Judgment turn ${t.turn_index} runtime_report returned=true must not carry an error_hash (fail closed).`);
      }
    } else {
      if (typeof rr.error_hash !== "string" || !RUNTIME_HASH.test(rr.error_hash)) {
        throw new Error(`Judgment turn ${t.turn_index} runtime_report returned=false requires a structural error_hash (fail closed).`);
      }
      if (rr.result_hash !== undefined) {
        throw new Error(`Judgment turn ${t.turn_index} runtime_report returned=false must not carry a result_hash (fail closed).`);
      }
    }
  }

  // FAIL CLOSED (anchored + BOUND lineage): inherited lineage state may be folded ONLY when
  //   (a) this pack carries a sealed `inherits_loop` edge proving WHICH prior capsule it came from, AND
  //   (b) the PRIOR loop's continuation capsule is supplied and binds to that edge, AND
  //   (c) the seed EQUALS the prior capsule's verified settled/open/next/changed.
  // The edge alone proves only which capsule was referenced — not that the inherited VALUES came from
  // it. Without (b)+(c), a caller could pass arbitrary "prior" plaintext plus a continuation folded
  // over the same forged seed and the export would publish it as verified memory. Proof Mode folds no
  // seed at all (content-blind), so the state checks bite only the mode that publishes the state.
  const seed = input.inherited_state;
  const seedHasState =
    !!seed && [seed.settled, seed.open_questions, seed.next_actions, seed.changed].some((a) => Array.isArray(a) && a.length > 0);
  // A Verified Context pack makes a LINEAGE-STATE claim when it folds a state-bearing seed OR when
  // its sealed scope carries an inherits_state_hash commitment — a sealed commitment that is never
  // verified (e.g. an empty-folding prior, or no prior supplied) would let an arbitrary/stale
  // commitment ride in scope-capsule.json as if verified. Either trigger demands the full binding.
  const lineageStateClaim = mode === "verified_context" && (seedHasState || input.inherits_state_hash !== undefined);
  if (lineageStateClaim) {
    if (!input.inherits_loop) {
      throw new Error(
        `Verified Context export supplies inherited lineage state but the verified original scope carries ` +
          `no sealed inherits_loop edge; refusing to publish prior-loop state with unanchored lineage (fail closed).`
      );
    }
    if (!input.prior_continuation) {
      throw new Error(
        `Verified Context export claims inherited lineage state (a state-bearing seed and/or a sealed ` +
          `inherits_state_hash commitment) but no prior_continuation to verify it against — supply the prior ` +
          `pack's continuation-capsule.json (fail closed).`
      );
    }
    if (!input.prior_judgment_turns) {
      throw new Error(
        `Verified Context export claims inherited lineage state but no prior judgment ledger to re-fold; ` +
          `the values bind to the prior ledger's re-folded reduction, never to the continuation sidecar ` +
          `compared to itself — supply the prior pack's judgment-ledger.json (fail closed).`
      );
    }
    if (!input.inherits_state_hash) {
      throw new Error(
        `Verified Context export supplies inherited lineage state but the sealed scope carries no ` +
          `inherits_state_hash commitment; without it the inherited values are not bound to the signed ` +
          `chain — no commitment means identity-only inheritance (edge without state). Fail closed.`
      );
    }
  }
  if (input.prior_continuation) {
    const edge = input.inherits_loop;
    if (!edge) {
      throw new Error(
        `A prior_continuation was supplied but the verified original scope seals no inherits_loop edge; ` +
          `nothing anchors which prior capsule this loop opened from (fail closed).`
      );
    }
    // Identity binding: the prior capsule's content-blind identity (recomputed, mode-independent),
    // final scope_ref, and final judgment turn must all equal the SEALED edge triple.
    const recomputedRef = deriveContinuationRef(input.prior_continuation);
    if (recomputedRef !== edge.capsule_ref) {
      throw new Error(
        `Prior continuation capsule_ref ${recomputedRef} does not match the sealed inherits_loop.capsule_ref ` +
          `${edge.capsule_ref}; the supplied prior capsule is not the one this loop opened from (fail closed).`
      );
    }
    if (input.prior_continuation.scope_ref !== edge.scope_ref) {
      throw new Error(`Prior continuation scope_ref does not match the sealed inherits_loop.scope_ref (fail closed).`);
    }
    if ((input.prior_continuation.final_turn_ref ?? null) !== edge.final_turn_ref) {
      throw new Error(`Prior continuation final_turn_ref does not match the sealed inherits_loop.final_turn_ref (fail closed).`);
    }
    // Value binding (Verified Context, state-bearing seed only) — TWO layers:
    //
    //   1) SEALED COMMITMENT (the cryptographic anchor): the supplied prior state must hash
    //      (deriveInheritsStateHash) to the `inherits_state_hash` SEALED into this loop's original
    //      scope at open. scope_ref is stamped into the signed receipt chain, so forging inherited
    //      memory requires forging the signed chain. What remains outside the proof is supervisor
    //      honesty at open — the system's trust root by design.
    //   2) NON-CIRCULAR CONSISTENCY: the prior pack's judgment-ledger.json turns are chain-validated
    //      (every turn_ref recomputes) and RE-FOLDED with the same reducer semantics; then THREE
    //      things must agree exactly: re-fold(prior turns) == prior continuation plaintext == seed,
    //      and the re-folded chain's final_turn_ref must equal the sealed edge's — so the supplied
    //      ledger IS the chain the edge pinned and the two prior sidecars agree with each other.
    //
    // CHAINED-PRIOR LIMITATION (fail closed, not silent): a prior loop that ITSELF inherited state
    // folded its own seed before its deltas, so re-folding its ledger ALONE cannot reproduce its
    // continuation plaintext. Verifying such a prior would require ITS prior pack too; until a
    // pack-chain input exists, a multi-hop inheritance export refuses here rather than publish a
    // prefix nothing supplied can verify.
    // Runs for EVERY lineage-state claim — including a sealed commitment over an EMPTY prior state
    // (the empty fold must still hash to the sealed commitment; a stale/arbitrary commitment may
    // never ride out unverified just because the prior happens to fold empty).
    if (lineageStateClaim) {
      const p = input.prior_continuation;
      const priorTurns = input.prior_judgment_turns!;
      // Re-fold the prior ledger (validates the chain fail-closed: contiguity, hash links, anchors).
      const priorFold = reduceJudgmentLedger({
        loop_id: p.loop_id,
        scope_ref: p.scope_ref,
        turns: priorTurns,
        mode: "verified_context"
      });
      if ((priorFold.final_turn_ref ?? null) !== edge.final_turn_ref) {
        throw new Error(
          `Prior judgment ledger re-folds to final_turn_ref ${priorFold.final_turn_ref ?? "null"} but the sealed ` +
            `inherits_loop.final_turn_ref is ${edge.final_turn_ref}; the supplied ledger is not the chain the ` +
            `edge pinned (fail closed).`
        );
      }
      const plainState = (s: { settled?: string[]; open_questions?: string[]; next_actions?: string[]; changed?: string[] }) => ({
        settled: s.settled ?? [],
        open_questions: s.open_questions ?? [],
        next_actions: s.next_actions ?? [],
        changed: s.changed ?? []
      });
      const foldState = canonicalScopeJson(plainState(priorFold));
      if (canonicalScopeJson(plainState(p)) !== foldState) {
        throw new Error(
          `Prior continuation plaintext does not equal the re-fold of the prior judgment ledger; the prior ` +
            `pack's continuation-capsule.json and judgment-ledger.json disagree (tampered or stale — fail closed).`
        );
      }
      if (canonicalScopeJson(plainState(seed ?? {})) !== foldState) {
        throw new Error(
          `Inherited state does not equal the prior capsule's verified state (the re-folded prior judgment ` +
            `ledger); the seed must be exactly the referenced prior capsule's state (fail closed).`
        );
      }
      // Layer 1 — the SEALED commitment: the supplied prior state must hash to the inherits_state_hash
      // sealed into this loop's scope_ref (and thus stamped into the signed receipt chain). A consistent
      // edit of BOTH prior sidecars passes layer 2 but cannot match the sealed commitment.
      const suppliedStateHash = deriveInheritsStateHash(plainState(p));
      if (suppliedStateHash !== input.inherits_state_hash) {
        throw new Error(
          `Supplied prior state hashes to ${suppliedStateHash} but the SEALED inherits_state_hash commitment ` +
            `is ${input.inherits_state_hash}; the inherited values are not the ones committed at open — bound ` +
            `to the signed chain via scope_ref (fail closed).`
        );
      }
    }
  }

  // 5) Fold + project under the privacy mode. The lineage seed (prior loop's inherited state) is
  // folded BEFORE this loop's deltas (Verified Context only; Proof Mode ignores it — content-blind).
  const reduced = reduceJudgmentLedger({ loop_id, scope_ref, turns, mode, seed });
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

  // FAIL CLOSED (plaintext sidecar binding, Verified Context judgment packs only): the structural
  // check above does not cover the PLAINTEXT the continuation carries, yet HANDOFF.md, the proof
  // card, and `lyhna-mcp handoff` render that plaintext (settled / open / next / changed /
  // continuation_prompt) verbatim. A stale or tampered continuation could therefore tell the next
  // agent false state while judgment-ledger.json holds the real supervisor-declared deltas. Bind
  // every plaintext field to the VERIFIED reduced fold, and the prompt to a rebuild from verified
  // values — equal or refused. (Proof Mode projects all of these away; nothing to bind.)
  if (mode === "verified_context") {
    const bindPlain = (name: string, got: string[] | undefined, want: string[] | undefined): void => {
      if (canonicalScopeJson(got ?? []) !== canonicalScopeJson(want ?? [])) {
        throw new Error(
          `Continuation plaintext "${name}" does not match the verified judgment fold; the handoff/proof card ` +
            `would publish unverified plaintext state (fail closed).`
        );
      }
    };
    bindPlain("settled", continuation.settled, reduced.settled);
    bindPlain("open_questions", continuation.open_questions, reduced.open_questions);
    bindPlain("next_actions", continuation.next_actions, reduced.next_actions);
    bindPlain("changed", continuation.changed, reduced.changed);
    const expectedPrompt = buildContinuationPrompt({
      loop_id,
      scope_ref,
      final_turn_ref: reduced.final_turn_ref,
      settled: reduced.settled,
      open_questions: reduced.open_questions,
      next_actions: reduced.next_actions
    });
    if (continuation.continuation_prompt !== expectedPrompt) {
      throw new Error(
        `Continuation continuation_prompt does not match the prompt rebuilt from the verified judgment fold; ` +
          `the handoff would carry an unverified prompt (fail closed).`
      );
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
  const memory = buildMemoryInjection({ loop_id, capsule_ref, scope_ref, reduced, inherits_loop: input.inherits_loop });
  return { ledger, markdown, memory };
}

/** Content-blind, mode-independent identity of a continuation capsule (over its structural projection). */
export function deriveContinuationRef(continuation: ContinuationCapsule): string {
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

/** Display-only short form of a long ref/hash (the full value stays in the pack's JSON artifacts). */
function shortRef(value: string): string {
  const sep = value.lastIndexOf(":");
  if (sep !== -1 && value.length - sep > 17) {
    return `${value.slice(0, sep + 1)}${value.slice(sep + 1, sep + 9)}…`;
  }
  return value.length > 24 ? `${value.slice(0, 16)}…` : value;
}

/**
 * proof-card.md — THE CARD: the human-facing face of the capsule, sized and shaped to paste
 * directly into a GitHub PR comment or a Slack thread. Verdict summary first, refused/attested
 * steps prominent, the verify one-liner at the bottom. Content-blind in Proof Mode: it carries
 * goal_hash / scope_ref / structural counts / attested hashes — never the plaintext goal or plan
 * (the Verified Context card may additionally carry the supervisor-declared settled/open/next).
 *
 * Every claim on the card is backed by the pack it ships in: the verdict counts and refused
 * steps render from the continuation's judgment section, which buildLoopProofBundle has already
 * proven equal to the verified reduced fold (fail closed) before this renderer runs.
 */
export function renderProofCardMarkdown(
  bundle: LoopProofBundle,
  continuation: ContinuationCapsule
): string {
  const cap = bundle.capsule;
  const j = continuation.judgment;
  const sealedBadge = bundle.loop.sealed ? "✅ SEALED" : "⚠️ UNSEALED";

  // Scannable verdict summary line. With a judgment ledger the verified verdict counts lead;
  // without one (a Gate 1 pack) fall back to the structural action/refusal counts.
  const summary = j
    ? `**${j.verdict_counts.APPROVED} approved · ${j.verdict_counts.REFUSED} refused · ` +
      `${j.verdict_counts.ESCALATED} escalated** — ${j.turn_count} judgment turn(s), every verdict ` +
      `anchored to a signed receipt or an attested scope event.`
    : `**${bundle.loop.action_count} action(s) ran in-lane · ${cap?.scope_events.count ?? 0} attested ` +
      `scope event(s)** under a sealed scope capsule.`;

  const lines = [
    `# Lyhna Proof Card — ${sealedBadge}`,
    ``,
    summary,
    ``,
    `| | |`,
    `| --- | --- |`,
    `| loop | \`${bundle.loop.loop_id}\` |`,
    `| outcome | **${bundle.loop.sealed ? "SEALED ✓" : "UNSEALED ✗"}** — ${bundle.loop.action_count} action(s), ${bundle.loop.receipt_count} signed receipt(s) |`,
    `| scope | \`${cap ? shortRef(cap.scope_ref) : "—"}\` · ${continuation.what_changed.length} amendment(s) |`,
    ...(j
      ? [
          `| judgment ledger | ${j.turn_count} turn(s) · final \`${j.final_turn_ref ? shortRef(j.final_turn_ref) : "—"}\` |`
        ]
      : []),
    `| signer | \`${bundle.trust_root.key_id}\` |`,
    `| mode | \`${cap?.mode ?? "—"}\` |`,
    ``
  ];

  // Refused / attested steps — the load-bearing section. The agent cannot author or omit these:
  // each is committed by an attested scope event or a signed REFUSED receipt in the pack.
  const refused = j?.refused_steps ?? [];
  if (refused.length > 0) {
    lines.push(
      `## ⛔ Refused — and attested`,
      ``,
      `The gate stopped these steps before execution. Each one is committed by hash in the`,
      `verified chain — the run cannot report itself clean:`,
      ``
    );
    for (const s of refused) {
      const anchor = s.scope_event_hash
        ? `attested event \`${shortRef(s.scope_event_hash)}\``
        : s.receipt_id
          ? `signed receipt \`${s.receipt_id}\``
          : `—`;
      lines.push(
        `- **Turn ${s.turn_index} — ${s.kind}** (${s.source}${s.reason_code ? `, rule \`${s.reason_code}\`` : ""}) — ` +
          `${s.corrected ? "corrected by a later approved step" : "not corrected"} · ${anchor}`
      );
    }
    lines.push(``);
  } else if ((cap?.scope_events.count ?? 0) > 0) {
    lines.push(`## ⛔ Attested scope refusals / escalations`, ``);
    for (const e of continuation.scope_events) {
      lines.push(`- **${e.decision}** ${e.event_type} (rule: \`${e.matched_rule ?? "—"}\`) — \`${shortRef(e.event_hash)}\``);
    }
    lines.push(``);
  }

  // Verified Context Mode only: the supervisor-declared state of the work. Proof Mode packs are
  // content-blind and never carry these fields (the export projection already stripped them).
  if (continuation.settled?.length || continuation.open_questions?.length || continuation.next_actions?.length || continuation.changed?.length) {
    lines.push(`## Where this run left the work`, ``);
    if (continuation.settled?.length) lines.push(`**Settled**`, ...continuation.settled.map((s) => `- ${s}`), ``);
    if (continuation.open_questions?.length) lines.push(`**Open**`, ...continuation.open_questions.map((s) => `- ${s}`), ``);
    if (continuation.next_actions?.length) lines.push(`**Next**`, ...continuation.next_actions.map((s) => `- ${s}`), ``);
    if (continuation.changed?.length) lines.push(`**Changed**`, ...continuation.changed.map((s) => `- ${s}`), ``);
  }

  lines.push(
    `## Verify it yourself`,
    ``,
    "```",
    `npx -y lyhna-verify --chain receipts.json`,
    "```",
    ``,
    `No Lyhna account, no network trust: the standalone verifier checks every Ed25519 signature`,
    `offline against the public key pinned in this pack. The sealed verdict above is advisory`,
    `until you re-run it.${j ? " Full turn-by-turn path: `judgment-ledger.md`." : ""} Next-agent handoff:`,
    `\`HANDOFF.md\`.`,
    ``,
    `<details>`,
    `<summary>Full identifiers (pinned key, digests, refs)</summary>`,
    ``,
    `| field | value |`,
    `| --- | --- |`,
    `| goal_hash | \`${bundle.loop.goal_hash}\` |`,
    `| scope_ref | \`${cap?.scope_ref ?? "—"}\` |`,
    ...(j ? [`| final_turn_ref | \`${j.final_turn_ref ?? "—"}\` |`] : []),
    `| trust_root.ed25519_public_key | \`${bundle.trust_root.ed25519_public_key}\` |`,
    `| content_digest | \`sha256:${bundle.export.content_digest.value}\` (over \`receipts.json\`) |`,
    ...(cap && cap.scope_events.count > 0
      ? cap.scope_events.event_hashes.map((h, i) => `| scope event ${i} | \`${h}\` |`)
      : []),
    ``,
    `</details>`,
    ``,
    `> Content-blind: this card carries \`goal_hash\` / \`scope_ref\` / hashes — never the`,
    `> plaintext goal or plan${cap?.mode === "verified_context" ? " (Verified Context Mode adds only the supervisor-declared sidecar)" : ""}.`,
    `> Verify instructions: \`verify-instructions.md\`.`,
    ``
  );
  return lines.join("\n");
}

/** verify-instructions.md — how to cold-verify the pack with the independent verifier. */
export function renderVerifyInstructionsMarkdown(bundle: LoopProofBundle, scope_capsule?: ScopeCapsuleExport): string {
  const lines = [
    `# Verify Instructions`,
    ``,
    `This proof pack is verified by the independent, trust-no-one \`lyhna-verify\`. The adapter's`,
    `embedded verdict is advisory; re-run the verifier to trust it.`,
    ``,
    `## 1. Cold-verify the signed receipt chain`,
    ``,
    `\`\`\``,
    `npx -y lyhna-verify --chain receipts.json --json`,
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
    // Cross-loop lineage guarantee — rendered only for an inheriting loop, stating EXACTLY what is
    // and is not proven (architect contract: the export must state the guarantee precisely).
    const lineage = scope_capsule?.structural.inherits_loop;
    if (lineage) {
      lines.push(
        `### Cross-loop lineage (what the inherited edge and state DO and DO NOT prove)`,
        ``,
        `- This loop opened FROM a prior capsule. The sealed \`inherits_loop\` triple in`,
        `  \`scope-capsule.json\` (capsule_ref \`${lineage.capsule_ref}\`, scope_ref, final_turn_ref) is`,
        `  hashed into \`scope_ref\`, which is stamped into the SIGNED receipt chain — the identity of`,
        `  the prior capsule is bound to the signatures.`,
        ...(scope_capsule?.structural.inherits_state_hash
          ? [
              `- The inherited settled/open/next/changed state is committed by the sealed`,
              `  \`inherits_state_hash\` (\`${scope_capsule.structural.inherits_state_hash}\`): sha256 over the`,
              `  prior continuation's canonical state, sealed into \`scope_ref\` at open.`,
              // The verification CLAIM must match what this export actually ran: only the Verified
              // Context judgment path executes the lineage binding. A Proof Mode pack publishes no
              // state and must not claim a verification it never performed.
              ...(bundle.capsule?.mode === "verified_context"
                ? [
                    `- THIS export verified it: the supplied prior state hashes to the sealed commitment, the`,
                    `  prior judgment ledger re-folds (chain-validated), and re-fold == prior continuation`,
                    `  plaintext == seed — so forging inherited memory requires forging the signed receipt chain.`
                  ]
                : [
                    `- This Proof Mode export publishes NO state and performed NO state verification; the`,
                    `  commitment is sealed (content-blind) and is verified by a Verified Context export of`,
                    `  this loop and by the Stage E two-pack check.`
                  ]),
              `- What remains OUTSIDE the proof: supervisor honesty at open (the supervisor read the genuine`,
              `  prior pack when sealing the commitment) — the system's trust root by design.`,
              `- KNOWN BOUNDARY (what this does NOT assert): the commitment is bound to the signed chain via the`,
              `  FINAL \`scope_ref\`, so a signed in-loop receipt must stamp that final version. A TRAILING`,
              `  amendment (amending the scope AFTER the last governed action) leaves the final \`scope_ref\``,
              `  unstamped; the pack ships no scope-history to re-derive earlier versions, so this is refused`,
              `  fail-closed at EXPORT and by the Stage E checker. Remedy: don't amend an inheriting loop after`,
              `  its last action, or perform a governed action after the amendment so a signed receipt stamps`,
              `  the final \`scope_ref\` before export.`
            ]
          : [
              `- No \`inherits_state_hash\` is sealed: this is IDENTITY-ONLY inheritance. The pack proves`,
              `  which prior capsule was referenced; it carries and proves NO inherited state values.`
            ]),
        `- Offline cross-check of the two packs together (digests + both signed chains) is the`,
        `  Stage E two-pack verification.`,
        ``
      );
    }
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
