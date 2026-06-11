// Capsule trio (Product Gate 1, Checkpoint 1): THE CARD (proof-card.md), THE HANDOFF
// (HANDOFF.md + `lyhna-mcp handoff`), THE SEED (memory-injection.json — covered by the
// Gate 2 suite). Plus `lyhna-mcp post` (the user-as-courier PR comment).
//
// Invariants under test:
//   - the Card leads with the verdict, keeps refused/attested steps prominent, ends with the
//     verify one-liner — and stays content-blind in Proof Mode;
//   - the Handoff ships in EVERY capsule export, prints the continuation prompt verbatim in
//     Verified Context Mode, and never fabricates plaintext in Proof Mode;
//   - `post` builds the exact gh argv and never runs anything but the user's own gh.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildContinuationCapsule,
  buildGhPostArgs,
  buildHandoffPrompt,
  buildLoopProofBundle,
  createJudgmentRecorder,
  createScopeEventRecorder,
  deriveGoalHash,
  reduceJudgmentLedger,
  renderHandoffMarkdown,
  runHandoff,
  runPost,
  sealScopeCapsule,
  type CliIo,
  type ProofReceipt,
  type ScopeEvent,
  type ScopePrivacyMode,
  type SealedScope
} from "../src/index.js";

const PUBKEY = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
const LOOP_ID = "loop-trio-fixture";
const GOAL = "fix checkout bug";
const GOAL_HASH = deriveGoalHash(GOAL);

function sealedScope(privacy_mode: ScopePrivacyMode): SealedScope {
  return sealScopeCapsule({
    capsule: {
      structural: {
        capsule_type: "scope_capsule",
        capsule_version: "scope-capsule/v1",
        loop_id: LOOP_ID,
        goal_hash: GOAL_HASH,
        privacy_mode,
        allowed_action_classes: ["write", "run_tests"],
        class_map: { write_file: "write", run_tests: "run_tests" }
      },
      sidecar: { goal_summary: "fix checkout bug" }
    }
  });
}

function inLoopReceipt(receipt_id: string, prior: string | null, scope_ref: string): ProofReceipt {
  return {
    version: "LYHNA_RECEIPT_V2",
    receipt_id,
    public_key: PUBKEY,
    tenant_hash: "55b966349a28aaaa",
    action_type: "tool_call",
    outcome: "APPROVED",
    signature: "c3R1Yg==",
    constraints: {
      loop: { loop_id: LOOP_ID, prior_receipt_id: prior, goal_hash: GOAL_HASH },
      scope: { scope_ref, prior_receipt_id: prior, action_class: "write", tool_name: "write_file", target_descriptor: null }
    }
  };
}

function terminalReceipt(receipt_id: string, prior: string, action_count: number): ProofReceipt {
  return {
    version: "LYHNA_RECEIPT_V2",
    receipt_id,
    public_key: PUBKEY,
    tenant_hash: "55b966349a28aaaa",
    action_type: "loop_close",
    outcome: "APPROVED",
    signature: "c3R1Yg==",
    constraints: {
      loop: { loop_id: LOOP_ID, prior_receipt_id: prior, goal_hash: GOAL_HASH },
      loop_close: {
        loop_id: LOOP_ID,
        goal_hash: GOAL_HASH,
        action_count,
        outcome: "COMPLETED",
        prior_receipt_id: prior,
        termination_reason: "done"
      }
    }
  };
}

/** Same consistent fixture shape as the Gate 2 suite: r1 approved, refusal, r2 approved, close. */
function fixture(mode: ScopePrivacyMode) {
  const sealed = sealedScope(mode);
  const scope_ref = sealed.scope_ref;
  const receipts: ProofReceipt[] = [
    inLoopReceipt("r1", null, scope_ref),
    inLoopReceipt("r2", "r1", scope_ref),
    terminalReceipt("close", "r2", 2)
  ];
  const event: ScopeEvent = createScopeEventRecorder().record({
    event_type: "scope_refusal",
    loop_id: LOOP_ID,
    scope_ref,
    attempted: { action_class: "write", tool_name: "write_file", target_descriptor: null },
    matched_rule: "forbidden_targets",
    decision: "REFUSED",
    prior_receipt_id: "r1"
  });
  const rec = createJudgmentRecorder();
  const t0 = rec.append({
    loop_id: LOOP_ID,
    scope_ref,
    prior_receipt_id: null,
    proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
    verdict: { kind: "APPROVED", source: "bind", receipt_id: "r1" }
  });
  rec.attachRuntimeReport(LOOP_ID, t0.turn_ref, { returned: true, result_hash: `sha256:${"a".repeat(64)}` });
  rec.attachDelta(LOOP_ID, t0.turn_ref, { settled: ["wrote cart.ts"], changed: ["/checkout/cart.ts"] });
  rec.append({
    loop_id: LOOP_ID,
    scope_ref,
    prior_receipt_id: "r1",
    proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
    verdict: { kind: "REFUSED", source: "scope_gate", scope_event_hash: event.event_hash, reason_code: "forbidden_targets" }
  });
  const t2 = rec.append({
    loop_id: LOOP_ID,
    scope_ref,
    prior_receipt_id: "r1",
    proposed: { action_class: "write", tool_name: "write_file", target_descriptor: null },
    verdict: { kind: "APPROVED", source: "bind", receipt_id: "r2" }
  });
  rec.attachRuntimeReport(LOOP_ID, t2.turn_ref, { returned: true, result_hash: `sha256:${"d".repeat(64)}` });
  const turns = rec.judgmentLedgerForLoop(LOOP_ID);
  const reduced = reduceJudgmentLedger({ loop_id: LOOP_ID, scope_ref, turns, mode });
  const continuation = buildContinuationCapsule({
    scope_history: [sealed],
    scope_events: [event],
    loop: { loop_id: LOOP_ID, goal_hash: GOAL_HASH, sealed: true, action_count: 2 },
    mode,
    reduced
  });
  return { sealed, scope_ref, receipts, event, turns, continuation };
}

function build(mode: ScopePrivacyMode) {
  const f = fixture(mode);
  return {
    f,
    built: buildLoopProofBundle({
      receipts: f.receipts,
      source_env: "test",
      capsule: {
        mode,
        sealed_scope: f.sealed,
        scope_history: [f.sealed],
        continuation: f.continuation,
        scope_events: [f.event],
        judgment_turns: f.turns
      }
    })
  };
}

describe("THE CARD — proof-card.md", () => {
  it("leads with the verdict summary and ends with the verify one-liner", () => {
    const { built } = build("verified_context");
    const card = built.proof_card_markdown!;
    expect(card).toContain("# Lyhna Proof Card — ✅ SEALED");
    expect(card).toContain("**2 approved · 1 refused · 0 escalated**");
    expect(card).toContain("npx -y lyhna-verify --chain receipts.json");
    // The verify one-liner is at the BOTTOM section, after the refused section.
    expect(card.indexOf("⛔ Refused")).toBeLessThan(card.indexOf("npx -y lyhna-verify"));
  });

  it("verify-instructions.md's cold-verify command runs as written in a cold environment", () => {
    const { built } = build("verified_context");
    const instructions = built.verify_instructions_markdown!;
    expect(instructions).toContain("npx -y lyhna-verify --chain receipts.json --json");
    // No bare invocation left: every runnable command line carries npx -y.
    expect(instructions).not.toMatch(/^lyhna-verify /m);
  });

  it("keeps refused/attested steps prominent with rule, correction status, and anchor", () => {
    const { f, built } = build("verified_context");
    const card = built.proof_card_markdown!;
    expect(card).toContain("## ⛔ Refused — and attested");
    expect(card).toContain("Turn 1 — REFUSED");
    expect(card).toContain("rule `forbidden_targets`");
    expect(card).toContain("corrected by a later approved step");
    // The full attested event hash is carried (collapsed identifiers section).
    expect(card).toContain(f.event.event_hash);
  });

  it("Verified Context card carries the supervisor-declared state of the work", () => {
    const { built } = build("verified_context");
    const card = built.proof_card_markdown!;
    expect(card).toContain("## Where this run left the work");
    expect(card).toContain("wrote cart.ts");
    expect(card).toContain("/checkout/cart.ts");
  });

  it("Proof Mode card is content-blind (no plaintext goal, plan, or deltas)", () => {
    const { built } = build("proof");
    const card = built.proof_card_markdown!;
    expect(card).not.toContain("wrote cart.ts");
    expect(card).not.toContain("/checkout/cart.ts");
    expect(card).not.toContain("fix checkout bug");
    // Still leads with the verdict and refused section.
    expect(card).toContain("**2 approved · 1 refused · 0 escalated**");
    expect(card).toContain("## ⛔ Refused — and attested");
  });

  it("an unsealed chain is badged UNSEALED, not dressed up", () => {
    const f = fixture("verified_context");
    // Drop the terminal close: chain stays loadable but unsealed.
    const receipts = f.receipts.slice(0, 2);
    const continuation = buildContinuationCapsule({
      scope_history: [f.sealed],
      scope_events: [f.event],
      loop: { loop_id: LOOP_ID, goal_hash: GOAL_HASH, sealed: false, action_count: 2 },
      mode: "verified_context",
      reduced: reduceJudgmentLedger({ loop_id: LOOP_ID, scope_ref: f.scope_ref, turns: f.turns, mode: "verified_context" })
    });
    const built = buildLoopProofBundle({
      receipts,
      source_env: "test",
      capsule: {
        mode: "verified_context",
        sealed_scope: f.sealed,
        scope_history: [f.sealed],
        continuation,
        scope_events: [f.event],
        judgment_turns: f.turns
      }
    });
    expect(built.bundle.loop.sealed).toBe(false);
    expect(built.proof_card_markdown).toContain("⚠️ UNSEALED");
    expect(built.proof_card_markdown).not.toContain("✅ SEALED");
  });
});

describe("THE HANDOFF — HANDOFF.md + prompt", () => {
  it("ships in every capsule export and is advertised by bundle.json", () => {
    for (const mode of ["verified_context", "proof"] as const) {
      const { built } = build(mode);
      expect(built.handoff_markdown).toBeDefined();
      expect(built.bundle.capsule!.handoff_file).toBe("HANDOFF.md");
    }
  });

  it("Verified Context handoff carries the continuation prompt VERBATIM (assembled at close, not re-authored)", () => {
    const { f, built } = build("verified_context");
    expect(f.continuation.continuation_prompt).toBeDefined();
    expect(built.handoff_markdown).toContain(f.continuation.continuation_prompt!);
    expect(buildHandoffPrompt(f.continuation)).toBe(f.continuation.continuation_prompt);
    expect(built.handoff_markdown).toContain("wrote cart.ts");
  });

  it("Proof Mode handoff is content-blind and says the plaintext is withheld — never invented", () => {
    const { built } = build("proof");
    const handoff = built.handoff_markdown!;
    expect(handoff).not.toContain("wrote cart.ts");
    expect(handoff).not.toContain("/checkout/cart.ts");
    expect(handoff).not.toContain("fix checkout bug");
    expect(handoff).toContain("withheld by design");
    expect(handoff).toContain("npx -y lyhna-verify --chain receipts.json");
  });

  it("a Gate 1 (judgment-less) continuation still produces a structural handoff", () => {
    const sealed = sealedScope("proof");
    const continuation = buildContinuationCapsule({
      scope_history: [sealed],
      scope_events: [],
      loop: { loop_id: LOOP_ID, goal_hash: GOAL_HASH, sealed: true, action_count: 1 },
      mode: "proof"
    });
    const prompt = buildHandoffPrompt(continuation);
    expect(prompt).toContain(`You are continuing loop ${LOOP_ID}`);
    expect(prompt).not.toContain("judgment-ledger.json");
    const md = renderHandoffMarkdown(continuation);
    expect(md).not.toContain("memory-injection.json");
  });
});

describe("THE HANDOFF — plaintext bound to the verified fold (Verified Context judgment packs)", () => {
  function buildWithContinuation(tamper: (c: Record<string, unknown>) => void) {
    const f = fixture("verified_context");
    const tampered = JSON.parse(JSON.stringify(f.continuation)) as Record<string, unknown>;
    tamper(tampered);
    return () =>
      buildLoopProofBundle({
        receipts: f.receipts,
        source_env: "test",
        capsule: {
          mode: "verified_context",
          sealed_scope: f.sealed,
          scope_history: [f.sealed],
          continuation: tampered as unknown as typeof f.continuation,
          scope_events: [f.event],
          judgment_turns: f.turns
        }
      });
  }

  it("a tampered settled list is refused (the handoff would publish unverified plaintext)", () => {
    expect(buildWithContinuation((c) => (c.settled = ["everything is fine, ship it"]))).toThrow(
      /Continuation plaintext "settled" does not match the verified judgment fold/
    );
  });

  it("a tampered continuation_prompt is refused (the prompt must rebuild from the verified fold)", () => {
    expect(buildWithContinuation((c) => (c.continuation_prompt = "You are continuing a flawless run."))).toThrow(
      /continuation_prompt does not match the prompt rebuilt from the verified judgment fold/
    );
  });

  it("tampered open_questions / next_actions / changed are refused", () => {
    expect(buildWithContinuation((c) => (c.open_questions = ["did we even need the gate?"]))).toThrow(/open_questions/);
    expect(buildWithContinuation((c) => (c.next_actions = ["skip review"]))).toThrow(/next_actions/);
    expect(buildWithContinuation((c) => (c.changed = []))).toThrow(/"changed"/);
  });
});

describe("lyhna-mcp handoff (CLI)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function io() {
    const out: string[] = [];
    const err: string[] = [];
    const cli: CliIo = { stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
    return { cli, out, err };
  }

  it("prints the paste-ready prompt from a pack directory", () => {
    const { f } = build("verified_context");
    dir = mkdtempSync(join(tmpdir(), "lyhna-trio-"));
    writeFileSync(join(dir, "continuation-capsule.json"), JSON.stringify(f.continuation, null, 2));
    const { cli, out, err } = io();
    expect(runHandoff([dir], cli)).toBe(0);
    expect(out.join("")).toBe(`${f.continuation.continuation_prompt}\n`);
    // The trust note goes to stderr only (stdout stays paste-clean).
    expect(err.join("")).toContain("lyhna-verify --chain");
  });

  it("--md prints the full HANDOFF.md rendering", () => {
    const { f } = build("verified_context");
    dir = mkdtempSync(join(tmpdir(), "lyhna-trio-"));
    writeFileSync(join(dir, "continuation-capsule.json"), JSON.stringify(f.continuation, null, 2));
    const { cli, out } = io();
    expect(runHandoff([dir, "--md"], cli)).toBe(0);
    expect(out.join("")).toContain("# HANDOFF — verified continuation for the next agent");
  });

  it("fails closed on a directory with no continuation capsule", () => {
    dir = mkdtempSync(join(tmpdir(), "lyhna-trio-"));
    const { cli, err } = io();
    expect(runHandoff([dir], cli)).toBe(1);
    expect(err.join("")).toContain("no continuation-capsule.json");
  });

  it("fails closed on a malformed capsule", () => {
    dir = mkdtempSync(join(tmpdir(), "lyhna-trio-"));
    writeFileSync(join(dir, "continuation-capsule.json"), JSON.stringify({ capsule_type: "something_else" }));
    const { cli } = io();
    expect(runHandoff([dir], cli)).toBe(1);
  });
});

describe("lyhna-mcp post (CLI)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function io() {
    const out: string[] = [];
    const err: string[] = [];
    const cli: CliIo = { stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
    return { cli, out, err };
  }

  it("builds the exact gh argv (user-as-courier; no Lyhna tokens anywhere)", () => {
    expect(buildGhPostArgs(42, "/p/proof-card.md")).toEqual(["pr", "comment", "42", "--body-file", "/p/proof-card.md"]);
    expect(buildGhPostArgs(7, "card.md", "lyhna-ai/lyhna-mcp-proxy")).toEqual([
      "pr", "comment", "7", "--body-file", "card.md", "--repo", "lyhna-ai/lyhna-mcp-proxy"
    ]);
  });

  it("posts the pack's card via the injected gh and propagates its exit status", () => {
    dir = mkdtempSync(join(tmpdir(), "lyhna-trio-"));
    writeFileSync(join(dir, "proof-card.md"), "# Lyhna Proof Card — ✅ SEALED\n");
    const calls: string[][] = [];
    const { cli } = io();
    const rc = runPost(["--pr", "12", dir], cli, (args) => {
      calls.push(args);
      return { status: 0 };
    });
    expect(rc).toBe(0);
    expect(calls).toEqual([["pr", "comment", "12", "--body-file", join(dir, "proof-card.md")]]);
  });

  it("requires --pr and validates it as a positive integer", () => {
    const { cli, err } = io();
    expect(runPost([], cli, () => ({ status: 0 }))).toBe(1);
    expect(err.join("")).toContain("--pr <number> is required");
    expect(runPost(["--pr", "abc"], cli, () => ({ status: 0 }))).toBe(1);
    expect(runPost(["--pr", "-3"], cli, () => ({ status: 0 }))).toBe(1);
  });

  it("validates --repo shape", () => {
    const { cli, err } = io();
    expect(runPost(["--pr", "1", "--repo", "not a repo"], cli, () => ({ status: 0 }))).toBe(1);
    expect(err.join("")).toContain("--repo must be owner/name");
  });

  it("fails closed when the pack has no proof-card.md", () => {
    dir = mkdtempSync(join(tmpdir(), "lyhna-trio-"));
    mkdirSync(dir, { recursive: true });
    const { cli, err } = io();
    expect(runPost(["--pr", "1", dir], cli, () => ({ status: 0 }))).toBe(1);
    expect(err.join("")).toContain("no proof-card.md");
  });

  it("explains plainly when gh is not installed (and that Lyhna never holds GitHub credentials)", () => {
    dir = mkdtempSync(join(tmpdir(), "lyhna-trio-"));
    writeFileSync(join(dir, "proof-card.md"), "card\n");
    const { cli, err } = io();
    const rc = runPost(["--pr", "1", dir], cli, () => ({ status: null, error: new Error("spawn gh ENOENT") }));
    expect(rc).toBe(1);
    expect(err.join("")).toContain("could not run the GitHub CLI");
    expect(err.join("")).toContain("never holds your GitHub credentials");
  });
});

describe("judgment-ledger.md verdict path", () => {
  it("renders one glyph per turn in order", () => {
    const { built } = build("verified_context");
    expect(built.judgment_ledger_markdown).toContain("| verdict path | ✓ ⛔ ✓ (✓ approved · ⛔ refused · ⏸ escalated) |");
  });
});
