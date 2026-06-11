import { describe, expect, it } from "vitest";

import type { ProofReceipt } from "../src/index.js";
import {
  assertContentBlind,
  assertExternalScope,
  assertNoDuplicateKeys,
  buildLoopProofBundle,
  deriveKeyId,
  pinTrustRoot,
  serializeReceipts,
  sha256Hex
} from "../src/index.js";

const PUBKEY = "2ecb73042161b7b0008971499b191ec9e3824cd4a6e058a8cede90b04e1efff2";
const GOAL_HASH = "065aa7a244632b1aac7dcfa8254ce0b6b3bae66001d8b884b900afa790c14136";
const LOOP_ID = "loop-synthetic-1";

// Synthetic EXTERNAL-scope receipts (tenant_hash, never tenant_id). No real signatures —
// the structural shape is what matters here; crypto fail-by-absence is expected when these
// reach the real verifier and is NOT a defect.
function externalReceipts(): ProofReceipt[] {
  return [
    {
      version: "LYHNA_RECEIPT_V2",
      receipt_id: "lrv2_synth_0001",
      public_key: PUBKEY,
      tenant_hash: "55b966349a28aaaa",
      action_type: "echo",
      outcome: "APPROVED",
      signature: "c3R1Yg==",
      constraints: { loop: { loop_id: LOOP_ID, prior_receipt_id: null, goal_hash: GOAL_HASH } }
    },
    {
      version: "LYHNA_RECEIPT_V2",
      receipt_id: "lrv2_synth_0002",
      public_key: PUBKEY,
      tenant_hash: "55b966349a28aaaa",
      action_type: "loop_close",
      outcome: "APPROVED",
      signature: "c3R1Yg==",
      constraints: {
        loop: { loop_id: LOOP_ID, prior_receipt_id: "lrv2_synth_0001", goal_hash: GOAL_HASH },
        loop_close: {
          loop_id: LOOP_ID,
          goal_hash: GOAL_HASH,
          action_count: 1,
          outcome: "COMPLETED",
          prior_receipt_id: "lrv2_synth_0001",
          termination_reason: "task_done"
        }
      }
    }
  ];
}

describe("buildLoopProofBundle (side-car shape)", () => {
  it("keeps the bare receipt array as the loadable side-car, byte-identical to input", () => {
    const receipts = externalReceipts();
    const built = buildLoopProofBundle({ receipts, source_env: "test" });

    expect(built.bundle.format).toBe("side-car");
    expect(built.bundle.receipts_file).toBe("receipts.json");
    // The verifier input is the bare array, unchanged — zero shape adaptation.
    expect(built.receipts_json).toBe(serializeReceipts(receipts));
    expect(JSON.parse(built.receipts_json)).toEqual(receipts);
  });

  it("derives the loop summary (sealed, action_count, goal_hash) from the chain", () => {
    const built = buildLoopProofBundle({ receipts: externalReceipts(), source_env: "test" });
    expect(built.bundle.loop).toEqual({
      loop_id: LOOP_ID,
      goal_hash: GOAL_HASH,
      action_count: 1,
      sealed: true,
      receipt_count: 2
    });
  });

  it("pins exactly one trust root with a deterministic key_id", () => {
    const built = buildLoopProofBundle({ receipts: externalReceipts(), source_env: "test" });
    expect(built.bundle.trust_root.ed25519_public_key).toBe(PUBKEY);
    expect(built.bundle.trust_root.key_id).toBe(deriveKeyId(PUBKEY));
    expect(built.bundle.trust_root.key_id).toMatch(/^ed25519:[0-9a-f]{16}$/);
  });

  it("computes a content digest over the exact receipts.json bytes", () => {
    const built = buildLoopProofBundle({ receipts: externalReceipts(), source_env: "test" });
    expect(built.bundle.export.content_digest).toEqual({
      algorithm: "sha256",
      value: sha256Hex(built.receipts_json),
      over: "receipts.json"
    });
  });

  it("embeds the verifier verdict marked ADVISORY", () => {
    const fakeVerdict = { mode: "chain", chains: [{ status: "VERIFIED" }] };
    const built = buildLoopProofBundle({
      receipts: externalReceipts(),
      source_env: "test",
      advisory_verdict: fakeVerdict
    });
    expect(built.bundle.verdict.advisory).toBe(true);
    expect(built.bundle.verdict.verifier.name).toBe("lyhna-verify");
    // The machine-readable reproduce command must run as written in a cold
    // environment — same rule as every human-facing verify instruction.
    expect(built.bundle.verdict.verifier.reproduce).toBe("npx -y lyhna-verify --chain receipts.json");
    expect(built.bundle.verdict.result).toEqual(fakeVerdict);
  });

  it("is content-blind: carries goal_hash, never a plaintext goal", () => {
    const built = buildLoopProofBundle({ receipts: externalReceipts(), source_env: "test" });
    const text = JSON.stringify(built.bundle) + built.graph_node_markdown;
    expect(built.bundle.loop.goal_hash).toBe(GOAL_HASH);
    expect(text).not.toMatch(/"goal"\s*:/);
  });

  it("emits an Authority Context Graph node (JSON + Markdown) for the loop", () => {
    const built = buildLoopProofBundle({ receipts: externalReceipts(), source_env: "prod-ish" });
    expect(built.graph_node).toMatchObject({
      id: `acg:loop:external:${LOOP_ID}`,
      type: "loop_proof",
      loop_id: LOOP_ID,
      goal_hash: GOAL_HASH,
      action_count: 1,
      sealed: true,
      scope: "external",
      receipt_count: 2
    });
    expect(built.graph_node_markdown).toContain(`acg:loop:external:${LOOP_ID}`);
    expect(built.graph_node_markdown).toContain("SEALED");
    expect(built.graph_node_markdown).toContain(GOAL_HASH);
  });
});

describe("external-scope enforcement (never leak internal tenant_id)", () => {
  it("rejects a receipt carrying internal tenant_id", () => {
    const receipts = externalReceipts();
    (receipts[0] as Record<string, unknown>).tenant_id = "tenant_secret";
    expect(() => assertExternalScope(receipts)).toThrow(/tenant_id/);
    expect(() => buildLoopProofBundle({ receipts, source_env: "test" })).toThrow(/tenant_id/);
  });

  it("rejects a receipt missing tenant_hash", () => {
    const receipts = externalReceipts();
    delete (receipts[0] as Record<string, unknown>).tenant_hash;
    expect(() => assertExternalScope(receipts)).toThrow(/tenant_hash/);
  });
});

describe("content-blind enforcement (goal_hash only, never plaintext goal)", () => {
  it("rejects a receipt carrying a plaintext intent (loop_close defaults intent to the goal)", () => {
    const receipts = externalReceipts();
    (receipts[1] as Record<string, unknown>).intent = "ship the whole secret roadmap";
    expect(() => assertContentBlind(receipts)).toThrow(/content-blind/);
    expect(() => buildLoopProofBundle({ receipts, source_env: "test" })).toThrow(/intent/);
  });

  it("rejects a receipt carrying an explicit plaintext goal field", () => {
    const receipts = externalReceipts();
    (receipts[0] as Record<string, unknown>).goal = "secret goal text";
    expect(() => buildLoopProofBundle({ receipts, source_env: "test" })).toThrow(/goal/);
  });

  it("permits the structured intent_version marker (not goal-bearing)", () => {
    const receipts = externalReceipts();
    (receipts[0] as Record<string, unknown>).intent_version = "loop_v1";
    expect(() => assertContentBlind(receipts)).not.toThrow();
  });

  it("rejects a NESTED plaintext goal/intent anywhere in the receipt (deep scan)", () => {
    const receipts = externalReceipts();
    // A plaintext goal buried below the top level must still fail closed.
    (receipts[0] as Record<string, unknown>).action_payload = {
      meta: { intent: "buried plaintext goal" }
    };
    expect(() => assertContentBlind(receipts)).toThrow(/action_payload\.meta\.intent/);
    expect(() => buildLoopProofBundle({ receipts, source_env: "test" })).toThrow(/content-blind/);
  });
});

describe("source-byte preservation (provenance)", () => {
  it("preserves verbatim source bytes as receipts.json and digests them", () => {
    const receipts = externalReceipts();
    // Compact source formatting, NOT JSON.stringify(...,2).
    const compact = JSON.stringify(receipts);
    const built = buildLoopProofBundle({ receipts, receipts_text: compact, source_env: "test" });

    expect(built.receipts_json).toBe(compact);
    expect(built.receipts_json).not.toBe(serializeReceipts(receipts)); // proves it wasn't re-normalized
    expect(built.bundle.export.content_digest.value).toBe(sha256Hex(compact));
  });

  it("rejects receipts_text that does not parse to the provided receipts (provenance guard)", () => {
    const receipts = externalReceipts();
    const mismatched = JSON.stringify([{ tampered: true }]);
    expect(() =>
      buildLoopProofBundle({ receipts, receipts_text: mismatched, source_env: "test" })
    ).toThrow(/provenance guard/);
  });

  it("falls back to canonical serialization when no source text is provided", () => {
    const receipts = externalReceipts();
    const built = buildLoopProofBundle({ receipts, source_env: "test" });
    expect(built.receipts_json).toBe(serializeReceipts(receipts));
  });

  it("refuses verbatim source bytes that hide plaintext in a discarded duplicate-key branch", () => {
    // An early duplicate `constraints` carries the plaintext goal; JSON.parse keeps the
    // LAST (clean) one, so the parsed object is content-blind — but the raw bytes leak.
    const head = externalReceipts()[0] as Record<string, unknown>;
    const leakyText =
      "[{" +
      `"receipt_id":${JSON.stringify(head.receipt_id)},` +
      `"public_key":${JSON.stringify(head.public_key)},` +
      `"tenant_hash":${JSON.stringify(head.tenant_hash)},` +
      `"action_type":"echo",` +
      `"constraints":{"leak":{"goal":"SECRET PLAINTEXT GOAL"}},` + // dropped by parse
      `"constraints":${JSON.stringify(head.constraints)}` + // kept (clean)
      "}]";
    const receipts = JSON.parse(leakyText) as typeof head[];
    // Sanity: the parsed object is clean (the attack hides from parsed-object checks).
    expect(JSON.stringify(receipts)).not.toContain("SECRET");
    // But the raw bytes are refused fail-closed.
    expect(() =>
      buildLoopProofBundle({ receipts, receipts_text: leakyText, source_env: "test" })
    ).toThrow(/duplicate JSON key/);
  });
});

describe("assertNoDuplicateKeys", () => {
  it("accepts well-formed JSON without duplicate keys (compact and pretty)", () => {
    expect(() => assertNoDuplicateKeys(JSON.stringify(externalReceipts()))).not.toThrow();
    expect(() => assertNoDuplicateKeys(JSON.stringify(externalReceipts(), null, 2))).not.toThrow();
  });

  it("rejects a duplicate key at the top level of an object", () => {
    expect(() => assertNoDuplicateKeys('{"a":1,"a":2}')).toThrow(/duplicate JSON key "a"/);
  });

  it("rejects a duplicate key nested inside an array of objects", () => {
    expect(() => assertNoDuplicateKeys('[{"x":{"k":1}},{"y":1,"y":2}]')).toThrow(/duplicate JSON key "y"/);
  });

  it("does not confuse string values (incl. braces/quotes) for keys", () => {
    expect(() => assertNoDuplicateKeys('{"a":"{\\"a\\": shadow}","b":"a"}')).not.toThrow();
  });

  it("allows the same key name in sibling/independent objects", () => {
    expect(() => assertNoDuplicateKeys('[{"k":1},{"k":2}]')).not.toThrow();
    expect(() => assertNoDuplicateKeys('{"a":{"k":1},"b":{"k":2}}')).not.toThrow();
  });
});

describe("trust-root pinning", () => {
  it("rejects a chain spanning more than one signing key", () => {
    const receipts = externalReceipts();
    (receipts[1] as Record<string, unknown>).public_key = "ff".repeat(32);
    expect(() => pinTrustRoot(receipts)).toThrow(/distinct signing keys/);
  });
});

describe("unsealed detection", () => {
  it("reports sealed=false when the terminal loop_close is absent", () => {
    const receipts = externalReceipts().slice(0, 1); // head only, no close
    const built = buildLoopProofBundle({ receipts, source_env: "test" });
    expect(built.bundle.loop.sealed).toBe(false);
    expect(built.graph_node.sealed).toBe(false);
    expect(built.graph_node_markdown).toContain("UNSEALED");
  });
});
