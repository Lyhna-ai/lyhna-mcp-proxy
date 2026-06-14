# Lyhna — LLM Context Sheet (proxy)

> **Last updated: 2026-06-14.** Read this first at the start of any session in this repo
> (`lyhna-mcp-proxy`). It is the durable map of *what Lyhna is now*, how the two repos fit, and the
> rules for changing things safely.
>
> **Canonical copy:** this is a proxy-anchored mirror of `lyhna-witness/LLM-CONTEXT.md`. Sections 1–6,
> 8, 9, 11 are shared product context (keep them in sync with the witness copy); sections 5, 7, 10 are
> oriented to this repo. If you make a material change, update the date + the relevant section in **both**
> copies in the same change set.

---

## 1. What Lyhna is (in one breath)

**Lyhna sells "AI Work Receipts your clients can trust."** It witnesses an AI agent's *real tool calls*,
compares them to what the agent *claimed* it did, and prints a deterministic, honest receipt:

- 🟢 **SUPPORTED** — the claim matches what crossed the tool boundary.
- 🟡 **CLAIMED_ACTUAL_MISMATCH** — the agent took a different route/action than it claimed (review note).
- 🔴 **UNSUPPORTED / DO_NOT_SEND** — the agent claimed something the witness never saw happen.

**Buyer:** AI agencies, bookkeepers, ops teams, VAs — anyone who white-labels the receipt to *their*
clients ("before your AI tells a client 'done,' get the receipt").

**The moat = the honesty ceiling.** Lyhna only asserts *action-level witnessed truth*, and the receipt
shows what was proven, what lacked evidence, and what Lyhna refuses to fake. That discipline lets the
demo survive "have your own AI audit this receipt." Never trade it away for a punchier claim.

---

## 2. The honesty ceiling (V1 — non-negotiable)

The witness is **action-level only**. It compares what crossed the tool-call boundary to what the
agent claimed. Canonical source: `THESIS.md` (witness repo). The receipt UI frames this as:

**What this receipt proves:** what actually crossed the tool boundary, whether each claim has
witnessed support, where support is missing or mismatched, and what is safe to continue from.

**What this receipt refuses to fake:** client behavior, business/legal correctness, agent confidence
as evidence, or anything outside the observed workflow.

If a change would make any surface imply more than the above (e.g. "the email was sent," "the work is
correct," "this happened live"), it is an **overclaim** — do not ship it.

---

## 3. Architecture — two repos (GitHub org: `Lyhna-ai`)

| Repo | Language | Base branch | What it is |
| --- | --- | --- | --- |
| **`lyhna-mcp-proxy`** (this repo) | TypeScript | `master` | Runtime MCP proxy in the tool-call path. Witnesses real tool calls, captures agent claims, and exports a `witness-input.json`. ~503 tests. |
| **`lyhna-witness`** | zero-dep ESM JS (Node ≥20) | `main` | Product layer: deterministic labeler + handoff generator + CLI + OKF export + the `web/` demo. ~70 tests. |

This repo **produces** the witness input; `lyhna-witness` **renders** it into the user-readable receipt.
Neither imports the other's internals — the witness mirrors this proxy's event vocabulary
(Integration Option A).

---

## 4. The loop (claim capture → witness → receipt), end to end

1. **Agent records a claim** via this proxy's `record_claim` MCP tool (opt-in, env
   `LYHNA_PROXY_CLAIM_CAPTURE=1`). The agent can *write* claims but can **never read** the witnessed
   ledger back.
2. **Proxy witnesses** the real tool calls through the standing-service loop (judgment ledger:
   verdict APPROVED/ESCALATED/REFUSED + runtime report `returned`/hashes).
3. **Loop close → `export-pack`** pairs the agent's claims with the witnessed judgment turns
   (`assembleWitnessInput`) and emits **`witness-input.json`** (verified-context only; plaintext).
4. **`lyhna-witness <witness-input.json>`** applies the deterministic labeler and writes the receipt
   (`handoff.json` / `HANDOFF.md` / `next-ai-prompt.md` / `okf/`).
5. **`lyhna-witness/web/`** renders a committed `handoff.json` for a user or AI to audit.

### The canonical "came through the live loop" receipt
- **This repo:** `scripts/live-loop-receipt.mjs` (`npm run demo:live-loop`) drives the real loop and
  emits `examples/live-loop/witness-input.json` (deterministic; `tests/live-loop-receipt.test.ts`
  asserts it byte-for-byte and that `npm test` self-builds dist).
- **Witness repo:** that file is vendored to `demo/live-loop-witness-input.json` and rendered to
  `examples/live-loop/`; the web demo serves it.
- Scenario (honest, mixed): agent wrote the checkout fix (SUPPORTED) + ran tests (SUPPORTED) +
  **claimed it emailed the client an invoice but made no email tool call** → UNSUPPORTED / DO_NOT_SEND.
  The killer demo: "claimed but never witnessed."

---

## 5. The website (lives in `lyhna-witness/web/`)

**Live (public):** https://lyhna-ai.github.io/lyhna-witness/ — a static page that **replays** the
committed live-loop receipt (not a live in-browser witness; tools shown are simulated). Tagline:
"Demo tools. Real witness loop. Deterministic receipt rules." The capsule is a **Client Review AI Work
Receipt**: 10-second verdict, witnessed-&-supported steps, the flagged DO-NOT-SEND step, a buyer-facing
"what this receipt proves / refuses to fake" section, and a "Copy receipt → ask your own AI if it
overclaims" button. Full details live in the witness copy of this sheet (§5 there). **Nothing in this
proxy repo serves or builds the website.**

---

## 6. Current state (as of 2026-06-14)

**Shipped & merged (packaging phase complete):**
- Backend/spine + the full claimed-vs-actual loop (proxy `#21–#25`, witness `#3–#8`).
- **Lane B** — canonical live-loop receipt: proxy `#26` (emits `witness-input.json`), witness `#9`.
- **Web demo** — witness `#10`–`#15` (retarget to live-loop receipt, tagline, sellable polish, GitHub
  Pages deploy, overclaim-audit fix, Client Review receipt copy). Live, public, honesty-audited.

**Health:** proxy `master` green (~503 tests); witness `main` green (~70 tests). Check GitHub for open
PRs before starting a new lane.

**Deferred / next lanes (NOT V1 blockers):** real beta-capture path (mailto/Tally/waitlist); buyer copy
+ MCP install instructions; **proxy README repositioning off "authority/proof/governance" onto
"witness"**; live Zapier/Gmail demos; concurrency-safe claim↔turn correlation (opt-in sequential is fine
for V1); proxy auto-invoking the witness.

---

## 7. How to work in this repo (`lyhna-mcp-proxy`, TypeScript)

```bash
npm install              # first, for @types/node etc.
npm run build            # tsc -> dist/
npm run check            # tsc --noEmit (typecheck)
npm test                 # vitest run — full suite (~503)
npm run demo             # scripts/demo-golden-path.mjs (deterministic local golden path)
npm run demo:live-loop   # drive the real loop -> examples/live-loop/witness-input.json
npm run verify:legs      # cold-verify legs against the real standalone lyhna-verify
```
Public CLI: `lyhna-mcp export-pack` / `lyhna-mcp export` (`export-loop-proof`), built to
`dist/src/bin/cli.js`. The standing HTTP proxy: `npm run start:proxy:http` (`src/bin/http-proxy.ts`).

**Drift / CI:** proxy CI runs typecheck + build + full test suite + the cold-verify legs. The witness
repo (not this one) has the `examples/` drift gate — if you change anything that affects the emitted
`witness-input.json` shape, the witness side must regenerate.

---

## 8. The PR / review workflow (how every change ships)

1. Work on a dev branch (base = this repo's `master`; witness's `main`).
2. One logical change per PR. Open it, mark ready, comment **`@codex review`** (mark-ready alone often
   misses the trigger).
3. **Merge gate — ALL must hold on the *current* head SHA:** every CI check `success` · `mergeable_state`
   clean · Codex bot "Didn't find any major issues" on that exact commit · **zero unresolved review
   threads**.
4. If Codex flags P1/P2 and the fix is small + unambiguous + in-scope: fix, re-run tests, push,
   **resolve the threads**, re-comment `@codex review`. If ambiguous/architectural or it touches a
   guardrail below: stop and ask the project owner.
5. **Squash-merge.** Then reset the dev branch to base (`git fetch origin <base>; git reset --hard
   origin/<base>; git push -f`).
6. GitHub MCP tools only (`mcp__github__*`); no `gh` CLI in this environment.

Codex catches real, product-relevant bugs (overclaims, edge-case verdict logic). Treat it as the
second engineer; don't merge around it.

---

## 9. Guardrails — do NOT touch without explicit project-owner sign-off

- **Proof spine (this repo):** no changes to the signed bundle / receipt shape / canonicalization. The
  `witness-input.json` is an *additive*, verified-context-only sidecar that `export-pack` already emits.
- **Witness determinism (witness repo):** the labeler/generator must stay deterministic — no clock, no
  model calls, no randomness. Same input ⇒ byte-identical output.
- **Claim capture posture:** opt-in · verified-context only · during-run only · fail-closed. The agent
  can write claims but can **never** read/forge the witnessed ledger.
- **The honesty ceiling (§2):** never let any surface (receipt, web copy, README) overclaim. No
  delivery confirmation, no outcome/quality verification, no "live witnessing" implication, no
  universal hallucination-detection claims.
- **`examples/live-loop` data:** generated, not hand-edited. Regenerate via the scripts.

---

## 10. Key files map (this repo)

- `src/claim-recorder.ts`, `src/record-claim-tool.ts` — agent claim capture.
- `src/transport/standing-http.ts`, `src/transport/mcp-sdk.ts` — standing HTTP proxy + record_claim wiring.
- `src/judgment-ledger.ts`, `src/judgment-recorder.ts` — the witnessed ledger.
- `src/scope-capsule.ts` — scope gate (APPROVED/ESCALATED/REFUSED), target extraction, sidecar projection.
- `src/witness-bridge.ts` — `assembleWitnessInput` (pairs claims ↔ turns into `witness-input.json`).
- `src/supervisor-cli.ts` — `export-pack` (dump → fold → emit the pack + `witness-input.json`).
- `src/bin/cli.ts`, `src/bin/export-loop-proof.ts`, `src/bin/http-proxy.ts` — CLI / proxy entry points.
- `scripts/live-loop-receipt.mjs` — drives the real loop for the canonical receipt.
- `tests/supervisor-cli.test.ts`, `tests/live-loop-receipt.test.ts` — the e2e loop + canonical receipt tests.
- `AGENTS.md` (hard invariants), `RUNNING.md`, `docs/` — proxy docs.

**In `lyhna-witness`:** `THESIS.md` (thesis + honesty ceiling, canonical), `src/labels.mjs` +
`src/generate.mjs` + `src/witnessed-event.mjs` (the labeler/renderer), `web/` (the demo).

---

## 11. Glossary

- **Witness / witnessed** — what the proxy actually observed crossing the tool-call boundary.
- **Claim** — what the agent *says* it did (via `record_claim`); the agent's voice, never trusted blind.
- **Receipt / handoff / capsule** — the rendered claimed-vs-actual output (`handoff.json` + `HANDOFF.md`).
- **`witness-input.json`** — this proxy's emitted pairing of claims with witnessed turns; the witness's input.
- **Honesty ceiling** — the fixed set of things Lyhna can/cannot assert (§2).
- **OKF** — a portable markdown+frontmatter projection of a handoff (`okf/`).
- **Drift gate** — CI that regenerates committed artifacts and fails if they differ (enforces determinism).
- **The loop / live loop** — the proxy standing-service run that produces a real witnessed receipt.
