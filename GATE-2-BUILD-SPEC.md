# Gate 2 — Capsule Inheritance (loop emits a judgment ledger → next loop initializes from it, not a transcript)

> Build spec written 2026-06-09 by the instance that built & merged Capsule Gate 1.
> Read `HANDOFF.md` first. This file is the concrete pipeline for the next gate.
> **The capture primitive is DONE. Do not rebuild capture. Build the inheritance.**

---

## Single structural claim (the build-prompt seed, vision stripped)

> A real multi-step loop's during-run chain of verdicts (APPROVED / ESCALATED / REFUSED, each
> anchored to its prior and carrying a *declared* settled-state delta) is reduced at close into a
> sealed capsule containing the ordered judgment chain + a derived settled/open state + an
> inherit-block; and a **second loop can be opened *from* that capsule**, initializing its starting
> state from the prior loop's settled verdicts (citing the capsule ref as its root anchor) instead of
> from a raw transcript. A verifier leg proves the second loop's root reconciles to the first loop's
> capsule, cold.

Everything below is how that claim becomes code, in order, each stage independently verifiable.

---

## What already exists (DO NOT rebuild)

The per-step verdict is already captured at the bind. One "judgment moment" today =
- a signed receipt with `constraints.loop` {loop_id, prior_receipt_id, goal_hash}, `constraints.scope`
  {scope_ref, action_class, tool_name, target_descriptor, prior_receipt_id}, and `outcome`
  (APPROVED forwarded) — for a step that acted; **or**
- an attested `ScopeEvent` {decision: REFUSED|ESCALATED, scope_ref, attempted, event_hash,
  prior_receipt_id} from `scope-event-recorder.ts` — for a step the pre-bind gate held/refused (no
  signed receipt, because the key-less adapter can't mint one).

The chain is already anchored (every step cites its prior). `ContinuationCapsule` already has
`inherits_from` / `scope_ref` / `what_changed` / settled-open-next and is re-validated at export in
`buildLoopProofBundle`. `verifyLoopChain` already enforces `loop_close.action_count == in-loop link
count`. **So "the 30 verdicts, anchored" already happen. The gap is (1) making the chain a
first-class object, (2) a declared+reduced settled-state, and (3) opening a NEW loop FROM a capsule.**

---

## The river (5 stages, build in this order)

### Stage A — Judgment Record projection  `[derivation only — lowest risk, do first]`
**Goal:** make "the chain of verdicts" a single addressable object, derived from data that already exists.

- New pure function in a new `src/judgment-chain.ts`:
  `deriveJudgmentChain(receipts: ProofReceipt[], scopeEvents: ScopeEvent[]): JudgmentRecord[]`
- `JudgmentRecord` (content-blind, structural):
  `{ step_index, anchor_prior_receipt_id, scope_ref, action_class, tool_name|null,
     target_descriptor|null, verdict: "APPROVED"|"ESCALATED"|"REFUSED", source: "receipt"|"scope_event",
     ref: receipt_id|event_hash, ts }`
  - verdict resolution: forwarded step → `receipt.outcome`; gate-held/refused step → `scopeEvent.decision`.
  - order by walking the `prior_receipt_id` anchor chain (fail closed on a break — reuse the
    contiguity logic already in `loop-proof-bundle.ts`).
- Surface it additively in the pack: add `judgment_chain` to `bundle.json` under `capsule`
  (alongside the existing `scope_events`). Re-validate at export (recompute, don't trust input).
- Tests: ordering, verdict-from-both-sources, contiguity fail-closed, count == receipts(in-loop) + gate events.

**No new capture, no protocol change, no core change.** This is the object the whole product names.

### Stage B — Declared settled-state delta per step  `[extend — additive structural key]`
**Goal:** each step *declares* what it settles/opens, so the chain can be folded into a settled-state — declared, never inferred (keeps the content-blind / determinism invariant).

- Extend the scope stamp (built in `loop.ts: mergeScopeConstraint` / `proxy-core.ts`) with an optional
  additive, content-blind `delta` on `constraints.scope`:
  `delta?: { settles?: string[]; opens?: string[]; resolves?: string[] }` where the strings are
  **structural ids/hashes**, never plaintext plan. (Plaintext "what it settled" lives in the
  Verified-Context **sidecar** only, exactly like the existing structural/sidecar split.)
- New deterministic reducer in `src/judgment-chain.ts`:
  `reduceSettledState(chain: JudgmentRecord[]): { settled: string[]; open: string[]; superseded: string[] }`
  — fold declared `settles`/`resolves`/`opens` across the chain in order; a later `resolves`
  supersedes an earlier `opens`; ESCALATED with no later resolve → stays `open`.
- Wire the reduced state into `ContinuationCapsule` (derive settled/open from the chain instead of
  free supervisor declaration) and **re-validate at export** the same way `what_changed` is already
  recomputed in `buildLoopProofBundle` (a tampered capsule that under-reports settled/open fails closed).
- Tests: reducer determinism; supersede semantics; ESCALATED→open; export recompute mismatch fails closed.

### Stage C — Inherit-block (make the capsule inheritance-ready)  `[extend — assembly]`
**Goal:** the emitted capsule carries exactly what a next loop needs to start from settled truth.

- Add `inherit_block` to the emitted capsule (continuation-capsule.ts + loop-proof-bundle.ts):
  `{ capsule_ref, prior_loop_id, goal_hash, settled: string[], open: string[],
     final_scope_ref, final_receipt_id }`
  - `capsule_ref` = a hash over the sealed capsule's structural projection (reuse `deriveScopeRef`-style
    canonical hashing in `scope-capsule.ts`; this is an adapter-side hash, NOT a core receipt change).
- This is the "back capsule" the next loop will cite. Re-validated at export.
- Tests: capsule_ref recompute matches; inherit_block reflects the reduced state.

### Stage D — Open a loop FROM a capsule (THE keystone — the "front capsule")  `[new — the gap]`
**Goal:** a second loop initializes from the prior capsule, not a transcript. This is the unbuilt half.

- `session-registry.ts: openLoop(...)` accepts optional `prior_capsule: { capsule_ref, settled, open,
  final_scope_ref, final_receipt_id, goal_hash }` (the inherit-block of a prior loop).
  - Seal it as the new loop's **starting settled-state** (the front anchor). The new loop's first
    `constraints.loop` carries an additive `inherits_capsule_ref: <capsule_ref>` (sibling key, like
    the scope key — no core/receipt-shape change).
  - The first step reconciles against the inherited settled-state (root anchor is the capsule, not null).
- `control-channel.ts: open` verb extended to accept `prior_capsule` (SUPERVISOR-ONLY; **fail closed**
  on present-but-malformed, exactly like the `scope_capsule`/`scope_class_map` guard added in round 31).
- The agent path never sets inheritance — supervisor-only, same as seal/close/dump.
- `buildLoopProofBundle` re-validates: if a loop declares `inherits_capsule_ref`, the export records
  it as the root anchor; a loop that claims inheritance from a capsule_ref it can't present fails closed.
- Tests: open-from-capsule cites the ref; malformed prior_capsule fails closed; agent cannot set it;
  a loop's root receipt anchors to the declared capsule_ref.

### Stage E — Inheritance verifier leg + demo (the sellable proof)  `[new — the deliverable]`
**Goal:** *watch* loop 2 skip the re-litigation. This is the demo that sells.

- New leg in `scripts/verify-legs.mjs` (AFTER the existing capsule leg — legs 0–3 + capsule stay
  byte/behavior-identical): **Leg Inheritance**:
  1. Run loop 1: a real multi-step run (≥3 consequential steps + ≥1 attested refusal), close, emit capsule.
  2. Open loop 2 **from loop 1's inherit-block**.
  3. Loop 2 performs a step whose precondition is one of loop 1's `settled` ids.
  4. Export loop 2's pack and **assert**: loop 2's root `constraints.loop.inherits_capsule_ref` ==
     loop 1's `capsule_ref`; loop 2's reduced `settled` ⊇ loop 1's inherited `settled`; loop 2 did
     **not** re-bind the inherited settled decisions (they appear in its init, not as fresh verdicts).
  5. Both packs cold-verify green (structural pass; Proof Mode content-blind).
- New demo `scripts/demo-capsule-inheritance.mjs` (sibling of `demo-capsule-gate.mjs`): narrate
  "without inheritance, loop 2 re-decides the 30; with inheritance, loop 2 starts from the settled set."
- `npm run` scripts: `demo:inherit`, and fold the leg into `verify:legs` + CI.

---

## Per-stage gate (same discipline as Gate 1, every stage)

```
npm run check && npm run build && npm test && npm run demo:capsule && npm run verify:legs
git checkout -- package-lock.json   # npm dirties it; never commit it
# commit (footer: https://claude.ai/code/session_...; NEVER put the model id in commits)
# push to the feature branch with retry/backoff; optional @codex review round
```
Each stage must keep: **216 baseline tests green, legs 0–3 byte/behavior-identical, demo green.**

---

## Invariant guardrails (the lines that, if crossed, rebuild the company you retired)

1. **Judgment = the verdict-of-record, NOT cognition.** Capture APPROVED/ESCALATED/REFUSED + declared
   structural delta. Never capture or infer beliefs/intent/rationale in the structural lane. Plaintext
   rationale (if any) is sidecar-only (Verified Context), content-blind everywhere else.
2. **"Correct / reconciled" ≠ "good work."** Reconciled = belongs to the inherited state + scope.
   Do NOT grade decision quality — that's the model/harness's claim, not Lyhna's.
3. **Settled-state is DECLARED per step + deterministically reduced + re-validated at export.**
   Never inferred. (Mirror the existing `what_changed` recompute-at-export pattern.)
4. **Additive sibling keys only.** No `lyhna-core` / canonical-receipt-shape / signing / canonicalization
   / `lyhna-verify` changes. `inherits_capsule_ref` and `scope.delta` are siblings of `constraints.loop`,
   exactly like `constraints.scope` was.
5. **Supervisor owns open-from-capsule / seal / close / dump.** Agent path can never set inheritance.
6. **Width.** Emit the capsule for the next loop to inherit AT ITS FRONT DOOR. Do NOT feed it into the
   current loop's live reasoning mid-step — that makes Lyhna the runtime memory store (the
   context-graph-company width violation). Inherit at open; don't become the brain.
7. **Per-loop capsule ≠ cross-loop IJL.** The capsule is one loop's closed, sealed ledger (the product
   object). The IJL is what capsules compound into across loops/tenants (the moat). Keep them named
   apart; "each loop is its own ledger" must NOT collapse "the IJL is just a pile of capsules."
8. **Capture-at-bind is the judgments that ACTED.** Name it honestly; the demo must not claim "every"
   judgment. A declaration verb for non-action judgments (deferrals/rule-outs) is a LATER premium for
   Lyhna-native agents — do not block this gate on agents adopting an emit protocol.

---

## Exit criteria (Gate 2 is done when…)

- [ ] `deriveJudgmentChain` + `reduceSettledState` exist, are pure/deterministic, and surface in the pack.
- [ ] A step can declare a content-blind settled-state `delta`; the reducer folds it; export re-validates.
- [ ] The emitted capsule carries an `inherit_block` with a recomputable `capsule_ref`.
- [ ] `openLoop` / control-channel `open` can start a loop FROM a prior capsule (supervisor-only,
      fail-closed on malformed); the first receipt cites `inherits_capsule_ref`.
- [ ] **Leg Inheritance** proves, cold, that loop 2's root reconciles to loop 1's capsule and the
      settled set was inherited (not re-bound). Legs 0–3 + capsule remain green.
- [ ] A demo a non-founder can run shows loop 2 starting from settled truth instead of a transcript.
- [ ] Install path: a stranger can `npm i && npm run demo:inherit` and see the two-loop handoff.

When this converges, the sentence is true in code: **the next agent starts from truth, not slop —
because the loop handed it a verified ledger of what was decided, captured before each step became the
next state.**
