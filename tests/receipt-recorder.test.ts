import { describe, expect, it } from "vitest";

import type { BindClient, BindRequest, BindResponse } from "../src/index.js";
import { createReceiptRecorder } from "../src/index.js";

// A fake inner bind that returns a distinct, fully-shaped receipt per call and echoes the
// request constraints (as the synthetic/real clients do).
function fakeInnerBind(): BindClient {
  let n = 0;
  return {
    async bind(request: BindRequest): Promise<BindResponse> {
      n += 1;
      return {
        outcome: "APPROVED",
        receipt_id: `rcpt_${n}`,
        signature: "c3R1Yg==",
        action_type: request.action_type,
        ...(request.constraints ? { constraints: request.constraints } : {})
      };
    }
  };
}

function loopRequest(loopId: string, prior: string | null): BindRequest {
  return {
    action_type: "echo",
    action_payload: {},
    intent: "mcp:echo",
    intent_version: "1.0",
    constraints: { loop: { loop_id: loopId, prior_receipt_id: prior, goal_hash: "a".repeat(64) } }
  };
}

describe("receipt recorder (observe-only)", () => {
  it("records each returned receipt per loop, in order", async () => {
    const recorder = createReceiptRecorder();
    const bind = recorder.wrap(fakeInnerBind());

    await bind.bind(loopRequest("loop-A", null));
    await bind.bind(loopRequest("loop-A", "rcpt_1"));
    await bind.bind(loopRequest("loop-B", null));

    const a = recorder.receiptsForLoop("loop-A");
    const b = recorder.receiptsForLoop("loop-B");
    expect(a.map((r) => r.receipt_id)).toEqual(["rcpt_1", "rcpt_2"]);
    expect(b.map((r) => r.receipt_id)).toEqual(["rcpt_3"]);
    expect(recorder.knownLoopIds().sort()).toEqual(["loop-A", "loop-B"]);
  });

  it("does not record binds with no loop constraint", async () => {
    const recorder = createReceiptRecorder();
    const bind = recorder.wrap(fakeInnerBind());
    await bind.bind({ action_type: "echo", action_payload: {}, intent: "mcp:echo", intent_version: "1.0" });
    expect(recorder.knownLoopIds()).toEqual([]);
  });

  it("attributes the terminal loop_close to its loop", async () => {
    const recorder = createReceiptRecorder();
    const bind = recorder.wrap(fakeInnerBind());
    await bind.bind(loopRequest("loop-C", null));
    await bind.bind({
      action_type: "loop_close",
      action_payload: { loop_id: "loop-C", action_count: 1 },
      intent: "g",
      intent_version: "loop_v1",
      constraints: {
        loop_close: { loop_id: "loop-C", goal_hash: "a".repeat(64), action_count: 1, outcome: "COMPLETED", prior_receipt_id: "rcpt_1", termination_reason: "t" }
      }
    });
    expect(recorder.receiptsForLoop("loop-C").map((r) => r.action_type)).toEqual(["echo", "loop_close"]);
  });

  it("returns the response object UNCHANGED (observe-only: no mutation)", async () => {
    const recorder = createReceiptRecorder();
    const inner = fakeInnerBind();
    const bind = recorder.wrap(inner);
    const returned = await bind.bind(loopRequest("loop-D", null));
    const recorded = recorder.receiptsForLoop("loop-D")[0];
    // Same object identity, not a reshaped copy.
    expect(recorded).toBe(returned as unknown);
    expect(recorded).toEqual({
      outcome: "APPROVED",
      receipt_id: "rcpt_1",
      signature: "c3R1Yg==",
      action_type: "echo",
      constraints: { loop: { loop_id: "loop-D", prior_receipt_id: null, goal_hash: "a".repeat(64) } }
    });
  });

  it("hands back a copy of the array so callers cannot mutate the recorded chain", async () => {
    const recorder = createReceiptRecorder();
    const bind = recorder.wrap(fakeInnerBind());
    await bind.bind(loopRequest("loop-E", null));
    const snapshot = recorder.receiptsForLoop("loop-E");
    snapshot.push({ receipt_id: "injected" });
    expect(recorder.receiptsForLoop("loop-E").map((r) => r.receipt_id)).toEqual(["rcpt_1"]);
  });
});
