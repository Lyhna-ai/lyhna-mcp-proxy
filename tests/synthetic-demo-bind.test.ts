import { describe, expect, it } from "vitest";

import type { BindRequest, ProofReceipt } from "../src/index.js";
import {
  assertContentBlind,
  assertExternalScope,
  buildBindRequest,
  buildLoopProofBundle,
  createLoopContext,
  createSyntheticDemoBindClient,
  LoopSession,
  verifyLoopChain
} from "../src/index.js";

const STUB_SIGNATURE = "c3R1Yg=="; // base64("stub") — the obvious non-signature

describe("synthetic demo bind client", () => {
  it("returns full external-scope receipts: version, public_key, tenant_hash, stub signature, no tenant_id", async () => {
    const bind = createSyntheticDemoBindClient();
    const request: BindRequest = {
      action_type: "echo",
      action_payload: { tool_name: "echo", arguments: { message: "hi" } },
      intent: "mcp:echo",
      intent_version: "1.0",
      constraints: { loop: { loop_id: "loop-x", prior_receipt_id: null, goal_hash: "a".repeat(64) } }
    };
    const r = (await bind.bind(request)) as ProofReceipt;

    expect(r.version).toBe("LYHNA_RECEIPT_V2");
    expect(r.outcome).toBe("APPROVED");
    expect(typeof r.public_key).toBe("string");
    expect(typeof r.tenant_hash).toBe("string");
    expect(r.tenant_id).toBeUndefined(); // external scope: never the internal id
    expect(r.signature).toBe(STUB_SIGNATURE); // honesty: never a real signature
    // echoes the stamped constraints (goal_hash only) verbatim
    expect(r.constraints).toEqual(request.constraints);
  });

  it("never echoes a plaintext goal/intent into the receipt (content-blind)", async () => {
    const bind = createSyntheticDemoBindClient();
    // loop_close requests default intent to the raw goal — the receipt must NOT carry it.
    const request: BindRequest = {
      action_type: "loop_close",
      action_payload: { loop_id: "loop-x", action_count: 1 },
      intent: "the secret raw goal text",
      intent_version: "loop_v1",
      constraints: {
        loop: { loop_id: "loop-x", prior_receipt_id: "r1", goal_hash: "a".repeat(64) },
        loop_close: {
          loop_id: "loop-x",
          goal_hash: "a".repeat(64),
          action_count: 1,
          outcome: "COMPLETED",
          prior_receipt_id: "r1",
          termination_reason: "t"
        }
      }
    };
    const r = (await bind.bind(request)) as ProofReceipt;
    expect(r.intent).toBeUndefined();
    expect(r.goal).toBeUndefined();
    // and the deep content-blind guard is satisfied
    expect(() => assertContentBlind([r])).not.toThrow();
  });

  it("advances receipt_id per call (distinct ids so a chain has real continuity)", async () => {
    const bind = createSyntheticDemoBindClient();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const r = (await bind.bind({
        action_type: "echo",
        action_payload: {},
        intent: "mcp:echo",
        intent_version: "1.0",
        constraints: { loop: { loop_id: "l", prior_receipt_id: null, goal_hash: "a".repeat(64) } }
      })) as ProofReceipt;
      ids.add(String(r.receipt_id));
    }
    expect(ids.size).toBe(5);
  });

  it("a driven loop produces a sealed, externally-scoped, content-blind chain that bundles and structurally verifies", async () => {
    const bind = createSyntheticDemoBindClient();
    const session = new LoopSession(createLoopContext({ loop_id: "loop-demo", goal: "do the thing" }));

    const r1 = (await session.bindToolCall(
      buildBindRequest({ toolName: "echo", arguments: { message: "one" } }),
      (req) => bind.bind(req)
    )) as ProofReceipt;
    const r2 = (await session.bindToolCall(
      buildBindRequest({ toolName: "echo", arguments: { message: "two" } }),
      (req) => bind.bind(req)
    )) as ProofReceipt;
    const close = await session.close((req) => bind.bind(req), {
      outcome: "COMPLETED",
      termination_reason: "task_done"
    });
    expect(close.sealed).toBe(true);

    const receipts = [r1, r2, close.sealed ? (close.receipt as ProofReceipt) : ({} as ProofReceipt)];

    expect(() => assertExternalScope(receipts)).not.toThrow();
    expect(() => assertContentBlind(receipts)).not.toThrow();

    const built = buildLoopProofBundle({ receipts, source_env: "test" });
    expect(built.bundle.loop.sealed).toBe(true);
    expect(built.bundle.loop.action_count).toBe(2);
    expect(built.bundle.scope).toBe("external");

    const links = receipts.map((r) => ({
      receipt_id: String(r.receipt_id),
      loop: (r.constraints?.loop as never) ?? null,
      loop_close: (r.constraints?.loop_close as never) ?? null
    }));
    expect(verifyLoopChain(links)).toEqual({
      valid: true,
      sealed: true,
      loop_id: "loop-demo",
      action_count: 2
    });
  });
});
