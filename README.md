# Lyhna Loop Proof Adapter for MCP

Point an agent runtime through Lyhna, run a loop, close it from the supervisor boundary,
export a proof bundle and graph node — and verify it cold.

This is the runtime adapter that places Lyhna in an MCP agent's execution path. The agent
talks MCP to the adapter exactly as it would to any upstream; the adapter routes each
`tools/call` through Lyhna's hosted `bind()` contract and forwards only when bind allows.
What the buyer receives is not the proxy itself — it is the **exported proof object**: a
portable, independently verifiable record that a loop ran and closed under authority.

> Permission grants access once. Lyhna attests authority every time.

**Have an API key already?** [`docs/QUICKSTART.md`](docs/QUICKSTART.md) is the ten-minute
path from key to capsule: one config block (or one `npx` command), a governed loop, and the
**capsule trio** out the other side —

- **THE CARD** (`proof-card.md`) — the human one-pager, sized to paste into a PR comment
  (`lyhna-mcp post --pr <n>` posts it with your own `gh` credentials);
- **THE HANDOFF** (`HANDOFF.md`) — the paste-ready continuation for the next agent session
  (`lyhna-mcp handoff` prints it), assembled from the sealed during-run judgment ledger —
  the agent cannot author its own report card;
- **THE SEED** (`memory-injection.json`) — the machine-ingestable handoff object.

CLI verbs (`npx -y @lyhna/mcp help`): the bare command starts the proxy (Streamable HTTP;
`stdio` for MCP client config blocks), `ctl` drives the supervisor control channel,
`export-pack` exports a closed loop's full pack in one command, `handoff` / `post` read an
exported pack, and `push-pack --pack <dir> --destination supabase` persists an exported pack
as ONE read-back-verified Supabase row — idempotent on `capsule_ref`, fail-closed on any
missing/malformed/mismatched artifact, and never required for export (proof generation stays
pure; see [docs/SUPABASE-DESTINATION.md](docs/SUPABASE-DESTINATION.md)).

**Two topologically distinct surfaces** (this separation is the whole point):

- **Agent path** — the agent holds only a per-session MCP URL (`/mcp/<session_id>`). It can
  list and call tools. It has **no** verb to open, close, or read a loop.
- **Supervisor control path** — a separate, owner-only channel that opens loops, closes them
  (sealing the proof), and dumps the sealed chain for export. The agent never reaches it. If
  the agent could close its own loop, "the proxy closes the loop" would collapse into "the
  agent closes the loop" — so the boundary is enforced by construction, not convention.

## Quick start — run the whole golden path locally

From a **repo checkout** (the demo is a development quick-start, not part of the published
package — `npm run demo` is supported only from a source clone, never from an installed
tarball):

```bash
git clone https://github.com/Lyhna-ai/lyhna-mcp-proxy
cd lyhna-mcp-proxy
npm install
npm run demo
```

`npm run demo` runs the complete adapter flow against the real product surfaces, with
nothing live: **start adapter → open loop → route a synthetic MCP call → supervisor closes
the loop → dump the sealed chain → export the LoopProofBundle → verify it cold** with the
standalone [`lyhna-verify`](https://github.com/Lyhna-ai/Lyhna-ai-lyhna-verify). It builds
`dist` on demand if missing from a checkout; from an installed package `npm run demo` is
unsupported and fails with Node's native module-not-found error (the demo script is not
published) — installed packages use the `lyhna-mcp` bin and the exported LoopProofBundle.

The demo is deliberately **synthetic and unsigned**: the receipts carry an obvious stub
signature, so the cold verify shows a **structural pass with crypto fail-by-absence**
(`all_receipts_verified:false`). That is the honest synthetic outcome — full-green *signed*
proof comes from the static signed corpus, guarded in CI. The demo never uses Chione,
Hermes, a live bind, or a production tenant.

To start the real standing adapter (it enters standing mode when a control channel is
configured), see [Standing Service Mode](#standing-service-mode-multi-session) and
[`RUNNING.md`](RUNNING.md).

---

## How it works (internals)

This project sits in front of upstream MCP servers, mirrors their tool surface, intercepts `tools/call`, routes the call through the existing hosted Lyhna `bind()` contract, and forwards upstream only when bind allows it.

Supported topologies:

- MCP client -> proxy over stdio -> upstream MCP over stdio
- MCP client -> proxy over Streamable HTTP -> upstream MCP over stdio
- MCP client -> proxy over stdio or Streamable HTTP -> upstream MCP over Streamable HTTP

## Status

Baseline proxy, Streamable HTTP server mode, multi-transport upstream support, the
loop-context adapter (loop-bound chained receipts with proxy-controlled close), the
standing multi-session service (session registry + supervisor-only control channel), and
the buyer-facing **LoopProofBundle** export are built and tested.

Current verification: 108 tests passing across 14 test files, plus the CI honesty guard
(typecheck, build, full suite, and cold-verify Leg 0 / Leg 1 / Leg 2 against the real
standalone `lyhna-verify`).

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

## Standing Service (multi-session)

The per-task topology above runs one loop per process, sealed on `SIGTERM`. The **standing
service** generalizes that to one long-lived proxy serving many concurrent sessions, each
with its own independent receipt chain. It is additive and composes the same
`LoopSession` spine — the bind contract, `prior_receipt_id` advance, and `verifyLoopChain`
are unchanged.

Two topologically distinct surfaces:

1. **Agent path — session-scoped MCP transport.** The supervisor hands each agent only a
   per-session URL: `http://<host>:<port>/mcp/<session_id>`. Every `tools/call` on that URL
   routes through the `LoopSession` the supervisor opened for `<session_id>`
   (`src/transport/standing-http.ts`). The agent can list and call tools; it has **no**
   open/close verb. A call for a session with no open loop fails closed.
2. **Control path — supervisor-only channel.** A separate listener
   (`src/control-channel.ts`) — a unix-domain socket created owner-only (`0o600`), or a
   loopback TCP fallback — emits `open` / `close` / `status` / `dump`. This is the **only**
   surface that opens or seals a loop. `loop_close` still rides `bind()` via
   `constraints.loop_close` exactly as in the per-task path. `dump` (keyed by `loop_id`) is
   read-only: it returns the loop's recorded receipt chain so the supervisor can package it
   — it never opens, closes, or mutates anything, and the agent path never reaches it.

**Receipt recording (the producer for export).** The standing service wraps its single
bind client in an **observe-only** receipt recorder (`src/receipt-recorder.ts`): every
receipt `bind()` returns — real signed receipts in `http` mode, synthetic unsigned ones in
`demo` mode — is captured in order, keyed by `loop_id`, and never mutated. After the
supervisor closes a loop, `dump` hands back that sealed chain, which is exactly the
`receipts.json` the export consumes. The proxy *proves*; the supervisor *packages*.

**Self-attestation guard (non-negotiable):** the control path sits on the supervisor side
of the UID / PID-namespace boundary and is never reachable on the agent's MCP path. If the
governed agent could close its own loop, "the proxy closes the loop" collapses back into
"the agent closes the loop." The agent is never the proxy's spawner — it holds only a URL —
which is what makes the Phase 5b kill-guard achievable. See
[`docs/PRODUCTION-ISOLATION.md`](docs/PRODUCTION-ISOLATION.md).

## Loop Proof Bundle (buyer-facing export)

`LoopProofBundle` (`src/loop-proof-bundle.ts`, CLI `src/bin/export-loop-proof.ts`) packages
a **sealed** loop receipt array into a portable, buyer-facing object that verifies
independently offline. It is **additive packaging only** — it never changes the receipt
shape, the proxy core, the `LoopSession` spine, the `bind()` contract, or `lyhna-core`.

**Side-car shape (the load-bearing choice):** the bare receipt array stays the loadable
top-level object (`receipts.json`), with the envelope alongside it (`bundle.json`). The
standalone, trust-no-one [`lyhna-verify`](https://github.com/Lyhna-ai/Lyhna-ai-lyhna-verify)
consumes `receipts.json` **unchanged** — `lyhna-verify --chain receipts.json` — with zero
verifier-side work.

The export writes four side-car files:

- `receipts.json` — the bare receipt array, byte-identical to input (the verifier input).
- `bundle.json` — the additive envelope: **trust-root pin** (`ed25519_public_key` +
  `key_id`), scheme/receipt version, export metadata (`exported_at`, `source_env`,
  `content_digest` = sha256 over `receipts.json`), and an **advisory** verdict (the
  verifier's own `--json` output, marked advisory — re-run to trust).
- `graph-node.json` / `graph-node.md` — the Authority Context Graph node (`id`, `loop_id`,
  `goal_hash`, `action_count`, sealed verdict, `scope`, trust root).

Buyer-facing invariants: **external scope only** (carries `tenant_hash`, never the internal
`tenant_id`; enforced fail-closed) and **content-blind** (`goal_hash` only, never the
plaintext goal). A real signed external loop chain packaged this way verifies full-green
cold under `lyhna-verify` (all signatures valid, sealed, exit 0) — the export does not
perturb an already-green chain.
