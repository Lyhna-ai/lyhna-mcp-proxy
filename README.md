# lyhna-mcp-proxy

Standalone Lyhna MCP proxy.

This project sits in front of upstream MCP servers, mirrors their tool surface, intercepts `tools/call`, routes the call through the existing hosted Lyhna `bind()` contract, and forwards upstream only when bind allows it.

Supported topologies:

- MCP client -> proxy over stdio -> upstream MCP over stdio
- MCP client -> proxy over Streamable HTTP -> upstream MCP over stdio
- MCP client -> proxy over stdio or Streamable HTTP -> upstream MCP over Streamable HTTP

## Status

Baseline proxy, Streamable HTTP server mode, multi-transport upstream support, and the
loop-context adapter (loop-bound chained receipts with proxy-controlled close) are built
and tested.

Current verification: 58 tests passing across 8 test files.

## Goals

- Keep Lyhna-core untouched
- Keep upstream MCP servers untouched
- Provide generic protocol-level interception
- Preserve payload identity exactly
- Fail closed on refusal, error, or ambiguity
- Support wrapper-family extraction without weakening baseline enforcement

## Non-Goals

- Forking or patching `lyhna-core`
- Embedding inside Chione or Hermes runtime
- Guessing operation identity from freeform text
- Mutating payloads to fit governance models

## Baseline Architecture

- Upstream MCP server(s)
- This proxy in the middle
- Hosted Lyhna `bind()` as external authority
- MCP client connects to this proxy instead of directly to the upstream server

Flow:

1. Client requests `tools/list`
2. Proxy mirrors upstream tools
3. Client calls `tools/call`
4. Proxy builds bind request from tool name and exact call arguments
5. Proxy calls hosted `bind()`
6. On APPROVED, proxy forwards the exact original call upstream
7. On ESCALATED, proxy holds and awaits resolution; forwards only if resolved to approved
8. On REFUSED or any error, proxy fails closed

## Repository Shape

- `src/` — proxy, bind client, classifiers, types
- `tests/` — unit and integration tests
- `AGENTS.md` — permanent repo orientation and hard invariants
- `RUNNING.md` — local standing-process startup instructions and bind safety rules

## First Build Target

Baseline generic MCP proxy is implemented:
- `tools/list` mirroring
- `tools/call` interception
- bind then forward
- exact payload preservation
- fail-closed enforcement
- upstream transport support for both stdio and Streamable HTTP

Wrapper-family registry is implemented:
- Zapier: matches `execute_zapier_*_action`, reads stringified-JSON arguments, extracts only `app` and `action`, and resolves action types such as `zapier.google_drive.folder`
- Apify: matches `call-actor`, reads plain-object arguments, extracts only `actor`, and resolves action types such as `apify.apify_hello-world`

Adding a new wrapper family should be a verified descriptor entry: tool-name matcher, argument reader, declared operation field paths, and action-type composer. It should not require new extraction logic.

## Loop-Context Adapter

This proxy is Lyhna's first runtime adapter: a reusable MCP execution-boundary surface
that governs tool calls with **loop-bound chained receipts**. It mirrors the loop
mechanism from `lyhna-bind/src/loop.ts` — additive `constraints.loop` merge,
`prior_receipt_id` chain advance, and a terminal `constraints.loop_close` field set —
client-side and additive, with the hosted `bind()` gate frozen. Chione is the first live
test of it; the adapter is designed to outlive that test.

Governing line: **the agent operates inside the loop; the PROXY boundary closes the loop
on controlled shutdown (SIGTERM); Lyhna signs the proof.**

When a loop is configured (`LYHNA_PROXY_LOOP_ID` + `LYHNA_PROXY_GOAL`, injected via the
start environment; the proxy derives `goal_hash = sha256(utf8(goal))` hex, matching the
canonical `@lyhna/bind` loop chain):

1. **Loop-context threading.** Every intercepted `tools/call` bind is stamped with
   `constraints.loop { loop_id, prior_receipt_id, goal_hash }`, merged additively over
   any caller constraints (never clobbering server-appended fields). `prior_receipt_id`
   advances to `receipt.receipt_id` after each bind; the root prior is `null`. Any
   caller-supplied `authority_tier` is stripped — the server resolves authority.
2. **Terminal close on shutdown.** On `SIGTERM` the proxy emits a `loop_close` bind
   carrying `constraints.loop_close { loop_id, goal_hash, action_count, outcome,
   prior_receipt_id, termination_reason }` **before** the upstream/bind transport is
   closed. `SIGTERM` is the only close trigger; there is no idle timeout. `SIGINT` is an
   abrupt interrupt and does not seal the chain.
3. **Grace window + retry.** `shutdown()` awaits the close POST and retries within a
   grace window (`LYHNA_PROXY_LOOP_CLOSE_GRACE_MS`, default 5000ms); if it ultimately
   fails the chain is left unsealed (detectable per item 5).
4. **Concurrency mutex.** The read-prior → bind → set-prior sequence is serialized in
   `LoopSession` so concurrent `tools/call` cannot fork the chain.
5. **Unsealed-chain detection.** `verifyLoopChain` rejects a chain that has in-loop links
   but no terminal `loop_close` (and rejects broken `prior_receipt_id` continuity,
   loop_id mismatch, a non-terminal or duplicated close, or an `action_count` that
   disagrees with the in-loop link count).
6. **Production isolation.** The proxy must run under an identity / PID namespace the
   agent cannot signal or kill, so the close stays genuinely proxy-controlled. This is a
   deployment requirement — see [`docs/PRODUCTION-ISOLATION.md`](docs/PRODUCTION-ISOLATION.md).
   The code seam (start-env loop identity, OS-signal close, standalone process) is kept
   open for it; Chione's throwaway env is not required to satisfy it.

When no loop is configured, the proxy behaves exactly as the baseline bind gate.
