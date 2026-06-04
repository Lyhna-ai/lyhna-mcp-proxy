# Running The Local Proxy

## Safety Rule

The standing proxy defaults to a stub bind client. It must not call production `api.lyhna.com` or use a production tenant during local deployment shakeout.

Production bind is a deliberate later switch, not a default. Production receipts are append-only; a stray call during startup testing would become permanent.

## Bind Modes

Default mode:

```text
LYHNA_PROXY_BIND_MODE=stub
LYHNA_PROXY_STUB_OUTCOME=REFUSED
```

Allowed stub outcomes:

```text
APPROVED
REFUSED
ESCALATED
```

Real HTTP bind mode is guarded and requires all of:

```text
LYHNA_PROXY_BIND_MODE=http
LYHNA_PROXY_ALLOW_REAL_BIND=true
LYHNA_PROXY_BIND_URL=<non-production bind URL>
LYHNA_PROXY_BIND_API_KEY=<dev tenant key>
```

If `LYHNA_PROXY_BIND_URL` points at `https://api.lyhna.com`, startup refuses unless this explicit production cutover flag is also set:

```text
LYHNA_PROXY_ALLOW_PRODUCTION_BIND=true
```

Do not set that flag during local shakeout.

## Local Reference Upstream

The default upstream is the local reference MCP server in `tests/fixtures/reference-upstream-mcp-server.ts`. It exposes:

- `echo`
- `read_count`

You can start that upstream directly for manual MCP-client inspection:

```powershell
npm.cmd run start:upstream
```

The proxy also spawns this same upstream internally by default, because stdio MCP upstreams are process-bound.

## Start The Proxy

Start the standing stdio proxy with the default fail-closed stub bind:

```powershell
npm.cmd run start:proxy
```

Start it with local stub approval so calls forward to the local reference upstream:

```powershell
$env:LYHNA_PROXY_STUB_OUTCOME='APPROVED'
npm.cmd run start:proxy
```

Start it with local stub escalation:

```powershell
$env:LYHNA_PROXY_STUB_OUTCOME='ESCALATED'
npm.cmd run start:proxy
```

## Streamable HTTP Mode

Chione connects to remote URL-based MCP servers over Streamable HTTP. The proxy can run in that mode as a local URL server while still using the same bind gate and upstream forwarding path.

HTTP mode defaults to:

```text
transport: mcp.client.streamable_http
url: http://127.0.0.1:8765/mcp
bind: stub:APPROVED
upstream: @modelcontextprotocol/server-filesystem
allowed filesystem root: C:\Users\Adam\lyhna-mcp-proxy
```

Start the HTTP proxy:

```powershell
npm.cmd run start:proxy:http
```

Chione should point at:

```text
url: "http://127.0.0.1:8765/mcp"
transport: "mcp.client.streamable_http"
```

You can override the bind stub outcome for hold/fail-closed testing:

```powershell
$env:LYHNA_PROXY_STUB_OUTCOME='ESCALATED'
npm.cmd run start:proxy:http
```

Do not set `LYHNA_PROXY_BIND_MODE=http` or any production bind flags during this transport proof. HTTP proxy mode is only proving URL connectivity; production bind remains a deliberate later cutover.

## Direct Remote Upstream Mode

The proxy can now connect to an upstream MCP server over Streamable HTTP instead of spawning an stdio child process. This is the topology needed when the upstream is already published as a URL-based MCP server.

Set:

```powershell
$env:LYHNA_PROXY_UPSTREAM_MODE='streamable_http'
$env:LYHNA_PROXY_UPSTREAM_URL='https://example-mcp-server.test/mcp'
```

Optional explicit upstream headers:

```powershell
$env:LYHNA_PROXY_UPSTREAM_HEADERS_JSON='{"Authorization":"Bearer <token>"}'
```

Then start either proxy surface:

```powershell
npm.cmd run start:proxy
```

or

```powershell
npm.cmd run start:proxy:http
```

The bind gate still runs locally in front of that remote upstream. Only the upstream transport changes.

## Loop-Context Mode

The proxy can thread a Lyhna loop through every bind and seal it on controlled shutdown.
Loop identity is injected via the **start environment** (never from agent request data):

```text
LYHNA_PROXY_LOOP_ID=<loop id for this run>
LYHNA_PROXY_GOAL=<raw goal string for this run>
```

Both must be set together, or startup refuses. When unset, the proxy runs as the plain
bind gate (no loop threading). `goal_hash` is derived from the raw goal as
`sha256(utf8(goal))` hex (no trimming/normalization), matching the canonical
`@lyhna/bind` loop chain; it is carried in `constraints.loop` on every link.

While the loop is active, every `tools/call` bind is stamped with
`constraints.loop { loop_id, prior_receipt_id, goal_hash }` and the receipt chain
advances per call. On `SIGTERM`, the proxy emits a terminal `loop_close` bind
(`constraints.loop_close { … }`) **before** tearing down the upstream/bind transport.
`SIGTERM` is the only close trigger; `SIGINT` (Ctrl-C) does not seal the chain.

Optional grace-window tuning for the close POST:

```text
LYHNA_PROXY_LOOP_CLOSE_GRACE_MS=5000   # total retry budget for the close POST
LYHNA_PROXY_LOOP_CLOSE_RETRY_MS=250    # delay between retries
```

If the close POST ultimately fails within the grace window, the chain is left
**unsealed** on purpose; `verifyLoopChain` detects that an in-loop chain has no terminal
`loop_close`.

> Production deployments must run the proxy under an identity / PID namespace the agent
> cannot signal or kill, so the `SIGTERM` close stays proxy-controlled. See
> `docs/PRODUCTION-ISOLATION.md`.

## Standing Service Mode (multi-session)

The HTTP proxy enters **standing mode** when a control-channel address is configured. One
process then serves many concurrent sessions, each routed by a session id in the URL path.
Loops are opened and closed ONLY through the supervisor control channel — never by the
agent.

Start it with a supervisor-only unix-domain control socket (preferred):

```text
LYHNA_PROXY_CONTROL_SOCKET=/run/lyhna/control.sock   # owner-only (0600) unix socket
LYHNA_PROXY_HTTP_PORT=8765                            # agent-facing MCP port
```

Or a loopback TCP control port (weaker isolation; any same-host process can reach it):

```text
LYHNA_PROXY_CONTROL_PORT=8790
LYHNA_PROXY_CONTROL_HOST=127.0.0.1
```

The agent is handed only a per-session URL:

```text
http://127.0.0.1:8765/mcp/<session_id>
```

The supervisor drives the control channel with newline-delimited JSON, one command per
line:

```text
{"cmd":"open","session_id":"s1","loop_id":"loop_s1","goal":"<raw goal>"}
{"cmd":"status"}
{"cmd":"close","session_id":"s1","outcome":"COMPLETED","reason":"task_done"}
```

`open` must precede the agent's first `tools/call`; a call for a session with no open loop
fails closed. `close` seals the chain (terminal `loop_close`) and removes the session.
`SIGTERM` is a supervisor signal and seals any still-open loops on shutdown; `SIGINT` does
not seal.

> The control channel inherits the SIGTERM isolation requirement: it must be reachable
> only by the supervisor identity, never by the governed agent. See
> `docs/PRODUCTION-ISOLATION.md`.

## Confirm It Mirrors Upstream Tools

This command starts a temporary proxy process with stub `APPROVED`, connects as an MCP client, lists tools, prints the result, and exits:

```powershell
npm.cmd run inspect:proxy
```

Expected tool names:

```text
echo
read_count
```

Confirm Streamable HTTP mode against the real filesystem MCP server:

```powershell
npm.cmd run inspect:proxy:http
```

Expected real filesystem tool names include:

```text
read_file
read_text_file
list_directory
directory_tree
search_files
list_allowed_directories
```
