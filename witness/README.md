# Lyhna Witness — build home

The product pivot: **Lyhna is the independent witness in the path of an agent's real-world tool
calls** — it records what actually crossed the wire, compares it to what the agent claimed, and
produces a trustworthy handoff of what the agent really did. Not authority. Not memory. Not a
summary generator. (Full decision: `THESIS.md`.)

## Files

| File | For | What it is |
|---|---|---|
| `THESIS.md` | everyone | The founder's product decision, **verbatim & canonical**. Do not edit. |
| `BUILD-PLAN.md` | builder agents | Code-grounded build: what already exists in `lyhna-mcp-proxy` to read, what's net-new, the MVP schema, the autonomy loop. |
| `HUMAN-GUIDE.md` | the founder | How the loop runs, your small part, how to carry this into Codex + new LLM projects. |
| `PROJECT-BRIEF.md` | new Codex/LLM projects | Self-contained, paste-as-first-instruction brief with a "no authority talk" guardrail. |

## Non-destruction guarantee

This folder is **additive**. It was created on the `claude/witness-build` branch as a new
`witness/` directory and **changes nothing** in the existing `lyhna-mcp-proxy` product —
`master`, the proxy core, receipt shape, signing, the verifier, and loop-close semantics are all
untouched. The witness build *reads* from the existing code; it never modifies it.

## Provenance

Assembled 2026-06-13 from the founder's uploaded handoff document (preserved verbatim in
`THESIS.md`) plus a live read of `lyhna-mcp-proxy` at commit `c20fca9`. The witness mechanism is
not greenfield: the existing wrapper-family registry (`src/extractors/wrapper-registry.ts`)
already resolves universal wrapper calls (e.g. Zapier `execute_zapier_*_action`) into their true
`app.action` — the mechanism that catches "the agent claimed Google but actually used Zapier."

## Separate-repo status

The intended final home is a **clean, separate repo** (kept apart from the old authority-framed
proxy so new agents start uncontaminated). Whether that repo could be created and populated from
the session that wrote this folder is recorded in the chat handoff; until it exists, this branch
is the durable home and the four files above are fully portable — copy them anywhere.

## Start here

- **Builder agent:** read `THESIS.md` then `BUILD-PLAN.md`; run the loop from slice 1.
- **Founder:** read `HUMAN-GUIDE.md`.
- **New Codex/LLM project:** paste `PROJECT-BRIEF.md` as the first instruction; attach `THESIS.md`.
