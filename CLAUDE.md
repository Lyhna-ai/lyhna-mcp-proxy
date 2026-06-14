# CLAUDE.md

**Read [`LLM-CONTEXT.md`](./LLM-CONTEXT.md) first** — it's the dated orientation for this project (what
Lyhna is, the two repos, the claim→witness→receipt loop, current state, the PR/Codex merge gate, and
the honesty ceiling). Then see [`AGENTS.md`](./AGENTS.md) for this repo's hard invariants.

Non-negotiable, even before reading the rest:
- **Honesty ceiling:** Lyhna only asserts *action-level witnessed truth*. Never let any surface imply an
  outcome was verified, work is correct, an email was sent, or that witnessing happened live. That is an
  overclaim — do not ship it.
- **Proof spine:** do not change the signed bundle / receipt shape / canonicalization. `witness-input.json`
  is an additive, verified-context-only sidecar.
- **Every change ships as a PR through the gate:** CI green + `mergeable` clean + Codex "no major issues"
  on the current head + zero unresolved review threads, then squash-merge.
