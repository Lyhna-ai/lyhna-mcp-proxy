// Judgment Ledger — the live MIDDLE layer between the Scope Capsule and the Continuation
// Capsule (Capsule Gate 2).
//
// Capsule Gate 1 built the bookends (Scope Capsule in -> governed loop -> Continuation
// Capsule out) and the signed receipt spine. Capsule Gate 2 captures the ORDERED JUDGMENT
// TURNS that occur during the loop. A judgment turn is the judgment-of-record for one
// consequential move:
//
//     inherited state -> proposed next move -> verdict -> resulting state delta
//
// Lyhna does NOT read the agent's mind, infer hidden cognition, or claim business/runtime
// correctness. A turn records ONLY structural facts:
//   - what consequential move was proposed (action_class / tool_name / target HASH)
//   - what structural lane (scope_ref) it cited and what prior receipt/turn it inherited
//   - what verdict resolved (APPROVED / ESCALATED / REFUSED), and its SOURCE (bind, the
//     scope gate, or the loop step bound)
//   - what signed receipt or attested scope-event hash ANCHORS the verdict
//   - what runtime result/error HASH the forwarded call returned (hashed, never interpreted)
//   - what state delta a SUPERVISOR declared should carry forward (Verified Context only)
//
// This module is ADDITIVE and adapter-side. It does NOT touch lyhna-core, the receipt shape,
// signing, or canonicalization. `turn_ref` is an adapter-side content hash over the turn's
// judgment core — never a receipt-field change; it rides alongside the existing artifacts
// exactly as `scope_ref` / `event_hash` do.
//
// TURN_REF DESIGN (load-bearing): `turn_ref` is derived over the JUDGMENT CORE that is fixed
// at decision time (loop_id, turn_index, prior_turn_ref, prior_receipt_id, scope_ref,
// proposed, verdict). `runtime_report` (known only AFTER the call is forwarded, outside the
// loop mutex) and `declared_delta` (attached later by the supervisor) are ADDITIVE anchors
// and are deliberately EXCLUDED from `turn_ref`. This is the only shape that simultaneously
// honors: deterministic turn_ref at append, append-only history, and additive runtime/delta
// attachment with no historical mutation of the committed judgment.

import { createHash } from "node:crypto";

import { canonicalScopeJson, type ScopePrivacyMode } from "./scope-capsule.js";

export const JUDGMENT_LEDGER_VERSION = "judgment-ledger/v1";

export type JudgmentVerdictKind = "APPROVED" | "ESCALATED" | "REFUSED";

export type JudgmentVerdictSource =
  | "scope_gate" // refused/escalated PRE-BIND by the adapter structural scope check
  | "bind" // resolved by the hosted bind() — anchored to a signed receipt
  | "loop_bound"; // refused INSIDE the loop mutex by the sealed bounds.max_steps

/** The proposed consequential move, structurally described — NEVER plaintext. */
export type JudgmentProposedMove = {
  action_class: string;
  tool_name: string;
  /** sha256 of the resolved target (single), a stable SET DIGEST (multi-target), or null. */
  target_descriptor: string | null;
  /** Per-target sha256 hashes (multi-target), so membership is re-validatable at export. */
  target_descriptors?: string[];
};

export type JudgmentVerdict = {
  kind: JudgmentVerdictKind;
  source: JudgmentVerdictSource;
  /** Signed receipt anchor — present iff the verdict came from bind(). */
  receipt_id?: string;
  /** Attested scope-event anchor — present iff source is scope_gate / loop_bound. */
  scope_event_hash?: string;
  /** Structural reason code (e.g. matched_rule); never plaintext plan content. */
  reason_code?: string;
};

/**
 * Structural runtime report for a FORWARDED (APPROVED) call. The runtime result/error is
 * HASHED, never interpreted: Lyhna links what the runtime returned but makes NO claim that
 * it is true/correct. Proof Mode strips nothing here (these are hashes), but the raw runtime
 * result/error is NEVER stored — only its deterministic hash.
 */
export type JudgmentRuntimeReport = {
  returned: boolean;
  result_hash?: string;
  error_hash?: string;
};

/** Supervisor-declared, additive state delta. Verified Context Mode sidecar ONLY. */
export type JudgmentDelta = {
  settled?: string[];
  open_questions?: string[];
  next_actions?: string[];
  changed?: string[];
};

export type JudgmentTurn = {
  loop_id: string;
  turn_index: number;

  prior_turn_ref: string | null;
  prior_receipt_id: string | null;
  scope_ref: string;

  proposed: JudgmentProposedMove;
  verdict: JudgmentVerdict;

  /** Additive, attached AFTER the forward. Excluded from turn_ref. */
  runtime_report?: JudgmentRuntimeReport;
  /** Additive, supervisor-declared, Verified Context only. Excluded from turn_ref. */
  declared_delta?: JudgmentDelta;

  turn_ref: string;
};

/** The judgment-core input the recorder appends (turn_index / prior_turn_ref / turn_ref derived). */
export type JudgmentTurnInput = {
  loop_id: string;
  scope_ref: string;
  prior_receipt_id: string | null;
  proposed: JudgmentProposedMove;
  verdict: JudgmentVerdict;
};

/** The closed delta key set — anything else fails closed (a plaintext field could only arrive as one). */
const DELTA_KEYS = new Set(["settled", "open_questions", "next_actions", "changed"]);

/**
 * Normalize a proposed move to its CLOSED structural projection (explicit allowlist, never a
 * spread) so an unknown/plaintext key can never ride into the hashed turn core or an export.
 */
export function normalizeProposed(proposed: JudgmentProposedMove): JudgmentProposedMove {
  const out: JudgmentProposedMove = {
    action_class: proposed.action_class,
    tool_name: proposed.tool_name,
    target_descriptor: proposed.target_descriptor ?? null
  };
  if (proposed.target_descriptors && proposed.target_descriptors.length > 0) {
    out.target_descriptors = [...proposed.target_descriptors];
  }
  return out;
}

/** Normalize a verdict to its CLOSED structural projection (explicit allowlist, never a spread). */
export function normalizeVerdict(verdict: JudgmentVerdict): JudgmentVerdict {
  const out: JudgmentVerdict = { kind: verdict.kind, source: verdict.source };
  if (verdict.receipt_id !== undefined) out.receipt_id = verdict.receipt_id;
  if (verdict.scope_event_hash !== undefined) out.scope_event_hash = verdict.scope_event_hash;
  if (verdict.reason_code !== undefined) out.reason_code = verdict.reason_code;
  return out;
}

/**
 * The judgment CORE that turn_ref commits — everything fixed at decision time. runtime_report
 * and declared_delta are deliberately excluded (additive post-hoc anchors; see file header).
 */
export function turnCore(turn: {
  loop_id: string;
  turn_index: number;
  prior_turn_ref: string | null;
  prior_receipt_id: string | null;
  scope_ref: string;
  proposed: JudgmentProposedMove;
  verdict: JudgmentVerdict;
}): Record<string, unknown> {
  return {
    loop_id: turn.loop_id,
    turn_index: turn.turn_index,
    prior_turn_ref: turn.prior_turn_ref ?? null,
    prior_receipt_id: turn.prior_receipt_id ?? null,
    scope_ref: turn.scope_ref,
    proposed: normalizeProposed(turn.proposed),
    verdict: normalizeVerdict(turn.verdict)
  };
}

/**
 * Derive `turn_ref` = "turn_v1:" + sha256(canonical judgment core). Deterministic over the
 * core only; runtime_report / declared_delta never affect it (so they can attach additively).
 */
export function deriveTurnRef(turn: Parameters<typeof turnCore>[0]): string {
  return `turn_v1:${createHash("sha256").update(canonicalScopeJson(turnCore(turn)), "utf8").digest("hex")}`;
}

// --- runtime hashing (TOTAL, linked, NEVER interpreted) -----------------------

/**
 * TOTAL, deterministic serialization fallback for values canonical JSON cannot express. The
 * runtime hash must exist for EVERY forwarded call ("hashed, never interpreted" is unconditional),
 * so cycles, BigInt, undefined, functions, symbols, and Errors all serialize to a stable tagged
 * form instead of throwing. Sorted keys + cycle markers keep it deterministic; nothing is read
 * beyond structure (no interpretation).
 */
function totalSerialize(value: unknown, seen: Set<unknown> = new Set()): string {
  if (value === null) return "null";
  if (value === undefined) return "#undefined";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number" || t === "boolean") return String(value);
  if (t === "bigint") return `#bigint:${String(value)}`;
  if (t === "function") return `#function:${(value as { name?: string }).name ?? ""}`;
  if (t === "symbol") return `#symbol:${String(value)}`;
  if (value instanceof Error) {
    return `#error:${JSON.stringify({ name: value.name, message: value.message })}`;
  }
  if (seen.has(value)) return "#cycle";
  seen.add(value);
  let out: string;
  if (Array.isArray(value)) {
    out = `[${value.map((v) => totalSerialize(v, seen)).join(",")}]`;
  } else {
    const record = value as Record<string, unknown>;
    out = `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${totalSerialize(record[k], seen)}`)
      .join(",")}}`;
  }
  seen.delete(value);
  return out;
}

/**
 * Serialize ANY value deterministically without throwing: the canonical sorted-key JSON when the
 * value is canonicalizable (hash-stable with prior packs), the total tagged fallback otherwise,
 * and a constant marker as the last resort (e.g. pathological nesting depth) — still deterministic
 * for the same input. Same input -> same string, always.
 */
function safeSerialize(value: unknown): string {
  try {
    const canonical = canonicalScopeJson(value);
    // JSON.stringify returns undefined (not a string) for bare undefined/function/symbol.
    if (typeof canonical === "string") return canonical;
  } catch {
    // Not canonicalizable (cycle / BigInt / overflow) — fall through to the total form.
  }
  try {
    return totalSerialize(value);
  } catch {
    return "#unserializable";
  }
}

/**
 * Deterministically hash a FORWARDED call's runtime RESULT — TOTAL: it never throws, so every
 * forwarded call carries a runtime hash unconditionally. Lyhna links what the runtime returned but
 * makes NO claim it is true/correct — only its content-addressed hash is kept (the raw result is
 * never stored, so a Proof Mode pack carries no runtime plaintext). The hash reads a copy; the
 * forwarded payload returned to the agent is never mutated.
 */
export function hashRuntimeResult(result: unknown): string {
  return `sha256:${createHash("sha256").update(safeSerialize(result ?? null), "utf8").digest("hex")}`;
}

/**
 * Deterministically hash a FORWARDED call's runtime ERROR — TOTAL: it never throws. Reduced to a
 * stable structural projection ({name,message} for an Error, else a safely-serialized value) and
 * hashed — never stored raw, never interpreted as a truth signal about the run.
 */
export function hashRuntimeError(error: unknown): string {
  const projection =
    error instanceof Error
      ? { kind: "error", name: error.name, message: error.message }
      : { kind: "value", value: typeof error === "string" ? error : safeSerialize(error ?? null) };
  return `sha256:${createHash("sha256").update(canonicalScopeJson(projection), "utf8").digest("hex")}`;
}

// --- delta / runtime validation ----------------------------------------------

/** Fail-closed validation that a supervisor delta carries ONLY the closed string-array keys. */
export function assertValidDelta(delta: unknown): asserts delta is JudgmentDelta {
  if (delta === null || typeof delta !== "object" || Array.isArray(delta)) {
    throw new Error("Judgment delta must be an object (fail closed).");
  }
  for (const [key, value] of Object.entries(delta)) {
    if (!DELTA_KEYS.has(key)) {
      throw new Error(`Judgment delta has unknown field "${key}"; only settled/open_questions/next_actions/changed are allowed (fail closed).`);
    }
    if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) {
      throw new Error(`Judgment delta field "${key}" must be an array of strings (fail closed).`);
    }
  }
}

/** Normalize a delta to its closed projection (explicit allowlist), dropping empty arrays. */
export function normalizeDelta(delta: JudgmentDelta): JudgmentDelta {
  const out: JudgmentDelta = {};
  if (delta.settled && delta.settled.length > 0) out.settled = [...delta.settled];
  if (delta.open_questions && delta.open_questions.length > 0) out.open_questions = [...delta.open_questions];
  if (delta.next_actions && delta.next_actions.length > 0) out.next_actions = [...delta.next_actions];
  if (delta.changed && delta.changed.length > 0) out.changed = [...delta.changed];
  return out;
}

/** Merge two deltas additively (append-only; later values appended after earlier). */
export function mergeDelta(prior: JudgmentDelta | undefined, next: JudgmentDelta): JudgmentDelta {
  const base = prior ?? {};
  const out: JudgmentDelta = {};
  const settled = [...(base.settled ?? []), ...(next.settled ?? [])];
  const open = [...(base.open_questions ?? []), ...(next.open_questions ?? [])];
  const nextActions = [...(base.next_actions ?? []), ...(next.next_actions ?? [])];
  const changed = [...(base.changed ?? []), ...(next.changed ?? [])];
  if (settled.length > 0) out.settled = settled;
  if (open.length > 0) out.open_questions = open;
  if (nextActions.length > 0) out.next_actions = nextActions;
  if (changed.length > 0) out.changed = changed;
  return out;
}

/** Fail-closed validation of a structural runtime report (booleans + hash strings only). */
export function assertValidRuntimeReport(report: unknown): asserts report is JudgmentRuntimeReport {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Runtime report must be an object (fail closed).");
  }
  const r = report as Record<string, unknown>;
  if (typeof r.returned !== "boolean") {
    throw new Error("Runtime report `returned` must be a boolean (fail closed).");
  }
  for (const key of Object.keys(r)) {
    if (key !== "returned" && key !== "result_hash" && key !== "error_hash") {
      throw new Error(`Runtime report has unknown field "${key}" (fail closed).`);
    }
  }
  if (r.result_hash !== undefined && typeof r.result_hash !== "string") {
    throw new Error("Runtime report `result_hash` must be a string (fail closed).");
  }
  if (r.error_hash !== undefined && typeof r.error_hash !== "string") {
    throw new Error("Runtime report `error_hash` must be a string (fail closed).");
  }
}

// --- projections -------------------------------------------------------------

/**
 * Project one turn for Proof Mode (content-blind): explicit allowlist, STRIPS the plaintext
 * `declared_delta`. runtime_report is structural (hashes only) and is retained.
 */
export function projectTurnProofMode(turn: JudgmentTurn): JudgmentTurn {
  return buildProjectedTurn(turn, false);
}

/** Project one turn for Verified Context Mode: explicit allowlist, retains `declared_delta`. */
export function projectTurnVerifiedContext(turn: JudgmentTurn): JudgmentTurn {
  return buildProjectedTurn(turn, true);
}

export function projectTurn(turn: JudgmentTurn, mode: ScopePrivacyMode): JudgmentTurn {
  return mode === "verified_context" ? projectTurnVerifiedContext(turn) : projectTurnProofMode(turn);
}

function buildProjectedTurn(turn: JudgmentTurn, withDelta: boolean): JudgmentTurn {
  // Reconstruct from an EXPLICIT allowlist — never spread the (possibly JSON-loaded) turn. A stale
  // or tampered turn could carry arbitrary extra keys (e.g. `notes`, `plan`) that would otherwise
  // leak into a content-blind pack alongside a valid turn_ref.
  const projected: JudgmentTurn = {
    loop_id: turn.loop_id,
    turn_index: turn.turn_index,
    prior_turn_ref: turn.prior_turn_ref ?? null,
    prior_receipt_id: turn.prior_receipt_id ?? null,
    scope_ref: turn.scope_ref,
    proposed: normalizeProposed(turn.proposed),
    verdict: normalizeVerdict(turn.verdict),
    turn_ref: turn.turn_ref
  };
  if (turn.runtime_report) {
    const rr: JudgmentRuntimeReport = { returned: turn.runtime_report.returned };
    if (turn.runtime_report.result_hash !== undefined) rr.result_hash = turn.runtime_report.result_hash;
    if (turn.runtime_report.error_hash !== undefined) rr.error_hash = turn.runtime_report.error_hash;
    projected.runtime_report = rr;
  }
  if (withDelta && turn.declared_delta) {
    projected.declared_delta = normalizeDelta(turn.declared_delta);
  }
  return projected;
}

// --- chain validation --------------------------------------------------------

/** The closed sets of verdict kind / source. A ledger loaded from JSON is untyped, so the chain
 * validator enforces these at runtime — an unknown source would otherwise dodge the export's
 * source-keyed cross-checks (bind vs scope/loop-bound) yet still be folded by the reducer. */
const KNOWN_VERDICT_KINDS = new Set<JudgmentVerdictKind>(["APPROVED", "ESCALATED", "REFUSED"]);
const KNOWN_VERDICT_SOURCES = new Set<JudgmentVerdictSource>(["bind", "scope_gate", "loop_bound"]);

export type JudgmentChainVerification =
  | { valid: true; loop_id: string | null; turn_count: number; final_turn_ref: string | null }
  | { valid: false; reason: string };

/**
 * Validate a judgment ledger as an append-only, contiguous, hash-linked chain:
 *   - turn_index is contiguous from 0
 *   - the first turn has prior_turn_ref null; each later turn points at its predecessor's turn_ref
 *   - every turn_ref recomputes from the turn's judgment core (no tampering)
 *   - no duplicate / missing turn_ref
 *   - all turns share one loop_id
 * Fail-closed: any gap, broken prior ref, duplicate, or malformed turn rejects the whole chain.
 */
export function validateJudgmentChain(turns: readonly JudgmentTurn[]): JudgmentChainVerification {
  if (turns.length === 0) {
    return { valid: true, loop_id: null, turn_count: 0, final_turn_ref: null };
  }
  const seen = new Set<string>();
  let expectedPrior: string | null = null;
  const loopId = turns[0]!.loop_id;

  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i]!;
    if (!turn || typeof turn !== "object") {
      return { valid: false, reason: `turn at index ${i} is malformed` };
    }
    if (turn.loop_id !== loopId) {
      return { valid: false, reason: `loop_id mismatch at turn ${i}` };
    }
    if (turn.turn_index !== i) {
      return { valid: false, reason: `non-contiguous turn_index at position ${i} (got ${turn.turn_index})` };
    }
    if (typeof turn.turn_ref !== "string" || turn.turn_ref.length === 0) {
      return { valid: false, reason: `missing turn_ref at turn ${i}` };
    }
    // Fail closed on an unknown verdict kind / source (a JSON-loaded ledger is untyped). An unknown
    // source would otherwise slip past the export's source-keyed cross-checks while still being folded.
    if (!turn.verdict || typeof turn.verdict !== "object") {
      return { valid: false, reason: `missing verdict at turn ${i}` };
    }
    if (!KNOWN_VERDICT_KINDS.has(turn.verdict.kind)) {
      return { valid: false, reason: `unknown verdict.kind ${JSON.stringify(turn.verdict.kind)} at turn ${i}` };
    }
    if (!KNOWN_VERDICT_SOURCES.has(turn.verdict.source)) {
      return { valid: false, reason: `unknown verdict.source ${JSON.stringify(turn.verdict.source)} at turn ${i}` };
    }
    if (seen.has(turn.turn_ref)) {
      return { valid: false, reason: `duplicate turn_ref at turn ${i}` };
    }
    if ((turn.prior_turn_ref ?? null) !== expectedPrior) {
      return { valid: false, reason: `broken prior_turn_ref chain at turn ${i}` };
    }
    const recomputed = deriveTurnRef(turn);
    if (recomputed !== turn.turn_ref) {
      return { valid: false, reason: `turn_ref at turn ${i} does not match its judgment core (tampered or stale)` };
    }
    seen.add(turn.turn_ref);
    expectedPrior = turn.turn_ref;
  }

  return {
    valid: true,
    loop_id: loopId,
    turn_count: turns.length,
    final_turn_ref: turns[turns.length - 1]!.turn_ref
  };
}

// --- markdown projection -----------------------------------------------------

/**
 * Render a judgment ledger to human-readable markdown that RESPECTS the privacy mode: Proof
 * Mode carries only structural refs/hashes (no plaintext delta); Verified Context Mode also
 * lists the supervisor-declared deltas.
 */
export function renderJudgmentLedgerMarkdown(
  loop_id: string,
  turns: readonly JudgmentTurn[],
  mode: ScopePrivacyMode
): string {
  const lines = [
    `# Judgment Ledger`,
    ``,
    `| field | value |`,
    `| --- | --- |`,
    `| loop_id | \`${loop_id}\` |`,
    `| version | \`${JUDGMENT_LEDGER_VERSION}\` |`,
    `| mode | \`${mode}\` |`,
    `| turns | ${turns.length} |`,
    `| final_turn_ref | \`${turns.length ? turns[turns.length - 1]!.turn_ref : "—"}\` |`,
    ``,
    `> ${mode === "proof" ? "Content-blind: structural refs / hashes only — no plaintext deltas." : "Verified Context: includes supervisor-declared sidecar deltas."}`,
    ``,
    `## Turns`,
    ``
  ];
  for (const t of turns) {
    const proj = projectTurn(t, mode);
    const anchor =
      proj.verdict.receipt_id !== undefined
        ? `receipt \`${proj.verdict.receipt_id}\``
        : proj.verdict.scope_event_hash !== undefined
          ? `scope-event \`${proj.verdict.scope_event_hash}\``
          : `—`;
    lines.push(
      `### Turn ${proj.turn_index} — **${proj.verdict.kind}** (${proj.verdict.source})`,
      ``,
      `- proposed: \`${proj.proposed.action_class}\` / \`${proj.proposed.tool_name}\` / target \`${proj.proposed.target_descriptor ?? "—"}\``,
      `- anchor: ${anchor}${proj.verdict.reason_code ? ` (reason: ${proj.verdict.reason_code})` : ""}`,
      `- inherits: prior_turn_ref \`${proj.prior_turn_ref ?? "root"}\`, prior_receipt_id \`${proj.prior_receipt_id ?? "loop-open"}\``,
      `- scope_ref: \`${proj.scope_ref}\``,
      `- turn_ref: \`${proj.turn_ref}\``
    );
    if (proj.runtime_report) {
      lines.push(
        `- runtime: returned=${proj.runtime_report.returned}` +
          (proj.runtime_report.result_hash ? `, result_hash \`${proj.runtime_report.result_hash}\`` : "") +
          (proj.runtime_report.error_hash ? `, error_hash \`${proj.runtime_report.error_hash}\`` : "") +
          ` (hashed, not interpreted)`
      );
    }
    if (mode === "verified_context" && proj.declared_delta) {
      const d = proj.declared_delta;
      if (d.settled?.length) lines.push(`- settled: ${d.settled.join("; ")}`);
      if (d.open_questions?.length) lines.push(`- open: ${d.open_questions.join("; ")}`);
      if (d.next_actions?.length) lines.push(`- next: ${d.next_actions.join("; ")}`);
      if (d.changed?.length) lines.push(`- changed: ${d.changed.join("; ")}`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}
