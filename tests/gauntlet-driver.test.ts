// The Reliability Gauntlet's parameterized real-loop driver must produce the right witnessed shape for
// each verdict/outcome it claims to drive — so the gauntlet's findings rest on the REAL loop, not a
// mock. This drives a handful of scenarios end to end (open -> route -> claim -> close -> export-pack)
// and asserts the emitted witness-input.json carries the expected verdict kinds + runtime reports.
//
// Mirrors live-loop-receipt.test.ts: the driver self-builds dist on a clean checkout, hence the
// generous timeouts; a present dist makes the build a no-op.

import { describe, expect, it } from "vitest";

// @ts-expect-error — zero-types ESM harness script, imported for its exported producer.
import { runScenario } from "../scripts/gauntlet/driver.mjs";

const W = "mcp__filesystem__write_file";
const D = "mcp__filesystem__delete_file";
const G = "mcp__gmail__send";

describe("gauntlet driver — real-loop verdict/outcome matrix", () => {
  it("APPROVED + success → APPROVED verdict with returned:true and a result_hash", async () => {
    const { witnessInput, sealed, exportRc } = await runScenario({
      id: "t-approved",
      objective: "approved success",
      calls: [{ toolName: W, arguments: { path: "x" } }],
      claims: [{ system: "filesystem", action: "write_file", result: "wrote" }],
      classMap: { [W]: "act" }
    });
    expect(sealed).toBe(true);
    expect(exportRc).toBe(0);
    const ev = witnessInput.steps[0].event;
    expect(ev.verdict.kind).toBe("APPROVED");
    expect(ev.runtime_report.returned).toBe(true);
    expect(ev.runtime_report.result_hash).toMatch(/^sha256:/);
  }, 180000);

  it("APPROVED + upstream throw → APPROVED verdict with returned:false and an error_hash", async () => {
    const { witnessInput } = await runScenario({
      id: "t-failed",
      objective: "approved but failed",
      calls: [{ toolName: W, arguments: { path: "x" } }],
      claims: [{ system: "filesystem", action: "write_file", result: "wrote", user_facing: true }],
      classMap: { [W]: "act" },
      failTools: [W]
    });
    const ev = witnessInput.steps[0].event;
    expect(ev.verdict.kind).toBe("APPROVED");
    expect(ev.runtime_report.returned).toBe(false);
    expect(ev.runtime_report.error_hash).toMatch(/^sha256:/);
  }, 180000);

  it("bind REFUSED → REFUSED verdict, no runtime report", async () => {
    const { witnessInput } = await runScenario({
      id: "t-refused",
      objective: "bind refused",
      calls: [{ toolName: G, arguments: {} }],
      claims: [{ system: "gmail", action: "send", result: "sent", user_facing: true }],
      classMap: { [G]: "act" },
      toolOutcomes: { [G]: "REFUSED" }
    });
    const ev = witnessInput.steps[0].event;
    expect(ev.verdict.kind).toBe("REFUSED");
    expect(ev.runtime_report).toBeUndefined();
  }, 180000);

  it("bind ESCALATED → ESCALATED verdict, no runtime report", async () => {
    const { witnessInput } = await runScenario({
      id: "t-escalated",
      objective: "bind escalated",
      calls: [{ toolName: G, arguments: {} }],
      claims: [{ system: "gmail", action: "send", result: "sent" }],
      classMap: { [G]: "act" },
      toolOutcomes: { [G]: "ESCALATED" }
    });
    const ev = witnessInput.steps[0].event;
    expect(ev.verdict.kind).toBe("ESCALATED");
    expect(ev.runtime_report).toBeUndefined();
  }, 180000);

  it("claim with no witnessed call → event:null (the dangerous claimed-but-never-seen)", async () => {
    const { witnessInput } = await runScenario({
      id: "t-unwitnessed",
      objective: "claimed but not witnessed",
      calls: [{ toolName: W, arguments: { path: "x" } }],
      claims: [
        { system: "filesystem", action: "write_file", result: "wrote" },
        { system: "gmail", action: "send", result: "emailed the client", user_facing: true }
      ],
      classMap: { [W]: "act" }
    });
    const gmail = witnessInput.steps.find((s: any) => s.claim?.system === "gmail");
    expect(gmail.event).toBeNull();
    expect(gmail.claim.user_facing).toBe(true);
  }, 180000);

  it("seals declared scenario tools into allowed_tools so undeclared same-class tools are REFUSED", async () => {
    const { witnessInput } = await runScenario({
      id: "t-undeclared-tool",
      objective: "undeclared same-class tool",
      calls: [{ toolName: D, arguments: { path: "x" } }],
      claims: [{ system: "filesystem", action: "delete_file", result: "deleted" }],
      classMap: { [W]: "write" }
    });
    const ev = witnessInput.steps[0].event;
    expect(ev.call.toolName).toBe(D);
    expect(ev.verdict.kind).toBe("REFUSED");
    expect(ev.runtime_report).toBeUndefined();
  }, 180000);

  it("records continuation fields through supervisor record_delta before export-pack emits witness-input", async () => {
    const { witnessInput } = await runScenario({
      id: "t-continuation-delta",
      objective: "continuation state",
      calls: [{ toolName: W, arguments: { path: "x" } }],
      claims: [{ system: "filesystem", action: "write_file", result: "wrote" }],
      classMap: { [W]: "write" },
      settled: ["wrote the file"],
      open_questions: ["does the client need a note?"],
      next_actions: ["confirm before sending"]
    });
    expect(witnessInput.objective).toBe("continuation state");
    expect(witnessInput.settled).toEqual(["wrote the file"]);
    expect(witnessInput.open_questions).toEqual(["does the client need a note?"]);
    expect(witnessInput.next_actions).toEqual(["confirm before sending"]);
  }, 180000);

  it("fails closed when a scenario routes calls but declares no scope (empty classMap)", async () => {
    // An empty classMap would seal empty allow-lists, which the scope gate treats as 'no rule' — every
    // call would forward as APPROVED instead of the intended REFUSED. The driver must refuse to run it.
    await expect(
      runScenario({
        id: "t-no-scope",
        objective: "misconfigured scenario",
        calls: [{ toolName: W, arguments: { path: "x" } }],
        claims: [{ system: "filesystem", action: "write_file" }],
        classMap: {}
      })
    ).rejects.toThrow(/declares no scope|fail closed/i);
  }, 180000);
});
