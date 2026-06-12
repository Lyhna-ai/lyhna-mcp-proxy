import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CROSS_LOOP_SUCCESS_WORDING,
  buildContinuationCapsule,
  buildLoopProofBundle,
  createJudgmentRecorder,
  deriveContinuationRef,
  deriveGoalHash,
  deriveInheritsStateHash,
  reduceJudgmentLedger,
  sealScopeCapsule,
  verifyCrossLoopLinkage,
  writeProofPackFiles,
  type ContinuationCapsule,
  type ProofReceipt,
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
    scope_events: [],
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
      scope_events: [],
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

  it("every report carries the signature notice — failure included (never implies full verification)", () => {
    const report = verifyCrossLoopLinkage({ prior_pack_dir: priorDir, current_pack_dir: priorDir });
    expect(report.ok).toBe(false);
    expect(report.signature_notice).toBe(
      "Signature verification not performed here. Re-run lyhna-verify on both receipt chains to trust signatures."
    );
    expect(report.verify_commands).toHaveLength(2);
  });
});
