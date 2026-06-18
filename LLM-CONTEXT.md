# LLM-CONTEXT - lyhna-mcp-proxy

**Read this first. This file is a pointer, not a copy.**

The canonical "what Lyhna is now" context lives in the witness repo and is the
single source of truth for shared product framing, the two-repo architecture,
the claim -> witness -> receipt loop, the website, the PR/Codex merge gate, and
the honesty ceiling:

- In repo: `lyhna-witness/LLM-CONTEXT.md`
- Raw: https://raw.githubusercontent.com/Lyhna-ai/lyhna-witness/main/LLM-CONTEXT.md

Read the canonical file before doing anything in this repo. Do not duplicate its
content here. Duplicated context drifts, and drift is the exact failure this
pointer exists to prevent.

## Desktop product framing (read before product-facing changes)

Before product-facing adapter/install changes, read the current desktop handoff in
`lyhna-witness/HANDOFF-DESKTOP.md`
([raw](https://raw.githubusercontent.com/Lyhna-ai/lyhna-witness/main/HANDOFF-DESKTOP.md)). **Lyhna Desktop
is the local product wrapper** — the full `lyhna-witness` engine plus this adapter packaged as a local app
(not a smaller product). **This repo remains the MCP adapter / tool-path witness.** Do not reintroduce
hosted/metered/private-beta SaaS-first framing unless explicitly approved. (This is docs/context only — no
adapter, signing, canonicalization, or verification behavior changes here.)

## What lives here (proxy-local only)

`lyhna-mcp-proxy` is the runtime MCP adapter in the agent's tool-call path. It
mirrors upstream tools, captures agent claims when enabled, witnesses the real
tool calls, preserves the proxy/proof/judgment artifacts, and emits
`witness-input.json` for `lyhna-witness`.

`lyhna-witness` is the product receipt layer. It compares the emitted claims and
witnessed actions, computes deterministic trust labels, and renders the
user-readable AI Work Receipt plus OKF/PAM-style export projections.

This repo should not decide receipt labels, weaken the proof spine, infer
real-world outcomes, or rewrite shared product positioning. Proxy invariants
live in `AGENTS.md`; shared product direction lives in
`lyhna-witness/LLM-CONTEXT.md` and `lyhna-witness/THESIS.md`.

## Proxy-local tooling

- `scripts/gauntlet/driver.mjs` — the Reliability Gauntlet's parameterized real-loop driver. Exports
  `runScenario(scenario)`, which drives the standing service end to end (open scoped loop → agent routes
  tool calls + records claims → close → `export-pack`) and returns the emitted `witness-input.json`. It
  changes nothing about the proof spine, receipt shape, or export-pack — it only drives the existing loop
  with varied, deterministic inputs (a programmable bind double for APPROVED/ESCALATED/REFUSED, a
  configurable upstream that can fail a call). Covered by `tests/gauntlet-driver.test.ts`. The
  witness-side gauntlet (`lyhna-witness/reliability/`) consumes it.

## Convention

Whoever makes a material change to the proxy updates this file's date and any
proxy-local note in the same PR. Everything shared changes in
`lyhna-witness/LLM-CONTEXT.md`, never here.

_Pointer last verified: 2026-06-15_
