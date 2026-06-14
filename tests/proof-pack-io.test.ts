// writeProofPackFiles — the one pack writer. The property under test: re-exporting into an
// existing directory NEVER leaves a stale optional artifact from a previous pack (an old
// proof-card.md / HANDOFF.md / scope-events.json beside a fresh receipts.json would let a human
// or `lyhna-mcp post` consume artifacts for the wrong chain). Unrelated files are left alone.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeProofPackFiles, type BuiltLoopProofBundle } from "../src/index.js";

function bareBuilt(): BuiltLoopProofBundle {
  return {
    bundle: { marker: "bundle" },
    receipts_json: `[{"marker":"receipts"}]`,
    graph_node: { marker: "graph" },
    graph_node_markdown: "# graph\n"
  } as unknown as BuiltLoopProofBundle;
}

function capsuleBuilt(): BuiltLoopProofBundle {
  return {
    ...bareBuilt(),
    scope_capsule: { marker: "scope" },
    continuation_capsule: { marker: "continuation" },
    scope_events: [{ marker: "event" }],
    proof_card_markdown: "# card\n",
    handoff_markdown: "# handoff\n",
    verify_instructions_markdown: "# verify\n",
    judgment_ledger: { marker: "ledger" },
    judgment_ledger_markdown: "# ledger\n",
    memory_injection: { marker: "memory" }
  } as unknown as BuiltLoopProofBundle;
}

describe("writeProofPackFiles", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("re-exporting a smaller pack clears every stale optional artifact", () => {
    dir = mkdtempSync(join(tmpdir(), "lyhna-pack-io-"));
    const full = writeProofPackFiles(dir, capsuleBuilt());
    expect(full).toContain("proof-card.md");
    expect(full).toContain("HANDOFF.md");
    expect(existsSync(join(dir, "scope-events.json"))).toBe(true);

    const bare = writeProofPackFiles(dir, bareBuilt());
    expect(bare).toEqual(["receipts.json", "bundle.json", "graph-node.json", "graph-node.md"]);
    for (const stale of [
      "proof-card.md",
      "HANDOFF.md",
      "scope-capsule.json",
      "continuation-capsule.json",
      "scope-events.json",
      "verify-instructions.md",
      "judgment-ledger.json",
      "judgment-ledger.md",
      "memory-injection.json"
    ]) {
      expect(existsSync(join(dir, stale)), `${stale} must not survive a re-export`).toBe(false);
    }
    expect(readFileSync(join(dir, "receipts.json"), "utf8")).toBe(`[{"marker":"receipts"}]`);
  });

  it("clears a stale witness-input.json sidecar on any pack write (every export path)", () => {
    dir = mkdtempSync(join(tmpdir(), "lyhna-pack-io-"));
    // A prior verified-context export-pack left the plaintext claims sidecar here. Any later pack
    // write — export-pack OR the offline export-loop-proof — must clear it so stale claims are not
    // presented as current beside a fresh (possibly content-blind) pack.
    writeFileSync(join(dir, "witness-input.json"), `{"steps":[{"claim":{"system":"stale"}}]}\n`);
    writeProofPackFiles(dir, bareBuilt());
    expect(existsSync(join(dir, "witness-input.json"))).toBe(false);
  });

  it("leaves unrelated files in the directory alone", () => {
    dir = mkdtempSync(join(tmpdir(), "lyhna-pack-io-"));
    writeFileSync(join(dir, "notes.txt"), "mine\n");
    writeProofPackFiles(dir, capsuleBuilt());
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("mine\n");
  });
});
