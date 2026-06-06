# Live-Bind Gate

The Live-Bind Gate is the **inverted-honesty** counterpart to the existing cold-verify legs.
Where Leg 1 asserts synthetic material must **not** verify as signed, this gate asserts a
**real, live Chione/Hermes loop — sealed through the hosted Lyhna bind — MUST verify full
green cold** with genuine Ed25519 signatures. It is the live positive control.

This document is the runbook (how to run it) **and** the status of record (what is, and is
not, done). Nothing here fabricates a live artifact: the gate is fail-closed until a genuine
hosted-bind capture exists.

---

## Boundary (load-bearing — do not cross)

The adapter is a client-side, additive loop-threading proxy. The gate does **not** change
that:

- The adapter **never holds signing keys.** It forwards a bind request to the hosted Lyhna
  tenant over HTTP with a Bearer API key; **signing is server-side.** Receipts are captured
  by the observe-only recorder, never minted locally.
- **No changes** to `lyhna-core`, to the receipt shape, to signing semantics, or to verifier
  semantics.
- `lyhna-verify` is used **read-only** (cloned in CI, never vendored, never modified).
- The **agent path has no close verb.** Loops are opened/closed only on the supervisor
  control channel — enforced topologically (the MCP transport never reaches
  `openLoop`/`closeLoop`). See `src/session-registry.ts` and the `agent-cannot-close` test in
  `tests/standing-service.test.ts`.

## Close design (hybrid; first-writer-wins)

- **Explicit** supervisor/orchestrator close is **authoritative** for the terminal outcome.
- Supervisor-owned **SIGTERM** is the **fail-safe** seal (the adapter's `closeAll`).
- **First writer wins**, exactly one terminal receipt, no open-loop leak. This is already
  enforced at the registry seam: `closeLoop` claims an in-flight close synchronously before
  the first await (so an explicit close coalesces with a racing SIGTERM sweep), and a sealed
  session is deleted (so a later sweep never re-seals it). `LoopSession.close()` additionally
  short-circuits on an already-sealed session (defense-in-depth), so the invariant is local to
  the session, not solely a registry property.

These behaviors are locked by `tests/session-registry-close-race.test.ts` (characterization)
and `tests/loop.test.ts` ("close() is idempotent…", a true red-green).

---

## Runtime facts (this gate)

| Field | Value |
| --- | --- |
| Lyhna hosted tenant id | `tenant_d04579fbbb4a` |
| Hermes/runtime tenant label | `dolios` (runtime metadata only — **not** a competing Lyhna tenant) |
| Agent | Chione |
| Account | `chione@keryke.com` |
| Hermes Agent version | `v0.15.2 (2026.5.29.2)` |
| MCP path | existing Hermes **URL-based HTTP MCP** server config → Lyhna standing HTTP MCP adapter |

Out of scope for this gate (future distribution/runtime options, **not** dependencies): the
Hermes `codex_app_server` runtime, OpenAI/Codex bundled plugins, and the Codex plugin
migration. Chione stays release-current on Hermes `v0.15.2` and uses the existing URL MCP path.

---

## WS-B — Live-bind config (adapter, supervisor-side)

Start the **standing** adapter in `http` bind mode against the hosted tenant. The adapter
holds the **API key only** (for the bind POST); it never holds signing keys.

```sh
# Supervisor-side environment (NOT exposed to the agent):
export LYHNA_PROXY_BIND_MODE=http
export LYHNA_PROXY_BIND_URL=<hosted bind endpoint for tenant_d04579fbbb4a>
export LYHNA_PROXY_BIND_API_KEY=<hosted API key>          # never committed; bind-only
export LYHNA_PROXY_ALLOW_REAL_BIND=true                   # explicit opt-in (defaults to stub)
# (LYHNA_PROXY_ALLOW_PRODUCTION_BIND=true only for a deliberate api.lyhna.com cutover)

# Standing mode is selected by configuring a control listener:
export LYHNA_PROXY_CONTROL_SOCKET="$PWD/.lyhna-control.sock"   # owner-only unix socket
# Upstream = whatever real MCP server the loop governs (stdio or streamable_http).

npm run adapter
# stderr prints: agent MCP=http://127.0.0.1:<port>/mcp/<session_id>; control=unix:...; bind=http:...
```

The `dolios` runtime label and Chione/Hermes account are **agent/runtime** metadata; the
adapter authenticates to Lyhna as `tenant_d04579fbbb4a`. They are not threaded as a Lyhna
tenant by the adapter.

## WS-A — Live run (supervisor capture driver)

With the adapter running and **Chione (Hermes URL MCP server)** pointed at the printed
per-session URL, run the supervisor capture driver. It connects to the **control channel
only** and performs open → (agent drives) → **explicit authoritative close** → dump → export.

```sh
export LYHNA_PROXY_CONTROL_SOCKET="$PWD/.lyhna-control.sock"   # same socket as the adapter
export LYHNA_BIND_GATE_LOOP_ID=$(uuidgen)                      # fresh, single-use
export LYHNA_BIND_GATE_GOAL="<the loop goal>"
# optional: LYHNA_BIND_GATE_SESSION_ID, _OUTCOME (default COMPLETED), _REASON, _OUT

npm run capture:live
```

The driver writes the exported artifacts to `tests/fixtures/live/chione-hermes/`:
`receipts.json`, `bundle.json`, `graph-node.json`, `graph-node.md`. SIGTERM on the adapter is
the fail-safe seal if the explicit close never runs — the gate's no-leak guarantee holds either
way.

## WS-C — Capture + Leg 3

The captured `receipts.json` **is** the live positive-control fixture — exported from the
ACTUAL sealed live run, never reconstructed. CI Leg 3 (`scripts/verify-legs.mjs`) then asserts,
cold, against the independent `lyhna-verify`:

- the receipts are **Ed25519-shaped** (32-byte hex public key + signature) — if not, Leg 3
  **stops and reports the mismatch** rather than adapting around it;
- the chain verifies **FULL GREEN** (exit 0, `status: VERIFIED`, `sealed: true`,
  `all_receipts_verified: true`);
- `bundle.json`'s `content_digest` matches `sha256(receipts.json bytes)` (digest match).

Until the fixture exists, **Leg 3 is fail-closed and reds the gate** with `PENDING LIVE
CAPTURE`. That red is correct: the gate is green only with a genuine live capture.

## WS-D — Cross-repo cold verify + persistence

- Cold-verify the exported bundle independently:
  `node <lyhna-verify>/bin/lyhna-verify.mjs --chain tests/fixtures/live/chione-hermes/receipts.json --json`
  → expect `status: VERIFIED`, `sealed: true`, `all_receipts_verified: true`.
- Optional: confirm Supabase persistence/readback for `tenant_d04579fbbb4a`. **CI must not
  depend on live Supabase or on the hosted bind** — this is an out-of-band confirmation only.

---

## Status of record

**Done on this branch (no live access required):**

- Idempotent `LoopSession.close()` guard + true red-green test (`tests/loop.test.ts`).
- Three characterization close-race tests (`tests/session-registry-close-race.test.ts`).
- Leg 3 added to `scripts/verify-legs.mjs`, fail-closed and Ed25519-asserting.
- Supervisor capture driver (`scripts/live-bind-capture.mjs`, `npm run capture:live`).
- This runbook.

**Blocked — requires live hosted access (cannot be produced in a sandbox without it):**

| Required output | Status |
| --- | --- |
| Sealed live `loop_id` | ⛔ pending live run |
| `tests/fixtures/live/chione-hermes/receipts.json` | ⛔ pending live capture |
| `bundle.json` / `graph-node.json` / `graph-node.md` | ⛔ pending live capture |
| Cold verification full-green output | ⛔ pending live capture |
| Leg 3 GREEN in the CI guard | ⛔ fail-closed (`PENDING LIVE CAPTURE`) until captured |
| Supabase readback for `tenant_d04579fbbb4a` | ⛔ optional, pending live access |

The blocker is environmental: no `LYHNA_PROXY_BIND_*` credentials, no Hermes/Chione runtime,
and no egress to the hosted bind are available in the build sandbox. Per the gate's own rule,
the live legs are **reported, not fabricated**. To finish: run WS-B → WS-A on a host with
hosted-tenant access and a live Chione/Hermes agent, commit the captured fixture, and Leg 3
goes green.
