# Handoff — lyhna-mcp-proxy / Capsule Gate 1

_Prepared 2026-06-09 by the previous Claude Code instance. Read this top-to-bottom before touching anything._

---

## 0. TL;DR / current state

- **Capsule Gate 1 is DONE and MERGED.** PR #7 ("Capsule Gate 1 — Scope Capsule → Continuation Capsule") merged to `master`.
- **Merge commit:** `66fdbb2c600cf686c456ef85aa0f2fca54808f72` (a true merge commit, not the PR head).
- **PR head that was merged:** `7de9222`.
- **Master CI on the merge commit:** ✅ green — workflow `ci` run **#96** (`27180523936`), all 12 steps passed.
- **Full test suite:** **216 passing** (21 files). Typecheck + build green. Demo + all verifier legs (0–3 unchanged + capsule) green.
- **The PR-activity subscription was auto-closed on merge.** Do NOT reopen PR #7 or open a new PR for this change.
- **DO NOT START THE NEXT GATE** without explicit instruction from Adam (the owner; `adamstx22@gmail.com`).

### Git facts
- Default branch: `master` (base). Merged work lives there now.
- The feature branch was **`claude/sharp-ride-upgj1b`** (this is what PR #7 used and what local HEAD `7de9222` is on).
- ⚠️ **Branch-name discrepancy to be aware of:** the session bootstrap instructions named a develop branch `claude/admiring-ramanujan-khiqr1`, but the actual PR work happened on `claude/sharp-ride-upgj1b`. If you get fresh "develop on branch X" instructions, follow those; just know the merged history is on `master` via `sharp-ride-upgj1b`.

---

## 1. What this project is

`lyhna-mcp-proxy` — an MCP proxy adapter. Universal interception with **bind-gated forwarding** and **three-state enforcement**:
- **APPROVED** → forward to upstream
- **ESCALATED** → hold, await resolution (never forwards)
- **REFUSED** → fail closed (never forwards)

Plus a wrapper-family registry that resolves collapsed operations to true granularity.

It sits in front of an upstream MCP server. Every `tools/call` is gated by a **bind** decision (from a hosted bind service that signs receipts). The adapter itself is **key-less** — it cannot mint signed receipts.

---

## 2. What Capsule Gate 1 added (the merged work)

A **supervisor-sealed scope** that constrains a loop, runs the loop with proof throughout, and emits a Continuation Capsule at close. **Built entirely adapter-side.**

### The hard constraint that shaped everything
**NO changes to:** `lyhna-core`, the canonical receipt shape, signing semantics, canonicalization, or `lyhna-verify`. Everything is additive in `lyhna-mcp-proxy`. This is the #1 invariant — every Codex round was checked against it. If you ever find yourself wanting to change core/verify/receipt-shape/signing, **stop and escalate to Adam** instead.

### Core mechanism
- `scope_ref` + structural target descriptors attach as a **new additive `constraints.scope` sibling key** — exactly like the existing `constraints.loop`. `lyhna-verify` reads only `constraints.loop`/`loop_close` and ignores the sibling, so a scoped chain cold-verifies green with zero core change. (Empirically confirmed.)
- **Two projections** of a Scope Capsule:
  - **structural** — hashed into `scope_ref`. Content-blind (no plaintext plan). Closed allowlist of keys.
  - **sidecar** — plaintext plan (goal_summary, planned_steps, etc.). Only ever appears in the Verified Context export, never on the bind/core/gate path.
- **Two privacy modes:**
  - **Proof Mode** — `scope-capsule.json` is **structural-only / content-blind**. Target checks degrade to `target_descriptor_hash` membership; the gate never reads plaintext targets.
  - **Verified Context Mode** — also carries the plaintext sidecar in the export only.
- **Scope refusals = Option B (sidecar-attested events).** The gate runs **adapter-side, pre-bind**, so there is no signed receipt (the key-less adapter can't mint a REFUSED core receipt). Events are recorded supervisor-side, anchored to the signed chain via `prior_receipt_id` + `event_hash`, and referenced from `bundle.json`.
- **Agent cannot seal/amend/close/dump.** The supervisor owns all of those via the **control channel** (loopback-only). The agent MCP path is read/call only.

---

## 3. Key files (where things live)

| File | Responsibility |
|---|---|
| `src/scope-capsule.ts` | Scope Capsule types, **sealing** (`sealScopeCapsule`, `deriveScopeRef`), the **pre-bind structural gate** (`checkScopeStructural`), `deriveActionClass`, the **closed structural allowlist** (`assertScopeStructuralClosed`) + content-blind assertion (`assertScopeStructuralContentBlind`), `projectScopeCapsuleForExport`, amendment chaining (`amendScope`). |
| `src/scope-event-recorder.ts` | Supervisor-only attestation store for scope refusals/escalations (Option B). `deriveScopeEventHash`. |
| `src/continuation-capsule.ts` | Emitted at close; inherits `scope_ref`/`goal_hash`/`loop_id`; records settled/open/next + what changed + attested scope events. |
| `src/proxy-core.ts` | Adapter-side **pre-bind** scope check; in-lane calls stamp additive `constraints.scope`; out-of-lane refused before bind/upstream and attested. `ProxyScopeContext`, `ScopeGateError`, `decideForward`. |
| `src/loop.ts` | `LoopSession` (mutex-serialized chain), `bindToolCall`, `mergeScopeConstraint`, `max_steps` enforcement, `verifyLoopChain`, `LoopStepBoundError`. |
| `src/session-registry.ts` | `openLoop` / `getScope` / `amendLoop`; seals scope at open; sources the gate classifier from the sealed projection. |
| `src/control-channel.ts` | Supervisor verbs `open` / `amend` / `dump_scope`; loopback-only; fail-closed input validation. |
| `src/loop-proof-bundle.ts` | Proof-pack build (`buildLoopProofBundle`); **export-time re-validation** of the scope/amendment chain; `renderVerifyInstructionsMarkdown` (contains the **Trust boundary** doc — see §5). |
| `src/bin/export-loop-proof.ts` | CLI proof-pack export. |
| `scripts/demo-capsule-gate.mjs` | Deterministic §16 checkout-bug scenario end-to-end. |
| `scripts/verify-legs.mjs` | Verifier legs: **0–3 are pre-existing and must stay byte/behavior-identical**, capsule leg added after them. |

---

## 4. Subtle design decisions you MUST know before editing (learned the hard way over 31 review rounds)

1. **`action_count` vs the `max_steps` budget are different counters (round 30).**
   - `verifyLoopChain` **requires** `loop_close.action_count == number of in-loop links`. So `actionCountValue` must count **every** in-loop bind (APPROVED/ESCALATED/REFUSED) and the chain advances on all of them.
   - `bounds.max_steps` budgets **forwarded (executed) steps only** — tracked by a **separate** `forwardedCountValue` that increments **only on APPROVED**. A held/refused bind never forwards, so it must not consume the budget.
   - The **export** re-check in `loop-proof-bundle.ts` mirrors this: it counts **only APPROVED in-loop receipts** against `max_steps`. Keep runtime and export consistent or one will reject what the other allows.

2. **The classifier (`class_map`) is sealed (round 29).** `scope_class_map` (tool_name → action_class) is folded **into the structural projection** at `openLoop`, hashed into `scope_ref`, and exported in the verified history. The gate derives the action class from `sealed.structural.class_map` (the external `classMap` option is a legacy/test fallback only). Don't reintroduce an unsealed classifier path — it would let a supervisor remap (e.g. `shell → read`) allow a step without appearing in the proof.

3. **Fail closed on present-but-malformed config (round 31).** In `control-channel.ts`, a **present** `scope_capsule`/`scope_class_map` key must be a real object; `null`/non-object is rejected with `ok:false` **before** any registry mutation. An *omitted* key still opens a baseline (ungated) loop. Don't let a falsy value silently downgrade to baseline.

4. **Closed structural allowlist.** `assertScopeStructuralClosed` rejects any field not on the known key set (and validates string-array fields + the flat `class_map` map). A stray/typo/future field must never ride into `scope_ref` or the content-blind export. If you add a structural field, add it to the allowlist **and** the export projection **and** re-run the content-blind assertion.

5. **Export re-validates everything from JSON.** `buildLoopProofBundle` reads receipts/scope from JSON (bypassing the seal-time path), so it re-runs the closed allowlist, content-blind, bounds, per-version `scope_ref`/`sidecar_hash` recomputation, loop binding, contiguous amendment chain, per-step scope anchoring (`scope.prior_receipt_id == loop.prior_receipt_id`), and stamp-in-lane checks. A hash-consistent-but-unsafe projection must still fail closed.

6. **`package-lock.json` churns.** `npm` mutates it during install/test. **Revert it (`git checkout -- package-lock.json`) before every commit** — we kept it out of all commits.

---

## 5. The one documented "Bucket 2" boundary (NOT a bug — do not "fix" it casually)

**Stamp ↔ `action_payload` binding is intentionally out of Capsule Gate 1's threat model.** Codex raised it (round 29); Adam decided to document, not fix.

- The content-blind pack **strips plaintext `action_payload`**, and the signed receipt **commits no payload hash**. So the exporter has nothing to re-derive each step's descriptor *from*.
- A real fix would require **either** a core-signed payload commitment (a canonical-receipt change) **or** carrying plaintext payload into the pack (weakening content-blind Proof Mode) — **both outside Gate 1's scope** (they violate the §2 hard constraint).
- Gate 1 **trusts the adapter** as the supervisor-side enforcement point and defends the agent / continuation / export / tampered-JSON paths. A malicious *adapter* forging its own stamps is outside this threat model.
- **Documented in:** `renderVerifyInstructionsMarkdown` in `src/loop-proof-bundle.ts`, the **"Trust boundary (what governs enforcement, and what this proof does NOT assert)"** section (renders into every pack's `verify-instructions.md`). Verified present on the merge commit.

If a future gate is meant to close this, it's a **core-signing change** and belongs in `lyhna-core`, not here.

---

## 6. How to verify locally (the standard gate)

```bash
npm ci                 # install (will dirty package-lock.json — revert before committing)
npm run check          # tsc --noEmit
npm run build          # clean + tsc
npm test               # vitest run — expect 216 passing, 21 files
npm run demo:capsule   # deterministic end-to-end demo
npm run verify:legs    # legs 0–3 (unchanged) + capsule leg; needs lyhna-verify
```

- `verify:legs` uses `LYHNA_VERIFY_DIR` if set, else clones `Lyhna-ai/Lyhna-ai-lyhna-verify`. **lyhna-verify is read-only — never modify it.**
- Expected final leg output:
  ```
  ✓ Leg Capsule: scope gate: 2 in-lane actions, 1 attested refusal(s); VC + Proof packs cold-verify (structural pass + fail-by-absence); Proof Mode content-blind
  VERIFY LEGS: PASSED (Leg 0 … Leg 3 … Leg Capsule …)
  ```
- CI workflow: `.github/workflows/ci.yml`, job name `verify` (Typecheck → Build → Test → clone lyhna-verify → cold-verify legs).

---

## 7. The review-loop workflow we ran (for if another adversarial pass is requested)

This PR went through **31 rounds** of `@codex review`. **43 findings total: 42 fixed (bucket-1) + 1 documented (bucket-2 boundary, §5).** The loop per round was:

1. New Codex review fires → fetch **new** review threads via `pull_request_read` `get_review_comments` using the `after` cursor (last round's `endCursor`). Webhook events also wake the session.
2. Classify each finding: **bucket-1** = adapter-side fail-closed/correctness fix → fix it; **bucket-2** = would require core/verify/receipt/signing change → document the boundary, don't fix.
3. Implement the fix **+ a regression test** that fails without it.
4. Run the **full** gate (§6): check, build, test, demo, legs.
5. `git checkout -- package-lock.json`, commit (message footer `https://claude.ai/code/session_…`; **never** put the model identity in commits), push to the feature branch with retry/backoff.
6. **Reply on each thread** explaining the fix (concise), then post a top-level `@codex review` re-trigger summarizing the round + restating the invariant checklist.
7. Convergence signal: Codex stops posting threads. A bare 👍 (no findings) does **not** wake the session, so silence ≈ converged. Confirm by checking the PR directly.

Useful invariant checklist we restated each round: no core/verify/receipt-shape/signing/canonicalization changes; structural↔plaintext partition; Proof Mode structural-only/content-blind; VC plaintext sidecar/export only + hash-bound; classifier sealed into scope_ref; scope refusals attested + self-bound; per-step scope stamp anchored; max_steps budgets forwarded executions; control plane loopback-only/supervisor-only; agent cannot seal/close/dump; synthetic-must-not-verify; legs 0–3 green.

---

## 8. Likely "next" (do not start unsolicited)

- The PR body and Adam's instructions reference a **"next gate"** — Gate 1 is "Scope Capsule → Continuation Capsule"; there is presumably a Gate 2+ in the roadmap. **Do not begin it without explicit instruction.**
- A plausible future thread is closing the §5 boundary properly, but that is a **core-signing change** (different repo / different threat model) and is explicitly out of this adapter's scope.

---

## 9. Environment notes

- Remote/web Claude Code session; ephemeral container; repo cloned fresh each session. Commit + push anything you want to keep.
- **No `gh` CLI / no direct GitHub API** — use the `mcp__github__*` MCP tools (load schemas via ToolSearch first). Scope is restricted to `Lyhna-ai/lyhna-mcp-proxy`; use `list_repos`/`add_repo` if you need another.
- `gh` Actions logs were pulled via `mcp__github__actions_list` / `actions_get` / `get_job_logs` (use `return_content:true`; the run-list payload is large — slice/grep the saved file).
- Don't create PRs or merge unless Adam explicitly asks.

---

_End of handoff. Everything is green and merged; the tree is clean except this file. Good luck._
