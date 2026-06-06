// Repeatable cold-verify legs for the LoopProofBundle honesty surface.
//
// Runs ALL legs against the REAL standalone lyhna-verify (cloned READ-ONLY; never
// vendored, never modified). Encodes the load-bearing exit semantics precisely:
//
//   Leg 0 (synthetic demo PRODUCER, end-to-end): drives the real adapter golden path
//     (open -> route synthetic call -> supervisor close -> dump -> export) via
//     produceGoldenPathBundle, then cold-verifies the EXPORTED receipts.json. Asserts BOTH
//     directions: structural invariants must all pass AND all_receipts_verified MUST be
//     false. A synthetic chain that ever verified as signed reds the build (synthetic
//     masquerading as signed); a structural failure reds the build. This locks the honesty
//     boundary onto the actual shipped product path, not just hand-built fixtures.
//
//   Leg 1 (synthetic, structural): the bundle's side-car receipts.json must be consumed
//     by lyhna-verify with ZERO shape adaptation; structural invariants (sealed,
//     continuity, loop_id/goal_hash consistency, action_count) must all pass; crypto
//     fails-by-absence (no signatures) — that is the EXPECTED success condition and must
//     NOT red the build. A structural failure, or the verifier being unable to consume the
//     bare array (shape adaptation required), IS a failure.
//
//   Leg 2 (real-signed external a4a40b55): the corpus's external-scope signed chain,
//     packaged through the export, must verify FULL GREEN cold (exit 0, all signatures
//     valid, sealed) AND remain byte-identical to source with a matching digest. Any
//     deviation reds the build.
//
//   Leg 3 (live positive-control — INVERTED HONESTY): the LIVE Chione/Hermes loop, sealed
//     through the hosted Lyhna bind and exported to tests/fixtures/live/chione-hermes/,
//     must verify FULL GREEN cold (exit 0, sealed, all_receipts_verified=true) with REAL
//     hosted-bind Ed25519 signatures, byte-identical with a matching digest. Where Leg 1
//     asserts synthetic material must NOT verify as signed, Leg 3 asserts the live chain
//     MUST. This leg is fail-closed: until the live fixture is captured from the ACTUAL
//     sealed live run, it REDS with a PENDING-LIVE-CAPTURE failure. The fixture must never
//     be reconstructed or hand-built — only a genuine hosted-bind capture satisfies it. If
//     the captured receipts are not Ed25519, this leg stops and reports the mismatch rather
//     than adapting around it.
//
// Legs 0–2 source material is all PUBLIC: the pinned key, the public verifier, and its
// static signed corpus. No secrets, no live bind. Leg 3 additionally consumes a committed
// live capture (no secrets in the repo — only the already-sealed, signed receipts).
//
// Inputs (env):
//   LYHNA_VERIFY_DIR  path to a lyhna-verify checkout (CI clones it). If unset/missing,
//                     this script clones it read-only to a temp dir.
//
// Assumes the proxy is already built (dist/ present) — CI runs `npm run build` first.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { produceGoldenPathBundle, assertSyntheticColdVerify } from "./demo-golden-path.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXPORT_CLI = join(ROOT, "dist", "src", "bin", "export-loop-proof.js");
const VERIFY_REPO = "https://github.com/Lyhna-ai/Lyhna-ai-lyhna-verify";
const PINNED_KEY = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
const REAL_LOOP_ID = "a4a40b55-c399-4f4f-b46f-105a53655d3a";
// Leg 3 live positive-control capture (exported from the ACTUAL sealed live run). Fail-closed
// until present; never reconstructed. See docs/LIVE-BIND-GATE.md for the capture procedure.
const LIVE_FIXTURE_DIR = join(ROOT, "tests", "fixtures", "live", "chione-hermes");

const work = mkdtempSync(join(tmpdir(), "verify-legs-"));
let failed = false;

function log(s) {
  process.stdout.write(s + "\n");
}
function fail(leg, msg) {
  failed = true;
  log(`  ✗ ${leg} FAIL: ${msg}`);
}
function ok(leg, msg) {
  log(`  ✓ ${leg}: ${msg}`);
}

function ensureBuilt() {
  if (!existsSync(EXPORT_CLI)) {
    throw new Error(`export CLI not found at ${EXPORT_CLI} — run \`npm run build\` first.`);
  }
}

function resolveVerifyDir() {
  const dir = process.env.LYHNA_VERIFY_DIR;
  if (dir && existsSync(join(dir, "bin", "lyhna-verify.mjs"))) {
    log(`Using existing lyhna-verify checkout: ${dir}`);
    return dir;
  }
  const dest = join(work, "lyhna-verify");
  log(`Cloning lyhna-verify (read-only) -> ${dest}`);
  execFileSync("git", ["clone", "--depth", "1", VERIFY_REPO, dest], { stdio: "inherit" });
  return dest;
}

function runVerifier(verifyDir, receiptsPath) {
  // Returns { exitCode, json } from `lyhna-verify --chain <file> --json`.
  const bin = join(verifyDir, "bin", "lyhna-verify.mjs");
  try {
    const out = execFileSync("node", [bin, "--chain", receiptsPath, "--json"], { encoding: "utf8" });
    return { exitCode: 0, json: JSON.parse(out) };
  } catch (e) {
    // Non-zero exit still carries stdout JSON.
    const out = e.stdout ? e.stdout.toString() : "";
    let json = null;
    try {
      json = JSON.parse(out);
    } catch {
      json = null;
    }
    return { exitCode: typeof e.status === "number" ? e.status : 1, json, stderr: e.stderr?.toString() };
  }
}

function exportBundle(receiptsPath, outDir, extraArgs = []) {
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    "node",
    [EXPORT_CLI, receiptsPath, "--out", outDir, "--source-env", "ci-verify-legs", ...extraArgs],
    { stdio: "pipe" }
  );
}

// ---- Leg 0: synthetic demo PRODUCER, end-to-end -----------------------------

async function leg0(verifyDir) {
  log("\n=== Leg 0 (synthetic demo PRODUCER end-to-end; structural pass REQUIRED + must NOT verify as signed) ===");
  const outDir = join(work, "bundle-demo");
  let produced;
  try {
    produced = await produceGoldenPathBundle({ outDir, exportCli: EXPORT_CLI, log: (s) => log(s) });
  } catch (e) {
    fail("Leg 0", `demo producer failed end-to-end: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  // Cold-verify the EXPORTED side-car with the real verifier (zero shape adaptation).
  const { json } = runVerifier(verifyDir, join(outDir, "receipts.json"));
  const verdict = assertSyntheticColdVerify(json);
  if (!verdict.ok) {
    fail("Leg 0", verdict.detail);
    return;
  }
  ok("Leg 0", `demo producer (open->call x${produced.actionCount}->close->dump->export) cold-verified: ${verdict.detail}`);
}

// ---- Leg 1: synthetic, structural -------------------------------------------

function leg1(verifyDir) {
  log("\n=== Leg 1 (synthetic, structural; crypto fail-by-absence is EXPECTED) ===");
  const goalHash = "0".repeat(64);
  const synthetic = [
    {
      version: "LYHNA_RECEIPT_V2",
      receipt_id: "lrv2_ci_synth_0001",
      public_key: PINNED_KEY,
      tenant_hash: "55b966349a28aaaa",
      action_type: "echo",
      outcome: "APPROVED",
      signature: "c3R1Yg==",
      constraints: { loop: { loop_id: "loop-ci-synth", prior_receipt_id: null, goal_hash: goalHash } }
    },
    {
      version: "LYHNA_RECEIPT_V2",
      receipt_id: "lrv2_ci_synth_0002",
      public_key: PINNED_KEY,
      tenant_hash: "55b966349a28aaaa",
      action_type: "loop_close",
      outcome: "APPROVED",
      signature: "c3R1Yg==",
      constraints: {
        loop: { loop_id: "loop-ci-synth", prior_receipt_id: "lrv2_ci_synth_0001", goal_hash: goalHash },
        loop_close: {
          loop_id: "loop-ci-synth",
          goal_hash: goalHash,
          action_count: 1,
          outcome: "COMPLETED",
          prior_receipt_id: "lrv2_ci_synth_0001",
          termination_reason: "ci"
        }
      }
    }
  ];
  const src = join(work, "synth.json");
  writeFileSync(src, JSON.stringify(synthetic));
  const outDir = join(work, "bundle-synth");
  exportBundle(src, outDir);

  const { json } = runVerifier(verifyDir, join(outDir, "receipts.json"));
  if (!json || json.mode !== "chain" || !Array.isArray(json.chains) || json.chains.length !== 1) {
    fail("Leg 1", "verifier did not consume the bare side-car as a chain (shape adaptation would be required)");
    return;
  }
  const c = json.chains[0];
  const structuralOk =
    c.sealed === true &&
    c.continuity_ok === true &&
    c.loop_id_consistent === true &&
    c.goal_hash_consistent === true &&
    c.action_count_ok === true;
  if (!structuralOk) {
    fail("Leg 1", `structural invariants did not all pass: ${JSON.stringify({
      sealed: c.sealed, continuity_ok: c.continuity_ok, loop_id_consistent: c.loop_id_consistent,
      goal_hash_consistent: c.goal_hash_consistent, action_count_ok: c.action_count_ok
    })}`);
    return;
  }
  if (c.all_receipts_verified !== false) {
    fail("Leg 1", "expected crypto fail-by-absence (all_receipts_verified=false) on unsigned synthetic input");
    return;
  }
  ok("Leg 1", "side-car consumed with zero adaptation; structural pass; crypto fail-by-absence (expected)");
}

// ---- Leg 2: real-signed external a4a40b55 -----------------------------------

function leg2(verifyDir) {
  log("\n=== Leg 2 (real-signed external a4a40b55; FULL GREEN cold REQUIRED) ===");
  const corpusPath = join(verifyDir, "corpus", "corpus.ndjson");
  if (!existsSync(corpusPath)) {
    fail("Leg 2", `corpus not found at ${corpusPath} — cannot source the a4a40b55 fixture (NOT vendoring)`);
    return;
  }
  const lines = readFileSync(corpusPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const ext = lines
    .map((o) => o.payload ?? o)
    .filter((p) => {
      const scope = p.tenant_hash && !p.tenant_id ? "external" : "internal";
      return scope === "external" && p.constraints?.loop?.loop_id === REAL_LOOP_ID;
    });
  if (ext.length === 0) {
    fail("Leg 2", `external-scope a4a40b55 chain not cleanly available in the clone (would require vendoring — stopping)`);
    return;
  }
  // Use a deliberately compact (differently-formatted) source to exercise byte-preservation.
  const srcText = JSON.stringify(ext);
  const src = join(work, "real.json");
  writeFileSync(src, srcText);

  // Capture the advisory verdict (pre-export) for embedding.
  const pre = runVerifier(verifyDir, src);
  if (pre.exitCode !== 0) {
    fail("Leg 2", `source external chain did not verify green pre-export (exit ${pre.exitCode})`);
    return;
  }
  const verdictPath = join(work, "verdict.json");
  writeFileSync(verdictPath, JSON.stringify(pre.json));

  const outDir = join(work, "bundle-real");
  exportBundle(src, outDir, ["--verdict", verdictPath]);

  // DECISIVE: the exported side-car must verify FULL GREEN cold.
  const post = runVerifier(verifyDir, join(outDir, "receipts.json"));
  const c = post.json?.chains?.[0];
  if (post.exitCode !== 0) {
    fail("Leg 2", `exported receipts.json did not verify green (exit ${post.exitCode}; status ${c?.status})`);
    return;
  }
  if (!c || c.status !== "VERIFIED" || c.sealed !== true || c.all_receipts_verified !== true) {
    fail("Leg 2", `exported chain not full-green: ${JSON.stringify({ status: c?.status, sealed: c?.sealed, all_receipts_verified: c?.all_receipts_verified })}`);
    return;
  }

  // Byte-identity + digest match.
  const outBytes = readFileSync(join(outDir, "receipts.json"), "utf8");
  const bundle = JSON.parse(readFileSync(join(outDir, "bundle.json"), "utf8"));
  if (outBytes !== srcText) {
    fail("Leg 2", "exported receipts.json is not byte-identical to the source");
    return;
  }
  const digest = createHash("sha256").update(outBytes, "utf8").digest("hex");
  if (bundle.export.content_digest.value !== digest) {
    fail("Leg 2", "content_digest does not match sha256 of receipts.json bytes");
    return;
  }
  ok("Leg 2", `FULL GREEN cold (exit 0, sealed, all signatures valid); byte-identical; digest matches`);
}

// ---- Leg 3: live positive-control (INVERTED HONESTY) ------------------------

function leg3(verifyDir) {
  log("\n=== Leg 3 (live positive-control; FULL GREEN cold with REAL Ed25519 REQUIRED; fail-closed until captured) ===");
  const receiptsPath = join(LIVE_FIXTURE_DIR, "receipts.json");
  const bundlePath = join(LIVE_FIXTURE_DIR, "bundle.json");

  // Fail-closed: a real hosted-bind capture is the ONLY thing that can satisfy this leg.
  // Absent it, the gate is honestly RED — never skipped, never fabricated.
  if (!existsSync(receiptsPath)) {
    fail(
      "Leg 3",
      `PENDING LIVE CAPTURE — no live fixture at ${receiptsPath}. ` +
        `Run the live-bind harness against the hosted tenant (see docs/LIVE-BIND-GATE.md), then ` +
        `commit the ACTUAL sealed exported artifacts (receipts.json, bundle.json, graph-node.json, ` +
        `graph-node.md). Do NOT reconstruct or hand-build this fixture.`
    );
    return;
  }

  const outBytes = readFileSync(receiptsPath, "utf8");

  // Real hosted-bind receipts must be Ed25519-signed. lyhna-verify validates Ed25519; a green
  // verify IS an Ed25519 validation. We additionally assert the receipts are Ed25519-SHAPED
  // (32-byte hex public key, present signature) so a non-Ed25519 capture STOPS here loudly
  // rather than being adapted around.
  let receipts;
  try {
    receipts = JSON.parse(outBytes);
  } catch (e) {
    fail("Leg 3", `live receipts.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!Array.isArray(receipts) || receipts.length === 0) {
    fail("Leg 3", "live receipts.json must be a non-empty JSON array of signed receipts");
    return;
  }
  const ED25519_PUBKEY = /^[0-9a-f]{64}$/;
  const notEd25519 = receipts.filter(
    (r) => !(typeof r.public_key === "string" && ED25519_PUBKEY.test(r.public_key) && typeof r.signature === "string" && r.signature.length > 0)
  );
  if (notEd25519.length > 0) {
    fail(
      "Leg 3",
      `live capture is not Ed25519-signed (${notEd25519.length}/${receipts.length} receipts lack a 32-byte hex public_key + signature). ` +
        `Stopping and reporting the mismatch — NOT adapting around it.`
    );
    return;
  }

  // DECISIVE: the committed live side-car must verify FULL GREEN cold against lyhna-verify.
  const post = runVerifier(verifyDir, receiptsPath);
  const c = post.json?.chains?.[0];
  if (post.exitCode !== 0) {
    fail("Leg 3", `live receipts.json did not verify green (exit ${post.exitCode}; status ${c?.status})`);
    return;
  }
  if (!c || c.status !== "VERIFIED" || c.sealed !== true || c.all_receipts_verified !== true) {
    fail("Leg 3", `live chain not full-green: ${JSON.stringify({ status: c?.status, sealed: c?.sealed, all_receipts_verified: c?.all_receipts_verified })}`);
    return;
  }

  // Digest match: the committed bundle.json must seal the exact receipts.json bytes.
  if (!existsSync(bundlePath)) {
    fail("Leg 3", `live bundle.json missing at ${bundlePath} — cannot confirm digest match`);
    return;
  }
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  const digest = createHash("sha256").update(outBytes, "utf8").digest("hex");
  if (bundle.export?.content_digest?.value !== digest) {
    fail("Leg 3", "live bundle content_digest does not match sha256 of receipts.json bytes");
    return;
  }

  ok("Leg 3", `live Chione/Hermes chain FULL GREEN cold (exit 0, sealed, all Ed25519 signatures valid); digest matches`);
}

// ---- main -------------------------------------------------------------------

try {
  ensureBuilt();
  const verifyDir = resolveVerifyDir();
  await leg0(verifyDir);
  leg1(verifyDir);
  leg2(verifyDir);
  leg3(verifyDir);
} catch (e) {
  failed = true;
  log(`\nFATAL: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

log(
  `\n${
    failed
      ? "VERIFY LEGS: FAILED"
      : "VERIFY LEGS: PASSED (Leg 0 demo-producer structural+must-not-verify, Leg 1 structural+fail-by-absence, Leg 2 full-green cold, Leg 3 live positive-control full-green)"
  }`
);
process.exit(failed ? 1 : 0);
