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
  assertScopeCapsuleStructuralOnly,
  projectScopeCapsuleForExport,
  type ScopeCapsuleExport,
  type ScopePrivacyMode,
  type SealedScope
} from "./scope-capsule.js";
import { projectScopeEvent, type ScopeEvent } from "./scope-event-recorder.js";
import {
  projectContinuationProofMode,
  type ContinuationCapsule
} from "./continuation-capsule.js";

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
    continuation: ContinuationCapsule;
    scope_events?: ScopeEvent[];
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

  if (input.capsule) {
    const mode = input.capsule.mode;
    const sealed = input.capsule.sealed_scope;
    const continuation = input.capsule.continuation;

    // FAIL CLOSED (identity binding): the sealed scope + continuation must belong to the SAME loop
    // as the receipt chain. A stale dump_scope/continuation from another loop must never be
    // packaged onto these receipts (the cold verifier only checks receipts.json, so a mislabeled
    // pack would otherwise claim an unrelated scope for this chain).
    const mismatches: string[] = [];
    if (sealed.structural.loop_id !== loop.loop_id) {
      mismatches.push(`sealed scope loop_id ${sealed.structural.loop_id} != receipts loop_id ${loop.loop_id}`);
    }
    if (sealed.structural.goal_hash !== loop.goal_hash) {
      mismatches.push(`sealed scope goal_hash != receipts goal_hash`);
    }
    if (continuation.loop_id !== loop.loop_id) {
      mismatches.push(`continuation loop_id ${continuation.loop_id} != receipts loop_id ${loop.loop_id}`);
    }
    if (continuation.goal_hash !== loop.goal_hash) {
      mismatches.push(`continuation goal_hash != receipts goal_hash`);
    }
    if (continuation.scope_ref !== sealed.scope_ref) {
      mismatches.push(`continuation scope_ref != sealed scope_ref`);
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

    // FAIL CLOSED (mode contract): an export mode must never be MORE permissive than the sealed
    // scope declared. A Proof-Mode-sealed scope can never be exported in Verified Context Mode —
    // that would emit the plaintext sidecar a content-blind scope forbade (an operator --mode typo
    // must not turn a content-blind pack into a plaintext one). Downgrading a VC scope to a Proof
    // pack is always safe (strictly more restrictive) and remains allowed.
    if (mode === "verified_context" && sealed.structural.privacy_mode === "proof") {
      throw new Error(
        "Cannot export a Proof-Mode-sealed scope in Verified Context Mode; the sealed scope " +
          "declared content-blind (proof) and must not emit a plaintext sidecar (fail closed)."
      );
    }

    scope_capsule = projectScopeCapsuleForExport(sealed, mode);
    continuation_capsule =
      mode === "verified_context" ? continuation : projectContinuationProofMode(continuation);
    scope_events = (input.capsule.scope_events ?? []).map((e) => projectScopeEvent(e, mode));

    // Proof Mode is content-blind: the scope-capsule.json must be structural-only. Fail closed.
    if (mode === "proof") {
      assertScopeCapsuleStructuralOnly(scope_capsule);
    }

    bundle.capsule = {
      mode,
      scope_ref: sealed.scope_ref,
      scope_capsule_file: "scope-capsule.json",
      continuation_capsule_file: "continuation-capsule.json",
      scope_events: {
        count: scope_events.length,
        event_hashes: scope_events.map((e) => e.event_hash)
      }
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
    verify_instructions_markdown
  };
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
