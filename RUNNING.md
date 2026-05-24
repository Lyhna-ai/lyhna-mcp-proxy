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
