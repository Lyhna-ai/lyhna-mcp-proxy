// push-pack — Supabase Destination Contract v1: structured ACCUMULATION of an exported pack.
//
// Reads a CLOSED, exported Gate-2 proof pack from disk, fail-closed-validates all ten required
// artifacts against each other (refs, digests, mode honesty, inheritance fields), builds ONE
// lyhna_loop_artifacts row, and drives an injected destination client through an idempotent
// insert + SEPARATE read-back + field compare. Proof export stays pure and composable: this
// module only ever READS a pack — it never builds one, and no destination is required to export.
// No artifact custody in this gate: receipts.json is required, digest-bound input but is NEVER
// uploaded (the row carries receipts_digest, not the chain).
//
// IDENTITY CONTRACT (architect ruling): capsule_ref is the row identity — the table carries
// unique(capsule_ref). Same capsule_ref + same receipts_digest => already_persisted (verify the
// EXISTING row, no second insert, exit 0). Same capsule_ref + DIFFERING receipts_digest => hard
// conflict, fail closed: two claims under one capsule_ref never coexist. bundle_digest does NOT
// participate in identity (exported_at varies across re-exports). There is no UPDATE and no
// DELETE path anywhere in this module.
//
// TRUST BOUNDARY (same wording contract as verify-cross-loop): this module NEVER verifies
// Ed25519 signatures. verification_status records push-pack's own structural/digest checks only;
// every report carries the signature notice and the lyhna-verify command to run.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ContinuationCapsule } from "./continuation-capsule.js";
import { renderHandoffMarkdown } from "./handoff.js";
import {
  deriveContinuationRef,
  renderProofCardMarkdown,
  renderVerifyInstructionsMarkdown,
  sha256Hex,
  type LoopProofBundle
} from "./loop-proof-bundle.js";
import {
  canonicalScopeJson,
  deriveScopeRef,
  type ScopeCapsuleExport,
  type ScopeStructuralProjection
} from "./scope-capsule.js";

/**
 * The ten required pack inputs (strict Gate-2 contract): legacy 4-artifact packs and
 * judgment-less Gate-1 packs fail closed — no backwards compatibility in v1.
 */
export const REQUIRED_PACK_FILES = [
  "receipts.json",
  "bundle.json",
  "graph-node.json",
  "scope-capsule.json",
  "continuation-capsule.json",
  "memory-injection.json",
  "judgment-ledger.json",
  "proof-card.md",
  "HANDOFF.md",
  "verify-instructions.md"
] as const;

export const PUSH_PACK_SIGNATURE_NOTICE =
  "Signature verification not performed here. Re-run lyhna-verify on the pack's receipts.json to trust signatures.";

/** The one row push-pack constructs. id / created_at are destination defaults, never sent. */
export type LoopArtifactRow = {
  loop_id: string;
  tenant_hash: string;
  scope_ref: string;
  final_turn_ref: string | null;
  capsule_ref: string;
  parent_capsule_ref: string | null;
  parent_scope_ref: string | null;
  parent_final_turn_ref: string | null;
  inherits_state_hash: string | null;
  mode: "proof" | "verified_context";
  sealed: boolean;
  action_count: number;
  receipt_count: number;
  proof_bundle: unknown;
  graph_node: unknown;
  continuation_capsule: unknown;
  memory_injection: unknown;
  judgment_ledger: unknown;
  proof_card_markdown: string;
  handoff_markdown: string;
  verify_instructions_markdown: string;
  receipts_digest: string;
  bundle_digest: string;
  verification_status: "structural_digests_verified";
  verified_at: string;
  source_env: string;
  exported_at: string;
};

export type PushPackCheck = { name: string; ok: boolean; detail: string };

export type PushPackRefs = {
  loop_id: string;
  tenant_hash: string;
  capsule_ref: string;
  scope_ref: string;
  final_turn_ref: string | null;
  parent_capsule_ref: string | null;
  parent_scope_ref: string | null;
  parent_final_turn_ref: string | null;
  inherits_state_hash: string | null;
  mode: string;
  receipts_digest: string;
  bundle_digest: string;
};

export type PushPackReport = {
  ok: boolean;
  pack: string;
  table: string;
  /** "inserted" | "already_persisted" only with ok: true; "failed" otherwise. */
  status: "inserted" | "already_persisted" | "failed";
  row_id: string | null;
  refs: PushPackRefs | null;
  checks: PushPackCheck[];
  /** Always present, pass or fail: push-pack NEVER verifies Ed25519 signatures. */
  signature_notice: string;
  verify_command: string;
};

/**
 * Destination client interface (Supabase PostgREST in v1; injected so tests run fully offline).
 * Methods THROW on transport/HTTP failure — pushPack converts every throw into a fail-closed
 * check. There is deliberately no update and no delete method.
 */
export type LoopArtifactDestinationClient = {
  selectByCapsuleRef(capsule_ref: string): Promise<Array<Record<string, unknown>>>;
  insertRow(row: LoopArtifactRow): Promise<{ kind: "inserted"; row: Record<string, unknown> } | { kind: "conflict" }>;
  selectById(id: string): Promise<Record<string, unknown> | null>;
};

/**
 * Identity fields compared on EVERY read-back (fresh insert and already_persisted alike).
 * bundle_digest / verification_status / source_env / timestamps are excluded here because an
 * already_persisted row may come from an earlier re-export of the SAME chain (exported_at and
 * therefore bundle_digest legitimately differ); they are compared only on a fresh insert.
 */
const IDENTITY_FIELDS = [
  "loop_id",
  "tenant_hash",
  "scope_ref",
  "final_turn_ref",
  "capsule_ref",
  "parent_capsule_ref",
  "parent_scope_ref",
  "parent_final_turn_ref",
  "inherits_state_hash",
  "mode",
  "sealed",
  "action_count",
  "receipt_count",
  "receipts_digest"
] as const;

const INSERT_ONLY_FIELDS = ["bundle_digest", "verification_status", "source_env"] as const;

/** Compared by epoch ms: PostgREST normalizes timestamptz text (e.g. Z -> +00:00). */
const INSERT_ONLY_TIMESTAMP_FIELDS = ["verified_at", "exported_at"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** null-normalized scalar compare; returns human-readable mismatch lines (refs/hashes/counts only — never artifact content). */
function compareRowFields(
  local: LoopArtifactRow,
  remote: Record<string, unknown>,
  fields: readonly string[],
  timestampFields: readonly string[]
): string[] {
  const mismatches: string[] = [];
  const l = local as unknown as Record<string, unknown>;
  for (const f of fields) {
    if ((l[f] ?? null) !== (remote[f] ?? null)) {
      mismatches.push(`${f}: local ${JSON.stringify(l[f] ?? null)} != destination ${JSON.stringify(remote[f] ?? null)}`);
    }
  }
  for (const f of timestampFields) {
    const lt = Date.parse(String(l[f]));
    const rt = Date.parse(String(remote[f]));
    if (!Number.isFinite(lt) || !Number.isFinite(rt) || lt !== rt) {
      mismatches.push(`${f}: local ${JSON.stringify(l[f] ?? null)} != destination ${JSON.stringify(remote[f] ?? null)}`);
    }
  }
  return mismatches;
}

/**
 * Build the row from a pack directory: fail closed on a missing/malformed/cross-inconsistent
 * artifact, on a digest that does not bind, on a Proof Mode boundary violation, and on invented
 * inheritance fields. Pure and local — no network. Exported for direct row-construction tests.
 */
export function buildLoopArtifactRow(
  pack_dir: string,
  now: () => Date = () => new Date()
): { ok: true; row: LoopArtifactRow; checks: PushPackCheck[] } | { ok: false; checks: PushPackCheck[] } {
  const checks: PushPackCheck[] = [];
  // BELT AND BRACES: a shape that slips past validation must degrade to a failing check, never an
  // uncaught exception (same report contract as verify-cross-loop).
  try {
    const row = buildRowChecked(pack_dir, now, checks);
    return row === null ? { ok: false, checks } : { ok: true, row, checks };
  } catch (error) {
    checks.push({
      name: "unexpected_error",
      ok: false,
      detail: `internal error while building the row (treat as NOT persisted): ${(error as Error).message}`
    });
    return { ok: false, checks };
  }
}

function buildRowChecked(pack_dir: string, now: () => Date, checks: PushPackCheck[]): LoopArtifactRow | null {
  const fail = (name: string, detail: string): null => {
    checks.push({ name, ok: false, detail });
    return null;
  };
  const pass = (name: string, detail: string): void => {
    checks.push({ name, ok: true, detail });
  };

  // --- 1) Pack directory + all ten required artifacts (fail closed, naming the file) ------------
  try {
    if (!statSync(pack_dir).isDirectory()) return fail("pack_dir", `${pack_dir} is not a directory (fail closed).`);
  } catch (error) {
    return fail("pack_dir", `pack path missing: ${(error as Error).message} (fail closed).`);
  }
  const texts = new Map<string, string>();
  for (const file of REQUIRED_PACK_FILES) {
    try {
      texts.set(file, readFileSync(join(pack_dir, file), "utf8"));
    } catch (error) {
      return fail("required_artifacts", `required artifact ${file} is missing/unreadable: ${(error as Error).message} (fail closed).`);
    }
  }
  const parsed = new Map<string, unknown>();
  for (const file of REQUIRED_PACK_FILES) {
    if (!file.endsWith(".json")) continue;
    try {
      parsed.set(file, JSON.parse(texts.get(file)!));
    } catch (error) {
      return fail("required_artifacts", `required artifact ${file} is not valid JSON: ${(error as Error).message} (fail closed).`);
    }
  }

  // --- 2) Shape validation (valid JSON with the wrong shape fails closed, never crashes) --------
  const receipts = parsed.get("receipts.json");
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return fail("required_artifacts", "receipts.json parses but is not a non-empty JSON array of receipts (fail closed).");
  }
  const bundle = parsed.get("bundle.json");
  if (
    !isRecord(bundle) ||
    bundle.bundle_version !== "loop-proof-bundle/v1" ||
    !isRecord(bundle.loop) ||
    !isRecord(bundle.export) ||
    !isRecord((bundle.export as Record<string, unknown>).content_digest)
  ) {
    return fail("required_artifacts", "bundle.json parses but is not a loop-proof-bundle/v1 bundle (fail closed).");
  }
  const bundleLoop = bundle.loop as Record<string, unknown>;
  const bundleExport = bundle.export as Record<string, unknown>;
  const contentDigest = bundleExport.content_digest as Record<string, unknown>;
  if (!isRecord(bundle.capsule) || !isRecord((bundle.capsule as Record<string, unknown>).judgment)) {
    return fail(
      "required_artifacts",
      "bundle.json carries no capsule.judgment section — push-pack v1 accepts strict Gate-2 (capsule + judgment) packs only (fail closed)."
    );
  }
  const bundleCapsule = bundle.capsule as Record<string, unknown>;
  const bundleJudgment = bundleCapsule.judgment as Record<string, unknown>;
  const graphNode = parsed.get("graph-node.json");
  if (!isRecord(graphNode) || !isRecord(graphNode.content_digest)) {
    return fail("required_artifacts", "graph-node.json parses but is not a graph node (fail closed).");
  }
  const scopeCapsule = parsed.get("scope-capsule.json");
  if (!isRecord(scopeCapsule) || !isRecord(scopeCapsule.structural) || !nonEmptyString(scopeCapsule.scope_ref)) {
    return fail("required_artifacts", "scope-capsule.json parses but is not a scope capsule (fail closed).");
  }
  const structural = scopeCapsule.structural as Record<string, unknown>;
  const continuation = parsed.get("continuation-capsule.json");
  if (!isRecord(continuation) || !nonEmptyString(continuation.loop_id) || !nonEmptyString(continuation.scope_ref)) {
    return fail("required_artifacts", "continuation-capsule.json parses but is not a continuation capsule (fail closed).");
  }
  const memoryInjection = parsed.get("memory-injection.json");
  if (!isRecord(memoryInjection) || !nonEmptyString(memoryInjection.capsule_ref)) {
    return fail("required_artifacts", "memory-injection.json parses but is not a memory injection capsule (fail closed).");
  }
  const judgmentLedger = parsed.get("judgment-ledger.json");
  if (!isRecord(judgmentLedger) || !Array.isArray(judgmentLedger.turns)) {
    return fail("required_artifacts", "judgment-ledger.json parses but is not a judgment ledger (fail closed).");
  }
  pass("required_artifacts", "all ten required artifacts are present, parse, and have the expected shapes");

  // --- 3) Digests: receipts_digest recomputes and binds; bundle_digest over the bytes read ------
  const receipts_digest = sha256Hex(texts.get("receipts.json")!);
  if (
    contentDigest.algorithm !== "sha256" ||
    contentDigest.over !== "receipts.json" ||
    contentDigest.value !== receipts_digest
  ) {
    return fail(
      "receipts_digest_binds",
      `receipts.json recomputes to sha256 ${receipts_digest} but bundle.json declares ` +
        `${JSON.stringify(contentDigest.value)} (${JSON.stringify(contentDigest.algorithm)} over ` +
        `${JSON.stringify(contentDigest.over)}); the pack's chain bytes are not the digested ones (fail closed).`
    );
  }
  const graphDigest = graphNode.content_digest as Record<string, unknown>;
  if (graphDigest.value !== receipts_digest) {
    return fail(
      "receipts_digest_binds",
      `graph-node.json declares content digest ${JSON.stringify(graphDigest.value)} but receipts.json recomputes to ${receipts_digest} (fail closed).`
    );
  }
  const bundle_digest = sha256Hex(texts.get("bundle.json")!);
  pass("receipts_digest_binds", `receipts_digest ${receipts_digest} recomputes and binds bundle + graph node; bundle_digest ${bundle_digest}`);

  // --- 4) Loop identity + summary consistent across every artifact that states it ---------------
  const loop_id = bundleLoop.loop_id;
  if (!nonEmptyString(loop_id)) return fail("loop_identity_consistent", "bundle.json loop.loop_id is not a non-empty string (fail closed).");
  for (const [label, v] of [
    ["graph-node.json", graphNode.loop_id],
    ["continuation-capsule.json", continuation.loop_id],
    ["scope-capsule.json structural", structural.loop_id],
    ["memory-injection.json", memoryInjection.loop_id],
    ["judgment-ledger.json", judgmentLedger.loop_id]
  ] as const) {
    if (v !== loop_id) {
      return fail("loop_identity_consistent", `${label} states loop_id ${JSON.stringify(v)} but bundle.json states ${JSON.stringify(loop_id)} (fail closed).`);
    }
  }
  const goal_hash = bundleLoop.goal_hash;
  for (const [label, v] of [
    ["graph-node.json", graphNode.goal_hash],
    ["continuation-capsule.json", continuation.goal_hash],
    ["scope-capsule.json structural", structural.goal_hash]
  ] as const) {
    if (v !== goal_hash) {
      return fail("loop_identity_consistent", `${label} states goal_hash ${JSON.stringify(v)} but bundle.json states ${JSON.stringify(goal_hash)} (fail closed).`);
    }
  }
  pass("loop_identity_consistent", `loop_id ${loop_id} and its goal_hash agree across all artifacts`);

  if (bundleLoop.sealed !== true || graphNode.sealed !== true || continuation.sealed !== true) {
    return fail("loop_summary_consistent", "the pack is not a sealed (closed) loop — push-pack persists closed/exported packs only (fail closed).");
  }
  const action_count = bundleLoop.action_count;
  if (typeof action_count !== "number" || graphNode.action_count !== action_count || continuation.action_count !== action_count) {
    return fail("loop_summary_consistent", "action_count disagrees across bundle / graph node / continuation (fail closed).");
  }
  const receipt_count = bundleLoop.receipt_count;
  if (typeof receipt_count !== "number" || graphNode.receipt_count !== receipt_count || receipts.length !== receipt_count) {
    return fail(
      "loop_summary_consistent",
      `bundle.json states receipt_count ${JSON.stringify(receipt_count)} but receipts.json carries ${receipts.length} receipt(s) (fail closed).`
    );
  }
  pass("loop_summary_consistent", `sealed loop; action_count ${action_count}, receipt_count ${receipt_count} agree with the chain`);

  // --- 5) scope_ref consistent everywhere AND recomputes from the sealed structural -------------
  const scope_ref = scopeCapsule.scope_ref;
  for (const [label, v] of [
    ["continuation-capsule.json", continuation.scope_ref],
    ["bundle.json capsule", bundleCapsule.scope_ref],
    ["memory-injection.json", memoryInjection.scope_ref],
    ["judgment-ledger.json", judgmentLedger.scope_ref]
  ] as const) {
    if (v !== scope_ref) {
      return fail("scope_ref_consistent", `${label} states scope_ref ${JSON.stringify(v)} but scope-capsule.json states ${JSON.stringify(scope_ref)} (fail closed).`);
    }
  }
  let recomputedScopeRef: string;
  try {
    recomputedScopeRef = deriveScopeRef(structural as unknown as ScopeStructuralProjection);
  } catch (error) {
    return fail("scope_ref_consistent", `scope-capsule.json structural cannot be hashed: ${(error as Error).message} (fail closed).`);
  }
  if (recomputedScopeRef !== scope_ref) {
    return fail(
      "scope_ref_consistent",
      `scope-capsule.json scope_ref ${scope_ref} does not recompute from its structural projection (${recomputedScopeRef}); the capsule is internally inconsistent (fail closed).`
    );
  }
  pass("scope_ref_consistent", `scope_ref ${scope_ref} recomputes and agrees across all artifacts`);

  // --- 6) Mode + Proof Mode honesty (BEFORE the capsule_ref recompute, so a plaintext-edited ----
  // continuation in a proof-claiming pack is reported as the boundary violation it is).
  const mode = bundleCapsule.mode;
  if (mode !== "proof" && mode !== "verified_context") {
    return fail("mode_consistent", `bundle.json capsule.mode ${JSON.stringify(mode)} is not "proof" or "verified_context" (fail closed).`);
  }
  if (scopeCapsule.privacy_mode !== mode || judgmentLedger.mode !== mode) {
    return fail(
      "mode_consistent",
      `export mode disagrees: bundle ${JSON.stringify(mode)}, scope-capsule ${JSON.stringify(scopeCapsule.privacy_mode)}, ` +
        `judgment-ledger ${JSON.stringify(judgmentLedger.mode)} (fail closed).`
    );
  }
  pass("mode_consistent", `export mode ${mode} agrees across bundle / scope capsule / judgment ledger`);
  if (mode === "verified_context" && structural.privacy_mode !== "verified_context") {
    return fail(
      "mode_honesty",
      `the pack claims a verified_context export but the SEALED structural privacy_mode is ` +
        `${JSON.stringify(structural.privacy_mode)}; an export may never be more permissive than the sealed scope (fail closed).`
    );
  }
  if (mode === "proof") {
    const plaintextKeys = ["settled", "open_questions", "next_actions", "changed"] as const;
    const leaks: string[] = [];
    if (scopeCapsule.sidecar !== undefined) leaks.push("scope-capsule.json carries a plaintext sidecar");
    if (continuation.continuation_prompt !== undefined) leaks.push("continuation-capsule.json carries continuation_prompt");
    for (const k of plaintextKeys) {
      const c = continuation[k];
      if (c !== undefined && (!Array.isArray(c) || c.length > 0)) leaks.push(`continuation-capsule.json publishes ${k}`);
      const m = memoryInjection[k];
      if (m !== undefined && (!Array.isArray(m) || m.length > 0)) leaks.push(`memory-injection.json publishes ${k}`);
    }
    if (leaks.length > 0) {
      return fail(
        "mode_honesty",
        `the pack claims a content-blind (proof) export but: ${leaks.join("; ")}. The unhashed export mode ` +
          `cannot relabel plaintext artifacts as content-blind (fail closed).`
      );
    }
  }
  pass("mode_honesty", "export mode is consistent with the sealed structural privacy_mode and the published artifacts");

  // --- 6b) Proof Mode markdown surfaces re-render byte-equal (adjudicated hardening, P1) --------
  // The three persisted Markdown faces are stored verbatim in the row, so a post-export tamper
  // could persist plaintext in a content-blind pack while the JSON-level mode_honesty check still
  // passes. All three renderers are PURE functions of the already-validated pack JSON (bundle /
  // continuation / scope capsule), so in Proof Mode each on-disk file must byte-equal its
  // re-render — the re-render path is used for all three surfaces (no sentinel fallback needed).
  // A mismatch names the file and NEVER echoes its content. Verified Context mode is not checked:
  // its markdown legitimately carries plaintext.
  if (mode === "proof") {
    const surfaces: Array<[file: string, render: () => string]> = [
      ["proof-card.md", () => renderProofCardMarkdown(bundle as unknown as LoopProofBundle, continuation as unknown as ContinuationCapsule)],
      ["HANDOFF.md", () => renderHandoffMarkdown(continuation as unknown as ContinuationCapsule)],
      [
        "verify-instructions.md",
        () => renderVerifyInstructionsMarkdown(bundle as unknown as LoopProofBundle, scopeCapsule as unknown as ScopeCapsuleExport)
      ]
    ];
    for (const [file, render] of surfaces) {
      let rendered: string;
      try {
        rendered = render();
      } catch (error) {
        return fail(
          "proof_markdown_rerenders",
          `${file} cannot be re-rendered from the validated pack JSON (${(error as Error).message}); a content-blind ` +
            `pack whose markdown cannot be re-derived is unverifiable (fail closed).`
        );
      }
      if (rendered !== texts.get(file)) {
        return fail(
          "proof_markdown_rerenders",
          `${file} does not byte-match its re-render from the validated pack JSON — a post-export edit could be ` +
            `persisting plaintext in a content-blind (proof) pack (fail closed; file content not echoed).`
        );
      }
    }
    pass(
      "proof_markdown_rerenders",
      "proof mode: proof-card.md, HANDOFF.md, verify-instructions.md each byte-match their re-render from the " +
        "validated pack JSON (re-render path used for all three surfaces)"
    );
  } else {
    pass("proof_markdown_rerenders", "verified_context export: markdown surfaces legitimately carry plaintext; re-render check not applicable");
  }

  // --- 7) Inheritance fields: captured from the SEALED edge only, null when absent — never -------
  // invented, never read from the unsigned sidecars alone.
  const edge = structural.inherits_loop;
  const stateHash = structural.inherits_state_hash;
  let parent_capsule_ref: string | null = null;
  let parent_scope_ref: string | null = null;
  let parent_final_turn_ref: string | null = null;
  let inherits_state_hash: string | null = null;
  if (edge === undefined) {
    if (continuation.inherits_loop !== undefined || memoryInjection.inherits_loop !== undefined) {
      return fail(
        "inheritance_fields",
        "the sealed scope carries no inherits_loop edge but the continuation / memory injection publish one — unsigned lineage is never trusted (fail closed)."
      );
    }
    if (stateHash !== undefined) {
      return fail("inheritance_fields", "the sealed scope commits inherits_state_hash without an inherits_loop edge (forged lineage shape; fail closed).");
    }
    pass("inheritance_fields", "non-inheriting pack: parent fields are null");
  } else {
    if (
      !isRecord(edge) ||
      !nonEmptyString(edge.capsule_ref) ||
      !nonEmptyString(edge.scope_ref) ||
      !nonEmptyString(edge.final_turn_ref)
    ) {
      return fail("inheritance_fields", "the sealed inherits_loop edge is not a {capsule_ref, scope_ref, final_turn_ref} triple of strings (fail closed).");
    }
    const sealedEdge = canonicalScopeJson(edge);
    if (canonicalScopeJson(continuation.inherits_loop ?? null) !== sealedEdge) {
      return fail("inheritance_fields", "continuation-capsule.json inherits_loop does not equal the sealed edge (fail closed).");
    }
    if (canonicalScopeJson(memoryInjection.inherits_loop ?? null) !== sealedEdge) {
      return fail("inheritance_fields", "memory-injection.json inherits_loop does not equal the sealed edge (fail closed).");
    }
    if (stateHash !== undefined && !nonEmptyString(stateHash)) {
      return fail("inheritance_fields", "the sealed inherits_state_hash is present but not a non-empty string (fail closed).");
    }
    parent_capsule_ref = edge.capsule_ref;
    parent_scope_ref = edge.scope_ref;
    parent_final_turn_ref = edge.final_turn_ref;
    inherits_state_hash = (stateHash as string | undefined) ?? null;
    pass(
      "inheritance_fields",
      `inheriting pack: sealed edge -> parent_capsule_ref ${parent_capsule_ref}` +
        (inherits_state_hash ? `, inherits_state_hash ${inherits_state_hash}` : " (identity-only: no state commitment)")
    );
  }

  // --- 8) capsule_ref recomputes from the on-disk continuation (mode-independent structural -----
  // identity) and equals the one memory-injection.json published at export time.
  let capsule_ref: string;
  try {
    capsule_ref = deriveContinuationRef(continuation as unknown as ContinuationCapsule);
  } catch (error) {
    return fail("capsule_ref_recomputes", `continuation-capsule.json cannot be hashed: ${(error as Error).message} (fail closed).`);
  }
  if (capsule_ref !== memoryInjection.capsule_ref) {
    return fail(
      "capsule_ref_recomputes",
      `continuation-capsule.json recomputes to capsule_ref ${capsule_ref} but memory-injection.json publishes ` +
        `${JSON.stringify(memoryInjection.capsule_ref)}; the pack's identity artifacts disagree (fail closed).`
    );
  }
  pass("capsule_ref_recomputes", `capsule_ref ${capsule_ref} recomputes from the continuation and matches memory-injection.json`);

  // --- 9) final_turn_ref agrees everywhere it is stated ------------------------------------------
  const final_turn_ref = (continuation.final_turn_ref ?? null) as string | null;
  if (final_turn_ref !== null && !nonEmptyString(final_turn_ref)) {
    return fail("final_turn_ref_consistent", "continuation-capsule.json final_turn_ref is neither null nor a non-empty string (fail closed).");
  }
  for (const [label, v] of [
    ["memory-injection.json", memoryInjection.final_turn_ref],
    ["judgment-ledger.json", judgmentLedger.final_turn_ref],
    ["bundle.json capsule.judgment", bundleJudgment.final_turn_ref]
  ] as const) {
    if ((v ?? null) !== final_turn_ref) {
      return fail(
        "final_turn_ref_consistent",
        `${label} states final_turn_ref ${JSON.stringify(v ?? null)} but the continuation states ${JSON.stringify(final_turn_ref)} (fail closed).`
      );
    }
  }
  pass("final_turn_ref_consistent", `final_turn_ref ${final_turn_ref ?? "null"} agrees across all artifacts`);

  // --- 10) tenant_hash: uniform, non-empty, EXTERNAL scope only (never tenant_id) ----------------
  let tenant_hash: string | null = null;
  for (const [i, r] of receipts.entries()) {
    if (!isRecord(r)) return fail("tenant_hash_uniform", `receipts.json entry ${i} is not an object (fail closed).`);
    if ("tenant_id" in r) {
      return fail("tenant_hash_uniform", `receipts.json entry ${i} carries an internal tenant_id — only external-scope receipts (tenant_hash) may be persisted (fail closed).`);
    }
    if (!nonEmptyString(r.tenant_hash)) {
      return fail("tenant_hash_uniform", `receipts.json entry ${i} is missing external-scope tenant_hash (fail closed).`);
    }
    if (tenant_hash === null) tenant_hash = r.tenant_hash;
    else if (r.tenant_hash !== tenant_hash) {
      return fail("tenant_hash_uniform", `receipts.json carries more than one tenant_hash — a pack persists exactly one tenant's loop (fail closed).`);
    }
  }
  pass("tenant_hash_uniform", `all ${receipts.length} receipt(s) carry tenant_hash ${tenant_hash}`);

  // --- 11) Export metadata agrees between bundle and graph node ----------------------------------
  const exported_at = bundleExport.exported_at;
  const source_env = bundleExport.source_env;
  if (!nonEmptyString(exported_at) || !Number.isFinite(Date.parse(exported_at))) {
    return fail("export_metadata_consistent", "bundle.json export.exported_at is not a parseable timestamp (fail closed).");
  }
  if (!nonEmptyString(source_env)) {
    return fail("export_metadata_consistent", "bundle.json export.source_env is not a non-empty string (fail closed).");
  }
  if (graphNode.exported_at !== exported_at || graphNode.source_env !== source_env) {
    return fail("export_metadata_consistent", "graph-node.json exported_at / source_env disagree with bundle.json (fail closed).");
  }
  pass("export_metadata_consistent", `exported_at ${exported_at}, source_env ${source_env}`);

  return {
    loop_id,
    tenant_hash: tenant_hash!,
    scope_ref,
    final_turn_ref,
    capsule_ref,
    parent_capsule_ref,
    parent_scope_ref,
    parent_final_turn_ref,
    inherits_state_hash,
    mode,
    sealed: true,
    action_count,
    receipt_count,
    proof_bundle: bundle,
    graph_node: graphNode,
    continuation_capsule: continuation,
    memory_injection: memoryInjection,
    judgment_ledger: judgmentLedger,
    proof_card_markdown: texts.get("proof-card.md")!,
    handoff_markdown: texts.get("HANDOFF.md")!,
    verify_instructions_markdown: texts.get("verify-instructions.md")!,
    receipts_digest,
    bundle_digest,
    verification_status: "structural_digests_verified",
    verified_at: now().toISOString(),
    source_env,
    exported_at
  };
}

function rowRefs(row: LoopArtifactRow): PushPackRefs {
  return {
    loop_id: row.loop_id,
    tenant_hash: row.tenant_hash,
    capsule_ref: row.capsule_ref,
    scope_ref: row.scope_ref,
    final_turn_ref: row.final_turn_ref,
    parent_capsule_ref: row.parent_capsule_ref,
    parent_scope_ref: row.parent_scope_ref,
    parent_final_turn_ref: row.parent_final_turn_ref,
    inherits_state_hash: row.inherits_state_hash,
    mode: row.mode,
    receipts_digest: row.receipts_digest,
    bundle_digest: row.bundle_digest
  };
}

/**
 * Full destination flow: build row -> idempotency query -> insert (or resolve the existing /
 * raced row) -> SEPARATE read-back -> field compare. Success wording is printed by the CLI only
 * when this returns ok: true — a row that inserted but failed read-back is reported persisted
 * but NOT verified, and the run fails closed.
 */
export async function pushPack(input: {
  pack_dir: string;
  table: string;
  client: LoopArtifactDestinationClient;
  now?: () => Date;
}): Promise<PushPackReport> {
  const report = (
    ok: boolean,
    status: PushPackReport["status"],
    row_id: string | null,
    refs: PushPackRefs | null,
    checks: PushPackCheck[]
  ): PushPackReport => ({
    ok,
    pack: input.pack_dir,
    table: input.table,
    status,
    row_id,
    refs,
    checks,
    signature_notice: PUSH_PACK_SIGNATURE_NOTICE,
    verify_command: `npx -y lyhna-verify --chain ${join(input.pack_dir, "receipts.json")}`
  });

  const built = buildLoopArtifactRow(input.pack_dir, input.now);
  if (!built.ok) return report(false, "failed", null, null, built.checks);
  const { row, checks } = built;
  const fail = (name: string, detail: string, row_id: string | null = null): PushPackReport => {
    checks.push({ name, ok: false, detail });
    return report(false, "failed", row_id, rowRefs(row), checks);
  };
  const pass = (name: string, detail: string): void => {
    checks.push({ name, ok: true, detail });
  };

  // Resolve an existing row under this capsule_ref (pre-insert hit OR post-409 re-query): same
  // receipts_digest -> verify the EXISTING row and report already_persisted; differing digest ->
  // two claims under one capsule_ref, fail closed. Never updates, never inserts a second row.
  const resolveExisting = (rows: Array<Record<string, unknown>>): PushPackReport => {
    if (rows.length > 1) {
      return fail(
        "capsule_ref_conflict",
        `${rows.length} rows exist for capsule_ref ${row.capsule_ref} — the destination table is missing its unique(capsule_ref) constraint (fail closed).`
      );
    }
    const existing = rows[0]!;
    if (existing.receipts_digest !== row.receipts_digest) {
      return fail(
        "capsule_ref_conflict",
        `a row already exists for capsule_ref ${row.capsule_ref} with receipts_digest ` +
          `${JSON.stringify(existing.receipts_digest)} but the local pack digests to ${row.receipts_digest}; ` +
          `two claims under one capsule_ref never coexist (fail closed).`
      );
    }
    const id = existing.id;
    if (!nonEmptyString(id)) {
      return fail("already_persisted_verifies", "the existing destination row carries no id (fail closed).");
    }
    const mismatches = compareRowFields(row, existing, IDENTITY_FIELDS, []);
    if (mismatches.length > 0) {
      return fail(
        "already_persisted_verifies",
        `row ${id} already persists this capsule_ref/receipts_digest but its identity fields do not match the local pack: ${mismatches.join("; ")} (fail closed).`,
        id
      );
    }
    pass(
      "already_persisted_verifies",
      `row ${id} already persists capsule_ref ${row.capsule_ref} with the same receipts_digest; all identity fields match — no second row inserted`
    );
    return report(true, "already_persisted", id, rowRefs(row), checks);
  };

  // --- Idempotency branch (architect decision 2): query by capsule_ref ALONE before inserting ---
  let existingRows: Array<Record<string, unknown>>;
  try {
    existingRows = await input.client.selectByCapsuleRef(row.capsule_ref);
  } catch (error) {
    return fail("destination_query", `pre-insert query by capsule_ref failed: ${(error as Error).message} (fail closed).`);
  }
  if (existingRows.length > 0) return resolveExisting(existingRows);
  pass("idempotency_query", `no existing row for capsule_ref ${row.capsule_ref}`);

  // --- Insert ------------------------------------------------------------------------------------
  let inserted: Awaited<ReturnType<LoopArtifactDestinationClient["insertRow"]>>;
  try {
    inserted = await input.client.insertRow(row);
  } catch (error) {
    return fail("insert_row", `insert failed: ${(error as Error).message} (fail closed).`);
  }
  if (inserted.kind === "conflict") {
    // Race: another writer inserted this capsule_ref between our query and our insert. Re-query
    // and route through the SAME two branches (verify-existing or hard conflict).
    let raced: Array<Record<string, unknown>>;
    try {
      raced = await input.client.selectByCapsuleRef(row.capsule_ref);
    } catch (error) {
      return fail("destination_query", `post-conflict re-query by capsule_ref failed: ${(error as Error).message} (fail closed).`);
    }
    if (raced.length === 0) {
      return fail(
        "insert_row",
        `insert reported a unique-constraint conflict for capsule_ref ${row.capsule_ref} but no row is visible on re-query (fail closed).`
      );
    }
    pass("insert_row", "insert raced an existing row (unique capsule_ref conflict); re-queried and resolving against the winner");
    return resolveExisting(raced);
  }
  const insertedId = inserted.row.id;
  if (!nonEmptyString(insertedId)) {
    return fail("insert_row", "insert succeeded but the destination returned no row id (fail closed; the row cannot be read back).");
  }
  pass("insert_row", `inserted row ${insertedId}`);

  // --- SEPARATE read-back + field compare (never trust the insert echo) --------------------------
  let readBack: Record<string, unknown> | null;
  try {
    readBack = await input.client.selectById(insertedId);
  } catch (error) {
    return fail(
      "read_back_matches",
      `read-back of row ${insertedId} failed: ${(error as Error).message} (fail closed; the row is persisted but NOT verified).`,
      insertedId
    );
  }
  if (readBack === null) {
    return fail(
      "read_back_matches",
      `row ${insertedId} was inserted but is not visible on read-back (fail closed; the row is persisted but NOT verified).`,
      insertedId
    );
  }
  const mismatches = compareRowFields(row, readBack, [...IDENTITY_FIELDS, ...INSERT_ONLY_FIELDS], INSERT_ONLY_TIMESTAMP_FIELDS);
  if (mismatches.length > 0) {
    return fail(
      "read_back_matches",
      `read-back of row ${insertedId} does not match the inserted refs/digests: ${mismatches.join("; ")} (fail closed; the row is persisted but NOT verified).`,
      insertedId
    );
  }
  pass("read_back_matches", `read-back of row ${insertedId} matches every required ref and digest`);
  return report(true, "inserted", insertedId, rowRefs(row), checks);
}
