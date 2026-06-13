# Human Guide — how this runs, and your (small) part

You wanted to be as hands-off as possible. Here is exactly what the agents do, what you do, and
how to carry this into Codex and new LLM projects without the authority talk creeping back in.

## What the agents do (no GitHub work from you)

- Develop the witness build on `claude/*` branches in the build home.
- Open ready-for-review PRs, get an independent Codex review, and **merge themselves when CI is
  green and the review is clean**, then move to the next slice. This is the loop. It runs without you.
- Keep the handoff/decision register updated as they go (the build dogfoods the product).

## What only you decide (the agents will hard-stop and ask)

These are the open forks from the thesis — the agents will stop and ask rather than guess:

1. **Fork 2 — first integration surface.** Zapier/Google path-discrepancy is *recommended* for the
   first demo; QuickBooks/Shopify is the obvious SMB-risk story. You pick which real system the
   first live integration targets after the deterministic demo works.
2. **Fork 3 — the name.** "Lyhna Witness" / "Lyhna Witnessed Handoff" are working names; don't
   over-invest until the demo proves the pain. Repos rename in one click, so this is not urgent.

The agents will also stop if anything drifts back toward **authority/gating/permission as the
headline**, or tries to promise more than the V1 line (no "catches every hallucination").

## How to start the next build session

You do not need to touch GitHub or code. In a session pointed at the witness build home:

> Read `witness/THESIS.md` and `witness/BUILD-PLAN.md`. Run the build loop. Start at slice 1
> (schema + types) and proceed through the brutal demo, hard-stopping only on the named forks
> and boundaries. Do not touch `lyhna-mcp-proxy/src`. Report slice completions and the demo.

That's the whole instruction. The plan carries the rest.

## How to carry this into Codex and two new LLM projects

So the new projects start clean and **never talk about authority again**:

1. Give each new project **two files**: `witness/THESIS.md` (the decision) and
   `witness/PROJECT-BRIEF.md` (the portable, self-contained brief).
2. Paste `PROJECT-BRIEF.md` as the **first message / project instructions**. Its top is an
   explicit "DO NOT talk about authority/gating/memory" banner, so the new model starts on the
   witnessed-handoff frame, not the old one.
3. If a new project starts drifting to authority/gating, paste the thesis §1 and §12 and say
   "this is settled, do not re-litigate." (That's the product's own discipline, used on the team.)

## The one thing worth knowing about the code

You were right about Zapier. The existing repo already has the mechanism that catches "the agent
said Google but actually used Zapier" — it's the wrapper-family registry
(`src/extractors/wrapper-registry.ts`), already built and tested. So the witness is not starting
from zero; the build mostly adds the *claim* side and the trust-marked handoff on top of capture
that already works. That's why this is weeks of focused build, not a rebuild.

## Provenance / honesty notes (so future-you trusts this folder)

- This folder was assembled 2026-06-13 from your uploaded handoff document (preserved verbatim in
  `THESIS.md`) plus a live read of `lyhna-mcp-proxy` at commit `c20fca9`.
- It is **additive**: it created a new `witness/` directory on a `claude/witness-build` branch and
  changed nothing in the existing product. `master` and the proxy code are untouched.
- The clean **separate repo** is the intended final home (see `README.md` for status) — kept apart
  from the old authority-framed code on purpose, so new agents don't get contaminated by it.
