# Lyhna Witness — Portable Project Brief

> **Paste this as the first instruction in any new Codex or LLM project.** It is self-contained.
> Pair it with `THESIS.md` for the full decision record.

---

## ⛔ Frame guardrail — read first

This project is **NOT** about any of these. Do not raise, design around, or drift into them:

- authority gating · permission management · "may the agent act" · governance
- generic memory · "the AI remembers things about me"
- transcript summarization · a "nice HANDOFF.md generator" as the product
- proof receipts / hashes as the headline · developer PR proof cards as the company
- dashboard-first SaaS · verifying real-world outcomes the system never observed

If you find yourself proposing any of the above, stop — it is a settled non-goal.

## What Lyhna is

**Lyhna is the independent witness in the path of an agent's real-world tool calls. It records
what actually crossed the wire, compares that to what the agent claimed, and produces a
trustworthy handoff of what the agent really did.**

- The MCP adapter is the witness. The Handoff is its human-readable testimony. The proof spine is
  the audit floor (one click away, never the headline).
- Core sentence: *Lyhna tells you what your AI agent actually did in your business systems, where
  that differs from what it claimed, and what the next human or AI can safely continue from.*
- The product primitive is **claimed vs. actual**. The agent is an unreliable narrator of its own
  work; Lyhna is the independent witness.

## Why it can exist (and isn't copyable)

A summary is the agent narrating itself — copyable, and the platforms give it away. A witnessed
handoff is backed by **independent observation of the tool calls**, which only exists if Lyhna is
in the path. The moat is being the witnessed route between agents and business tools (Zapier,
Google, QuickBooks, Shopify, Notion, CRMs, email), worker-agnostic (Claude, Codex, Hermes,
ChatGPT, any agent).

## V1 promise (the honesty ceiling — do not exceed)

**Action-level witness + evidence-bound continuation.** Lyhna can: record the actual tool path /
app / action / result / hash; preserve what the agent claimed; flag claimed-vs-actual mismatch;
flag missing evidence for a "done" claim; mark steps SUPPORTED / UNSUPPORTED / NEEDS_EVIDENCE /
NEEDS_HUMAN_APPROVAL; separate settled / open / next / discrepancies in the handoff.

Lyhna must **not** claim: catching every hallucination; verifying real-world outcomes it did not
observe; judging whether the work was good; arbitrary sentence-level truth. Constitutional line:
*it witnesses what crossed the boundary and compares it to claims — it does not know reality
outside the observed path.*

## Trust labels (the agent-usable product)

`SUPPORTED · UNSUPPORTED · NEEDS_EVIDENCE · NEEDS_HUMAN_APPROVAL · CLAIMED_ACTUAL_MISMATCH ·
SETTLED · REOPENED · SAFE_TO_CONTINUE · DO_NOT_SEND · DO_NOT_RE_LITIGATE`

## First build target

A deterministic generator: tool-call event sequence (expected path + agent claim + actual
witnessed call + result) → `HANDOFF.md` + `handoff.json` + `next-ai-prompt.md`, with at least one
`CLAIMED_ACTUAL_MISMATCH` ("agent claimed Google; witness observed Zapier"), readable by a
non-technical business owner. Demo it as a business owner discovering what their agent really did
— not as a code review.

## Where the existing assets live (read-only)

In `lyhna-mcp-proxy` (do not modify it): the wrapper-family registry that resolves universal
wrapper calls to true app/action granularity (the Zapier catch) is `src/extractors/wrapper-registry.ts`;
per-call capture is in the judgment ledger/recorder; settled/open/next state in the judgment
reducer + continuation capsule; the proof floor in the loop-proof-bundle / proof-pack code. The
witness build adds the **claim** side and the trust-marked handoff on top — it does not rebuild
the proxy or change receipt shape.

## Do not re-litigate

Product form is MCP/plugin/witness in the tool-call path. Handoff is the visible artifact; the
trust verdict (claimed-vs-actual + evidence-bound continuation) is the value. V1 does not claim
universal truth detection. Dashboard is downstream. First demo shows a path discrepancy. These are
settled; reopen only with a named new finding.
