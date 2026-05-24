# AGENTS.md

## Purpose

This repository is a standalone Lyhna MCP proxy.

It exists to sit in front of upstream MCP servers, mirror their tool surfaces, intercept `tools/call`, route the call through the existing hosted Lyhna `bind()` contract, and then forward or fail closed based on the bind result.

This repository is intentionally separate from:
- `lyhna-core`
- Chione / Hermes runtime
- any tenant runtime state

It may read those systems as reference material only. It must not depend on them to run.

## Hard Invariants

### Invariant 1: Never Modify lyhna-core

Do not edit, patch, vendor, or quietly depend on changes inside `lyhna-core`.

This proxy is additive. If the desired behavior would require changing Lyhna-core, stop and surface that constraint to the user explicitly.

### Invariant 2: Preserve Action Payload Identity Exactly

The action payload that is bound is the action payload that is forwarded.

For this repository, the action payload means:
- the upstream MCP tool name
- the upstream MCP arguments

Classification, extraction, and canonical action identity may be computed from a copy of the call data, but that metadata must never feed back into or mutate the forwarded upstream call.

The forwarded arguments must remain semantically identical to what was bound.

This invariant governs the action payload only. It does not require preserving unrelated transport mechanics such as request IDs, connection state, or proxy-local metadata.

### Invariant 3: Bind Must Resolve Before Forwarding

`bind()` must complete with an allowing outcome before any upstream tool execution is forwarded.

No optimistic forwarding.
No parallel "bind while executing."
No speculative execution.
No cached approval reuse across materially different calls.

If bind does not complete cleanly with an allowing outcome, the proxy fails closed.

APPROVED means forward. ESCALATED means hold and await human resolution — do not forward until the escalation resolves to approved. REFUSED means never forward. ESCALATED is not a forwardable state on its own; treating it as one defeats the hold-and-resolve mechanism and violates this invariant.

## Design Rules

- The proxy is a separate process.
- Lyhna `bind()` remains the existing hosted contract.
- The gate stays pure; this repo does not reimplement Lyhna-core.
- Fail closed on bind refusal, bind error, timeout, or ambiguous enforcement state.
- Do not guess hidden intent from freeform text.
- Prefer declared tool identity first, then structured argument extraction.
- Wrapper-family extraction is allowed only from stable structured fields.
- If a server is opaque, bind at wrapper granularity or escalate; never invent precision.
- Preserve upstream MCP compatibility as much as possible.
- Keep transport/proxy logic separate from bind-client logic.
- Keep classification logic separate from forwarding logic.
- Keep canonicalization metadata separate from forwarded call payloads.

## Contract Verification

The `@lyhna/bind` request shape used in this repo must be verified against the actual hosted contract before the real bind client is built. The locked contract is strict four-field: `action_type`, `action_payload`, `intent`, `intent_version`. The caller must NOT supply `authority_tier` — the server resolves it. Any `action_payload` sub-shape or optional `metadata` field in the scaffold is a placeholder and must be confirmed against the real package, not assumed.

## Constraint Handling

If any requirement, time pressure, or technical constraint would force a bad design, surface it to the user instead of coding around it badly.

Examples:
- a request would require mutating payloads after bind
- a request would require patching lyhna-core
- a request would require guessing operation identity from prose
- a request would silently weaken fail-closed behavior
- a request would blur proxy enforcement with business-specific shortcuts

In those cases:
- stop
- explain the constraint plainly
- propose the narrowest correct alternative

## What This Repo Should Build

Baseline scope:
- mirror upstream MCP `tools/list`
- intercept upstream MCP `tools/call`
- construct bind request from tool name + arguments
- call hosted `bind()`
- forward exact call only when allowed
- fail closed otherwise

Later scope:
- structured wrapper-family extractors
- canonical action metadata
- observability and audit surfaces
- server-family fixtures and conformance tests

## What This Repo Should Not Become

- not a fork of Hermes
- not a patch layer inside Chione
- not a rewrite of Lyhna-core
- not a policy engine that hides uncertainty by guessing
- not a convenience layer that trades away payload integrity

## Working Style

Prefer small, auditable components:
- transport adapter
- upstream MCP client
- bind client
- classifier/extractor
- enforcement decision layer
- tests

Favor explicitness over magic.
Favor fail-closed over silent fallback.
Favor surfaced constraints over fragile cleverness.

## Roadmap

### Execution Correlation (post-Phase-1)

Extend the proxy to make the authorization → execution → reported-result chain first-class, as a linked pair rather than a single authorization point.

Mechanism:
- Issue a correlation token at bind time, tied to the authorization receipt (receipt_id is the spine). Nothing forwards without it.
- After forwarding an APPROVED call, capture the runtime's returned result, hash it, and submit a linked completion record bound to the authorization by the token.
- The pair (authorization receipt + completion record, joined by the token, each signed and hashed) is the artifact. It proves the authorized action and the executed call are the same transaction, and captures the runtime's reported result as signed, attributable evidence.

CONSTITUTIONAL LIMIT (do not violate):
- The proxy RECORDS the runtime's reported result, hashed, WITHOUT interpreting, evaluating, or verifying its truth.
- No success-judgment logic in the proxy. No "did it work" evaluation. Record, hash, link — never judge.
- Lyhna proves LINKAGE and PROVENANCE (authorized → executed → reported), NEVER that the real-world effect actually occurred. If a runtime misreports, the misreport is recorded faithfully and attributably; Lyhna proves "the runtime claimed X," not "X is true."
- This is the same declared-not-detected line as Invariant 2: record what crossed the boundary, do not infer.

Why it matters:
- Replaces the manual honesty-clause workaround (forcing the agent to self-report true runtime state) with automatic, cryptographic capture of the runtime's actual return.
- Exposes the gap between an agent's belief ("sent") and what happened ("draft created") as a recorded discrepancy in a signed pair, not something that must be interrogated out of the agent.
- Gives the IJL authorization-vs-completion correspondence as a richer judgment signal ("authorized as X, completed as Y" = measurable drift).

Sequencing: build AFTER baseline Phase 1 (intercept → bind → forward). The completion record hangs off the proxy — you must be the thing forwarding the call before you can record what came back. Do not build before Phase 1.

May touch the hosted bind contract (formalizing receipt_id as the execution token, adding a linked completion record type). That is a deliberate, additive contract decision — flag it; it is not a change to how authorization logic works, and it is not a Lyhna-core logic change.
