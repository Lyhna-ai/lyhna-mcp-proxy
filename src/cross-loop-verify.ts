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

export function verifyCrossLoopLinkage(input: { prior_pack_dir: string; current_pack_dir: string }): CrossLoopLinkageReport {
  const checks: CrossLoopCheck[] = [];
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
  pass("read_packs", "required artifacts present and parse in both packs");

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
    return fail(
      "commitment_scope_ref_stamped",
      "the sealed inherits_state_hash claims signed-chain binding, but no in-loop receipt OF THIS LOOP in this " +
        "pack stamps the commitment-bearing scope_ref (note: stamps citing amendment versions not shipped in " +
        "the pack are not visible to this check) — the commitment is anchored to no presented signature (fail closed)."
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
  // fold; the offline checker mirrors it read-side: every bind-verdict turn must map to a receipt
  // present in the prior chain, in the prior loop, with agreeing outcome and scope stamp.
  const priorReceiptById = new Map<string, { outcome?: unknown; loop_id?: unknown; scope_ref?: unknown }>();
  for (const r of priorReceiptsR.value) {
    const rec = r as {
      receipt_id?: unknown;
      outcome?: unknown;
      constraints?: { loop?: { loop_id?: unknown }; scope?: { scope_ref?: unknown } };
    };
    if (typeof rec.receipt_id === "string") {
      priorReceiptById.set(rec.receipt_id, {
        outcome: rec.outcome,
        loop_id: rec.constraints?.loop?.loop_id,
        scope_ref: rec.constraints?.scope?.scope_ref
      });
    }
  }
  for (const t of priorLedgerR.value.turns) {
    const turn = t as { turn_index?: number; scope_ref?: string; verdict?: { kind?: string; source?: string; receipt_id?: string } };
    const v = turn.verdict;
    if (v?.source !== "bind" || typeof v.receipt_id !== "string") continue;
    const r = priorReceiptById.get(v.receipt_id);
    if (!r) {
      return fail(
        "prior_ledger_receipts_bind",
        `prior ledger turn ${turn.turn_index} cites receipt ${v.receipt_id}, which is not present in the prior ` +
          `pack's receipts.json — the ledger does not belong to the presented chain (fail closed).`
      );
    }
    if (r.loop_id !== priorCont.loop_id) {
      return fail(
        "prior_ledger_receipts_bind",
        `prior ledger turn ${turn.turn_index} cites receipt ${v.receipt_id}, which belongs to loop ` +
          `${JSON.stringify(r.loop_id)} rather than ${priorCont.loop_id} (fail closed).`
      );
    }
    if (v.kind === "APPROVED" && r.outcome !== "APPROVED") {
      return fail(
        "prior_ledger_receipts_bind",
        `prior ledger turn ${turn.turn_index} records an APPROVED bind on receipt ${v.receipt_id}, but the chain ` +
          `receipt's outcome is ${JSON.stringify(r.outcome)} (fail closed).`
      );
    }
    if (r.scope_ref !== undefined && r.scope_ref !== turn.scope_ref) {
      return fail(
        "prior_ledger_receipts_bind",
        `prior ledger turn ${turn.turn_index} ran under scope_ref ${turn.scope_ref} but receipt ${v.receipt_id} ` +
          `stamps ${JSON.stringify(r.scope_ref)} (fail closed).`
      );
    }
  }
  pass(
    "prior_ledger_receipts_bind",
    "every bind-verdict turn in the prior ledger cites a receipt present in the prior chain (loop / outcome / scope agree)"
  );
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

  // --- 9) The child actually carries the inherited prefix (Verified Context child only) ---------
  if (curScope.privacy_mode === "verified_context") {
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
