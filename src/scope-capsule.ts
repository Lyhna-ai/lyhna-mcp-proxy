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
  bounds?: ScopeBounds;
  prior_receipt_ref?: string | null;
  prior_proof_bundle_ref?: string;
  prior_capsule_ref?: string;
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
  assertScopeStructuralContentBlind(structural);

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
  /** sha256 hash of the resolved target, or a structural class — never the plaintext target. */
  target_descriptor: string | null;
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

/** Resolve the plaintext target argument of a tool call, if any (Verified Context Mode). */
export function resolveTargetPlaintext(call: McpToolCall, extraKeys?: string[]): string | undefined {
  const args = call.arguments ?? {};
  const keys = extraKeys && extraKeys.length > 0 ? [...TARGET_ARG_KEYS, ...extraKeys] : TARGET_ARG_KEYS;
  for (const key of keys) {
    const v = (args as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function hashTarget(target: string): string {
  return `sha256:${sha256Hex(target)}`;
}

/** Translate a glob (supporting `**` and `*`) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    // `/**` matches the directory itself AND anything beneath it (so `/checkout/**` matches both
    // `/checkout` and `/checkout/cart/x.ts`).
    if (c === "/" && glob[i + 1] === "*" && glob[i + 2] === "*") {
      re += "(/.*)?";
      i += 3;
      if (glob[i] === "/") i += 1; // consume a trailing slash in `/**/`
      continue;
    }
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (glob[i] === "/") i += 1; // `**/` -> `.*`
        continue;
      }
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
 * Verified Context Mode reads the plaintext target for richer allowed/forbidden glob checks.
 * Proof Mode degrades to tool / action-class / explicit descriptor-hash membership and does NOT
 * read plaintext targets (no readable blast-radius guidance promised).
 *
 * Declared, never inferred: a check only fails on an EXPLICIT declared rule (a forbidden match,
 * a non-empty allow-list miss, or a missing required descriptor in Proof Mode).
 */
export function checkScopeStructural(
  call: McpToolCall,
  sealed: SealedScope,
  options: { mode: ScopePrivacyMode; classMap?: Record<string, string> }
): ScopeDecision {
  const s = sealed.structural;
  const action_class = deriveActionClass(call, options.classMap);

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

  if (options.mode === "verified_context") {
    // Verified Context Mode: read the plaintext target for richer exclusion / membership checks.
    const target = resolveTargetPlaintext(call, s.target_arg_keys);
    const target_descriptor = target ? hashTarget(target) : null;
    const hasTargetRules =
      (s.allowed_targets?.length ?? 0) > 0 || (s.forbidden_targets?.length ?? 0) > 0;
    const targetless = (s.targetless_action_classes ?? []).includes(action_class);

    // FAIL CLOSED: when the capsule declares target-based rules, a call whose target cannot be
    // resolved (missing key, or a key this capsule did not declare) cannot be proven inside the
    // declared lane — refuse it before execution. The only exemption is an action class the
    // capsule explicitly declared targetless (e.g. run_tests). Declared, never inferred.
    if (hasTargetRules && target === undefined && !targetless) {
      return refuse(
        action_class,
        call.toolName,
        null,
        `target-based scope rules are declared but no target could be resolved for "${call.toolName}" (fail closed)`,
        "unresolved_target"
      );
    }

    if (target !== undefined) {
      const forbidden = matchesAny(target, s.forbidden_targets);
      if (forbidden) {
        return {
          decision: "REFUSED",
          reason: `target matches forbidden_targets rule "${forbidden}"`,
          matched_rule: forbidden,
          descriptor: { action_class, tool_name: call.toolName, target_descriptor },
          target_plaintext: target
        };
      }
      if (s.allowed_targets && s.allowed_targets.length > 0 && !matchesAny(target, s.allowed_targets)) {
        return {
          decision: "REFUSED",
          reason: `target is outside allowed_targets`,
          matched_rule: "allowed_targets",
          descriptor: { action_class, tool_name: call.toolName, target_descriptor },
          target_plaintext: target
        };
      }
    }

    return {
      decision: "IN_SCOPE",
      reason: "within declared structural lane",
      descriptor: { action_class, tool_name: call.toolName, target_descriptor },
      target_plaintext: target
    };
  }

  // Proof Mode: content-blind — no plaintext target is read, so the ONLY enforceable target
  // check is explicit descriptor-hash membership. When the sealed scope declares ANY target rule
  // (descriptor hashes OR plaintext allowed/forbidden globs) and the action is not declared
  // targetless, a matching descriptor hash is REQUIRED. A capsule that declares only plaintext
  // target globs — which Proof Mode cannot evaluate — without target_descriptor_hashes cannot be
  // enforced content-blind, so it FAILS CLOSED rather than degrading to tool/class-only.
  const declaredHash = proofModeDescriptorHash(call);
  const hasTargetRules =
    (s.allowed_targets?.length ?? 0) > 0 ||
    (s.forbidden_targets?.length ?? 0) > 0 ||
    (s.target_descriptor_hashes?.length ?? 0) > 0;
  const targetless = (s.targetless_action_classes ?? []).includes(action_class);

  if (hasTargetRules && !targetless) {
    if (!s.target_descriptor_hashes || s.target_descriptor_hashes.length === 0) {
      return refuse(
        action_class,
        call.toolName,
        null,
        "Proof Mode cannot evaluate plaintext target rules; declare target_descriptor_hashes for content-blind enforcement (fail closed)",
        "proof_mode_target_unenforceable"
      );
    }
    if (!declaredHash) {
      return refuse(action_class, call.toolName, null, "Proof Mode requires an explicit target_descriptor hash; none supplied", "target_descriptor_hashes");
    }
    if (!s.target_descriptor_hashes.includes(declaredHash)) {
      return refuse(action_class, call.toolName, declaredHash, "target descriptor hash is not a declared member", "target_descriptor_hashes");
    }
  }
  return {
    decision: "IN_SCOPE",
    reason: "within declared structural lane (content-blind)",
    descriptor: { action_class, tool_name: call.toolName, target_descriptor: declaredHash }
  };
}

function proofModeDescriptorHash(call: McpToolCall): string | null {
  const v = (call.arguments as Record<string, unknown> | undefined)?.target_descriptor;
  return typeof v === "string" && v.length > 0 ? v : null;
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
