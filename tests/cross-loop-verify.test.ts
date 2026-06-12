import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CROSS_LOOP_SUCCESS_WORDING,
  buildContinuationCapsule,
  buildLoopProofBundle,
  createJudgmentRecorder,
  createScopeEventRecorder,
  deriveContinuationRef,
  deriveGoalHash,
  deriveInheritsStateHash,
  deriveScopeRef,
  reduceJudgmentLedger,
  sealScopeCapsule,
  verifyCrossLoopLinkage,
  writeProofPackFiles,
  type ContinuationCapsule,
  type ProofReceipt,
  type ScopeEvent,
  type ScopeInheritsLoop,
  type SealedScope
} from "../src/index.js";
import { runVerifyCrossLoop } from "../src/bin/verify-cross-loop.js";

const PUBKEY = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";

function sealed(loop_id: string, goal_hash: string, lineage?: { edge: ScopeInheritsLoop; stateHash: string }): SealedScope {
  return sealScopeCapsule({
    capsule: {
      structural: {
        capsule_type: "scope_capsule",
        capsule_version: "scope-capsule/v1",
        loop_id,
        goal_hash,
        privacy_mode: "verified_context",
        allowed_action_classes: ["write"],
        class_map: { write_file: "write" },
        ...(lineage ? { inherits_loop: lineage.edge, inherits_state_hash: lineage.stateHash } : {})
      },
      sidecar: { goal_summary: `goal of ${loop_id}` }
    }
  });
}

function inLoopReceipt(loop_id: string, goal_hash: string, receipt_id: string, prior: string | null, scope_ref: string): ProofReceipt {
  return {
    version: "LYHNA_RECEIPT_V2",
    receipt_id,
    public_key: PUBKEY,
    tenant_hash: "55b966349a28aaaa",
    action_type: "tool_call",
    outcome: "APPROVED",
    signature: "c3R1Yg==",
    constraints: {
      loop: { loop_id, prior_receipt_id: prior, goal_hash },
      scope: { scope_ref, prior_receipt_id: prior, action_class: "write", tool_name: "write_file", target_descriptor: null }
    }
  };
}

function terminalReceipt(loop_id: string, goal_hash: string, receipt_id: string, prior: string, action_count: number): ProofReceipt {
  return {
    version: "LYHNA_RECEIPT_V2",
    receipt_id,
    public_key: PUBKEY,
    tenant_hash: "55b966349a28aaaa",
    action_type: "loop_close",
    outcome: "APPROVED",
    signature: "c3R1Yg==",
    constraints: {
      loop: { loop_id, prior_receipt_id: prior, goal_hash },
      loop_close: { loop_id, goal_hash, action_count, outcome: "COMPLETED", prior_receipt_id: prior, termination_reason: "done" }
    }
  };
}

/**
 * Build + write a real single-loop VC pack with judgment artifacts. Returns the built objects so
 * the child loop can derive its sealed edge from the ACTUAL exported continuation.
 */
function exportPack(opts: {
  dir: string;
  loop_id: string;
  goal: string;
  delta: { settled?: string[]; next_actions?: string[]; changed?: string[] };
  lineage?: { edge: ScopeInheritsLoop; stateHash: string; prior: ContinuationCapsule; priorTurns: unknown };
  seed?: { settled?: string[]; open_questions?: string[]; next_actions?: string[]; changed?: string[] };
  withRefusal?: boolean;
}) {
  const goal_hash = deriveGoalHash(opts.goal);
  const scope = sealed(opts.loop_id, goal_hash, opts.lineage);
  const receipts: ProofReceipt[] = [
    inLoopReceipt(opts.loop_id, goal_hash, "r1", null, scope.scope_ref),
    terminalReceipt(opts.loop_id, goal_hash, "close", "r1", 1)
  ];
  const rec = createJudgmentRecorder();
  const t0 = rec.append({
    loop_id: opts.loop_id,
    scope_ref: scope.scope_ref,
    prior_receipt_id: null,
    proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
    verdict: { kind: "APPROVED", source: "bind", receipt_id: "r1" }
  });
  rec.attachRuntimeReport(opts.loop_id, t0.turn_ref, { returned: true, result_hash: `sha256:${"a".repeat(64)}` });
  rec.attachDelta(opts.loop_id, t0.turn_ref, opts.delta);
  // Optional attested refusal: a scope event + the scope_gate turn anchored to it.
  const events: ScopeEvent[] = [];
  if (opts.withRefusal) {
    const scopeRec = createScopeEventRecorder();
    const event = scopeRec.record({
      event_type: "scope_refusal",
      loop_id: opts.loop_id,
      scope_ref: scope.scope_ref,
      attempted: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      matched_rule: "forbidden_targets",
      decision: "REFUSED",
      prior_receipt_id: "r1"
    });
    events.push(event);
    rec.append({
      loop_id: opts.loop_id,
      scope_ref: scope.scope_ref,
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "REFUSED", source: "scope_gate", scope_event_hash: event.event_hash, reason_code: "forbidden_targets" }
    });
  }
  const turns = rec.judgmentLedgerForLoop(opts.loop_id);
  const reduced = reduceJudgmentLedger({
    loop_id: opts.loop_id,
    scope_ref: scope.scope_ref,
    turns,
    mode: "verified_context",
    seed: opts.seed
  });
  const continuation = buildContinuationCapsule({
    scope_history: [scope],
    scope_events: events,
    loop: { loop_id: opts.loop_id, goal_hash, sealed: true, action_count: 1 },
    mode: "verified_context",
    reduced
  });
  const built = buildLoopProofBundle({
    receipts,
    source_env: "test",
    capsule: {
      mode: "verified_context",
      sealed_scope: scope,
      scope_history: [scope],
      continuation,
      scope_events: events,
      judgment_turns: turns,
      ...(opts.seed ? { inherited_state: opts.seed } : {}),
      ...(opts.lineage ? { prior_continuation: opts.lineage.prior, prior_judgment_turns: opts.lineage.priorTurns as never } : {})
    }
  });
  writeProofPackFiles(opts.dir, built);
  return { scope, receipts, turns, continuation, built };
}

describe("Stage E — offline two-pack cross-loop linkage checker", () => {
  let root: string;
  let priorDir: string;
  let currentDir: string;
  let prior: ReturnType<typeof exportPack>;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lyhna-cross-loop-"));
    priorDir = join(root, "pack-loop-1");
    currentDir = join(root, "pack-loop-2");

    // Loop 1: a plain (non-inheriting) VC pack.
    prior = exportPack({
      dir: priorDir,
      loop_id: "loop-1",
      goal: "design the gate",
      delta: { settled: ["chose Ed25519"], next_actions: ["wire export"] }
    });

    // Loop 2: opens FROM the loop-1 pack — edge + commitment derived from the ACTUAL exported
    // continuation, the seed is loop 1's state, folded before loop 2's own delta.
    const edge: ScopeInheritsLoop = {
      capsule_ref: deriveContinuationRef(prior.continuation),
      scope_ref: prior.continuation.scope_ref,
      final_turn_ref: prior.continuation.final_turn_ref!
    };
    const stateHash = deriveInheritsStateHash(prior.continuation);
    exportPack({
      dir: currentDir,
      loop_id: "loop-2",
      goal: "ship the gate",
      delta: { settled: ["wired export"] },
      lineage: { edge, stateHash, prior: prior.continuation, priorTurns: prior.turns },
      seed: { settled: prior.continuation.settled, next_actions: prior.continuation.next_actions }
    });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("verifies a genuine two-pack linkage end-to-end (every check passes)", () => {
    const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    // The contract wording + the two cold-verify commands, verbatim.
    expect(CROSS_LOOP_SUCCESS_WORDING).toBe(
      "Linkage verified. Structural chain check passed. Signature verification not performed here. " +
        "Re-run lyhna-verify on both receipt chains to trust signatures."
    );
    expect(report.signature_notice).toContain("Signature verification not performed here");
    expect(report.verify_commands[0]).toContain(join(priorDir, "receipts.json"));
    expect(report.verify_commands[1]).toContain(join(currentDir, "receipts.json"));
  });

  it("CLI: exits 0 and prints the exact contract wording + both lyhna-verify commands", () => {
    let out = "";
    let err = "";
    const code = runVerifyCrossLoop(["--prior", priorDir, "--current", currentDir], {
      stdout: (t: string) => {
        out += t;
      },
      stderr: (t: string) => {
        err += t;
      }
    });
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain(CROSS_LOOP_SUCCESS_WORDING);
    expect(out).toContain("npx -y lyhna-verify --chain");
  });

  function withTamperedFile(dir: string, file: string, mutate: (parsed: never) => unknown, run: () => void) {
    const p = join(dir, file);
    const original = readFileSync(p, "utf8");
    try {
      writeFileSync(p, JSON.stringify(mutate(JSON.parse(original) as never), null, 2));
      run();
    } finally {
      writeFileSync(p, original);
    }
  }

  it("fails closed: prior continuation plaintext edited on disk (identity passes, consistency catches it)", () => {
    withTamperedFile(priorDir, "continuation-capsule.json", (c: { settled?: string[] }) => ({ ...c, settled: ["FORGED memory"] }), () => {
      const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
      expect(report.ok).toBe(false);
      const failed = report.checks.find((c) => !c.ok)!;
      expect(failed.name).toBe("prior_state_consistent");
    });
  });

  it("fails closed: BOTH prior sidecars edited consistently (re-fold passes, sealed commitment catches it)", () => {
    const ledgerPath = join(priorDir, "judgment-ledger.json");
    const contPath = join(priorDir, "continuation-capsule.json");
    const ledger0 = readFileSync(ledgerPath, "utf8");
    const cont0 = readFileSync(contPath, "utf8");
    try {
      const ledger = JSON.parse(ledger0) as { turns: Array<{ declared_delta?: unknown }> };
      ledger.turns[0]!.declared_delta = { settled: ["FORGED memory"] };
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
      const cont = JSON.parse(cont0) as Record<string, unknown>;
      cont.settled = ["FORGED memory"];
      delete cont.next_actions;
      writeFileSync(contPath, JSON.stringify(cont, null, 2));
      const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
      expect(report.ok).toBe(false);
      const failed = report.checks.find((c) => !c.ok)!;
      expect(failed.name).toBe("state_commitment_binds");
    } finally {
      writeFileSync(ledgerPath, ledger0);
      writeFileSync(contPath, cont0);
    }
  });

  it("fails closed: the wrong prior pack (identity binding)", () => {
    // A third pack with the same shape but different content is NOT the capsule the edge pinned.
    const otherDir = join(root, "pack-other");
    exportPack({ dir: otherDir, loop_id: "loop-other", goal: "something else", delta: { settled: ["other"] } });
    const report = verifyCrossLoopLinkage({ prior_pack_dir: otherDir, current_pack_dir: currentDir });
    expect(report.ok).toBe(false);
    const failed = report.checks.find((c) => !c.ok)!;
    expect(failed.name).toBe("edge_capsule_ref_binds");
  });

  it("fails closed: prior pack missing its judgment ledger (state cannot be verified)", () => {
    const p = join(priorDir, "judgment-ledger.json");
    const original = readFileSync(p, "utf8");
    try {
      unlinkSync(p);
      const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
      expect(report.ok).toBe(false);
      expect(report.checks.find((c) => !c.ok)!.name).toBe("prior_ledger_present");
    } finally {
      writeFileSync(p, original);
    }
  });

  it("fails closed: no in-loop receipt OF THIS LOOP stamps the commitment-bearing scope_ref", () => {
    // The real in-loop receipts' stamps point at a different scope version: a stateful lineage
    // claim with no presented stamp of the commitment-bearing scope must not pass.
    withTamperedFile(
      currentDir,
      "receipts.json",
      (receipts: Array<{ constraints?: { loop?: unknown; loop_close?: unknown; scope?: { scope_ref?: string } } }>) => {
        for (const r of receipts) {
          if (r.constraints?.loop && !r.constraints?.loop_close && r.constraints.scope) {
            r.constraints.scope.scope_ref = "scope_v1:" + "f".repeat(64);
          }
        }
        return receipts;
      },
      () => {
        const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
        expect(report.ok).toBe(false);
        expect(report.checks.find((c) => !c.ok)!.name).toBe("commitment_scope_ref_stamped");
      }
    );
  });

  it("fails closed: an injected loop-less stamp record cannot satisfy the binding (structural check rejects it)", () => {
    // A record with no constraints.loop carrying only a matching scope stamp: the loop-aware stamp
    // count would not count it, and the structural chain check independently rejects the stray
    // record — the injection vector is closed at both layers.
    withTamperedFile(
      currentDir,
      "receipts.json",
      (receipts: Array<{ constraints?: { loop?: unknown; loop_close?: unknown; scope?: { scope_ref?: string } } }>) => {
        const finalRef = receipts.find((r) => r.constraints?.loop && !r.constraints?.loop_close)!.constraints!.scope!.scope_ref!;
        for (const r of receipts) {
          if (r.constraints?.loop && !r.constraints?.loop_close && r.constraints.scope) {
            r.constraints.scope.scope_ref = "scope_v1:" + "f".repeat(64); // real stamp points elsewhere
          }
        }
        receipts.push({ constraints: { scope: { scope_ref: finalRef } } }); // injected, loop-less
        return receipts;
      },
      () => {
        const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
        expect(report.ok).toBe(false);
        const failed = report.checks.find((c) => !c.ok)!;
        expect(["current_chain_structural", "commitment_scope_ref_stamped"]).toContain(failed.name);
      }
    );
  });

  it("fails closed: prior receipts.json swapped for another valid sealed chain the ledger never cited", () => {
    // Same loop_id/goal_hash, structurally valid and sealed — but its receipt IDs are not the ones
    // the prior ledger's bind turns cite, so the fold's authority does not come from this chain.
    withTamperedFile(
      currentDir,
      "scope-capsule.json",
      (s: never) => s, // no-op on current; tamper target is the prior pack below
      () => {
        const goal_hash = deriveGoalHash("design the gate");
        const swapped = [
          inLoopReceipt("loop-1", goal_hash, "rX", null, prior.scope.scope_ref),
          terminalReceipt("loop-1", goal_hash, "closeX", "rX", 1)
        ];
        withTamperedFile(priorDir, "receipts.json", () => swapped as never, () => {
          const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
          expect(report.ok).toBe(false);
          expect(report.checks.find((c) => !c.ok)!.name).toBe("prior_ledger_receipts_bind");
        });
      }
    );
  });

  it("fails closed: a non-inheriting current pack has no linkage to verify", () => {
    const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: priorDir });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => !c.ok)!.name).toBe("inheritance_edge_sealed");
  });

  it("fails closed: tampered current scope-capsule (scope_ref no longer recomputes)", () => {
    withTamperedFile(
      currentDir,
      "scope-capsule.json",
      (s: { structural: { inherits_state_hash?: string } }) => {
        s.structural.inherits_state_hash = "sha256:" + "f".repeat(64);
        return s;
      },
      () => {
        const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
        expect(report.ok).toBe(false);
        expect(report.checks.find((c) => !c.ok)!.name).toBe("current_scope_ref_recomputes");
      }
    );
  });

  it("fails closed: a bind-cited prior receipt with its scope stamp REMOVED (absence is not agreement)", () => {
    withTamperedFile(
      priorDir,
      "receipts.json",
      (receipts: Array<{ constraints?: { loop?: unknown; loop_close?: unknown; scope?: unknown } }>) => {
        for (const r of receipts) {
          if (r.constraints?.loop && !r.constraints?.loop_close) delete r.constraints.scope;
        }
        return receipts;
      },
      () => {
        const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
        expect(report.ok).toBe(false);
        expect(report.checks.find((c) => !c.ok)!.name).toBe("prior_ledger_receipts_bind");
      }
    );
  });

  it("fails closed: child sidecar edited after export — prefix intact, but its own ledger never produced it", () => {
    // Appending to settled keeps the inherited PREFIX valid, so a bare prefix check would pass;
    // the child re-fold (over the verified prior seed) catches that the presented ledger never
    // produced the published arrays.
    withTamperedFile(
      currentDir,
      "continuation-capsule.json",
      (c: { settled?: string[] }) => ({ ...c, settled: [...(c.settled ?? []), "INJECTED after export"] }),
      () => {
        const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
        expect(report.ok).toBe(false);
        expect(report.checks.find((c) => !c.ok)!.name).toBe("child_state_refolds");
      }
    );
  });

  it("fails closed: CURRENT receipts.json swapped for another valid chain the child ledger never cited", () => {
    // The swapped chain is structurally valid, sealed, and stamps the final scope — but its receipt
    // IDs are not the ones the child ledger's bind turns cite (same gap as the prior-side check).
    const goal_hash = deriveGoalHash("ship the gate");
    withTamperedFile(
      currentDir,
      "receipts.json",
      (receipts: Array<{ constraints?: { loop?: unknown; loop_close?: unknown; scope?: { scope_ref?: string } } }>) => {
        const finalRef = receipts.find((r) => r.constraints?.loop && !r.constraints?.loop_close)!.constraints!.scope!.scope_ref!;
        return [
          inLoopReceipt("loop-2", goal_hash, "rY", null, finalRef),
          terminalReceipt("loop-2", goal_hash, "closeY", "rY", 1)
        ] as never;
      },
      () => {
        const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
        expect(report.ok).toBe(false);
        expect(report.checks.find((c) => !c.ok)!.name).toBe("child_ledger_receipts_bind");
      }
    );
  });

  it("fails closed: bind verdict outcome must EQUAL the chain receipt's outcome (both directions)", () => {
    // The comparison is exact equality, so a ledger APPROVED over a chain ESCALATED fails — and the
    // same line rejects the reverse (a ledger REFUSED/ESCALATED unbacked by the signed chain).
    withTamperedFile(
      priorDir,
      "receipts.json",
      (receipts: Array<{ outcome?: string; constraints?: { loop?: unknown; loop_close?: unknown } }>) => {
        for (const r of receipts) {
          if (r.constraints?.loop && !r.constraints?.loop_close) r.outcome = "ESCALATED";
        }
        return receipts;
      },
      () => {
        const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
        expect(report.ok).toBe(false);
        const failed = report.checks.find((c) => !c.ok)!;
        expect(failed.name).toBe("prior_ledger_receipts_bind");
        expect(failed.detail).toContain("ESCALATED");
      }
    );
  });

  it("fails closed: a truncated ledger — the chain carries an in-loop receipt no bind turn records", () => {
    // Append a second signed in-loop receipt (chain stays valid: r1 -> r1b -> close with
    // action_count 2) while the ledger still records only r1. The fold would silently drop the
    // second step's delta — reverse binding catches it.
    const goal_hash = deriveGoalHash("design the gate");
    withTamperedFile(
      priorDir,
      "receipts.json",
      (receipts: Array<{ receipt_id?: string; constraints?: { loop?: { prior_receipt_id?: string | null }; loop_close?: { prior_receipt_id?: string; action_count?: number }; scope?: { scope_ref?: string } } }>) => {
        const inLoop = receipts.find((r) => r.constraints?.loop && !r.constraints?.loop_close)!;
        const close = receipts.find((r) => r.constraints?.loop_close)!;
        const extra = inLoopReceipt("loop-1", goal_hash, "r1b", inLoop.receipt_id!, inLoop.constraints!.scope!.scope_ref!);
        close.constraints!.loop!.prior_receipt_id = "r1b";
        close.constraints!.loop_close!.prior_receipt_id = "r1b";
        close.constraints!.loop_close!.action_count = 2;
        return [receipts[0], extra, close] as never;
      },
      () => {
        const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
        expect(report.ok).toBe(false);
        const failed = report.checks.find((c) => !c.ok)!;
        expect(failed.name).toBe("prior_ledger_receipts_bind");
        expect(failed.detail).toContain("truncated");
      }
    );
  });

  it("fails closed: a same-loop chain for a DIFFERENT goal_hash cannot stand in for the continuation's chain", () => {
    const otherGoal = deriveGoalHash("an entirely different goal");
    withTamperedFile(
      priorDir,
      "receipts.json",
      (receipts: Array<{ constraints?: { loop?: { goal_hash?: string }; loop_close?: { goal_hash?: string } } }>) => {
        for (const r of receipts) {
          if (r.constraints?.loop) r.constraints.loop.goal_hash = otherGoal;
          if (r.constraints?.loop_close) r.constraints.loop_close.goal_hash = otherGoal;
        }
        return receipts;
      },
      () => {
        const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
        expect(report.ok).toBe(false);
        expect(report.checks.find((c) => !c.ok)!.name).toBe("prior_chain_goal_binds");
      }
    );
  });

  it("fails closed: scope-event-anchored turns bind to verified scope-events.json (missing or tampered)", () => {
    // A prior pack with an attested refusal — its scope_gate turn anchors a scope event.
    const evPriorDir = join(root, "pack-loop-1-ev");
    const evCurrentDir = join(root, "pack-loop-2-ev");
    const evPrior = exportPack({
      dir: evPriorDir,
      loop_id: "loop-1ev",
      goal: "design with refusal",
      delta: { settled: ["chose Ed25519"] },
      withRefusal: true
    });
    const edge: ScopeInheritsLoop = {
      capsule_ref: deriveContinuationRef(evPrior.continuation),
      scope_ref: evPrior.continuation.scope_ref,
      final_turn_ref: evPrior.continuation.final_turn_ref!
    };
    exportPack({
      dir: evCurrentDir,
      loop_id: "loop-2ev",
      goal: "ship after refusal",
      delta: { settled: ["wired export"] },
      lineage: { edge, stateHash: deriveInheritsStateHash(evPrior.continuation), prior: evPrior.continuation, priorTurns: evPrior.turns },
      seed: { settled: evPrior.continuation.settled }
    });
    // Genuine pair verifies.
    expect(verifyCrossLoopLinkage({ prior_pack_dir: evPriorDir, current_pack_dir: evCurrentDir }).ok).toBe(true);
    // Missing scope-events.json: the anchored turn cannot be substantiated.
    const evPath = join(evPriorDir, "scope-events.json");
    const original = readFileSync(evPath, "utf8");
    try {
      unlinkSync(evPath);
      const report = verifyCrossLoopLinkage({ prior_pack_dir: evPriorDir, current_pack_dir: evCurrentDir });
      expect(report.ok).toBe(false);
      expect(report.checks.find((c) => !c.ok)!.name).toBe("prior_ledger_events_bind");
    } finally {
      writeFileSync(evPath, original);
    }
    // Tampered event (matched_rule rewritten): recompute no longer equals the declared event_hash.
    withTamperedFile(evPriorDir, "scope-events.json", (events: Array<{ matched_rule?: string }>) => {
      events[0]!.matched_rule = "totally_different_rule";
      return events;
    }, () => {
      const report = verifyCrossLoopLinkage({ prior_pack_dir: evPriorDir, current_pack_dir: evCurrentDir });
      expect(report.ok).toBe(false);
      const failed = report.checks.find((c) => !c.ok)!;
      expect(failed.name).toBe("prior_ledger_events_bind");
      expect(failed.detail).toContain("tampered");
    });
  });

  it("fails closed: a scope-capsule sealed for a DIFFERENT loop, hash-consistently re-sealed", () => {
    // Change the sealed structural loop_id to another loop and recompute scope_ref so the capsule is
    // internally consistent (recompute rung passes). The scope is now sealed for a loop the
    // continuation/chain are not — the identity binding refuses before the opaque scope_ref is trusted.
    withTamperedFile(
      currentDir,
      "scope-capsule.json",
      (s: { scope_ref?: string; structural: { loop_id?: string } }) => {
        s.structural.loop_id = "loop-someone-else";
        s.scope_ref = deriveScopeRef(s.structural as never);
        return s;
      },
      () => {
        const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
        expect(report.ok).toBe(false);
        const failed = report.checks.find((c) => !c.ok)!;
        expect(failed.name).toBe("current_scope_loop_binds");
        expect(failed.detail).toContain("not sealed for this loop");
      }
    );
  });

  it("fails closed: a bind turn's PROPOSED descriptor edited away from the signed receipt stamp", () => {
    // Same receipt_id/outcome/scope_ref, but the ledger's proposed move is rewritten (tool_name).
    // The reducer would re-fold an action identity the signed receipt never authorized — the
    // checker now mirrors the exporter's descriptor binding and refuses.
    withTamperedFile(
      currentDir,
      "judgment-ledger.json",
      (ledger: { turns: Array<{ verdict?: { source?: string }; proposed?: { tool_name?: string } }> }) => {
        const bind = ledger.turns.find((t) => t.verdict?.source === "bind")!;
        bind.proposed!.tool_name = "delete_file"; // receipt stamps write_file
        return ledger;
      },
      () => {
        const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
        expect(report.ok).toBe(false);
        const failed = report.checks.find((c) => !c.ok)!;
        expect(failed.name).toBe("child_ledger_receipts_bind");
        expect(failed.detail).toContain("did not authorize");
      }
    );
  });

  it("fails closed: a scope-event-anchored turn whose CONTENT disagrees with the attested event", () => {
    // Codex's vector: a prior ledger that chain-validates and re-folds cleanly, yet whose scope_gate
    // turn anchors a real attested event that DESCRIBES A DIFFERENT MOVE than the turn proposed. The
    // honest exporter rejects this at export (content binding), so we assemble the prior pack files
    // directly — exactly the trust-no-one case the offline checker must catch. (Editing an existing
    // honest ledger cannot reach this rung: any content edit changes the hash-chained final_turn_ref,
    // which the immutable sealed edge pins, so the re-fold rung fires first.) The checker reads only
    // continuation / receipts / judgment-ledger / scope-events for the prior pack, so those four
    // suffice. event.attempted = delete_file; the turn proposes write_file.
    const craftedPriorDir = join(root, "pack-crafted-prior");
    const craftedCurrentDir = join(root, "pack-crafted-current");
    const goal_hash = deriveGoalHash("design with mismatched refusal");
    const priorScope = sealed("loop-1cr", goal_hash);
    const priorReceipts: ProofReceipt[] = [
      inLoopReceipt("loop-1cr", goal_hash, "r1", null, priorScope.scope_ref),
      terminalReceipt("loop-1cr", goal_hash, "close", "r1", 1)
    ];
    const rec = createJudgmentRecorder();
    const t0 = rec.append({
      loop_id: "loop-1cr",
      scope_ref: priorScope.scope_ref,
      prior_receipt_id: null,
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
      verdict: { kind: "APPROVED", source: "bind", receipt_id: "r1" }
    });
    rec.attachRuntimeReport("loop-1cr", t0.turn_ref, { returned: true, result_hash: `sha256:${"a".repeat(64)}` });
    rec.attachDelta("loop-1cr", t0.turn_ref, { settled: ["chose Ed25519"] });
    const scopeRec = createScopeEventRecorder();
    const event = scopeRec.record({
      event_type: "scope_refusal",
      loop_id: "loop-1cr",
      scope_ref: priorScope.scope_ref,
      attempted: { action_class: "write", tool_name: "delete_file", target_descriptor: null }, // event says delete_file
      matched_rule: "forbidden_targets",
      decision: "REFUSED",
      prior_receipt_id: "r1"
    });
    rec.append({
      loop_id: "loop-1cr",
      scope_ref: priorScope.scope_ref,
      prior_receipt_id: "r1",
      proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null }, // turn says write_file
      verdict: { kind: "REFUSED", source: "scope_gate", scope_event_hash: event.event_hash, reason_code: "forbidden_targets" }
    });
    const priorTurns = rec.judgmentLedgerForLoop("loop-1cr");
    const reduced = reduceJudgmentLedger({ loop_id: "loop-1cr", scope_ref: priorScope.scope_ref, turns: priorTurns, mode: "verified_context" });
    const priorContinuation = buildContinuationCapsule({
      scope_history: [priorScope],
      scope_events: [event],
      loop: { loop_id: "loop-1cr", goal_hash, sealed: true, action_count: 1 },
      mode: "verified_context",
      reduced
    });
    mkdirSync(craftedPriorDir, { recursive: true });
    writeFileSync(join(craftedPriorDir, "receipts.json"), JSON.stringify(priorReceipts, null, 2));
    writeFileSync(join(craftedPriorDir, "judgment-ledger.json"), JSON.stringify({ turns: priorTurns }, null, 2));
    writeFileSync(join(craftedPriorDir, "scope-events.json"), JSON.stringify([event], null, 2));
    writeFileSync(join(craftedPriorDir, "continuation-capsule.json"), JSON.stringify(priorContinuation, null, 2));

    const edge: ScopeInheritsLoop = {
      capsule_ref: deriveContinuationRef(priorContinuation),
      scope_ref: priorContinuation.scope_ref,
      final_turn_ref: priorContinuation.final_turn_ref!
    };
    exportPack({
      dir: craftedCurrentDir,
      loop_id: "loop-2cr",
      goal: "ship after mismatched refusal",
      delta: { settled: ["wired export"] },
      lineage: { edge, stateHash: deriveInheritsStateHash(priorContinuation), prior: priorContinuation, priorTurns },
      seed: { settled: priorContinuation.settled }
    });

    const report = verifyCrossLoopLinkage({ prior_pack_dir: craftedPriorDir, current_pack_dir: craftedCurrentDir });
    expect(report.ok).toBe(false);
    // The earlier rungs (refold, receipt-bind) pass — only the event CONTENT binding catches it.
    expect(report.checks.find((c) => !c.ok)!.name).toBe("prior_ledger_events_bind");
  });

  it("fails closed: a loop receipt with NO goal_hash cannot bind to the continuation's goal", () => {
    withTamperedFile(
      priorDir,
      "receipts.json",
      (receipts: Array<{ constraints?: { loop?: { goal_hash?: string }; loop_close?: { goal_hash?: string } } }>) => {
        for (const r of receipts) {
          if (r.constraints?.loop) delete r.constraints.loop.goal_hash;
          if (r.constraints?.loop_close) delete r.constraints.loop_close.goal_hash;
        }
        return receipts;
      },
      () => {
        const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
        expect(report.ok).toBe(false);
        // Either the structural chain check or the goal binding refuses — both are fail closed.
        expect(["prior_chain_structural", "prior_chain_goal_binds"]).toContain(report.checks.find((c) => !c.ok)!.name);
      }
    );
  });

  it("fails closed: the unhashed top-level privacy_mode cannot be flipped to 'proof' to skip child-state checks", () => {
    // privacy_mode (top level) is the EXPORT mode and is not covered by scope_ref. Editing it to
    // "proof" while the continuation still publishes plaintext is the contradiction the checker
    // refuses — the child-state checks cannot be skipped this way.
    withTamperedFile(
      currentDir,
      "scope-capsule.json",
      (s: { privacy_mode: string }) => ({ ...s, privacy_mode: "proof" }),
      () => {
        const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
        expect(report.ok).toBe(false);
        expect(report.checks.find((c) => !c.ok)!.name).toBe("current_privacy_mode_consistent");
      }
    );
  });

  it("fails closed (never crashes): valid JSON with the wrong shape produces the report, not an exception", () => {
    // receipts.json containing {} — must yield a failing report with the signature notice, not throw.
    withTamperedFile(priorDir, "receipts.json", () => ({}) as never, () => {
      const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
      expect(report.ok).toBe(false);
      expect(report.checks.find((c) => !c.ok)!.name).toBe("read_prior_receipts");
      expect(report.signature_notice).toContain("Signature verification not performed here");
    });
    // scope-capsule.json without a structural projection — same contract.
    withTamperedFile(currentDir, "scope-capsule.json", () => ({ scope_ref: "scope_v1:" + "a".repeat(64) }) as never, () => {
      const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
      expect(report.ok).toBe(false);
      expect(report.checks.find((c) => !c.ok)!.name).toBe("read_current_scope_capsule");
    });
    // judgment-ledger.json with no turns array — same contract.
    withTamperedFile(priorDir, "judgment-ledger.json", () => ({ judgment_ledger_version: "x" }) as never, () => {
      const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: currentDir });
      expect(report.ok).toBe(false);
      expect(report.checks.find((c) => !c.ok)!.name).toBe("prior_ledger_present");
    });
    // CLI smoke over a malformed pack: exit 1, no throw, notice printed.
    withTamperedFile(priorDir, "receipts.json", () => ({}) as never, () => {
      let out = "";
      const code = runVerifyCrossLoop(["--prior", priorDir, "--current", currentDir], {
        stdout: (t: string) => {
          out += t;
        },
        stderr: () => {}
      });
      expect(code).toBe(1);
      expect(out).toContain("Linkage NOT verified");
      expect(out).toContain("npx -y lyhna-verify --chain");
    });
  });

  it("every report carries the signature notice — failure included (never implies full verification)", () => {
    const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: priorDir });
    expect(report.ok).toBe(false);
    expect(report.signature_notice).toBe(
      "Signature verification not performed here. Re-run lyhna-verify on both receipt chains to trust signatures."
    );
    expect(report.verify_commands).toHaveLength(2);
  });
});
