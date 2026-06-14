// Lane B — the canonical "came through the live loop" receipt is produced by the REAL loop, not
// hand-authored, and the committed artifact stays regenerable (a drift gate in the suite).
//
// scripts/live-loop-receipt.mjs drives the standing service end to end with claim capture on and runs
// export-pack; here we assert the emitted witness-input.json pairs the agent's claims with the
// witnessed turns the way the product promises, AND that the committed examples/live-loop copy is a
// byte-for-byte match of a fresh run (so nobody can quietly edit the receipt the demo renders).

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error — zero-types ESM demo script, imported for its exported producer.
import { produceLiveLoopReceipt } from "../scripts/live-loop-receipt.mjs";

const COMMITTED = fileURLToPath(new URL("../examples/live-loop/witness-input.json", import.meta.url));

describe("live-loop canonical receipt (Lane B)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
  });

  function freshPack(): string {
    const packDir = mkdtempSync(join(tmpdir(), "lyhna-live-loop-test-"));
    cleanups.push(() => rmSync(packDir, { recursive: true, force: true }));
    return packDir;
  }

  it("drives the real loop end to end and emits the paired witness-input.json", async () => {
    const { witnessInputPath } = await produceLiveLoopReceipt({ packDir: freshPack() });
    const wi = JSON.parse(readFileSync(witnessInputPath, "utf8")) as {
      steps: Array<{ claim?: { system?: string; user_facing?: boolean }; event: unknown }>;
      settled?: string[];
    };
    expect(wi.steps).toHaveLength(3);

    // The witnessed work: claims paired with an approved, returned tool call.
    const fileStep = wi.steps.find((s) => s.claim?.system === "filesystem");
    const testStep = wi.steps.find((s) => s.claim?.system === "test_runner");
    expect(fileStep?.event).toBeTruthy();
    expect(testStep?.event).toBeTruthy();

    // The dangerous one: claimed but never witnessed (event: null) and user-facing → DO_NOT_SEND.
    const gmailStep = wi.steps.find((s) => s.claim?.system === "gmail");
    expect(gmailStep?.event).toBeNull();
    expect(gmailStep?.claim?.user_facing).toBe(true);

    // The supervisor's settled delta folds into the handoff continuation state.
    expect(wi.settled).toContain("checkout total rounding bug patched");
  });

  it("the committed canonical artifact is a byte-for-byte match of a fresh run (deterministic, not hand-edited)", async () => {
    const { witnessInputPath } = await produceLiveLoopReceipt({ packDir: freshPack() });
    const fresh = readFileSync(witnessInputPath, "utf8");
    const committed = readFileSync(COMMITTED, "utf8");
    expect(fresh).toBe(committed);
  });
});
