// Stage E — offline two-pack cross-loop linkage checker.
//
// Given TWO exported proof-pack directories — the PRIOR loop's pack and the CURRENT (child) loop's
// pack — re-verify the cross-loop inheritance claims from the artifacts alone, without trusting the
// exporter that wrote them:
//
//   1. the child's sealed `inherits_loop` triple recomputes against the prior pack's continuation
//      (capsule_ref / scope_ref / final_turn_ref — identity binding);
//   2. the prior pack is internally consistent: its judgment ledger chain-validates and RE-FOLDS to
//      exactly the state its continuation publishes (non-circular value binding);
//   3. that state hashes to the child's sealed `inherits_state_hash` commitment — which is part of
//      the child's scope_ref and therefore stamped into the child's signed receipt chain;
//   4. both receipt chains pass the in-repo STRUCTURAL check (continuity, terminal close, counts),
//      and the child's commitment-bearing scope_ref is actually stamped by a signed in-loop receipt.
//
// TRUST BOUNDARY (architect contract, stated verbatim in every report): Ed25519 signature
// verification is OUT OF SCOPE for this checker. It never shells out and never claims crypto.
// The structural chain check is local continuity/shape only; to trust the signatures, re-run the
// independent verifier on BOTH chains:
//
//   npx -y lyhna-verify --chain <prior-pack>/receipts.json
//   npx -y lyhna-verify --chain <current-pack>/receipts.json
//
// The checker is pure, local, and deterministic: it reads the two directories, computes, and
// returns a structured report. It performs no network access and spawns no subprocess.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ContinuationCapsule } from "./continuation-capsule.js";
import type { JudgmentTurn } from "./judgment-ledger.js";
import { reduceJudgmentLedger } from "./judgment-reducer.js";
import { deriveContinuationRef } from "./loop-proof-bundle.js";
import { verifyLoopChain, type LoopChainLink } from "./loop.js";
import {
  canonicalScopeJson,
  deriveInheritsStateHash,
  deriveScopeRef,
  type ScopeCapsuleExport,
  type ScopeInheritsLoop
} from "./scope-capsule.js";
import { deriveScopeEventHash } from "./scope-event-recorder.js";

export type CrossLoopCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type CrossLoopLinkageReport = {
  ok: boolean;
  prior_pack: string;
  current_pack: string;
  checks: CrossLoopCheck[];
  /**
   * Always present, pass or fail: this checker NEVER verifies Ed25519 signatures. The wording is
   * part of the contract — a linkage PASS must not read as full verification.
   */
  signature_notice: string;
  /** Cold-verify both signed chains with the independent, trust-no-one verifier. */
  verify_commands: [string, string];
};

const SIGNATURE_NOTICE =
  "Signature verification not performed here. Re-run lyhna-verify on both receipt chains to trust signatures.";

/** The plaintext lineage-state arrays, absent normalized to []. */
function plainState(s: { settled?: string[]; open_questions?: string[]; next_actions?: string[]; changed?: string[] }) {
  return {
    settled: s.settled ?? [],
    open_questions: s.open_questions ?? [],
    next_actions: s.next_actions ?? [],
    changed: s.changed ?? []
  };
}

/** Map exported receipts to the structural chain-verifier's link shape. */
function asChainLinks(receipts: unknown[]): LoopChainLink[] {
  return receipts.map((r) => {
    const rec = r as { receipt_id?: unknown; constraints?: { loop?: unknown; loop_close?: unknown } };
    return {
      receipt_id: typeof rec.receipt_id === "string" ? rec.receipt_id : "",
      loop: (rec.constraints?.loop ?? null) as LoopChainLink["loop"],
      loop_close: (rec.constraints?.loop_close ?? null) as LoopChainLink["loop_close"]
    };
  });
}

/** `a` begins with `b` (the child's folded state must carry the inherited prefix FIRST). */
function hasPrefix(a: string[], b: string[]): boolean {
  return b.every((v, i) => a[i] === v);
}

/**
 * Every receipt in the chain that carries a loop / loop_close constraint must cite the SAME
 * goal_hash the continuation claims — the structural chain check verifies internal consistency,
 * not that the chain belongs to THIS capsule's goal. Returns the failing detail or null.
 */
function chainGoalBinds(receipts: unknown[], expected_goal_hash: unknown, label: string): string | null {
  for (const r of receipts) {
    const rec = r as {
      receipt_id?: unknown;
      constraints?: { loop?: { goal_hash?: unknown }; loop_close?: { goal_hash?: unknown } };
    };
    // A loop / loop_close constraint with NO goal_hash fails closed too: a chain that never cites
    // the goal cannot be said to bind to the continuation's goal (absence is not agreement).
    for (const c of [rec.constraints?.loop, rec.constraints?.loop_close]) {
      if (c === undefined || c === null) continue;
      const gh = (c as { goal_hash?: unknown }).goal_hash;
      if (gh === undefined) {
        return (
          `${label} chain receipt ${JSON.stringify(rec.receipt_id)} carries a loop constraint with no goal_hash; ` +
          `the chain cannot be bound to the ${label} continuation's goal (fail closed).`
        );
      }
      if (gh !== expected_goal_hash) {
        return (
          `${label} chain receipt ${JSON.stringify(rec.receipt_id)} cites goal_hash ${JSON.stringify(gh)} but the ` +
          `${label} continuation claims ${JSON.stringify(expected_goal_hash)}; the signed chain belongs to a ` +
          `different goal than the capsule beside it (fail closed).`
        );
      }
    }
  }
  return null;
}

/**
 * Bind a ledger's scope-event-anchored turns (scope_gate / loop_bound verdicts) to the pack's
 * scope-events.json: each cited scope_event_hash must belong to an event that RECOMPUTES to its own
 * event_hash (deriveScopeEventHash — a tampered event file fails) and belongs to the expected loop.
 * Without this, a turn's self-reported anchor would be trusted bare and a tampered/missing
 * scope-events.json could ride beside a fold it never substantiated. Returns failing detail or null.
 */
type AttestedEvent = {
  decision?: unknown;
  matched_rule?: unknown;
  scope_ref?: unknown;
  prior_receipt_id?: unknown;
  attempted?: { action_class?: unknown; tool_name?: unknown; target_descriptor?: unknown };
};

function bindEventTurnsToEvents(turns: unknown[], events: unknown, expected_loop_id: string, label: string): string | null {
  const anchored = (
    turns as Array<{
      turn_index?: number;
      scope_ref?: unknown;
      prior_receipt_id?: unknown;
      proposed?: { action_class?: unknown; tool_name?: unknown; target_descriptor?: unknown };
      verdict?: { kind?: unknown; source?: string; reason_code?: unknown; scope_event_hash?: string };
    }>
  ).filter((t) => (t.verdict?.source === "scope_gate" || t.verdict?.source === "loop_bound") && typeof t.verdict?.scope_event_hash === "string");
  if (!Array.isArray(events)) {
    // No readable scope-events.json. Fine ONLY if the ledger anchors none; if it anchors any, those
    // turns cannot be substantiated.
    if (anchored.length === 0) return null;
    return (
      `${label} ledger carries ${anchored.length} scope-event-anchored turn(s) but the ${label} pack has no ` +
      `readable scope-events.json array to substantiate them (fail closed).`
    );
  }
  // events IS an array (possibly empty) — scan it EVEN WHEN anchored.length === 0. Otherwise a pack
  // could drop every scope_gate / loop_bound turn from the ledger + continuation while leaving the
  // attested events in the file; the truncated ledger re-folds to a truncated continuation and the
  // reverse check below (every verified event must be anchored) is what catches the omission.
  const verified = new Map<string, AttestedEvent>();
  for (const e of events) {
    const ev = e as Parameters<typeof deriveScopeEventHash>[0] & AttestedEvent & { event_hash?: unknown; loop_id?: unknown };
    let recomputed: string;
    try {
      recomputed = deriveScopeEventHash(ev);
    } catch (error) {
      return `${label} pack scope-events.json contains an event that cannot be hashed (${(error as Error).message}); fail closed.`;
    }
    if (recomputed !== ev.event_hash) {
      return (
        `${label} pack scope-events.json event recomputes to ${recomputed} but declares event_hash ` +
        `${JSON.stringify(ev.event_hash)} (tampered — fail closed).`
      );
    }
    if (ev.loop_id !== expected_loop_id) {
      return `${label} pack scope-events.json event ${recomputed} belongs to loop ${JSON.stringify(ev.loop_id)} rather than ${expected_loop_id} (fail closed).`;
    }
    verified.set(recomputed, ev);
  }
  // CONTENT binding (mirror the exporter): the event_hash commits the event's decision, matched_rule,
  // attempted descriptor, prior_receipt_id, and scope_ref — so a turn anchoring a real event hash is
  // not enough. The turn's verdict/source/reason_code/proposed/prior_receipt_id/scope_ref must MATCH
  // the attested event; otherwise, in a pack with several attested events, a turn could cite an
  // unrelated valid same-loop event and have its (refused/escalated) fold pass unsubstantiated.
  const anchoredHashes = new Set<string>();
  for (const t of anchored) {
    const h = t.verdict!.scope_event_hash!;
    const ev = verified.get(h);
    if (!ev) {
      return (
        `${label} ledger turn ${t.turn_index} cites scope_event_hash ${h}, which is not among the ${label} pack's ` +
        `verified scope events (fail closed).`
      );
    }
    if (anchoredHashes.has(h)) {
      return `${label} attested scope event ${h} is anchored by more than one judgment turn (fail closed).`;
    }
    anchoredHashes.add(h);
    if (t.verdict!.kind !== ev.decision) {
      return (
        `${label} ledger turn ${t.turn_index} verdict ${JSON.stringify(t.verdict!.kind)} does not match attested ` +
        `scope event ${h} decision ${JSON.stringify(ev.decision)} (fail closed).`
      );
    }
    // A max_steps event is a loop_bound halt; every other attested scope event is a scope_gate refusal.
    const expectedSource = ev.matched_rule === "max_steps" ? "loop_bound" : "scope_gate";
    if (t.verdict!.source !== expectedSource) {
      return (
        `${label} ledger turn ${t.turn_index} source ${JSON.stringify(t.verdict!.source)} does not match attested ` +
        `scope event ${h} (matched_rule ${JSON.stringify(ev.matched_rule)} implies ${expectedSource}); fail closed.`
      );
    }
    if ((t.verdict!.reason_code ?? null) !== (ev.matched_rule ?? null)) {
      return (
        `${label} ledger turn ${t.turn_index} reason_code ${JSON.stringify(t.verdict!.reason_code ?? null)} does not ` +
        `match attested scope event ${h} matched_rule ${JSON.stringify(ev.matched_rule ?? null)} (fail closed).`
      );
    }
    const p = t.proposed ?? {};
    if (
      p.action_class !== ev.attempted?.action_class ||
      p.tool_name !== ev.attempted?.tool_name ||
      (p.target_descriptor ?? null) !== (ev.attempted?.target_descriptor ?? null)
    ) {
      return (
        `${label} ledger turn ${t.turn_index} proposed descriptor does not match the descriptor committed by ` +
        `attested scope event ${h} (fail closed).`
      );
    }
    if ((t.prior_receipt_id ?? null) !== (ev.prior_receipt_id ?? null)) {
      return (
        `${label} ledger turn ${t.turn_index} inherits prior_receipt_id ${JSON.stringify(t.prior_receipt_id ?? null)} ` +
        `but attested scope event ${h} is anchored to ${JSON.stringify(ev.prior_receipt_id ?? null)} (fail closed).`
      );
    }
    if ((t.scope_ref ?? null) !== (ev.scope_ref ?? null)) {
      return (
        `${label} ledger turn ${t.turn_index} cites scope_ref ${JSON.stringify(t.scope_ref ?? null)} but attested ` +
        `scope event ${h} commits scope_ref ${JSON.stringify(ev.scope_ref ?? null)} (fail closed).`
      );
    }
  }
  // REVERSE direction (mirror the exporter): every verified attested event must be anchored by a turn.
  // Otherwise a pack could drop an attested refusal / loop-bound step from the ledger + continuation
  // while leaving the (verified) event file in place — the fold would then UNDER-report refused /
  // max-step steps and still certify. Exactly-once is already enforced by the duplicate guard above.
  for (const h of verified.keys()) {
    if (!anchoredHashes.has(h)) {
      return (
        `${label} pack scope-events.json carries attested scope event ${h} that NO judgment turn anchors — the ` +
        `ledger / continuation under-reports a refused / loop-bound step (fail closed).`
      );
    }
  }
  return null;
}

/**
 * Bind a ledger's bind-verdict turns to the chain that ships beside it: every cited receipt must be
 * PRESENT in that pack's receipts.json, in the expected loop, with the EXACT verdict outcome (both
 * directions — a ledger REFUSED/ESCALATED unbacked by the signed chain is as forged as an APPROVED)
 * and a PRESENT, agreeing scope stamp. Returns the failing detail, or null when every turn binds.
 * Used identically for the prior and the current ledgers — a fold's authority always comes from the
 * chain it ships with, never from the (unsigned) ledger fields alone.
 */
function bindLedgerTurnsToChain(turns: unknown[], receipts: unknown[], expected_loop_id: string, label: string): string | null {
  const byId = new Map<
    string,
    { outcome?: unknown; loop_id?: unknown; scope_ref?: unknown; action_class?: unknown; tool_name?: unknown; target_descriptor?: unknown; target_descriptors?: unknown }
  >();
  for (const r of receipts) {
    const rec = r as {
      receipt_id?: unknown;
      outcome?: unknown;
      constraints?: {
        loop?: { loop_id?: unknown };
        scope?: { scope_ref?: unknown; action_class?: unknown; tool_name?: unknown; target_descriptor?: unknown; target_descriptors?: unknown };
      };
    };
    if (typeof rec.receipt_id === "string") {
      byId.set(rec.receipt_id, {
        outcome: rec.outcome,
        loop_id: rec.constraints?.loop?.loop_id,
        scope_ref: rec.constraints?.scope?.scope_ref,
        action_class: rec.constraints?.scope?.action_class,
        tool_name: rec.constraints?.scope?.tool_name,
        target_descriptor: rec.constraints?.scope?.target_descriptor,
        target_descriptors: rec.constraints?.scope?.target_descriptors
      });
    }
  }
  // Canonical (order-independent) per-target hash list, mirroring the exporter's bind so a tampered
  // ledger cannot reorder/alter the individual target hashes while the receipt proves a different set.
  const canonTargets = (v: unknown): string | undefined =>
    Array.isArray(v) ? JSON.stringify([...(v as unknown[])].map((x) => String(x)).sort()) : undefined;
  // Forward direction: every bind-verdict turn must cite a receipt the chain carries (checked in
  // the loop below). Reverse direction: count citations, then require every IN-LOOP receipt to be
  // recorded by EXACTLY ONE bind turn — a ledger that omits a turn for a real signed in-loop
  // receipt is truncated, and its fold silently drops that step's delta (fail closed).
  const citedCount = new Map<string, number>();
  for (const t of turns) {
    const turn = t as {
      turn_index?: number;
      scope_ref?: string;
      proposed?: { action_class?: unknown; tool_name?: unknown; target_descriptor?: unknown; target_descriptors?: unknown };
      verdict?: { kind?: string; source?: string; receipt_id?: string };
    };
    const v = turn.verdict;
    if (v?.source !== "bind" || typeof v.receipt_id !== "string") continue;
    citedCount.set(v.receipt_id, (citedCount.get(v.receipt_id) ?? 0) + 1);
    const r = byId.get(v.receipt_id);
    if (!r) {
      return (
        `${label} ledger turn ${turn.turn_index} cites receipt ${v.receipt_id}, which is not present in the ` +
        `${label} pack's receipts.json — the ledger does not belong to the presented chain (fail closed).`
      );
    }
    if (r.loop_id !== expected_loop_id) {
      return (
        `${label} ledger turn ${turn.turn_index} cites receipt ${v.receipt_id}, which belongs to loop ` +
        `${JSON.stringify(r.loop_id)} rather than ${expected_loop_id} (fail closed).`
      );
    }
    if (r.outcome !== v.kind) {
      return (
        `${label} ledger turn ${turn.turn_index} records a ${v.kind} bind on receipt ${v.receipt_id}, but the ` +
        `chain receipt's outcome is ${JSON.stringify(r.outcome)} (fail closed).`
      );
    }
    // The stamp must be PRESENT and agree: a bind-cited in-loop receipt with no scope stamp would
    // let the fold be treated as scoped on the strength of the (unsigned) ledger field alone.
    if (r.scope_ref === undefined) {
      return (
        `${label} ledger turn ${turn.turn_index} cites receipt ${v.receipt_id}, which carries no ` +
        `constraints.scope.scope_ref stamp; the turn's scope cannot be substantiated by the chain (fail closed).`
      );
    }
    if (r.scope_ref !== turn.scope_ref) {
      return (
        `${label} ledger turn ${turn.turn_index} ran under scope_ref ${turn.scope_ref} but receipt ${v.receipt_id} ` +
        `stamps ${JSON.stringify(r.scope_ref)} (fail closed).`
      );
    }
    // Bind the turn's PROPOSED MOVE to the signed constraints.scope descriptor — exactly as the
    // exporter does. Without this, a pack could keep the same receipt_id/outcome/scope_ref but edit
    // turn.proposed (action_class/tool_name/target hash), and the reducer would re-fold and publish an
    // action identity the signed receipt never authorized (fail closed). target_descriptors (multi-
    // target tools) is compared canonically; both absent is a match.
    const p = turn.proposed ?? {};
    if (
      p.action_class !== r.action_class ||
      p.tool_name !== r.tool_name ||
      (p.target_descriptor ?? null) !== (r.target_descriptor ?? null) ||
      canonTargets(p.target_descriptors) !== canonTargets(r.target_descriptors)
    ) {
      return (
        `${label} ledger turn ${turn.turn_index} proposes ` +
        `${JSON.stringify(p.action_class)}/${JSON.stringify(p.tool_name)}/${JSON.stringify(p.target_descriptor ?? null)} ` +
        `but receipt ${v.receipt_id}'s signed constraints.scope authorizes ` +
        `${JSON.stringify(r.action_class)}/${JSON.stringify(r.tool_name)}/${JSON.stringify(r.target_descriptor ?? null)} ` +
        `(the fold would publish an action identity the receipt did not authorize — fail closed).`
      );
    }
  }
  // Reverse direction: every in-loop receipt the chain carries must be recorded by exactly one
  // bind-verdict turn (the exporter's receipts<->judgment mapping, mirrored read-side).
  for (const r of receipts) {
    const rec = r as { receipt_id?: unknown; constraints?: { loop?: unknown; loop_close?: unknown } };
    const isTerminal = typeof rec.constraints?.loop_close === "object" && rec.constraints?.loop_close !== null;
    const isInLoop = typeof rec.constraints?.loop === "object" && rec.constraints?.loop !== null && !isTerminal;
    if (!isInLoop || typeof rec.receipt_id !== "string") continue;
    const count = citedCount.get(rec.receipt_id) ?? 0;
    if (count === 0) {
      return (
        `${label} chain carries in-loop receipt ${rec.receipt_id} that NO bind-verdict turn in the ${label} ` +
        `ledger records — the ledger is truncated relative to the signed chain, so its fold silently drops ` +
        `that step (fail closed).`
      );
    }
    if (count > 1) {
      return (
        `${label} chain in-loop receipt ${rec.receipt_id} is cited by ${count} bind-verdict turns; exactly one ` +
        `is expected (fail closed).`
      );
    }
  }
  return null;
}

export function verifyCrossLoopLinkage(input: { prior_pack_dir: string; current_pack_dir: string }): CrossLoopLinkageReport {
  const checks: CrossLoopCheck[] = [];
  // BELT AND BRACES (report contract): the checker promises a structured fail-closed report —
  // signature notice and verify commands included — on EVERY outcome. A malformed artifact that
  // slips past the shape checks must degrade to a failing report, never an uncaught exception.
  try {
    return verifyCrossLoopLinkageChecks(input, checks);
  } catch (error) {
    checks.push({
      name: "unexpected_error",
      ok: false,
      detail: `internal error while checking (treat as NOT verified): ${(error as Error).message}`
    });
    return {
      ok: false,
      prior_pack: input.prior_pack_dir,
      current_pack: input.current_pack_dir,
      checks,
      signature_notice: SIGNATURE_NOTICE,
      verify_commands: [
        `npx -y lyhna-verify --chain ${join(input.prior_pack_dir, "receipts.json")}`,
        `npx -y lyhna-verify --chain ${join(input.current_pack_dir, "receipts.json")}`
      ]
    };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function verifyCrossLoopLinkageChecks(
  input: { prior_pack_dir: string; current_pack_dir: string },
  checks: CrossLoopCheck[]
): CrossLoopLinkageReport {
  const report = (ok: boolean): CrossLoopLinkageReport => ({
    ok,
    prior_pack: input.prior_pack_dir,
    current_pack: input.current_pack_dir,
    checks,
    signature_notice: SIGNATURE_NOTICE,
    verify_commands: [
      `npx -y lyhna-verify --chain ${join(input.prior_pack_dir, "receipts.json")}`,
      `npx -y lyhna-verify --chain ${join(input.current_pack_dir, "receipts.json")}`
    ]
  });
  const fail = (name: string, detail: string): CrossLoopLinkageReport => {
    checks.push({ name, ok: false, detail });
    return report(false);
  };
  const pass = (name: string, detail: string): void => {
    checks.push({ name, ok: true, detail });
  };

  // Read a required JSON artifact; a missing/corrupt file is a fail-closed check, not a crash.
  function readJson<T>(dir: string, file: string): { ok: true; value: T } | { ok: false; detail: string } {
    const p = join(dir, file);
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch (error) {
      return { ok: false, detail: `cannot read ${p}: ${(error as Error).message}` };
    }
    try {
      return { ok: true, value: JSON.parse(raw) as T };
    } catch (error) {
      return { ok: false, detail: `${p} is not valid JSON: ${(error as Error).message}` };
    }
  }

  // --- 1) Read both packs (fail closed on missing/corrupt required artifacts) -------------------
  const curScopeR = readJson<ScopeCapsuleExport>(input.current_pack_dir, "scope-capsule.json");
  if (!curScopeR.ok) return fail("read_current_scope_capsule", curScopeR.detail);
  const curContR = readJson<ContinuationCapsule>(input.current_pack_dir, "continuation-capsule.json");
  if (!curContR.ok) return fail("read_current_continuation", curContR.detail);
  const curReceiptsR = readJson<unknown[]>(input.current_pack_dir, "receipts.json");
  if (!curReceiptsR.ok) return fail("read_current_receipts", curReceiptsR.detail);
  const priorContR = readJson<ContinuationCapsule>(input.prior_pack_dir, "continuation-capsule.json");
  if (!priorContR.ok) return fail("read_prior_continuation", priorContR.detail);
  const priorReceiptsR = readJson<unknown[]>(input.prior_pack_dir, "receipts.json");
  if (!priorReceiptsR.ok) return fail("read_prior_receipts", priorReceiptsR.detail);
  const curScope = curScopeR.value;
  const curCont = curContR.value;
  const priorCont = priorContR.value;

  // SHAPE VALIDATION (fail closed, not crash): valid JSON with the wrong shape must produce a
  // failing report, never reach the typed ladder as if it were a real artifact.
  if (!isRecord(curScope) || !isRecord(curScope.structural) || typeof curScope.scope_ref !== "string") {
    return fail(
      "read_current_scope_capsule",
      "scope-capsule.json parses but is not a scope capsule (object with a structural projection and a scope_ref string); fail closed."
    );
  }
  for (const [name, cont, file] of [
    ["read_current_continuation", curCont, "current"],
    ["read_prior_continuation", priorCont, "prior"]
  ] as const) {
    if (!isRecord(cont) || typeof cont.loop_id !== "string" || typeof cont.scope_ref !== "string") {
      return fail(
        name,
        `${file} pack continuation-capsule.json parses but is not a continuation capsule (object with loop_id and scope_ref strings); fail closed.`
      );
    }
  }
  if (!Array.isArray(curReceiptsR.value)) {
    return fail("read_current_receipts", "current pack receipts.json parses but is not a JSON array of receipts; fail closed.");
  }
  if (!Array.isArray(priorReceiptsR.value)) {
    return fail("read_prior_receipts", "prior pack receipts.json parses but is not a JSON array of receipts; fail closed.");
  }
  pass("read_packs", "required artifacts present, parse, and have the expected shapes in both packs");

  // --- 2) Child scope-capsule internal integrity: scope_ref recomputes from the structural ------
  const recomputedScopeRef = deriveScopeRef(curScope.structural);
  if (recomputedScopeRef !== curScope.scope_ref) {
    return fail(
      "current_scope_ref_recomputes",
      `scope-capsule.json scope_ref ${curScope.scope_ref} does not recompute from its structural projection ` +
        `(${recomputedScopeRef}); the capsule is internally inconsistent (fail closed).`
    );
  }
  pass("current_scope_ref_recomputes", `scope_ref ${curScope.scope_ref} recomputes from the structural projection`);

  // --- 2a) Sealed identity binding: the scope must be sealed FOR THIS loop/goal -------------------
  // scope_ref recomputing only proves the capsule is self-consistent — it does NOT prove the opaque
  // scope_ref belongs to THIS loop. The sealed structural carries its own loop_id/goal_hash; a
  // capsule hash-consistently sealed for a DIFFERENT loop could otherwise ride beside this
  // continuation/chain (stampCount only proves some receipt of curCont's loop stamped the opaque
  // scope_ref; signatures, out of scope here, would not prove the scope was sealed for this loop).
  // Mirror the exporter, which binds structural.loop_id/goal_hash to the loop it packages.
  if (curScope.structural.loop_id !== curCont.loop_id) {
    return fail(
      "current_scope_loop_binds",
      `scope-capsule.json is sealed for loop_id ${JSON.stringify(curScope.structural.loop_id)} but the current ` +
        `continuation is loop ${JSON.stringify(curCont.loop_id)}; this scope was not sealed for this loop (fail closed).`
    );
  }
  if (curScope.structural.goal_hash !== curCont.goal_hash) {
    return fail(
      "current_scope_loop_binds",
      `scope-capsule.json is sealed for goal_hash ${JSON.stringify(curScope.structural.goal_hash)} but the current ` +
        `continuation's goal_hash is ${JSON.stringify(curCont.goal_hash)}; this scope was not sealed for this goal (fail closed).`
    );
  }
  // The continuation publishes the FINAL scope_ref the loop ran under, and the exporter builds it FROM
  // the sealed scope — so it must equal curScope.scope_ref. Without this, a continuation edited to
  // publish a different final scope_ref rides through: the commitment stamp check counts receipts for
  // curScope.scope_ref while the published continuation (and any grandchild edge that pins its
  // scope_ref) belongs to an UNSTAMPED scope version.
  if (curCont.scope_ref !== curScope.scope_ref) {
    return fail(
      "current_scope_loop_binds",
      `continuation-capsule.json publishes final scope_ref ${JSON.stringify(curCont.scope_ref)} but the sealed ` +
        `scope-capsule.json scope_ref is ${JSON.stringify(curScope.scope_ref)}; the continuation belongs to a ` +
        `different scope version than the one sealed/stamped for this loop (fail closed).`
    );
  }
  pass("current_scope_loop_binds", "the sealed scope's structural loop_id / goal_hash / scope_ref match the current continuation");

  // --- 2b) Mode honesty: the top-level privacy_mode is the EXPORT mode and is NOT covered by ----
  // scope_ref, so it can be edited freely. Two contradictions are forged shapes (mirroring the
  // exporter's mode contract — downgrading a VC-sealed scope to a proof EXPORT remains legitimate):
  //   (a) an UPGRADE claim: top-level "verified_context" over a sealed structural that is not VC;
  //   (b) a pack CLAIMING proof while its continuation PUBLISHES plaintext state — the classic
  //       dodge: edit the unhashed top-level mode to "proof" so the child-state checks are skipped
  //       while the edited plaintext rides along as if content-blind.
  const curPublishesState = Object.values(plainState(curCont)).some((a) => a.length > 0);
  if (curScope.privacy_mode === "verified_context" && curScope.structural.privacy_mode !== "verified_context") {
    return fail(
      "current_privacy_mode_consistent",
      `scope-capsule.json claims a verified_context export but the SEALED structural privacy_mode is ` +
        `${JSON.stringify(curScope.structural.privacy_mode)}; an export may never be more permissive than the ` +
        `sealed scope (fail closed).`
    );
  }
  if (curScope.privacy_mode !== "verified_context" && curPublishesState) {
    return fail(
      "current_privacy_mode_consistent",
      "scope-capsule.json claims a content-blind (proof) export but the continuation publishes plaintext " +
        "settled/open/next/changed; a proof pack carrying plaintext state is contradictory — the unhashed " +
        "top-level mode cannot be used to skip the child-state checks (fail closed)."
    );
  }
  pass("current_privacy_mode_consistent", "export mode is consistent with the sealed structural privacy_mode and the published artifacts");

  // --- 3) The child seals an inheritance edge ---------------------------------------------------
  const edge = curScope.structural.inherits_loop as ScopeInheritsLoop | undefined;
  if (!edge) {
    return fail(
      "inheritance_edge_sealed",
      "the current pack's sealed scope carries no inherits_loop edge — this is not an inheriting loop, " +
        "so there is no cross-loop linkage to verify (fail closed for a linkage check)."
    );
  }
  pass("inheritance_edge_sealed", `sealed inherits_loop -> capsule_ref ${edge.capsule_ref}`);

  // --- 4) Identity binding: the edge triple recomputes against the PRIOR pack's continuation ----
  const recomputedRef = deriveContinuationRef(priorCont);
  if (recomputedRef !== edge.capsule_ref) {
    return fail(
      "edge_capsule_ref_binds",
      `prior continuation recomputes to capsule_ref ${recomputedRef} but the sealed edge pins ` +
        `${edge.capsule_ref}; the supplied prior pack is not the one this loop opened from (fail closed).`
    );
  }
  pass("edge_capsule_ref_binds", `prior continuation recomputes to the sealed capsule_ref`);
  if (priorCont.scope_ref !== edge.scope_ref) {
    return fail("edge_scope_ref_binds", `prior continuation scope_ref ${priorCont.scope_ref} != sealed edge scope_ref ${edge.scope_ref} (fail closed).`);
  }
  pass("edge_scope_ref_binds", "prior continuation scope_ref matches the sealed edge");
  if ((priorCont.final_turn_ref ?? null) !== edge.final_turn_ref) {
    return fail(
      "edge_final_turn_ref_binds",
      `prior continuation final_turn_ref ${priorCont.final_turn_ref ?? "null"} != sealed edge final_turn_ref ${edge.final_turn_ref} (fail closed).`
    );
  }
  pass("edge_final_turn_ref_binds", "prior continuation final_turn_ref matches the sealed edge");

  // --- 5) The child's continuation carries the SAME edge it sealed ------------------------------
  if (canonicalScopeJson(curCont.inherits_loop ?? null) !== canonicalScopeJson(edge)) {
    return fail(
      "child_continuation_carries_edge",
      "the current pack's continuation-capsule.json inherits_loop does not equal the sealed edge (fail closed)."
    );
  }
  pass("child_continuation_carries_edge", "current continuation carries the sealed edge verbatim");

  // --- 6) Structural chain checks (local continuity/shape only — NOT signatures) ----------------
  const priorChain = verifyLoopChain(asChainLinks(priorReceiptsR.value));
  if (!priorChain.valid) {
    return fail("prior_chain_structural", `prior receipts.json fails the structural chain check: ${priorChain.reason} (fail closed).`);
  }
  if (!priorChain.sealed || priorChain.loop_id !== priorCont.loop_id) {
    return fail(
      "prior_chain_structural",
      `prior chain sealed=${priorChain.sealed} loop_id=${priorChain.loop_id ?? "null"}, but the prior continuation ` +
        `claims a sealed loop ${priorCont.loop_id} (fail closed).`
    );
  }
  pass("prior_chain_structural", `prior chain is structurally contiguous and sealed (loop ${priorChain.loop_id})`);
  const priorGoalFail = chainGoalBinds(priorReceiptsR.value, priorCont.goal_hash, "prior");
  if (priorGoalFail) return fail("prior_chain_goal_binds", priorGoalFail);
  pass("prior_chain_goal_binds", "every prior chain receipt cites the prior continuation's goal_hash");
  const curChain = verifyLoopChain(asChainLinks(curReceiptsR.value));
  if (!curChain.valid) {
    return fail("current_chain_structural", `current receipts.json fails the structural chain check: ${curChain.reason} (fail closed).`);
  }
  if (!curChain.sealed || curChain.loop_id !== curCont.loop_id) {
    return fail(
      "current_chain_structural",
      `current chain sealed=${curChain.sealed} loop_id=${curChain.loop_id ?? "null"}, but the current continuation ` +
        `claims a sealed loop ${curCont.loop_id} (fail closed).`
    );
  }
  pass("current_chain_structural", `current chain is structurally contiguous and sealed (loop ${curChain.loop_id})`);
  const curGoalFail = chainGoalBinds(curReceiptsR.value, curCont.goal_hash, "current");
  if (curGoalFail) return fail("current_chain_goal_binds", curGoalFail);
  pass("current_chain_goal_binds", "every current chain receipt cites the current continuation's goal_hash");

  // --- 7) The commitment-bearing scope_ref is stamped by a signed in-loop receipt ---------------
  // (Signature VALIDITY is out of scope here; presence of the stamp in the chain is what links the
  // sealed commitment to the material lyhna-verify then proves was signed.) The stamp must come
  // from an in-loop receipt OF THIS LOOP — a record without `constraints.loop` (or for a foreign
  // loop/goal) is ignored by the structural chain check, so counting it here would let an injected
  // stamp satisfy the binding while the real chain never stamped the commitment-bearing scope.
  const stampCount = curReceiptsR.value.filter((r) => {
    const rec = r as {
      constraints?: { loop?: { loop_id?: unknown; goal_hash?: unknown }; loop_close?: unknown; scope?: { scope_ref?: unknown } };
    };
    const isTerminal = typeof rec.constraints?.loop_close === "object" && rec.constraints?.loop_close !== null;
    const loop = rec.constraints?.loop;
    const isCurrentInLoop =
      !isTerminal &&
      typeof loop === "object" &&
      loop !== null &&
      loop.loop_id === curCont.loop_id &&
      loop.goal_hash === curCont.goal_hash;
    return isCurrentInLoop && rec.constraints?.scope?.scope_ref === curScope.scope_ref;
  }).length;
  const stateHash = curScope.structural.inherits_state_hash;
  if (stateHash !== undefined && stampCount === 0) {
    // KNOWN BOUNDARY (adjudicated; see verify-instructions.md trust boundary): the only way a VALID
    // exported pack reaches here is a TRAILING amendment — the final scope_ref was produced by an
    // amendment AFTER the last governed action, so no signed receipt stamps it, and packs ship no
    // scope-history to re-derive earlier versions (and trusting the unsigned what_changed ancestry
    // would reopen the vacuous-binding hole). The exporter fails closed on this same shape, so it
    // cannot produce such a pack; the message teaches the remedy regardless.
    return fail(
      "commitment_scope_ref_stamped",
      `the sealed inherits_state_hash claims signed-chain binding, but no in-loop receipt OF THIS LOOP stamps the ` +
        `final scope_ref ${curScope.scope_ref}. Why: either the chain stamps the commitment-bearing scope nowhere ` +
        `(forged lineage), or the final scope_ref was produced by a TRAILING amendment after the last governed ` +
        `action (packs ship no scope-history to verify earlier versions, by design). Remedy: do not amend an ` +
        `inheriting loop after its last action, or perform a governed action AFTER the amendment so a signed ` +
        `receipt stamps the final scope_ref before export (fail closed).`
    );
  }
  pass(
    "commitment_scope_ref_stamped",
    stampCount > 0
      ? `${stampCount} in-loop receipt(s) of this loop stamp the final scope_ref`
      : "no final-scope stamp required (identity-only inheritance)"
  );

  // --- 8) State commitment binding (only when the child sealed one) -----------------------------
  if (stateHash === undefined) {
    pass(
      "identity_only_inheritance",
      "no inherits_state_hash sealed: the linkage proves WHICH prior capsule was referenced; it carries and " +
        "proves NO inherited state values."
    );
    return report(true);
  }
  const priorLedgerR = readJson<{ turns: JudgmentTurn[] }>(input.prior_pack_dir, "judgment-ledger.json");
  if (!priorLedgerR.ok) {
    return fail(
      "prior_ledger_present",
      `the child seals inherits_state_hash but the prior pack has no readable judgment ledger to re-fold ` +
        `(${priorLedgerR.detail}) — the state values cannot be verified (fail closed).`
    );
  }
  if (!isRecord(priorLedgerR.value) || !Array.isArray(priorLedgerR.value.turns)) {
    return fail(
      "prior_ledger_present",
      "prior pack judgment-ledger.json parses but is not a judgment ledger (object with a turns array); fail closed."
    );
  }
  let priorFold: ReturnType<typeof reduceJudgmentLedger>;
  try {
    // Re-fold validates the prior chain fail-closed (contiguity, hash links, anchors).
    priorFold = reduceJudgmentLedger({
      loop_id: priorCont.loop_id,
      scope_ref: priorCont.scope_ref,
      turns: priorLedgerR.value.turns,
      mode: "verified_context"
    });
  } catch (error) {
    return fail("prior_ledger_refolds", `prior judgment ledger fails chain validation / re-fold: ${(error as Error).message}`);
  }
  if ((priorFold.final_turn_ref ?? null) !== edge.final_turn_ref) {
    return fail(
      "prior_ledger_refolds",
      `prior ledger re-folds to final_turn_ref ${priorFold.final_turn_ref ?? "null"} but the sealed edge pins ` +
        `${edge.final_turn_ref}; the supplied ledger is not the chain the edge pinned (fail closed).`
    );
  }
  pass("prior_ledger_refolds", "prior judgment ledger chain-validates and re-folds to the edge-pinned final turn");

  // --- 8b) The prior ledger's bind turns must cite receipts the PRIOR CHAIN actually carries -----
  // A ledger can be internally consistent (turn_refs recompute, fold matches) while citing receipt
  // IDs the supplied receipts.json never contained — e.g. the chain swapped for another valid sealed
  // chain of the same loop_id. The exporter cross-checks receipts<->judgment before accepting the
  // fold; the offline checker mirrors it read-side via bindLedgerTurnsToChain.
  const priorBindFail = bindLedgerTurnsToChain(priorLedgerR.value.turns, priorReceiptsR.value, priorCont.loop_id, "prior");
  if (priorBindFail) {
    return fail("prior_ledger_receipts_bind", priorBindFail);
  }
  pass(
    "prior_ledger_receipts_bind",
    "every bind-verdict turn in the prior ledger cites a receipt present in the prior chain (loop / outcome / scope agree)"
  );
  // Scope-event-anchored turns (refusals / max-step bounds) bind to the prior pack's verified
  // scope-events.json — never to the turn's self-reported anchor alone.
  const priorEventsR = readJson<unknown>(input.prior_pack_dir, "scope-events.json");
  const priorEventFail = bindEventTurnsToEvents(
    priorLedgerR.value.turns,
    priorEventsR.ok ? priorEventsR.value : null,
    priorCont.loop_id,
    "prior"
  );
  if (priorEventFail) return fail("prior_ledger_events_bind", priorEventFail);
  pass("prior_ledger_events_bind", "every scope-event-anchored prior turn cites a verified event in the prior pack");
  const foldState = canonicalScopeJson(plainState(priorFold));
  if (canonicalScopeJson(plainState(priorCont)) !== foldState) {
    return fail(
      "prior_state_consistent",
      "the prior pack's continuation-capsule.json plaintext does not equal the re-fold of its judgment-ledger.json " +
        "(tampered or stale — fail closed)."
    );
  }
  pass("prior_state_consistent", "prior continuation plaintext equals the ledger re-fold (non-circular)");
  const suppliedHash = deriveInheritsStateHash(plainState(priorCont));
  if (suppliedHash !== stateHash) {
    return fail(
      "state_commitment_binds",
      `prior state hashes to ${suppliedHash} but the child sealed inherits_state_hash ${stateHash}; the inherited ` +
        `values are not the ones committed at open (fail closed).`
    );
  }
  pass("state_commitment_binds", "prior state hashes to the sealed inherits_state_hash commitment");

  // --- 9) The child's published state is its OWN ledger's re-fold over the prior seed -----------
  // (Verified Context child only.) The child continuation's plaintext is never trusted bare: the
  // current pack's judgment ledger must re-fold — SEEDED by the verified prior state — to exactly
  // the arrays the continuation publishes, mirroring the export-time continuation binding. An
  // after-export edit of the child sidecar (e.g. prepending the prior arrays by hand) fails here
  // even though a bare prefix comparison would pass.
  if (curScope.privacy_mode === "verified_context") {
    const curLedgerR = readJson<{ turns: JudgmentTurn[] }>(input.current_pack_dir, "judgment-ledger.json");
    if (!curLedgerR.ok || !isRecord(curLedgerR.value) || !Array.isArray(curLedgerR.value.turns)) {
      return fail(
        "child_state_refolds",
        `the child claims inherited state but its pack has no readable judgment ledger to re-fold ` +
          `(${curLedgerR.ok ? "judgment-ledger.json has no turns array" : curLedgerR.detail}); the published ` +
          `state cannot be verified (fail closed).`
      );
    }
    // The child ledger gets the SAME receipt binding as the prior: its bind turns must cite
    // receipts present in the CURRENT chain (loop / exact outcome / scope stamp agree) — otherwise
    // a valid signed chain could ship beside a ledger citing receipts it never carried.
    const childBindFail = bindLedgerTurnsToChain(curLedgerR.value.turns, curReceiptsR.value, curCont.loop_id, "current");
    if (childBindFail) {
      return fail("child_ledger_receipts_bind", childBindFail);
    }
    pass(
      "child_ledger_receipts_bind",
      "every bind-verdict turn in the child ledger cites a receipt present in the current chain (loop / outcome / scope agree)"
    );
    const curEventsR = readJson<unknown>(input.current_pack_dir, "scope-events.json");
    const curEventFail = bindEventTurnsToEvents(
      curLedgerR.value.turns,
      curEventsR.ok ? curEventsR.value : null,
      curCont.loop_id,
      "current"
    );
    if (curEventFail) return fail("child_ledger_events_bind", curEventFail);
    pass("child_ledger_events_bind", "every scope-event-anchored child turn cites a verified event in the current pack");
    let curFold: ReturnType<typeof reduceJudgmentLedger>;
    try {
      curFold = reduceJudgmentLedger({
        loop_id: curCont.loop_id,
        scope_ref: curCont.scope_ref,
        turns: curLedgerR.value.turns,
        mode: "verified_context",
        seed: plainState(priorCont)
      });
    } catch (error) {
      return fail("child_state_refolds", `current judgment ledger fails chain validation / re-fold: ${(error as Error).message}`);
    }
    if (canonicalScopeJson(plainState(curFold)) !== canonicalScopeJson(plainState(curCont))) {
      return fail(
        "child_state_refolds",
        "the child continuation's plaintext does not equal its own judgment ledger re-folded over the verified " +
          "prior state; the published state was not produced by the presented ledger (tampered or stale — fail closed)."
      );
    }
    pass("child_state_refolds", "child continuation state equals its ledger re-folded over the verified prior seed");
    const prior = plainState(priorCont);
    const cur = plainState(curCont);
    const prefixOk =
      hasPrefix(cur.settled, prior.settled) &&
      hasPrefix(cur.open_questions, prior.open_questions) &&
      hasPrefix(cur.next_actions, prior.next_actions) &&
      hasPrefix(cur.changed, prior.changed);
    if (!prefixOk) {
      return fail(
        "child_carries_inherited_prefix",
        "the child continuation's settled/open/next/changed do not BEGIN with the prior state — the child did not " +
          "fold the inherited seed first (lineage order violated; fail closed)."
      );
    }
    pass("child_carries_inherited_prefix", "child continuation state begins with the inherited prior state (seed-first fold)");
  } else {
    pass("child_carries_inherited_prefix", "content-blind child publishes no state; prefix check not applicable");
  }

  return report(true);
}

/** The exact success wording (architect contract). The CLI prints this on a passing report. */
export const CROSS_LOOP_SUCCESS_WORDING =
  "Linkage verified. Structural chain check passed. " + SIGNATURE_NOTICE;
