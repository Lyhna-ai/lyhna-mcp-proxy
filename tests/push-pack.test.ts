// Supabase Destination Contract v1 — `lyhna-mcp push-pack`.
//
// Everything here runs OFFLINE: packs are real exports built with the production builders and
// written by writeProofPackFiles into tmp dirs; the destination is either an in-memory client
// (pushPack-level flow tests) or the real Supabase PostgREST client driven by a mock fetch that
// implements insert/select with a unique(capsule_ref) constraint (client + CLI end-to-end).

import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildContinuationCapsule,
  buildLoopArtifactRow,
  buildLoopProofBundle,
  createJudgmentRecorder,
  createSupabaseLoopArtifactClient,
  deriveContinuationRef,
  deriveGoalHash,
  deriveInheritsStateHash,
  pushPack,
  reduceJudgmentLedger,
  resolveSupabaseEnv,
  sealScopeCapsule,
  sha256Hex,
  writeProofPackFiles,
  REQUIRED_PACK_FILES,
  type ContinuationCapsule,
  type LoopArtifactDestinationClient,
  type LoopArtifactRow,
  type ProofReceipt,
  type ScopeInheritsLoop,
  type ScopePrivacyMode,
  type SealedScope
} from "../src/index.js";
import { runPushPack } from "../src/bin/push-pack.js";

const PUBKEY = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
const TENANT_HASH = "55b966349a28aaaa";

// Plaintext sentinels: none of these may EVER appear in a Proof Mode row.
const SETTLED_SENTINEL = "PLAINTEXT-SETTLED-chose-Ed25519";
const NEXT_SENTINEL = "PLAINTEXT-NEXT-wire-the-export";
const GOAL_SUMMARY_SENTINEL = "PLAINTEXT-GOAL-SUMMARY";

function sealed(loop_id: string, goal_hash: string, mode: ScopePrivacyMode, lineage?: { edge: ScopeInheritsLoop; stateHash?: string }): SealedScope {
  return sealScopeCapsule({
    capsule: {
      structural: {
        capsule_type: "scope_capsule",
        capsule_version: "scope-capsule/v1",
        loop_id,
        goal_hash,
        privacy_mode: mode,
        allowed_action_classes: ["write"],
        class_map: { write_file: "write" },
        ...(lineage ? { inherits_loop: lineage.edge, ...(lineage.stateHash ? { inherits_state_hash: lineage.stateHash } : {}) } : {})
      },
      sidecar: { goal_summary: `${GOAL_SUMMARY_SENTINEL} of ${loop_id}` }
    }
  });
}

function inLoopReceipt(loop_id: string, goal_hash: string, receipt_id: string, prior: string | null, scope_ref: string): ProofReceipt {
  return {
    version: "LYHNA_RECEIPT_V2",
    receipt_id,
    public_key: PUBKEY,
    tenant_hash: TENANT_HASH,
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
    tenant_hash: TENANT_HASH,
    action_type: "loop_close",
    outcome: "APPROVED",
    signature: "c3R1Yg==",
    constraints: {
      loop: { loop_id, prior_receipt_id: prior, goal_hash },
      loop_close: { loop_id, goal_hash, action_count, outcome: "COMPLETED", prior_receipt_id: prior, termination_reason: "done" }
    }
  };
}

/** Build + write a real single-loop Gate-2 pack with the production builders (both modes). */
function exportPack(opts: {
  dir: string;
  loop_id: string;
  goal: string;
  mode?: ScopePrivacyMode;
  delta?: { settled?: string[]; next_actions?: string[]; changed?: string[] };
  lineage?: { edge: ScopeInheritsLoop; stateHash?: string; prior: ContinuationCapsule; priorTurns: unknown };
  seed?: { settled?: string[]; open_questions?: string[]; next_actions?: string[]; changed?: string[] };
}) {
  const mode = opts.mode ?? "verified_context";
  const goal_hash = deriveGoalHash(opts.goal);
  const scope = sealed(opts.loop_id, goal_hash, mode, opts.lineage);
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
  rec.attachDelta(opts.loop_id, t0.turn_ref, opts.delta ?? { settled: [SETTLED_SENTINEL], next_actions: [NEXT_SENTINEL] });
  const turns = rec.judgmentLedgerForLoop(opts.loop_id);
  const reduced = reduceJudgmentLedger({
    loop_id: opts.loop_id,
    scope_ref: scope.scope_ref,
    turns,
    mode,
    ...(opts.seed ? { seed: opts.seed } : {})
  });
  const continuation = buildContinuationCapsule({
    scope_history: [scope],
    scope_events: [],
    loop: { loop_id: opts.loop_id, goal_hash, sealed: true, action_count: 1 },
    mode,
    reduced
  });
  const built = buildLoopProofBundle({
    receipts,
    source_env: "test",
    capsule: {
      mode,
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

/** In-memory destination client with a unique(capsule_ref) constraint and call recording. */
function memoryClient(initial: Array<Record<string, unknown>> = []) {
  const rows: Array<Record<string, unknown>> = [...initial];
  const calls: string[] = [];
  let nextId = 1;
  const client: LoopArtifactDestinationClient = {
    async selectByCapsuleRef(ref) {
      calls.push("selectByCapsuleRef");
      return rows.filter((r) => r.capsule_ref === ref).map((r) => ({ ...r }));
    },
    async insertRow(row) {
      calls.push("insertRow");
      if (rows.some((r) => r.capsule_ref === row.capsule_ref)) return { kind: "conflict" };
      const stored = { id: `row-${nextId++}`, created_at: "2026-06-12T00:00:00.000Z", ...row } as Record<string, unknown>;
      rows.push(stored);
      return { kind: "inserted", row: { ...stored } };
    },
    async selectById(id) {
      calls.push("selectById");
      const r = rows.find((x) => x.id === id);
      return r ? { ...r } : null;
    }
  };
  return { client, rows, calls };
}

/**
 * Mock fetch implementing the PostgREST surface push-pack uses: GET with capsule_ref=eq./id=eq.
 * filters, POST insert with a unique(capsule_ref) 409, return=representation, and the
 * timestamptz normalization a real Supabase project performs on read (Z -> +00:00).
 */
function supabaseMock(opts: { table?: string; insertStatus?: number } = {}) {
  const table = opts.table ?? "lyhna_loop_artifacts";
  const rows: Array<Record<string, unknown>> = [];
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; redirect: string | undefined }> = [];
  let nextId = 1;
  const normalize = (r: Record<string, unknown>): Record<string, unknown> => ({
    ...r,
    verified_at: String(r.verified_at).replace(/Z$/, "+00:00"),
    exported_at: String(r.exported_at).replace(/Z$/, "+00:00")
  });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: url.toString(),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      redirect: init?.redirect
    });
    if (!url.pathname.endsWith(`/rest/v1/${table}`)) {
      return new Response(JSON.stringify({ code: "404", message: "relation not found" }), { status: 404 });
    }
    if (method === "POST") {
      if (opts.insertStatus !== undefined) {
        return new Response(JSON.stringify({ code: "XX000", message: "injected failure" }), { status: opts.insertStatus });
      }
      const row = JSON.parse(String(init!.body)) as Record<string, unknown>;
      if (rows.some((r) => r.capsule_ref === row.capsule_ref)) {
        return new Response(JSON.stringify({ code: "23505", message: "duplicate key value violates unique constraint" }), { status: 409 });
      }
      const stored = { id: `row-${nextId++}`, created_at: new Date().toISOString(), ...row };
      rows.push(stored);
      return new Response(JSON.stringify([normalize(stored)]), { status: 201 });
    }
    let out = rows;
    const capsuleEq = url.searchParams.get("capsule_ref");
    if (capsuleEq !== null) out = out.filter((r) => capsuleEq === `eq.${r.capsule_ref}`);
    const idEq = url.searchParams.get("id");
    if (idEq !== null) out = out.filter((r) => idEq === `eq.${r.id}`);
    return new Response(JSON.stringify(out.map(normalize)), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, rows, calls };
}

const ENV = {
  LYHNA_SUPABASE_URL: "https://example.supabase.co",
  LYHNA_SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key"
};

function captureIo() {
  let out = "";
  let err = "";
  return {
    io: { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t) },
    out: () => out,
    err: () => err
  };
}

function failing(result: ReturnType<typeof buildLoopArtifactRow>) {
  expect(result.ok).toBe(false);
  return result.checks.filter((c) => !c.ok);
}

describe("push-pack — Supabase Destination Contract v1", () => {
  let root: string;
  let vcDir: string;
  let proofDir: string;
  let childDir: string;
  let vc: ReturnType<typeof exportPack>;
  let child: ReturnType<typeof exportPack>;
  let childEdge: ScopeInheritsLoop;
  let childStateHash: string;
  let copyCount = 0;

  /** Fresh tamperable copy of a pack directory. */
  function copyOf(dir: string): string {
    const dest = join(root, `copy-${copyCount++}`);
    cpSync(dir, dest, { recursive: true });
    return dest;
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lyhna-push-pack-"));
    vcDir = join(root, "pack-vc");
    proofDir = join(root, "pack-proof");
    childDir = join(root, "pack-child");
    vc = exportPack({ dir: vcDir, loop_id: "loop-vc", goal: "design the destination" });
    exportPack({ dir: proofDir, loop_id: "loop-proof", goal: "content-blind destination", mode: "proof" });
    childEdge = {
      capsule_ref: deriveContinuationRef(vc.continuation),
      scope_ref: vc.continuation.scope_ref,
      final_turn_ref: vc.continuation.final_turn_ref!
    };
    childStateHash = deriveInheritsStateHash(vc.continuation);
    child = exportPack({
      dir: childDir,
      loop_id: "loop-child",
      goal: "accumulate the destination",
      delta: { settled: ["child step"] },
      lineage: { edge: childEdge, stateHash: childStateHash, prior: vc.continuation, priorTurns: vc.turns },
      seed: { settled: vc.continuation.settled, next_actions: vc.continuation.next_actions }
    });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- row construction (pure, local)

  it("constructs the full row from a complete Verified Context pack", () => {
    const result = buildLoopArtifactRow(vcDir, () => new Date("2026-06-12T22:00:00.000Z"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.row;
    const bundle = JSON.parse(readFileSync(join(vcDir, "bundle.json"), "utf8"));
    expect(row.loop_id).toBe("loop-vc");
    expect(row.tenant_hash).toBe(TENANT_HASH);
    expect(row.mode).toBe("verified_context");
    expect(row.sealed).toBe(true);
    expect(row.action_count).toBe(1);
    expect(row.receipt_count).toBe(2);
    expect(row.scope_ref).toBe(vc.continuation.scope_ref);
    expect(row.capsule_ref).toBe(deriveContinuationRef(vc.continuation));
    expect(row.final_turn_ref).toBe(vc.continuation.final_turn_ref);
    // Non-inheriting pack: parent fields are null, never invented.
    expect(row.parent_capsule_ref).toBeNull();
    expect(row.parent_scope_ref).toBeNull();
    expect(row.parent_final_turn_ref).toBeNull();
    expect(row.inherits_state_hash).toBeNull();
    expect(row.receipts_digest).toBe(sha256Hex(readFileSync(join(vcDir, "receipts.json"), "utf8")));
    expect(row.receipts_digest).toBe(bundle.export.content_digest.value);
    expect(row.bundle_digest).toBe(sha256Hex(readFileSync(join(vcDir, "bundle.json"), "utf8")));
    expect(row.verification_status).toBe("structural_digests_verified");
    expect(row.verified_at).toBe("2026-06-12T22:00:00.000Z");
    expect(row.source_env).toBe("test");
    expect(row.exported_at).toBe(bundle.export.exported_at);
    expect(row.proof_card_markdown.length).toBeGreaterThan(0);
    expect(row.handoff_markdown.length).toBeGreaterThan(0);
    expect(row.verify_instructions_markdown.length).toBeGreaterThan(0);
    expect((row.proof_bundle as { bundle_version: string }).bundle_version).toBe("loop-proof-bundle/v1");
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("constructs a content-blind row from a Proof Mode pack (leak regression with plaintext sentinels)", () => {
    const result = buildLoopArtifactRow(proofDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.mode).toBe("proof");
    // The ENTIRE serialized row — jsonb artifacts and markdown faces included — must carry none
    // of the plaintext the loop produced. This is the content-blind Proof Mode boundary.
    const serialized = JSON.stringify(result.row);
    expect(serialized).not.toContain(SETTLED_SENTINEL);
    expect(serialized).not.toContain(NEXT_SENTINEL);
    expect(serialized).not.toContain(GOAL_SUMMARY_SENTINEL);
  });

  it("maps the sealed inheritance edge to parent_* columns and inherits_state_hash", () => {
    const result = buildLoopArtifactRow(childDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.parent_capsule_ref).toBe(childEdge.capsule_ref);
    expect(result.row.parent_scope_ref).toBe(childEdge.scope_ref);
    expect(result.row.parent_final_turn_ref).toBe(childEdge.final_turn_ref);
    expect(result.row.inherits_state_hash).toBe(childStateHash);
  });

  it("fails closed when the pack path is missing", () => {
    const checks = failing(buildLoopArtifactRow(join(root, "no-such-pack")));
    expect(checks[0]!.name).toBe("pack_dir");
  });

  it("fails closed when ANY of the ten required artifacts is missing", () => {
    expect(REQUIRED_PACK_FILES).toHaveLength(10);
    for (const file of REQUIRED_PACK_FILES) {
      const dir = copyOf(vcDir);
      unlinkSync(join(dir, file));
      const checks = failing(buildLoopArtifactRow(dir));
      expect(checks[0]!.name).toBe("required_artifacts");
      expect(checks[0]!.detail).toContain(file);
    }
  });

  it("fails closed when ANY required JSON artifact is malformed", () => {
    for (const file of REQUIRED_PACK_FILES.filter((f) => f.endsWith(".json"))) {
      const dir = copyOf(vcDir);
      writeFileSync(join(dir, file), "{ this is not json");
      const checks = failing(buildLoopArtifactRow(dir));
      expect(checks[0]!.name).toBe("required_artifacts");
      expect(checks[0]!.detail).toContain(file);
    }
  });

  it("fails closed when receipts.json does not recompute to the declared content digest", () => {
    const dir = copyOf(vcDir);
    writeFileSync(join(dir, "receipts.json"), readFileSync(join(dir, "receipts.json"), "utf8") + " ");
    const checks = failing(buildLoopArtifactRow(dir));
    expect(checks[0]!.name).toBe("receipts_digest_binds");
  });

  it("fails closed when the recomputed capsule_ref disagrees with memory-injection.json", () => {
    const dir = copyOf(vcDir);
    const memory = JSON.parse(readFileSync(join(dir, "memory-injection.json"), "utf8"));
    memory.capsule_ref = `cap_v1:${"0".repeat(64)}`;
    writeFileSync(join(dir, "memory-injection.json"), JSON.stringify(memory, null, 2) + "\n");
    const checks = failing(buildLoopArtifactRow(dir));
    expect(checks[0]!.name).toBe("capsule_ref_recomputes");
  });

  it("fails closed when ANY Proof Mode markdown surface is tampered post-export (re-render byte check)", () => {
    for (const file of ["proof-card.md", "HANDOFF.md", "verify-instructions.md"]) {
      const dir = copyOf(proofDir);
      writeFileSync(join(dir, file), readFileSync(join(dir, file), "utf8") + `\nINJECTED-${SETTLED_SENTINEL}\n`);
      const checks = failing(buildLoopArtifactRow(dir));
      expect(checks[0]!.name).toBe("proof_markdown_rerenders");
      expect(checks[0]!.detail).toContain(file);
      // The fail detail names the file but NEVER echoes the tampered content.
      expect(checks[0]!.detail).not.toContain(SETTLED_SENTINEL);
    }
  });

  it("untampered Proof Mode pack passes the re-render check on the re-render path for all three surfaces", () => {
    const result = buildLoopArtifactRow(proofDir);
    expect(result.ok).toBe(true);
    const check = result.checks.find((c) => c.name === "proof_markdown_rerenders")!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("re-render path used for all three surfaces");
  });

  it("Verified Context markdown is NOT re-render-checked (rich/edited markdown passes untouched)", () => {
    const dir = copyOf(vcDir);
    for (const file of ["proof-card.md", "HANDOFF.md", "verify-instructions.md"]) {
      writeFileSync(join(dir, file), readFileSync(join(dir, file), "utf8") + "\n## Operator notes\nrich plaintext annotations are legitimate here.\n");
    }
    const result = buildLoopArtifactRow(dir);
    expect(result.ok).toBe(true);
    const check = result.checks.find((c) => c.name === "proof_markdown_rerenders")!;
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("not applicable");
  });

  it("fails closed when a proof-claiming pack publishes plaintext state (mode honesty)", () => {
    const dir = copyOf(proofDir);
    const continuation = JSON.parse(readFileSync(join(dir, "continuation-capsule.json"), "utf8"));
    continuation.settled = ["leaked plaintext"];
    writeFileSync(join(dir, "continuation-capsule.json"), JSON.stringify(continuation, null, 2) + "\n");
    const checks = failing(buildLoopArtifactRow(dir));
    expect(checks[0]!.name).toBe("mode_honesty");
  });

  it("fails closed when a receipt lacks external-scope tenant_hash, even with a re-bound digest", () => {
    // Adversarial: strip tenant_hash from a receipt AND recompute the digests so the pack stays
    // internally digest-consistent — the tenant check itself must catch it.
    const dir = copyOf(vcDir);
    const receipts = JSON.parse(readFileSync(join(dir, "receipts.json"), "utf8"));
    delete receipts[0].tenant_hash;
    const newText = JSON.stringify(receipts, null, 2);
    writeFileSync(join(dir, "receipts.json"), newText);
    const digest = sha256Hex(newText);
    const bundle = JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8"));
    bundle.export.content_digest.value = digest;
    writeFileSync(join(dir, "bundle.json"), JSON.stringify(bundle, null, 2) + "\n");
    const graphNode = JSON.parse(readFileSync(join(dir, "graph-node.json"), "utf8"));
    graphNode.content_digest.value = digest;
    writeFileSync(join(dir, "graph-node.json"), JSON.stringify(graphNode, null, 2) + "\n");
    const checks = failing(buildLoopArtifactRow(dir));
    expect(checks[0]!.name).toBe("tenant_hash_uniform");
  });

  it("fails closed when the sealed scope carries an edge the continuation does not publish", () => {
    const dir = copyOf(childDir);
    const continuation = JSON.parse(readFileSync(join(dir, "continuation-capsule.json"), "utf8"));
    delete continuation.inherits_loop;
    writeFileSync(join(dir, "continuation-capsule.json"), JSON.stringify(continuation, null, 2) + "\n");
    const checks = failing(buildLoopArtifactRow(dir));
    expect(checks[0]!.name).toBe("inheritance_fields");
  });

  // ---------------------------------------------------------------- destination flow (in-memory)

  it("inserts one row, reads it back separately, and reports inserted with refs", async () => {
    const { client, rows, calls } = memoryClient();
    const report = await pushPack({ pack_dir: vcDir, table: "lyhna_loop_artifacts", client });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.status).toBe("inserted");
    expect(report.row_id).toBe("row-1");
    expect(report.refs!.capsule_ref).toBe(deriveContinuationRef(vc.continuation));
    expect(report.signature_notice).toContain("Signature verification not performed here");
    expect(report.verify_command).toContain(join(vcDir, "receipts.json"));
    expect(rows).toHaveLength(1);
    // Idempotency query, insert, then a SEPARATE read-back — never the insert echo alone.
    expect(calls).toEqual(["selectByCapsuleRef", "insertRow", "selectById"]);
  });

  it("re-pushing the identical pack reports already_persisted, exit-equivalent 0, and NO second row", async () => {
    const { client, rows } = memoryClient();
    const first = await pushPack({ pack_dir: vcDir, table: "lyhna_loop_artifacts", client });
    expect(first.status).toBe("inserted");
    const second = await pushPack({ pack_dir: vcDir, table: "lyhna_loop_artifacts", client });
    expect(second.ok).toBe(true);
    expect(second.status).toBe("already_persisted");
    expect(second.row_id).toBe(first.row_id);
    expect(rows).toHaveLength(1);
  });

  it("fails closed when a row exists under the same capsule_ref with a DIFFERING receipts_digest", async () => {
    const { client, rows } = memoryClient();
    await pushPack({ pack_dir: vcDir, table: "lyhna_loop_artifacts", client });
    rows[0]!.receipts_digest = "0".repeat(64);
    const report = await pushPack({ pack_dir: vcDir, table: "lyhna_loop_artifacts", client });
    expect(report.ok).toBe(false);
    expect(report.status).toBe("failed");
    expect(report.checks.at(-1)!.name).toBe("capsule_ref_conflict");
    expect(rows).toHaveLength(1);
  });

  it("fails closed when the existing same-digest row mismatches an identity field", async () => {
    const { client, rows } = memoryClient();
    await pushPack({ pack_dir: vcDir, table: "lyhna_loop_artifacts", client });
    rows[0]!.scope_ref = "scope_v1:tampered";
    const report = await pushPack({ pack_dir: vcDir, table: "lyhna_loop_artifacts", client });
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)!.name).toBe("already_persisted_verifies");
    expect(report.checks.at(-1)!.detail).toContain("scope_ref");
  });

  it("resolves an insert 409 race by re-querying and verifying the winner (already_persisted)", async () => {
    // Script the race: the pre-insert query sees nothing, the insert collides, the re-query
    // finds the row another writer inserted in between.
    const seeded = memoryClient();
    const first = await pushPack({ pack_dir: vcDir, table: "lyhna_loop_artifacts", client: seeded.client });
    expect(first.status).toBe("inserted");
    const winner = seeded.rows[0]!;
    let selectCalls = 0;
    const racing: LoopArtifactDestinationClient = {
      async selectByCapsuleRef() {
        selectCalls += 1;
        return selectCalls === 1 ? [] : [{ ...winner }];
      },
      async insertRow() {
        return { kind: "conflict" };
      },
      async selectById() {
        return null;
      }
    };
    const report = await pushPack({ pack_dir: vcDir, table: "lyhna_loop_artifacts", client: racing });
    expect(report.ok).toBe(true);
    expect(report.status).toBe("already_persisted");
    expect(report.row_id).toBe(winner.id);
  });

  it("fails closed on an insert 409 race whose winner carries a DIFFERING receipts_digest", async () => {
    const seeded = memoryClient();
    await pushPack({ pack_dir: vcDir, table: "lyhna_loop_artifacts", client: seeded.client });
    const winner = { ...seeded.rows[0]!, receipts_digest: "f".repeat(64) };
    let selectCalls = 0;
    const racing: LoopArtifactDestinationClient = {
      async selectByCapsuleRef() {
        selectCalls += 1;
        return selectCalls === 1 ? [] : [winner];
      },
      async insertRow() {
        return { kind: "conflict" };
      },
      async selectById() {
        return null;
      }
    };
    const report = await pushPack({ pack_dir: vcDir, table: "lyhna_loop_artifacts", client: racing });
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)!.name).toBe("capsule_ref_conflict");
  });

  it("fails closed when an insert conflict resolves to NO visible row", async () => {
    const client: LoopArtifactDestinationClient = {
      async selectByCapsuleRef() {
        return [];
      },
      async insertRow() {
        return { kind: "conflict" };
      },
      async selectById() {
        return null;
      }
    };
    const report = await pushPack({ pack_dir: vcDir, table: "lyhna_loop_artifacts", client });
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)!.name).toBe("insert_row");
  });

  it("fails closed when the insert itself errors", async () => {
    const { client } = memoryClient();
    const failingClient: LoopArtifactDestinationClient = {
      ...client,
      async insertRow() {
        throw new Error("destination insert failed: HTTP 500");
      }
    };
    const report = await pushPack({ pack_dir: vcDir, table: "lyhna_loop_artifacts", client: failingClient });
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)!.name).toBe("insert_row");
  });

  it("fails closed when the pre-insert query errors", async () => {
    const { client } = memoryClient();
    const failingClient: LoopArtifactDestinationClient = {
      ...client,
      async selectByCapsuleRef() {
        throw new Error("destination select by capsule_ref failed: HTTP 503");
      }
    };
    const report = await pushPack({ pack_dir: vcDir, table: "lyhna_loop_artifacts", client: failingClient });
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)!.name).toBe("destination_query");
  });

  it("fails closed when the inserted row is not visible on read-back (404)", async () => {
    const { client } = memoryClient();
    const blind: LoopArtifactDestinationClient = {
      ...client,
      async selectById() {
        return null;
      }
    };
    const report = await pushPack({ pack_dir: vcDir, table: "lyhna_loop_artifacts", client: blind });
    expect(report.ok).toBe(false);
    expect(report.status).toBe("failed");
    expect(report.checks.at(-1)!.name).toBe("read_back_matches");
    // The orphan row is named so the operator can inspect it — but NEVER reported as success.
    expect(report.row_id).toBe("row-1");
  });

  it("fails closed when the read-back row mismatches the inserted refs/digests", async () => {
    const { client } = memoryClient();
    const lying: LoopArtifactDestinationClient = {
      ...client,
      async selectById(id) {
        const row = await client.selectById(id);
        return row === null ? null : { ...row, loop_id: "some-other-loop" };
      }
    };
    const report = await pushPack({ pack_dir: vcDir, table: "lyhna_loop_artifacts", client: lying });
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)!.name).toBe("read_back_matches");
    expect(report.checks.at(-1)!.detail).toContain("loop_id");
  });

  // ---------------------------------------------------------------- env + Supabase client + CLI

  it("resolveSupabaseEnv fails closed on missing URL, missing key, bad URL, and unsafe table names", () => {
    expect(resolveSupabaseEnv({}).ok).toBe(false);
    expect(resolveSupabaseEnv({ LYHNA_SUPABASE_URL: ENV.LYHNA_SUPABASE_URL }).ok).toBe(false);
    expect(resolveSupabaseEnv({ ...ENV, LYHNA_SUPABASE_URL: "not a url" }).ok).toBe(false);
    expect(resolveSupabaseEnv({ ...ENV, LYHNA_SUPABASE_URL: "ftp://x" }).ok).toBe(false);
    for (const table of ["lyhna; drop table receipts", "1bad", "with space", "a".repeat(64), "x/y"]) {
      const result = resolveSupabaseEnv({ ...ENV, LYHNA_SUPABASE_TABLE: table });
      expect(result.ok).toBe(false);
    }
    const ok = resolveSupabaseEnv({ ...ENV, LYHNA_SUPABASE_URL: "https://example.supabase.co/" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.config.url).toBe("https://example.supabase.co");
      expect(ok.config.table).toBe("lyhna_loop_artifacts");
    }
    const custom = resolveSupabaseEnv({ ...ENV, LYHNA_SUPABASE_TABLE: "my_artifacts" });
    expect(custom.ok && custom.config.table === "my_artifacts").toBe(true);
  });

  it("refuses plaintext http: for non-loopback hosts (key never rides plaintext) and never echoes the URL or key", () => {
    for (const url of ["http://example.supabase.co", "http://10.0.0.5:8000", "http://supabase.internal"]) {
      const result = resolveSupabaseEnv({ ...ENV, LYHNA_SUPABASE_URL: url });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.detail).toContain("https:");
        expect(result.detail).not.toContain(url);
        expect(result.detail).not.toContain(ENV.LYHNA_SUPABASE_SERVICE_ROLE_KEY);
      }
    }
    // Invalid-URL branch must not echo the value either (a malformed paste could embed the key).
    const invalid = resolveSupabaseEnv({ ...ENV, LYHNA_SUPABASE_URL: `not a url ${ENV.LYHNA_SUPABASE_SERVICE_ROLE_KEY}` });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.detail).not.toContain(ENV.LYHNA_SUPABASE_SERVICE_ROLE_KEY);
  });

  it("permits http: for loopback hosts (local Supabase stacks); https: unchanged", () => {
    for (const url of ["http://localhost:54321", "http://127.0.0.1:54321", "http://[::1]:54321"]) {
      const result = resolveSupabaseEnv({ ...ENV, LYHNA_SUPABASE_URL: url });
      expect(result.ok).toBe(true);
    }
    expect(resolveSupabaseEnv(ENV).ok).toBe(true);
  });

  it("CLI: http: non-loopback URL fails closed with zero network calls", async () => {
    const mock = supabaseMock();
    const { io, err } = captureIo();
    const code = await runPushPack(
      ["--pack", vcDir, "--destination", "supabase"],
      io,
      { ...ENV, LYHNA_SUPABASE_URL: "http://example.supabase.co" },
      mock.fetchImpl
    );
    expect(code).toBe(1);
    expect(err()).toContain("https:");
    expect(mock.calls).toHaveLength(0);
  });

  it("supabase client maps a unique-constraint 409 to a conflict (never a throw)", async () => {
    const mock = supabaseMock();
    const resolved = resolveSupabaseEnv(ENV);
    if (!resolved.ok) throw new Error(resolved.detail);
    const client = createSupabaseLoopArtifactClient(resolved.config, mock.fetchImpl);
    const built = buildLoopArtifactRow(vcDir);
    if (!built.ok) throw new Error("pack should build");
    expect((await client.insertRow(built.row)).kind).toBe("inserted");
    expect((await client.insertRow(built.row)).kind).toBe("conflict");
  });

  it("CLI: missing env fails closed BEFORE any network call", async () => {
    const mock = supabaseMock();
    for (const env of [{}, { LYHNA_SUPABASE_URL: ENV.LYHNA_SUPABASE_URL }, { LYHNA_SUPABASE_SERVICE_ROLE_KEY: "k" }]) {
      const { io, err } = captureIo();
      const code = await runPushPack(["--pack", vcDir, "--destination", "supabase"], io, env, mock.fetchImpl);
      expect(code).toBe(1);
      expect(err()).toContain("fail closed");
    }
    expect(mock.calls).toHaveLength(0);
  });

  it("CLI: unsafe table name fails closed before any network call", async () => {
    const mock = supabaseMock();
    const { io, err } = captureIo();
    const code = await runPushPack(
      ["--pack", vcDir, "--destination", "supabase"],
      io,
      { ...ENV, LYHNA_SUPABASE_TABLE: "lyhna; drop table receipts" },
      mock.fetchImpl
    );
    expect(code).toBe(1);
    expect(err()).toContain("not a safe table name");
    expect(mock.calls).toHaveLength(0);
  });

  it("CLI: unknown destination, missing flags, and unknown args fail with usage; --help exits 0", async () => {
    const mock = supabaseMock();
    const cases: string[][] = [
      ["--pack", vcDir, "--destination", "postgres"],
      ["--pack", vcDir],
      ["--destination", "supabase"],
      ["--pack"],
      ["--pack", vcDir, "--destination", "supabase", "--bogus"]
    ];
    for (const argv of cases) {
      const { io, err } = captureIo();
      expect(await runPushPack(argv, io, ENV, mock.fetchImpl)).toBe(1);
      expect(err()).toContain("usage: lyhna-mcp push-pack");
    }
    const help = captureIo();
    expect(await runPushPack(["--help"], help.io, ENV, mock.fetchImpl)).toBe(0);
    expect(help.out()).toContain("usage: lyhna-mcp push-pack");
    expect(mock.calls).toHaveLength(0);
  });

  it("CLI end-to-end: insert + read-back success prints row id + key refs and exits 0", async () => {
    const mock = supabaseMock();
    const { io, out, err } = captureIo();
    const code = await runPushPack(["--pack", vcDir, "--destination", "supabase"], io, ENV, mock.fetchImpl);
    expect(err()).toBe("");
    expect(code).toBe(0);
    expect(out()).toContain("Persisted to lyhna_loop_artifacts (read-back verified).");
    expect(out()).toContain("row_id: row-1");
    expect(out()).toContain(`capsule_ref: ${deriveContinuationRef(vc.continuation)}`);
    expect(out()).toContain("receipts_digest:");
    expect(out()).toContain("Signature verification not performed here");
    expect(mock.rows).toHaveLength(1);
    // The service-role key authenticates every request.
    expect(mock.calls.every((c) => c.headers.apikey === ENV.LYHNA_SUPABASE_SERVICE_ROLE_KEY)).toBe(true);
    // POST + the SEPARATE read-back GET both happened.
    expect(mock.calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
    // EVERY request refuses redirects: fetch retains the apikey header across cross-origin
    // redirects, so redirect: "error" is what keeps the key from being re-sent off-host
    // (including from a loopback http: endpoint that 3xxes outward).
    expect(mock.calls.every((c) => c.redirect === "error")).toBe(true);
  });

  it("CLI end-to-end: re-push reports already_persisted, exits 0, still one row", async () => {
    const mock = supabaseMock();
    const first = captureIo();
    expect(await runPushPack(["--pack", vcDir, "--destination", "supabase"], first.io, ENV, mock.fetchImpl)).toBe(0);
    const second = captureIo();
    const code = await runPushPack(["--pack", vcDir, "--destination", "supabase"], second.io, ENV, mock.fetchImpl);
    expect(code).toBe(0);
    expect(second.out()).toContain("Already persisted to lyhna_loop_artifacts (read-back verified).");
    expect(second.out()).toContain("row_id: row-1");
    expect(mock.rows).toHaveLength(1);
  });

  it("CLI end-to-end: --json emits the structured report", async () => {
    const mock = supabaseMock();
    const { io, out } = captureIo();
    const code = await runPushPack(["--pack", vcDir, "--destination", "supabase", "--json"], io, ENV, mock.fetchImpl);
    expect(code).toBe(0);
    const report = JSON.parse(out());
    expect(report.ok).toBe(true);
    expect(report.status).toBe("inserted");
    expect(report.row_id).toBe("row-1");
    expect(report.refs.capsule_ref).toBe(deriveContinuationRef(vc.continuation));
    expect(report.table).toBe("lyhna_loop_artifacts");
  });

  it("CLI end-to-end: an insert HTTP failure fails closed with exit 1", async () => {
    const mock = supabaseMock({ insertStatus: 500 });
    const { io, out } = captureIo();
    const code = await runPushPack(["--pack", vcDir, "--destination", "supabase"], io, ENV, mock.fetchImpl);
    expect(code).toBe(1);
    expect(out()).toContain("FAIL  insert_row");
    expect(out()).toContain("Push FAILED closed");
  });

  it("CLI end-to-end: a custom safe LYHNA_SUPABASE_TABLE is used in the PostgREST path", async () => {
    const mock = supabaseMock({ table: "my_artifacts" });
    const { io } = captureIo();
    const code = await runPushPack(
      ["--pack", childDir, "--destination", "supabase"],
      io,
      { ...ENV, LYHNA_SUPABASE_TABLE: "my_artifacts" },
      mock.fetchImpl
    );
    expect(code).toBe(0);
    expect(mock.calls.every((c) => c.url.includes("/rest/v1/my_artifacts"))).toBe(true);
    // The inheriting pack's parent fields survived the trip.
    const row = mock.rows[0]! as Partial<LoopArtifactRow>;
    expect(row.parent_capsule_ref).toBe(childEdge.capsule_ref);
    expect(row.parent_scope_ref).toBe(childEdge.scope_ref);
    expect(row.parent_final_turn_ref).toBe(childEdge.final_turn_ref);
    expect(row.inherits_state_hash).toBe(childStateHash);
  });
});
