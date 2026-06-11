// Scope Capsule — the sealed, two-projection declaration of a loop's STRUCTURAL lane.
//
// Capsule Gate 1 front-half. A Scope Capsule is sealed by the supervisor at loop-open and
// declares the structural lane a run may operate in. It has TWO projections (the load-bearing
// partition):
//
//   - STRUCTURAL projection (gate-safe, content-blind): classes, tools, target globs/hashes,
//     exclusions, bounds, refs. ONLY this is hashed into `scope_ref`, stamped into
//     `constraints.scope`, and signed. It is the only thing the gate path / bind / core ever
//     sees.
//   - PLAINTEXT SIDECAR projection (human/UI/export only): goal summary, planned steps,
//     decisions, open questions, next actions, notes, success criteria. NEVER read by the gate,
//     NEVER passed to bind()/core. Carried only in Verified Context Mode export + continuation.
//
// This module is ADDITIVE and adapter-side. It does not touch lyhna-core, the receipt shape,
// signing, or canonicalization. `scope_ref` is an adapter-side content hash over the structural
// projection — it is NOT a receipt field shape change; it rides the existing additive
// `constraints` envelope (see mergeScopeConstraint in loop.ts) exactly as `constraints.loop` does.

import { createHash } from "node:crypto";

import type { McpToolCall } from "./mcp.js";

export type ScopePrivacyMode = "proof" | "verified_context";

/** Bounds the run must stay within (structural, content-free). */
export type ScopeBounds = {
  max_steps?: number;
  max_writes?: number;
  max_budget?: number;
};

/**
 * The cross-loop inheritance edge: the prior loop's emitted capsule this loop opens FROM.
 * An ATOMIC triple of content-blind refs — the prior continuation capsule's identity
 * (`cap_v1:` hash), the prior loop's final sealed `scope_ref`, and the prior loop's final
 * judgment `turn_ref`. Sealed into THIS loop's scope_ref via the structural projection, so
 * the edge is hash-bound and offline-checkable from the two packs alone. Distinct from the
 * Continuation Capsule's intra-loop `inherits_from` (this loop's own original scope_ref) —
 * that field is untouched.
 */
export type ScopeInheritsLoop = {
  capsule_ref: string;
  scope_ref: string;
  final_turn_ref: string;
};

/**
 * The gate-safe, content-blind projection. Every field here is a class, hash, ref, glob,
 * exclusion, or bound — never a plaintext plan field. Only this projection is hashed into
 * `scope_ref` and is eligible for the gate path.
 */
export type ScopeStructuralProjection = {
  capsule_type: "scope_capsule";
  capsule_version: string;
  loop_id: string;
  goal_hash: string;
  privacy_mode: ScopePrivacyMode;
  /** Allowed action classes, e.g. ["read","write","run_tests"]. */
  allowed_action_classes?: string[];
  /** Allowed tool names / MCP servers. */
  allowed_tools?: string[];
  /** Allowed target globs, e.g. ["/checkout/**","/payments/types.ts"]. */
  allowed_targets?: string[];
  /** Explicit out-of-scope target globs, e.g. ["/billing/migrations/**"]. */
  forbidden_targets?: string[];
  /**
   * Extra tool-argument keys (beyond the built-in path/file/target set) where this capsule's
   * tools carry their target, e.g. ["command","cwd"]. Declared, never inferred — lets a capsule
   * name where the target lives so target-based rules can be evaluated for its tools.
   */
  target_arg_keys?: string[];
  /**
   * Action classes that legitimately operate WITHOUT a target (e.g. ["run_tests"]). When
   * target-based rules are declared, a call whose target cannot be resolved fails closed UNLESS
   * its action class is named here. Declared exemption — the capsule says what needs no target.
   */
  targetless_action_classes?: string[];
  /** Pre-hashed target descriptors for content-blind (Proof Mode) membership checks. */
  target_descriptor_hashes?: string[];
  /**
   * Classifier override: tool_name -> action_class. SEALED into scope_ref so the exact classifier
   * that governed `deriveActionClass()` at the gate is hash-bound and surfaces in the verified scope
   * history (a supervisor-supplied `shell -> read` remap can no longer silently allow a step without
   * appearing in the proof). Content-blind: keys are tool names, values are action-class identifiers
   * — structural, never plaintext plan content.
   */
  class_map?: Record<string, string>;
  bounds?: ScopeBounds;
  prior_receipt_ref?: string | null;
  prior_proof_bundle_ref?: string;
  prior_capsule_ref?: string;
  /**
   * Cross-loop inheritance edge (atomic triple of content-blind refs). When present, this loop
   * declares it opens FROM the prior loop's emitted capsule; sealing hashes the edge into
   * scope_ref. Partial / malformed triples fail closed at seal.
   */
  inherits_loop?: ScopeInheritsLoop;
};

/**
 * The plaintext sidecar projection. Human/UI/export only — NEVER read by the gate and NEVER
 * passed to bind()/core. Carried in Verified Context Mode export + the Continuation Capsule.
 */
export type ScopeSidecarProjection = {
  goal_summary?: string;
  planned_steps?: string[];
  settled_decisions?: string[];
  open_questions?: string[];
  next_actions?: string[];
  notes?: string;
  success_criteria?: string[];
  source_pointers?: string[];
};

export type ScopeCapsule = {
  structural: ScopeStructuralProjection;
  sidecar?: ScopeSidecarProjection;
};

/** A sealed Scope Capsule: `scope_ref` + `sidecar_hash` pinned over the projections. */
export type SealedScope = {
  scope_ref: string;
  sidecar_hash: string | null;
  structural: ScopeStructuralProjection;
  sidecar?: ScopeSidecarProjection;
  prior_scope_ref?: string | null;
  sealed_at: string;
};

export const SCOPE_CAPSULE_VERSION = "scope-capsule/v1";

// Keys that would carry a plaintext plan field. The structural projection must NEVER contain
// any of these (it is content-blind by construction); this is the fail-closed floor.
const PLAN_PLAINTEXT_KEYS = new Set([
  "goal",
  "goal_summary",
  "intent",
  "plan",
  "planned_steps",
  "settled_decisions",
  "open_questions",
  "next_actions",
  "notes",
  "success_criteria",
  "source_pointers"
]);

// The CLOSED allowlist of structural-projection fields. The structural projection is hashed into
// scope_ref AND emitted in the Proof Mode (content-blind) scope-capsule.json, so it must carry
// ONLY known structural keys — any stray/typo/future field (e.g. `description: "fix checkout bug"`)
// would otherwise ride into the content-blind export. Anything not on this list fails closed.
const STRUCTURAL_ALLOWED_KEYS = new Set([
  "capsule_type",
  "capsule_version",
  "loop_id",
  "goal_hash",
  "privacy_mode",
  "allowed_action_classes",
  "allowed_tools",
  "allowed_targets",
  "forbidden_targets",
  "target_arg_keys",
  "targetless_action_classes",
  "target_descriptor_hashes",
  "class_map",
  "bounds",
  "prior_receipt_ref",
  "prior_proof_bundle_ref",
  "prior_capsule_ref",
  "inherits_loop"
]);

/** The closed key set of the cross-loop inheritance triple. Atomic: all three, nothing else. */
const INHERITS_LOOP_KEYS = ["capsule_ref", "scope_ref", "final_turn_ref"] as const;

/**
 * The exact ref prefix each inherits_loop member must carry — the shapes the proxy itself emits
 * (deriveContinuationRef / deriveScopeRef / deriveTurnRef), each "<prefix>:" + 64 hex. A non-empty
 * string that is NOT one of these hash refs (e.g. a plaintext note) would otherwise be hashed into
 * scope_ref and exported in the structural Proof Mode capsule, breaking the field's content-blind
 * contract. Fail closed.
 */
const INHERITS_LOOP_REF_PREFIXES: Record<(typeof INHERITS_LOOP_KEYS)[number], string> = {
  capsule_ref: "cap_v1",
  scope_ref: "scope_v1",
  final_turn_ref: "turn_v1"
};

// Structural fields that must be string arrays — validated so a nested object can't smuggle a
// plaintext value past the closed-key allowlist.
const STRUCTURAL_STRING_ARRAY_KEYS = [
  "allowed_action_classes",
  "allowed_tools",
  "allowed_targets",
  "forbidden_targets",
  "target_arg_keys",
  "targetless_action_classes",
  "target_descriptor_hashes"
];

/**
 * Fail-closed CLOSED-allowlist validation of the structural projection. Rejects any unknown
 * top-level field (so a typo/stray/future field cannot be hashed into scope_ref or emitted in the
 * content-blind export) and enforces that the string-array fields really are arrays of strings.
 */
export function assertScopeStructuralClosed(structural: ScopeStructuralProjection): void {
  for (const key of Object.keys(structural)) {
    if (!STRUCTURAL_ALLOWED_KEYS.has(key)) {
      throw new Error(
        `Scope structural projection has unknown field "${key}"; it is a CLOSED allowlist — a ` +
          `stray or plaintext field must never be hashed into scope_ref or emitted in the ` +
          `content-blind export (fail closed).`
      );
    }
  }
  for (const key of STRUCTURAL_STRING_ARRAY_KEYS) {
    const v = (structural as Record<string, unknown>)[key];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) {
      throw new Error(`Scope structural projection field "${key}" must be an array of strings (fail closed).`);
    }
  }
  // class_map is a FLAT tool_name -> action_class map: a non-null, non-array object whose values are
  // all strings. A nested object / array value could smuggle non-structural content into the hashed,
  // exported projection, so reject anything that isn't a flat string->string map (fail closed).
  const cm = (structural as Record<string, unknown>).class_map;
  if (cm !== undefined) {
    if (cm === null || typeof cm !== "object" || Array.isArray(cm) || Object.values(cm).some((x) => typeof x !== "string")) {
      throw new Error(`Scope structural projection field "class_map" must be a flat object of tool_name -> action_class strings (fail closed).`);
    }
  }
  // inherits_loop is an ATOMIC triple: the cross-loop edge is only meaningful when the prior
  // capsule_ref, scope_ref, and final_turn_ref are all pinned together. A partial triple, a
  // non-string ref, or a stray key (which could smuggle non-structural content into the hashed,
  // exported projection) is rejected rather than sealed (fail closed).
  const il = (structural as Record<string, unknown>).inherits_loop;
  if (il !== undefined) {
    assertInheritsLoopAtomic(il);
  }
}

/** Fail-closed validation of the cross-loop inheritance triple (closed keys, non-empty string refs). */
function assertInheritsLoopAtomic(value: unknown): asserts value is ScopeInheritsLoop {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Scope structural projection field "inherits_loop" must be an object ` +
        `{ capsule_ref, scope_ref, final_turn_ref } (fail closed).`
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(INHERITS_LOOP_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `Scope structural projection field "inherits_loop" has unknown key "${key}"; it is a closed ` +
          `triple of capsule_ref / scope_ref / final_turn_ref (fail closed).`
      );
    }
  }
  for (const key of INHERITS_LOOP_KEYS) {
    const v = record[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(
        `Scope structural projection field "inherits_loop" requires a non-empty string "${key}"; the ` +
          `cross-loop edge is an atomic triple (fail closed).`
      );
    }
    const prefix = INHERITS_LOOP_REF_PREFIXES[key];
    if (!new RegExp(`^${prefix}:[0-9a-f]{64}$`).test(v)) {
      throw new Error(
        `Scope structural projection field "inherits_loop.${key}" must be a "${prefix}:" + 64-hex ` +
          `hash ref; a non-ref value (e.g. plaintext) must never be sealed into scope_ref or ` +
          `exported in the content-blind projection (fail closed).`
      );
    }
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Deterministic, recursive sorted-key JSON for hashing the structural projection into
 * `scope_ref`. This is an ADAPTER-SIDE hash input only — it is NOT the lyhna-core receipt
 * canonicalization (which stays frozen). It exists purely so `scope_ref` is stable.
 */
export function canonicalScopeJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Fail-closed content-blind guard for the STRUCTURAL projection. A structural projection that
 * carries any plan-bearing key (anywhere, deep) is rejected — the structural lane is the
 * gate/core path and must never carry plaintext plan fields.
 */
export function assertScopeStructuralContentBlind(structural: ScopeStructuralProjection): void {
  const leak = findPlanKey(structural);
  if (leak) {
    throw new Error(
      `Scope structural projection carries a plaintext plan field at "${leak}"; the structural ` +
        `lane is content-blind (plan plaintext belongs only in the sidecar projection). Fail closed.`
    );
  }
}

function findPlanKey(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findPlanKey(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const here = path ? `${path}.${key}` : key;
      if (PLAN_PLAINTEXT_KEYS.has(key)) return here;
      const hit = findPlanKey(child, here);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Fail-closed bounds gate at seal time. A declared bound must be one Capsule Gate 1 actually
 * ENFORCES — otherwise a sealed scope would imply a constraint that is never checked. Gate 1
 * enforces the STEP bound (`max_steps`) only; `max_writes` and `max_budget` have no honest meter
 * in this gate (metering/budget are out of scope), so a capsule declaring them is rejected rather
 * than accepted-and-ignored. (Reserved for a later gate, not silently unenforced here.)
 */
export function assertBoundsEnforceable(bounds?: ScopeBounds): void {
  if (!bounds) return;
  // Closed-key check FIRST: `bounds` arrives as JSON, so a stray nested key (e.g.
  // `bounds: { max_steps: 2, description: "..." }`) would otherwise be hashed into scope_ref and
  // emitted in the structural Proof Mode export despite the top-level allowlist. Fail closed.
  for (const key of Object.keys(bounds)) {
    if (key !== "max_steps" && key !== "max_writes" && key !== "max_budget") {
      throw new Error(`Scope bounds has unknown field "${key}"; only max_steps is supported (fail closed).`);
    }
  }
  if (bounds.max_writes !== undefined || bounds.max_budget !== undefined) {
    throw new Error(
      "Scope bounds max_writes/max_budget are not enforced in Capsule Gate 1; declare only " +
        "max_steps (or omit bounds) — fail closed rather than imply an unenforced bound."
    );
  }
  if (bounds.max_steps !== undefined && (!Number.isInteger(bounds.max_steps) || bounds.max_steps < 0)) {
    throw new Error("Scope bounds max_steps must be a non-negative integer.");
  }
}

/**
 * Derive `scope_ref` = "scope_v1:" + sha256(canonical structural projection). Content-blind:
 * the hash is computed over the structural projection only; the sidecar never affects it.
 */
export function deriveScopeRef(structural: ScopeStructuralProjection): string {
  return `scope_v1:${sha256Hex(canonicalScopeJson(structural))}`;
}

/** Derive the sidecar content hash (or null when there is no sidecar). */
export function deriveSidecarHash(sidecar?: ScopeSidecarProjection): string | null {
  if (!sidecar || Object.keys(sidecar).length === 0) return null;
  return `sha256:${sha256Hex(canonicalScopeJson(sidecar))}`;
}

/**
 * Seal a Scope Capsule. SUPERVISOR-ONLY by call site (the control channel `open`/`amend`
 * verbs); the agent's MCP path never reaches here. Validates the structural projection is
 * content-blind (fail closed), then pins `scope_ref` + `sidecar_hash`.
 */
export function sealScopeCapsule(input: {
  capsule: ScopeCapsule;
  prior_scope_ref?: string | null;
  sealed_at?: string;
}): SealedScope {
  const { structural, sidecar } = input.capsule;
  if (structural.capsule_type !== "scope_capsule") {
    throw new Error('Scope capsule structural projection requires capsule_type "scope_capsule".');
  }
  if (!structural.loop_id || !structural.goal_hash) {
    throw new Error("Scope capsule structural projection requires loop_id and goal_hash.");
  }
  // privacy_mode arrives as plain JSON (control channel / export CLI); validate it against the two
  // allowed values at seal time so a typo like "Proof" cannot later slip past a `=== "proof"`
  // mode-contract check and leak the plaintext sidecar. Fail closed.
  if (structural.privacy_mode !== "proof" && structural.privacy_mode !== "verified_context") {
    throw new Error(
      `Scope capsule privacy_mode must be "proof" or "verified_context", received ` +
        `${JSON.stringify(structural.privacy_mode)} (fail closed).`
    );
  }
  assertScopeStructuralClosed(structural);
  assertScopeStructuralContentBlind(structural);
  assertBoundsEnforceable(structural.bounds);

  return {
    scope_ref: deriveScopeRef(structural),
    sidecar_hash: deriveSidecarHash(sidecar),
    structural,
    sidecar,
    prior_scope_ref: input.prior_scope_ref ?? null,
    sealed_at: input.sealed_at ?? new Date().toISOString()
  };
}

/**
 * Amend a sealed scope: seal a NEW scope version whose structural projection replaces the
 * prior, chained via `prior_scope_ref`. Supervisor-only by call site. The amendment is never
 * silent: it produces a distinct `scope_ref` surfaced in the Continuation Capsule.
 */
export function amendScope(prior: SealedScope, next: ScopeCapsule, sealed_at?: string): SealedScope {
  return sealScopeCapsule({ capsule: next, prior_scope_ref: prior.scope_ref, sealed_at });
}

// --- export projection -------------------------------------------------------

/**
 * The `scope-capsule.json` export shape. In Proof Mode this is STRUCTURAL-ONLY (no sidecar) so
 * the content-blind pack stays blind. In Verified Context Mode the plaintext sidecar is carried
 * for the tenant-visible pack.
 */
export type ScopeCapsuleExport = {
  capsule_type: "scope_capsule";
  capsule_version: string;
  scope_ref: string;
  sidecar_hash: string | null;
  prior_scope_ref: string | null;
  sealed_at: string;
  privacy_mode: ScopePrivacyMode;
  structural: ScopeStructuralProjection;
  /** Present ONLY in Verified Context Mode. */
  sidecar?: ScopeSidecarProjection;
};

/** Project a sealed scope to its `scope-capsule.json` export shape under a privacy mode. */
export function projectScopeCapsuleForExport(
  sealed: SealedScope,
  mode: ScopePrivacyMode
): ScopeCapsuleExport {
  const base: ScopeCapsuleExport = {
    capsule_type: "scope_capsule",
    capsule_version: sealed.structural.capsule_version,
    scope_ref: sealed.scope_ref,
    sidecar_hash: sealed.sidecar_hash,
    prior_scope_ref: sealed.prior_scope_ref ?? null,
    sealed_at: sealed.sealed_at,
    privacy_mode: mode,
    structural: sealed.structural
  };
  if (mode === "verified_context" && sealed.sidecar) {
    base.sidecar = sealed.sidecar;
  }
  return base;
}

/**
 * Fail-closed guard for a Proof Mode `scope-capsule.json`: it must be STRUCTURAL-ONLY (no
 * sidecar key, and the structural projection itself content-blind). Reject anything else.
 */
export function assertScopeCapsuleStructuralOnly(exported: ScopeCapsuleExport): void {
  if (exported.sidecar !== undefined) {
    throw new Error("Proof Mode scope-capsule.json must be structural-only; sidecar present (fail closed).");
  }
  assertScopeStructuralContentBlind(exported.structural);
}

// --- the gate ----------------------------------------------------------------

export type ScopeDecisionKind = "IN_SCOPE" | "REFUSED" | "ESCALATED";

/**
 * The structural descriptor stamped into `constraints.scope` for an IN_SCOPE event. Every field
 * is structural / a hash — NEVER plaintext (even in Verified Context Mode the target is carried
 * as a hash here; the plaintext target stays in the sidecar scope event).
 */
export type ScopeStructuralDescriptor = {
  action_class: string;
  tool_name: string;
  /** sha256 hash of the resolved target (single), or a stable SET DIGEST (multi-target), or null.
   * Never the plaintext target. */
  target_descriptor: string | null;
  /** Per-target sha256 hashes (one per resolved target), so a multi-target call is re-validatable
   * member-by-member at export. Omitted when no target resolved. */
  target_descriptors?: string[];
};

export type ScopeDecision = {
  decision: ScopeDecisionKind;
  reason: string;
  matched_rule?: string;
  descriptor: ScopeStructuralDescriptor;
  /** Plaintext target the gate resolved (Verified Context Mode only) — for the sidecar event. */
  target_plaintext?: string;
};

// Common argument keys that name a target (path/file/etc). Verified Context Mode reads these
// pre-execution to do richer blast-radius / exclusion checks. The plaintext never leaves the
// adapter (it is hashed for the descriptor and kept only in the sidecar event).
const TARGET_ARG_KEYS = ["path", "file_path", "file", "target", "target_path", "filename"];

/** Map a tool name to a coarse action class. Declared map wins; otherwise a small heuristic. */
export function deriveActionClass(call: McpToolCall, classMap?: Record<string, string>): string {
  if (classMap && classMap[call.toolName]) return classMap[call.toolName];
  const name = call.toolName.toLowerCase();
  if (name.includes("test")) return "run_tests";
  if (name.includes("write") || name.includes("edit") || name.includes("create") || name.includes("delete")) {
    return "write";
  }
  if (name.includes("read") || name.includes("get") || name.includes("list") || name.includes("search")) {
    return "read";
  }
  return "other";
}

/** Resolve the FIRST plaintext target argument of a tool call, if any. */
export function resolveTargetPlaintext(call: McpToolCall, extraKeys?: string[]): string | undefined {
  return resolveTargets(call, extraKeys)[0];
}

/**
 * Resolve ALL distinct plaintext target arguments of a tool call (built-in keys + capsule-declared
 * `target_arg_keys`). Multi-target tools (copy/move: `path` + `destination`, etc.) carry more than
 * one target; the gate must evaluate EVERY one, never just the first — otherwise a call could put
 * an allowed value in one key and the real out-of-lane target in another.
 */
export function resolveTargets(call: McpToolCall, extraKeys?: string[]): string[] {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const keys = extraKeys && extraKeys.length > 0 ? [...TARGET_ARG_KEYS, ...extraKeys] : TARGET_ARG_KEYS;
  const out: string[] = [];
  for (const key of keys) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0 && !out.includes(v)) out.push(v);
  }
  return out;
}

export function hashTarget(target: string): string {
  return `sha256:${sha256Hex(target)}`;
}

/**
 * Lexically canonicalize a `/`-separated target so glob/membership checks see the SAME path the
 * filesystem-style upstream will actually operate on — closing path-traversal bypasses like
 * `/checkout/../billing/migrations/x.sql` (which would match an allowed `/checkout/**` lane while
 * the upstream resolves it to the forbidden billing path).
 *
 * Returns the canonical target, or `null` when it cannot be made safe (so the caller FAILS CLOSED):
 *   - a backslash (ambiguous Windows-style separator that a `/`-glob cannot reason about), or
 *   - a `..` that escapes the root / a relative path that escapes its base.
 *
 * This is a LEXICAL resolution only (no filesystem access); symlinks are not resolved — a
 * symlink-based escape is out of scope for an adapter that must not touch the filesystem.
 */
export function canonicalizeTarget(target: string): string | null {
  if (target.includes("\\")) return null; // ambiguous separator -> cannot reason -> fail closed
  const isAbsolute = target.startsWith("/");
  const out: string[] = [];
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue; // collapse `//` and `.` segments
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (isAbsolute) {
        return null; // `..` above an absolute root — refuse rather than silently clamp
      } else {
        out.push("..");
      }
      continue;
    }
    out.push(part);
  }
  if (out.includes("..")) return null; // residual `..` (relative escape) -> unsafe
  const joined = out.join("/");
  return isAbsolute ? `/${joined}` : joined;
}

/**
 * Stamp descriptor over the resolved target set: a single target hashes to its own descriptor
 * (so single-target descriptor-hash membership is unchanged); multiple targets hash to a stable
 * set digest. Per-target membership/exclusion is still checked individually in the gate.
 */
function hashTargets(targets: string[]): string | null {
  if (targets.length === 0) return null;
  if (targets.length === 1) return hashTarget(targets[0]!);
  const canonical = JSON.stringify([...new Set(targets)].sort());
  return `sha256:${sha256Hex(canonical)}`;
}

// Translate a glob to an anchored RegExp. Globstar (double-star) matches across path segments
// while PRESERVING the `/` boundary, so a "slash double-star slash package.json" pattern matches
// "/checkout/package.json" and "/checkout/a/b/package.json" but NOT "/checkout/notpackage.json":
//   - slash double-star slash (middle)   -> "/(?:.*/)?"  (zero or more whole directory segments)
//   - slash double-star (trailing)       -> "(?:/.*)?"   (the dir itself and anything beneath it)
//   - double-star slash (leading)        -> "(?:.*/)?"
//   - double-star (standalone)           -> ".*"
//   - single star                        -> "[^/]*" (within one segment)
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const c = glob[i];
    if (c === "/") {
      // Slash-anchored globstar constructs are handled here so the boundary is never lost.
      if (glob[i + 1] === "*" && glob[i + 2] === "*") {
        if (glob[i + 3] === "/") {
          re += "/(?:.*/)?"; // `/**/` — zero or more whole segments, boundary preserved
          i += 4;
        } else {
          re += "(?:/.*)?"; // `/**` (end / non-slash) — the dir itself and anything beneath it
          i += 3;
        }
        continue;
      }
      re += "/";
      i += 1;
      continue;
    }
    if (c === "*" && glob[i + 1] === "*") {
      // `**` not preceded by `/` (start, or after a non-slash char).
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?"; // `**/` — zero or more leading segments
        i += 3;
      } else {
        re += ".*"; // standalone `**`
        i += 2;
      }
      continue;
    }
    if (c === "*") {
      re += "[^/]*";
      i += 1;
      continue;
    }
    if ("\\^$.|?+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(target: string, globs?: string[]): string | undefined {
  if (!globs) return undefined;
  for (const g of globs) {
    if (globToRegExp(g).test(target)) return g;
  }
  return undefined;
}

/**
 * The adapter-side structural scope check. Runs PRE-BIND. Returns a decision plus the structural
 * descriptor to stamp (IN_SCOPE) or attest (REFUSED/ESCALATED).
 *
 * Verified Context Mode reads the plaintext target for richer allowed/forbidden glob checks and
 * RETAINS it (sidecar event/export). Proof Mode also resolves the FORWARDED payload target
 * tenant-side, but only to HASH it (then discards the plaintext — content-blind export), and
 * enforces target lanes by descriptor-hash membership. Neither mode trusts a separate
 * agent-supplied descriptor field; the descriptor is always tied to the actual payload.
 *
 * Declared, never inferred: a check only fails on an EXPLICIT declared rule (a forbidden match,
 * a non-empty allow-list miss, an unresolved target, or a descriptor-hash miss).
 *
 * NOTE: the step bound (`bounds.max_steps`) is stateful (it depends on the loop's advancing
 * action count), so it is enforced INSIDE the loop mutex (LoopSession.bindToolCall), NOT here —
 * a pre-bind read of the count races concurrent calls. This function checks only the structural
 * lane (tool/class/target).
 */
export function checkScopeStructural(
  call: McpToolCall,
  sealed: SealedScope,
  options: { mode: ScopePrivacyMode; classMap?: Record<string, string> }
): ScopeDecision {
  const s = sealed.structural;
  // Derive the action class with the SEALED classifier (hash-bound into scope_ref), so the classifier
  // that governs enforcement is exactly the one the proof exports. `options.classMap` is a legacy/test
  // fallback only used when the sealed scope declares none; production wiring sources it from the
  // sealed projection, so the gate can never enforce an unsealed/unbound classifier.
  const action_class = deriveActionClass(call, s.class_map ?? options.classMap);

  // 1) Tool allow-list (structural, both modes).
  if (s.allowed_tools && s.allowed_tools.length > 0 && !s.allowed_tools.includes(call.toolName)) {
    return refuse(action_class, call.toolName, null, `tool "${call.toolName}" not in allowed_tools`, "allowed_tools");
  }

  // 2) Action-class allow-list (structural, both modes).
  if (
    s.allowed_action_classes &&
    s.allowed_action_classes.length > 0 &&
    !s.allowed_action_classes.includes(action_class)
  ) {
    return refuse(action_class, call.toolName, null, `action class "${action_class}" not in allowed_action_classes`, "allowed_action_classes");
  }

  // Resolve EVERY declared/built-in target the call carries — never just the first. A multi-target
  // tool must have all of its targets inside the lane.
  const rawTargets = resolveTargets(call, s.target_arg_keys);
  const targetless = (s.targetless_action_classes ?? []).includes(action_class);
  // A target rule exists if ANY of: allowed globs, forbidden globs, or descriptor hashes.
  const hasTargetRules =
    (s.allowed_targets?.length ?? 0) > 0 ||
    (s.forbidden_targets?.length ?? 0) > 0 ||
    (s.target_descriptor_hashes?.length ?? 0) > 0;

  // FAIL CLOSED on a path-traversal / ambiguous target BEFORE any glob/membership check, so the
  // gate matches and hashes the SAME canonical path the upstream will operate on. Only relevant
  // when target rules are declared (otherwise targets are unconstrained anyway).
  if (hasTargetRules) {
    const unsafe = rawTargets.find((t) => canonicalizeTarget(t) === null);
    if (unsafe !== undefined) {
      return refuse(
        action_class,
        call.toolName,
        null,
        `target "${unsafe}" contains unsafe path segments (.. or ambiguous separators); its real location cannot be proven (fail closed)`,
        "unsafe_target"
      );
    }
  }
  // Canonical targets used for ALL matching, hashing, and the stamped descriptor.
  const targets = rawTargets.map((t) => canonicalizeTarget(t) ?? t);
  const target_descriptor = hashTargets(targets);
  // Per-target hashes (deduped) so a multi-target call is re-validatable member-by-member at export.
  const target_descriptors = targets.length > 0 ? [...new Set(targets.map((t) => hashTarget(t)))] : undefined;

  if (options.mode === "verified_context") {
    // FAIL CLOSED: when the capsule declares target-based rules, a call whose target cannot be
    // resolved (missing key, or a key this capsule did not declare) cannot be proven inside the
    // declared lane — refuse it before execution. The only exemption is an action class the
    // capsule explicitly declared targetless (e.g. run_tests). Declared, never inferred.
    if (hasTargetRules && targets.length === 0 && !targetless) {
      return refuse(
        action_class,
        call.toolName,
        null,
        `target-based scope rules are declared but no target could be resolved for "${call.toolName}" (fail closed)`,
        "unresolved_target"
      );
    }

    // EVERY target must pass: any forbidden match, any target outside a declared allow-list, or
    // any target whose hash is not a declared descriptor-hash member refuses the whole call.
    for (const target of targets) {
      const forbidden = matchesAny(target, s.forbidden_targets);
      if (forbidden) {
        return {
          decision: "REFUSED",
          reason: `target matches forbidden_targets rule "${forbidden}"`,
          matched_rule: forbidden,
          descriptor: { action_class, tool_name: call.toolName, target_descriptor: hashTarget(target) },
          target_plaintext: target
        };
      }
      if (s.allowed_targets && s.allowed_targets.length > 0 && !matchesAny(target, s.allowed_targets)) {
        return {
          decision: "REFUSED",
          reason: `target is outside allowed_targets`,
          matched_rule: "allowed_targets",
          descriptor: { action_class, tool_name: call.toolName, target_descriptor: hashTarget(target) },
          target_plaintext: target
        };
      }
      if (
        s.target_descriptor_hashes &&
        s.target_descriptor_hashes.length > 0 &&
        !s.target_descriptor_hashes.includes(hashTarget(target))
      ) {
        return {
          decision: "REFUSED",
          reason: `target descriptor is not a declared member`,
          matched_rule: "target_descriptor_hashes",
          descriptor: { action_class, tool_name: call.toolName, target_descriptor: hashTarget(target) },
          target_plaintext: target
        };
      }
    }

    return {
      decision: "IN_SCOPE",
      reason: "within declared structural lane",
      descriptor: { action_class, tool_name: call.toolName, target_descriptor, target_descriptors },
      target_plaintext: targets.length === 1 ? targets[0] : targets.join(", ") || undefined
    };
  }

  // Proof Mode: content-blind EXPORT. Descriptors are derived by HASHING the (canonical) FORWARDED
  // payload targets tenant-side (then the plaintext is discarded — never retained or exported), so
  // they are tied to the exact payload and can NOT be forged by a separate agent-supplied field.
  // EVERY target must be a member of the sealed target_descriptor_hashes.
  if (hasTargetRules) {
    if (targets.length === 0) {
      // The `targetless` exemption ONLY covers a genuinely missing target. With none resolved and
      // the class not declared targetless, the call cannot be proven in-lane -> fail closed.
      if (!targetless) {
        return refuse(
          action_class,
          call.toolName,
          null,
          `target-based scope rules are declared but no target could be resolved for "${call.toolName}" (fail closed)`,
          "unresolved_target"
        );
      }
    } else {
      // Targets ARE present — even for a 'targetless' action class, every present target must be
      // validated before forwarding (the exemption never licenses an unchecked present target).
      // Content-blind enforcement requires declared descriptor hashes; absent them, FAIL CLOSED.
      if (!s.target_descriptor_hashes || s.target_descriptor_hashes.length === 0) {
        return refuse(
          action_class,
          call.toolName,
          target_descriptor,
          "Proof Mode cannot evaluate plaintext target rules; declare target_descriptor_hashes for content-blind enforcement (fail closed)",
          "proof_mode_target_unenforceable"
        );
      }
      for (const target of targets) {
        if (!s.target_descriptor_hashes.includes(hashTarget(target))) {
          return refuse(action_class, call.toolName, hashTarget(target), "payload target descriptor is not a declared member", "target_descriptor_hashes");
        }
      }
    }
  }
  return {
    decision: "IN_SCOPE",
    reason: "within declared structural lane (content-blind)",
    descriptor: { action_class, tool_name: call.toolName, target_descriptor, target_descriptors }
    // No target_plaintext: Proof Mode discards the plaintext after hashing (content-blind).
  };
}

function refuse(
  action_class: string,
  tool_name: string,
  target_descriptor: string | null,
  reason: string,
  matched_rule: string
): ScopeDecision {
  return {
    decision: "REFUSED",
    reason,
    matched_rule,
    descriptor: { action_class, tool_name, target_descriptor }
  };
}
