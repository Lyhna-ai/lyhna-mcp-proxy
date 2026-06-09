# Lyhna Product Thesis: From Agent Runs to Verified Judgment Capsules

## The Problem

AI agents are moving from one-shot answers into long-running loops.

They do not just answer a question anymore. They plan, edit, retry, inspect, call tools, revise, correct themselves, and hand work to the next agent. A single run may contain 20, 30, or 100 consequential decision turns before it produces the final deliverable.

The final output is not enough.

A transcript is too messy. A log is too low-signal. A progress note is written after the fact. A harness check may tell you whether something passed, but it does not give the next agent a compact, verified route of how the work actually got there.

The missing object is not another dashboard, permission gate, or tool-call log.

The missing object is a verified record of the judgment path that produced the work.

## What Lyhna Builds

Lyhna turns an autonomous agent loop into a verified judgment capsule.

It captures consequential judgment turns while the loop is happening, then emits a portable capsule that the next agent, human, or memory/context system can inherit.

A judgment turn is the basic unit:

```text
inherited state -> proposed next move -> verdict -> resulting state delta
```

One agent run is not “30 tool calls.”

It is 30 judgment turns chained together.

Each turn records:

- what state this step inherited
- what the agent proposed to do next
- whether that move reconciled with the declared loop state
- the verdict that resolved the move: approved, escalated (held), or refused
- what receipt, event, or result anchor proves that verdict
- what changed because of that turn
- what the next turn should inherit

The value is not that Lyhna captures one decision at the beginning or summarizes one result at the end.

The value is that Lyhna captures the chain of decisions before they become stale memory.

Thirty captured judgment turns during execution are more valuable than one summary after the loop has already finished.

## The Product Object

At loop close, Lyhna emits a capsule package:

- Proof Card
- `receipts.json`
- `bundle.json`
- `graph-node.json`
- `graph-node.md`
- `judgment-ledger.json`
- `judgment-ledger.md`
- Continuation Capsule / verified-context sidecar
- `memory-injection.json`
- cold verification instructions

(`judgment-ledger.*` and `memory-injection.json` are what Gate 2 adds; the rest ship today.)

The important part is not the file list.

The important part is that the capsule is built from the live judgment chain, not reconstructed afterward from a transcript.

The next agent should not inherit a giant conversation history. It should inherit a compact verified state object:

```text
prior capsule / scope_ref
prior receipt_id
final judgment turn ref
settled decisions
open questions
refusals / corrections
current allowed lane
what changed since last step
next permitted continuation
proof refs
```

That is what makes the next run cleaner.

The next agent starts from the verified capsule instead of transcript sludge.

## What Exists Now

Capsule Gate 1 established the foundation.

The current system can:

- open a loop with a sealed Scope Capsule
- constrain the loop against that scope
- capture in-lane actions
- refuse and attest out-of-lane actions
- close the loop through the supervisor boundary
- export a Continuation Capsule and LoopProofBundle

The current spine is:

```text
Scope Capsule
  -> governed loop
  -> scope/refusal events
  -> supervisor close
  -> Continuation Capsule + LoopProofBundle
```

That is pointed at the right product.

The missing product layer is the middle:

```text
Scope Capsule
  -> Judgment Ledger Reducer
  -> Continuation Capsule
```

Right now, the system has the bookends and the receipt spine. The next build adds the middle layer that records and folds every consequential decision turn into the final capsule.

## What Is Missing

The next gate should add the Judgment Ledger Reducer.

This is not a new permission system. It is not a dashboard. It is not a full IJL. It is not a memory product.

It is the layer that turns live verdicts into a portable capsule.

During the run, the reducer records each judgment turn:

```text
agent proposes next consequential move
  -> adapter derives structural descriptor
  -> scope/bind resolves verdict
  -> judgment turn is appended
  -> receipt/event/result refs anchor it
  -> reducer updates current loop state
  -> next turn inherits prior judgment ref
```

At close, the reducer folds those turns into the final capsule:

```text
settled decisions
open questions
next actions
refused/corrected steps
proof refs
final_turn_ref
memory-injection object
```

That is the product layer.

It turns the loop from “something an agent did” into “a verified judgment path another system can inherit.”

## Guardrails

Lyhna captures the judgment-of-record, not the agent’s private cognition.

It does not claim to know what the agent believed. It records what the agent proposed, what structural lane that proposal cited, what verdict resolved, and what proof anchors that verdict.

The capture surface is the consequential move — the point where a proposal meets a structural boundary and a verdict resolves. Deliberation that never reaches that boundary is out of scope by design. That boundary is not a limitation to apologize for; it is exactly what keeps the record structural, attestable, and content-blind.

Lyhna also does not judge whether the agent made a good business or creative decision. “Correct” means reconciled with the declared scope, prior receipt, and loop state. It does not mean “wise,” “optimal,” or “true in the world.”

Runtime results may be hashed and linked, but not interpreted.

Supervisor-declared deltas may appear in Verified Context Mode, but plaintext deltas must never enter bind, core, gate, signing, or canonicalization.

Proof Mode remains structural and content-blind.

## Why This Matters

Every serious agent platform is moving toward longer loops.

Longer context windows do not solve the problem. They often create more accumulated slop.

The real question is not whether an agent can keep more tokens in context.

The real question is whether the agent can preserve a clean line of judgment through many consequential turns.

Lyhna gives that line.

It answers:

- how did this agent produce this deliverable?
- what had to be true at each step?
- where did the loop continue?
- where did it refuse?
- where did it correct?
- what state should the next agent inherit?

That is the difference between a transcript and a verified capsule.

## Customer Value

For an operator:

> Do not make me watch every agent step, and do not hand me a giant mess afterward. Give me the verified path the agent took and the state the next agent should continue from.

For a developer:

> Stop making my next agent re-read the whole thread and re-decide settled work. Give it the capsule.

For a team:

> Turn every agent loop into a reusable memory object, not a disposable transcript.

For an enterprise:

> Over time, these capsules become the institutional record of how autonomous work is actually decided and delivered.

## Product Sentence

Lyhna captures the judgment path of an agent loop before it becomes memory.

## Buyer Sentence

Stop handing your next agent a transcript. Hand it the verified judgment ledger of the run.

## Build Target

The next build target is:

**Capsule Gate 2: Judgment Ledger Reducer**

The goal:

A real multi-step loop captures each consequential judgment turn during the run, folds those turns into a final Continuation Capsule, and emits a portable memory-injection object that another agent or context system can inherit.

The proof of success:

A deterministic loop runs through multiple steps. Lyhna captures the ordered judgment turns. One step is refused or corrected. Approved steps anchor to receipts. Refused scope steps anchor to events. Runtime results are hashed but not interpreted. Supervisor-declared deltas attach only in Verified Context Mode. Proof Mode remains content-blind. The final export includes the judgment ledger and memory-injection object. Cold verification still passes.

The memory-injection object is inheritance-ready by construction. The immediate payoff — and the very next proof to stand up — is a second loop that opens from this object and begins from the settled decisions instead of re-reading the transcript. Gate 2 produces the object; that second-loop handoff is what makes the object pay. Build the object here; prove the handoff next.

No `lyhna-core` changes. No `lyhna-verify` changes. No canonical receipt shape changes. No signing or canonicalization changes.

## Final Frame

Lyhna is not trying to own the customer’s memory system.

Lyhna emits the object their memory system wants.

The customer keeps their context graph wherever they want.

Lyhna gives them a verified capsule made from the agent’s actual judgment path.

One loop creates one sealed judgment capsule.

Many capsules compound into the IJL.

That is the business.

That is the product.

That is what we build next.
