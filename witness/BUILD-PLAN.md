# Witness Build Plan (agent-facing, code-grounded)

> Serves `THESIS.md`. Does not override it. If this plan and the thesis ever disagree, the
> thesis wins and this plan is wrong.
>
> **Hard boundary, stated by the founder:** do NOT overwrite or rewrite the existing
> `lyhna-mcp-proxy` build. You pull from it by **reading**, never by modifying. This new
> product lives in its own spot. The proxy core, receipt shape, signing, verifier,
> canonicalization, and loop-close semantics are frozen.

## 0. What this build is

The smallest artifact that proves the Witnessed Handoff direction: a deterministic generator
that turns a **tool-call event sequence** (expected path + agent claim + actual witnessed call +
result) into a **trust-marked Handoff** (`HANDOFF.md` + `handoff.json` + `next-ai-prompt.md`),
surfacing at least one `CLAIMED_ACTUAL_MISMATCH` (the Hermes/Zapier "said Google, used Zapier"
catch) in language a non-technical person understands. See `THESIS.md` §14.

It is NOT: a proxy rebuild, a receipt-shape change, a dashboard, a live-traffic integration
(that comes only after the deterministic MVP works), or an authority/permission feature.

## 1. What already exists in `lyhna-mcp-proxy` (READ-ONLY; do not modify)

The witness is **not greenfield**. The "actual path" half of claimed-vs-actual is already built
and tested. Pull these by reading; mirror their shapes; never edit them.

| Asset (read-only) | File | What it gives the witness |
|---|---|---|
| **Wrapper-family registry** | `src/extractors/wrapper-registry.ts` | Cracks a universal wrapper call (`execute_zapier_*_action`, Apify `call-actor`) open into its TRUE operation (`zapier.<app>.<action>`). **This is the mechanism that catches "agent called Zapier when it claimed Google."** Tested in `tests/zapier-wrapper-extractor.test.ts`. |
| **Judgment ledger** | `src/judgment-ledger.ts`, `src/judgment-recorder.ts` | Per-tool-call capture: proposed move (action_class / tool / target), verdict (APPROVED/REFUSED/ESCALATED + source), runtime report (returned / result_hash / error_hash). **This is the witnessed-action record.** |
| **Judgment reducer** | `src/judgment-reducer.ts` | Folds turns → `settled / open_questions / next_actions / changed`, `refused_steps[]` with a `corrected` flag, evidence ref arrays. **This is SETTLED / SAFE_TO_CONTINUE.** |
| **Continuation capsule** | `src/continuation-capsule.ts` | The continuation/inheritance object. **This is `load_handoff` / safe-continuation state.** |
| **Proof bundle + pack IO** | `src/loop-proof-bundle.ts`, `src/proof-pack-io.ts` | The audit floor (receipts, digests, proof pack). Stays underneath; surfaced only via "verify proof." |
| **Supabase accumulation** | `src/push-pack.ts`, `src/destinations/supabase.ts` | Optional later: durable storage of witnessed handoffs. Not in the MVP. |

**Net-new (this is the actual build):**
1. **Capture the agent's CLAIM** (`record_claim`) — what the agent *says* it did — so it can be
   diffed against the already-resolved actual action. The actual side exists; the claim side does not.
2. **The witnessed-handoff schema + generator** — deterministic, with the trust labels from
   `THESIS.md` §7.
3. **The claimed-vs-actual diff** — compose the agent's claimed `{path, app, action, result}`
   against the witnessed `{path, app, action, result}` and emit `SUPPORTED` /
   `CLAIMED_ACTUAL_MISMATCH` / `UNSUPPORTED` / `NEEDS_EVIDENCE`.

## 2. MVP schema sketch (`witnessed-handoff/v1`)

Deterministic. No model calls in the MVP — labels are computed from the event sequence, which is
what makes them trustworthy (see thesis §6: witness, don't guess).

```jsonc
// handoff.json
{
  "schema": "witnessed-handoff/v1",
  "objective": "string (what the agent was asked to do)",
  "steps": [
    {
      "index": 0,
      "claimed":  { "system": "google_docs", "action": "create_document", "result": "created", "evidence_ref": null },
      "witnessed":{ "system": "zapier", "app": "google_docs", "action": "create_document",
                    "result": "created", "result_hash": "sha256:...", "wrapper_family": "zapier" },
      "labels": ["CLAIMED_ACTUAL_MISMATCH"],   // computed, deterministic
      "human_note": "Agent said it used Google Docs directly; it routed through Zapier."
    }
  ],
  "settled": [...], "open_questions": [...], "next_actions": [...],
  "needs_human_approval": [...], "do_not_re_litigate": [...],
  "safe_to_continue": true,
  "proof_refs": { "receipts": "optional", "bundle": "optional" }   // audit floor, optional in MVP
}
```

Label computation (deterministic rules, not judgment):
- `witnessed` missing for a `claimed` step → `UNSUPPORTED` + `NEEDS_EVIDENCE`.
- `claimed.system` ≠ `witnessed.system` (or claimed direct but `wrapper_family` present) → `CLAIMED_ACTUAL_MISMATCH`.
- `witnessed.result` is error/`returned:false` → `UNSUPPORTED` (+ `DO_NOT_SEND` if the step's output is user-facing).
- `claimed` and `witnessed` agree on system+action+result → `SUPPORTED`.
- Anything routed to a human → `NEEDS_HUMAN_APPROVAL` (the model never auto-decides this).

`HANDOFF.md` renders the same data in the §8 section order, plain-language. `next-ai-prompt.md`
is the §15 continuation prompt, parameterized with this run's settled/open/next.

## 3. The build loop (founder wants hands-off; this is the autonomy protocol)

Proven on the Stage D/E + Supabase gates. Each work item runs this loop **without the founder**,
hard-stopping only on the named conditions.

1. Develop on a `claude/*` branch in the witness home (never on `master`/`main`).
2. Build the smallest next slice. Tests first or alongside; keep it deterministic and offline.
3. Open a **ready-for-review** PR (never draft). Request Codex review at open.
4. CI green + Codex review clean → **merge and proceed to the next slice.**
5. Refresh the decision register / handoff as you go (dogfood the product on the build itself).

**HARD-STOP to the founder (use `AskUserQuestion`, do not guess) only for:**
- anything that would change receipt shape, signing, the verifier, canonicalization, or
  loop-close semantics in `lyhna-mcp-proxy` (these are frozen — the witness reads, never edits);
- the open forks the founder owns: **Fork 2 (first integration surface)** and **Fork 3 (name)**;
- promising anything beyond the V1 line (no "catches every hallucination", no real-world-outcome claims);
- anything that would reintroduce **authority / gating / permission** as a headline (thesis §12);
- storing raw customer content in the proof layer; handling secrets.

**Reviewer silence is a hard stop, not a substitution.** If Codex does not respond, report and
hold; do not merge on self-review.

## 4. Build order (slices)

1. **Schema + types** — `witnessed-handoff/v1` (json) and the label enum. Pure, tested.
2. **Deterministic generator** — event sequence → `handoff.json` + `HANDOFF.md` + `next-ai-prompt.md`,
   with the label rules in §2. Golden-file tests, including the Google-claimed/Zapier-witnessed mismatch.
3. **Claim capture shape** — `record_claim` input + the diff against a witnessed step. (Actual-side
   shape mirrors `wrapper-registry.ts` output; do not re-implement the registry — read it.)
4. **The brutal demo** — a runnable script that prints the §9 mismatch readout, non-technical-readable.
   This is the deliverable that proves the direction.
5. *(Only after 1–4 pass)* wire the generator to real witnessed events from the existing
   judgment-ledger / wrapper-registry path — still no proxy edits.

## 5. Guardrails (repeat, because the founder said it out loud)

- New spot only. Nothing in `lyhna-mcp-proxy/src` is edited by this build.
- Receipt shape, signing, verifier, canonicalization, loop-close: frozen.
- No authority / gating / permission headline. Witness, not gate.
- V1 promise is the ceiling: action-level witness + evidence-bound continuation. No truth oracle.
- Deterministic labels in the MVP. The trust is in *witnessing*, not in a model's opinion.
