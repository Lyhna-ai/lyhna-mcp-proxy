# Production Isolation — Deployment Requirement

This is a **deployment requirement**, not a fixture constraint. It is written here so
the requirement survives the first live test (Chione) and applies to every later
deployment of the adapter. Chione's throwaway environment is **not** required to
satisfy it; production deployments **are**.

## Why this exists

The adapter closes the loop on a **proxy-controlled** signal: `SIGTERM`. The governing
line is:

> The agent operates inside the loop; the PROXY boundary closes the loop on controlled
> shutdown (SIGTERM); Lyhna signs the proof.

The whole point of the loop-close is that the close is **not** the agent's own
declaration of completion. The terminal `loop_close` receipt seals the chain, and an
unsealed chain is detectable (`verifyLoopChain` rejects in-loop links with no terminal
close). That guarantee only holds if **the agent cannot forge, suppress, or trigger the
close**. Concretely the agent must not be able to:

- send `SIGTERM` / `SIGKILL` to the proxy process (forging or pre-empting the close, or
  killing the proxy before it can seal the chain);
- inspect or overwrite the loop identity (`LYHNA_PROXY_LOOP_ID`, `LYHNA_PROXY_GOAL`)
  or the bind credentials the proxy uses;
- share a process / signal domain with the proxy such that crashing the agent also
  tears down the proxy before `shutdown()` runs.

If the agent can do any of those, "the proxy closes the loop" collapses back into "the
agent closes the loop," which is exactly the property the design removes.

## The requirement

The proxy MUST be deployable under an **identity and PID namespace that the agent
runtime cannot signal or kill**. Recommended posture:

1. **Separate UID.** Run the proxy as a dedicated, unprivileged service user distinct
   from the agent's user. The agent's user must not be able to `kill(2)` the proxy
   (POSIX permits signalling only same-real/effective-UID processes, absent
   `CAP_KILL`).
2. **Separate PID namespace.** Run the proxy in its own PID namespace (or its own
   container / service unit) so the agent cannot even name the proxy's PID, let alone
   signal it. The agent's tools/call traffic reaches the proxy only over the MCP
   transport (stdio pipe or the Streamable HTTP URL), never via process control.
3. **Supervisor-owned shutdown.** `SIGTERM` is delivered by the **supervisor**
   (systemd, the container runtime, the orchestrator) — never by the agent. This is the
   controlled-shutdown signal that seals the loop. Loop teardown is therefore an
   infrastructure action, not an in-band agent action.
4. **Injected, not negotiated, loop identity.** `LYHNA_PROXY_LOOP_ID` and
   `LYHNA_PROXY_GOAL` (from which `goal_hash` is derived) are injected into the proxy's
   start environment by the supervisor. They are never read from agent-supplied request
   data, and the agent never sees the bind credentials (`LYHNA_PROXY_BIND_API_KEY`).
5. **Bind egress, not agent egress.** The proxy's path to `bind()` must be reachable
   from the proxy's network identity independent of the agent, so the agent cannot
   block the close POST by manipulating its own egress.

## The code seam (kept open, not foreclosed)

The adapter is written so this isolation is a drop-in, not a rewrite:

- **Loop identity is start-env only.** `loadLoopContextFromEnv()` reads the loop
  identity from the process environment at startup (`src/loop.ts`). It is never taken
  from MCP request payloads, so a different-UID supervisor can inject it and the agent
  cannot reach it.
- **Close is an OS signal, not an MCP message.** The close is triggered exclusively by
  `process.on("SIGTERM", …)` in the bin entrypoints (`src/bin/local-proxy.ts`,
  `src/bin/http-proxy.ts`). There is no in-band "close the loop" tool or request, so
  nothing on the agent's MCP channel can trigger or counterfeit it. `SIGINT` is treated
  as an abrupt interrupt and deliberately does **not** seal the chain.
- **`shutdown()` awaits the seal before teardown.** The signal handler runs
  `shutdown()` which `await`s `closeLoopWithRetry(...)` (the close POST, with grace-window
  retry) **before** closing the upstream and bind transports. Ordering is guaranteed by
  sequential `await`, and the process only exits in the handler's `.finally`.
- **No same-process assumption.** The proxy is a standalone process (per `AGENTS.md`
  design rules) and holds no reference to the agent process. Nothing in the code assumes
  shared UID, shared PID namespace, or shared lifecycle with the agent, so dropping it
  behind a namespace boundary requires no code change — only deployment configuration.

## Standing service: the control channel inherits this isolation

The standing service (one proxy, many sessions) replaces the per-process `SIGTERM` close
with a supervisor-only **control channel** (`src/control-channel.ts`) that emits
`open` / `close` per session. That channel is the standing-mode equivalent of the
`SIGTERM` trigger, and it inherits **exactly** the isolation described above:

- It is a **separate listener** from the agent-facing MCP transport — a unix-domain socket
  created owner-only (`0o600`) so a different-UID agent cannot `connect(2)` to it, or a
  loopback TCP fallback for platforms without unix sockets. The agent's MCP path
  (`/mcp/<session_id>`) has no open/close verb and never reaches it.
- It must run under the **supervisor identity**, on the supervisor side of the UID /
  PID-namespace boundary. The governed agent must not be able to speak `close` on it. If it
  could, the agent would close its own loop and the proof collapses — the same
  self-attestation failure the `SIGTERM` rules exist to prevent.
- `close` and the `SIGTERM` shutdown sweep are both supervisor actions. Loop teardown stays
  an infrastructure action, never an in-band agent action.

The deployable shape is therefore a standing HTTP service the supervisor starts (the agent
is never its spawner; it holds only a per-session URL), with the control channel bound to a
supervisor-owned socket. Under that posture the proxy can be dropped behind the UID /
PID-namespace boundary with no code change — only deployment configuration.

## What Chione's throwaway env does and does not need

For the first live test it is acceptable to run the proxy in the same environment as the
test harness; the loop mechanism, chained receipts, and sealed/unsealed verification are
all exercised there. The throwaway env is **not** expected to provide the UID / PID-
namespace separation above. Production deployment **is**: before any real-tenant,
production-bind use, the proxy must run under the isolated identity described here so the
loop-close remains a genuinely proxy-controlled signal.
