# Lyhna Witnessed Handoff — Product Thesis (CANONICAL)

> **Provenance.** This is the founder's product-direction document, preserved **verbatim**.
> It is the canonical decision record. Do not edit, soften, or "improve" it. The build layer
> (`BUILD-PLAN.md`) sits *underneath* this thesis and serves it — it never overrides it.
> Assembled 2026-06-13 from the uploaded handoff document.

---

**Date:** 2026-06-13
**Status:** Product-direction handoff for future agents and projects
**Purpose:** Preserve the current strategic decision so future AI/human sessions can continue without re-litigating the same architecture, market, and product questions.

## 1. Current Decision

Lyhna should not be positioned as agent proof infrastructure, an authority gate, generic memory, or a nice handoff-summary generator.

The product direction is:

**Lyhna is the independent witness in the path of an agent's real-world tool calls. It records what actually crossed the wire, compares that against what the agent claimed, and gives the human a trustworthy handoff of what the agent really did.**

- The MCP adapter is the witness.
- The Handoff is the human-readable face.
- The proof spine is the audit floor.

The product value is not "the agent was allowed." The product value is:

*Here is what your agent actually touched, through which system, with what result, and where its story does not match reality.*

## 2. Why This Matters

The agent is usually the only narrator of what it did after leaving the chat and entering real systems such as Zapier, Google, QuickBooks, Shopify, Notion, a CRM, email, or a vendor portal.

That narrator is unreliable. Not malicious, but unreliable. Agents often report intent rather than actual path:

- "I used Google" when the tool path actually went through Zapier.
- "I created the document" when the runtime returned an error or created a different artifact.
- "I finished the workflow" when some steps were skipped, refused, escalated, or completed through a fallback path.

Normal summaries cannot solve this because they are agent self-report. Lyhna can solve it only when it sits in the tool-call path:

- The agent says what it thinks happened.
- The witness saw what actually happened.
- The Handoff shows the discrepancy plainly.

This is the real product primitive: **Claimed vs. actual.**

## 3. Core Product Sentence

Use this as the shared product sentence until a named delta changes it:

**Lyhna tells you what your AI agent actually did in your business systems, where that differs from what it claimed, and what the next human or AI can safely continue from.**

Shorter versions:

- The witnessed handoff for AI work.
- Know what your agent really did.
- A trustworthy handoff from the tool-call path, not the agent's self-report.

Avoid leading with: "agent proof infrastructure", "authority gating", "governance", "memory", "handoff document" as a standalone commodity, "stop re-explaining work" as the whole pitch. ("Stop re-explaining work" is useful as a secondary benefit, not the moat.)

## 4. Settled Product Model

**Form.** Lyhna is an MCP plugin/proxy/witness that rides in with agents. It is not primarily a destination dashboard. A dashboard can exist later as a human view over witnessed activity, but the product spine must be agent-usable and tool-call-native.

**Surface.** Lyhna produces a Handoff: `HANDOFF.md`, `handoff.json`, `next-ai-prompt.md`, optional evidence index, optional proof pack references. The Handoff is not merely a summary. It is a trust-marked continuation object.

**Hidden Spine.** Existing Lyhna primitives remain underneath: MCP proxy / adapter, tool-call interception, bind/proof receipt chain, judgment ledger, scope capsule, continuation capsule, evidence/result hashes, proof pack. Do not widen the receipt shape just to make the product easier to explain. The visible product changes; the core invariants remain.

## 5. The Key Difference From Commodity Handoffs

A normal handoff says: *Here is what the agent says happened.*

A Lyhna Witnessed Handoff says: *Here is what crossed the tool boundary, here is what the agent claimed, here is where those agree, and here is where they do not.*

This is why the handoff is not just a prompt or a summary. Commodity summaries are copyable. A witnessed handoff is valuable because it is backed by independent observation of tool calls.

## 6. V1 Promise

Do not overpromise universal truth detection. V1 should promise: **Evidence-bound continuation and action-level witnessed truth.**

V1 can honestly do:

- Record actual tool path, tool name, arguments, result status, and result hash.
- Preserve what the agent claimed or declared about the step.
- Flag mismatch between claimed path and actual path.
- Flag missing evidence for a claimed completed action.
- Mark a step as supported by observed tool evidence.
- Mark a step as unsupported when no witnessed tool evidence exists.
- Produce a Handoff that separates settled state, open questions, next actions, and discrepancies.

V1 should not claim: "We catch every hallucination." / "We know whether the business outcome actually happened in the real world." / "We judge whether the work was good." / "We verify arbitrary sentence-level truth across all documents."

The constitutional line: **Lyhna witnesses what crossed the boundary and compares it to claims. It does not magically know reality outside the observed path.**

## 7. Agent-Facing Product Primitives

Future MCP/plugin tools should be designed around agent-native operations like:

```
lyhna.load_handoff
lyhna.record_claim
lyhna.record_evidence
lyhna.record_decision
lyhna.check_next_step
lyhna.compare_claimed_vs_actual
lyhna.flag_unsupported
lyhna.mark_settled
lyhna.mark_reopened
lyhna.export_handoff
lyhna.export_next_ai_prompt
```

Trust labels should be plain and operational:

```
SUPPORTED
UNSUPPORTED
NEEDS_EVIDENCE
NEEDS_HUMAN_APPROVAL
CLAIMED_ACTUAL_MISMATCH
SETTLED
REOPENED
SAFE_TO_CONTINUE
DO_NOT_SEND
DO_NOT_RE_LITIGATE
```

These labels are the agent-usable product.

## 8. Human-Facing Handoff Shape

The human should see a plain-language Handoff that answers: What was the agent supposed to do? What did it claim it did? What did the tool-call witness actually observe? Which systems did it touch? Which path did it use? What result came back? What is supported by evidence? What is unsupported? What mismatched? What needs human approval? What is settled? What should not be re-litigated? What changed since the last handoff? What should the next human or AI do?

Suggested `HANDOFF.md` sections:

```
# Witnessed Handoff
## Current Objective
## Current State
## Claimed vs. Actual Summary
## Systems Touched
## Supported Work
## Unsupported or Missing Evidence
## Mismatches
## Settled Decisions
## Do Not Re-Litigate
## Open Questions
## Human Approval Needed
## Next Actions
## Safe Continuation Prompt
```

## 9. Demo To Build First

The first demo should reproduce the Hermes/Zapier-style failure on purpose.

**Demo Story.** Human instructs agent to use an expected path, such as Google or a direct app integration. Agent performs the task through a different route, such as Zapier. Agent reports the cleaner/intended story in its own words. Lyhna, sitting in the MCP/tool path, records the actual path. Lyhna Handoff surfaces the discrepancy:

```
CLAIMED_ACTUAL_MISMATCH
Agent claimed: used Google Docs directly.
Witness observed: routed through Zapier action create_document.
Result: document created, but formatting degraded.
Human action: review before sending.
```

**Demo Bar.** The demo succeeds only if a non-technical person can understand: what the agent claimed, what actually happened, why the difference matters, what they should do next. Do not demo this as a code review. Demo it as a business owner discovering what their agent really did inside business systems.

## 10. Adoption Thesis

The hard problem is not only building the witness. The hard problem is becoming the path enough agent tool calls travel through.

The strategic bet: MCP is becoming the way agents reach business systems. Lyhna should be the trusted witness layer between agents and those systems. Platforms benefit when trusted plugins make their tools safer for agents to use. This is the Datadog-like pattern: a third-party tool becomes valuable because it makes the platform more operable and trustworthy.

Lyhna should therefore be worker-agnostic: Claude can use it. Codex can use it. Hermes can use it. ChatGPT can use it. Future agents can use it. Do not bind the product identity to one worker. Bind it to the witnessed route between agents and business tools.

## 11. Where The Morning Dashboard Fits

The morning dashboard is still compelling, but it is downstream of the plugin/witness.

Product image: *You walk into work and your dashboard is filled with witnessed handoffs from what your agents did overnight.* The dashboard shows work completed, systems touched, mismatches, unsupported claims, approvals needed, safe-to-continue items, next actions. But the dashboard is not the source of truth. The source of truth is the witnessed tool-call path and the generated handoffs.

## 12. Non-Goals

Do not drift back into: pure authority gating; permission management as the headline; generic memory; generic transcript summarization; dashboard-first SaaS; developer-only proof cards as the company; storing all customer content inside the proof layer; claiming Lyhna can verify real-world outcomes it did not observe.

## 13. Open Forks

**Fork 1: Action-Level Witness vs. Claim-Grounding.** Current recommended V1: start with action-level witness plus evidence-bound continuation. This means Lyhna can flag claimed path vs. actual path mismatch, missing tool evidence, unsupported action claims, human approval gaps. Defer full sentence-level claim-grounding unless explicitly selected as the next build. Sentence-level grounding may require a content-aware layer alongside the content-blind proof spine.

**Fork 2: First Integration Surface.** Candidates: Zapier-style wrapper family (the old Hermes work already exposed the path-discrepancy pain); Google/Drive-style document workflow (humans understand the output); QuickBooks/Shopify-style business-system workflow (SMB risk is obvious); Codex/Claude workflow (the current team can test it daily). Recommended first demo: Zapier/Google path discrepancy, because it dramatizes claimed-vs-actual.

**Fork 3: Product Name.** Working names: Lyhna Witnessed Handoff, Lyhna Handoff, Lyhna Witness, Lyhna Work Witness. Do not over-invest in naming until the demo proves the pain.

## 14. Next Action For Builder Agent

Do not start by changing receipt shape or rebuilding the proxy. Build the smallest product artifact that proves the new direction:

1. Create a deterministic witnessed-handoff schema.
2. Feed it a mocked or recorded sequence of: expected path, agent claim, actual tool call path, result status, evidence hash/ref.
3. Generate: `HANDOFF.md`, `handoff.json`, `next-ai-prompt.md`.
4. Include at least one path discrepancy: "Agent claimed Google." / "Witness observed Zapier."
5. Make the mismatch readable to a non-technical human.

Only after this works should the build connect to live MCP traffic.

## 15. Safe Continuation Prompt

> You are continuing Lyhna product work from the Witnessed Handoff decision.
>
> **Settled direction:** Lyhna is not primarily an authority gate, generic memory tool, or transcript summarizer. Lyhna is the independent witness in the path of an agent's real-world tool calls. It records what actually crossed the wire, compares it to what the agent claimed, and produces a trustworthy Handoff for the next human or AI.
>
> **Do not re-litigate:** pure proof-infrastructure positioning; generic "stop re-explaining work" as the whole product; dashboard-first product direction; developer-only PR proof card as the company; authority gating as the headline.
>
> **Build target:** Create a Witnessed Handoff MVP from a tool-call event sequence. The MVP must output `HANDOFF.md`, `handoff.json`, and `next-ai-prompt.md`. It must include claimed-vs-actual labels and at least one path discrepancy, such as "agent claimed Google; witness observed Zapier." The result must be readable by a non-technical business user.
>
> **V1 promise:** Action-level witness plus evidence-bound continuation. Do not promise universal hallucination detection or real-world outcome verification.
>
> **Core product sentence:** Lyhna tells you what your AI agent actually did in your business systems, where that differs from what it claimed, and what the next human or AI can safely continue from.

## 16. Decision Register

| Decision | Status | Reopen only if |
|---|---|---|
| Product form is MCP/plugin/witness in the agent tool path | Settled | MCP/tool-call adoption fails as a route into business systems |
| Handoff is visible artifact, not the moat by itself | Settled | Users pay for handoff summaries without trust labels (unlikely) |
| Trust value is claimed-vs-actual plus evidence-bound continuation | Settled | A stronger claim-grounding layer is explicitly selected |
| V1 should not claim universal truth/hallucination detection | Settled | A content-aware verifier is built and tested against real failures |
| Morning dashboard is downstream of witnessed handoffs | Settled | Users reject plugin-first flow and demand destination app first |
| First demo should show path discrepancy | Recommended | A more reachable demo proves the same claimed-vs-actual pain faster |

## 17. One-Line Reminder

The agent is an unreliable witness to its own work. Lyhna is the independent witness in the tool-call path, and the Handoff is its testimony.
