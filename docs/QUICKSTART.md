# Quickstart — from an API key to your first capsule

This is the stranger path: you have a Lyhna API key (created at lyhna.com — shown once,
keep it safe) and a machine with **Node 20+**. Ten minutes from here you hold the capsule
trio for a loop your own agent ran:

- **THE CARD** — `proof-card.md`: the one-pager you paste into a PR or Slack.
- **THE HANDOFF** — `HANDOFF.md`: the paste-ready continuation for your next agent session.
- **THE SEED** — `memory-injection.json`: the machine-ingestable version for a harness/memory system.

All three are folded from the loop's sealed, during-run judgment ledger and anchored to
signed receipts — the agent cannot author its own report card. Anyone can verify the pack
offline: `npx -y lyhna-verify --chain receipts.json`.

Two keys, never conflated: your **API key** (`LYHNA_API_KEY`) is a Bearer credential that
authenticates your tenant to the hosted gate. The **Ed25519 signing key** that signs
receipts never leaves Lyhna's servers — only its public half travels, embedded in each
receipt so verification needs no Lyhna account and no network.

> No key yet? Every command below also runs fully offline with
> `LYHNA_PROXY_BIND_MODE=demo` instead of `LYHNA_API_KEY` — same flow, same artifacts,
> but the receipts are deliberately **unsigned** and `lyhna-verify` will honestly report
> `all_receipts_verified: false`. Real signatures come from the hosted gate.

---

## Path A — one config block (Claude Code or any MCP client)

Wrap an MCP server you already use with the Lyhna gate by changing only its config block.
Example: `.mcp.json` in a Claude Code project, governing the filesystem server:

```json
{
  "mcpServers": {
    "filesystem-governed": {
      "command": "npx",
      "args": ["-y", "@lyhna/mcp", "stdio"],
      "env": {
        "LYHNA_API_KEY": "<your key>",
        "LYHNA_PROXY_LOOP_ID": "loop-2026-06-10-checkout-fix",
        "LYHNA_PROXY_GOAL": "fix the checkout bug",
        "LYHNA_PROXY_UPSTREAM_COMMAND": "npx",
        "LYHNA_PROXY_UPSTREAM_ARGS_JSON": "[\"-y\", \"@modelcontextprotocol/server-filesystem\", \"/path/you/allow\"]"
      }
    }
  }
}
```

What this does, per tool call: the agent talks MCP to the proxy exactly as it would to the
upstream; the proxy routes each `tools/call` through the hosted `bind()` first and forwards
**only** on APPROVED (ESCALATED holds, REFUSED and any error fail closed). Every call earns
a signed receipt chained into the loop; on a controlled shutdown (SIGTERM) the proxy seals
the loop with a terminal `loop_close`.

Path A gives you governed calls and a sealed receipt chain. The full capsule trio (scope
capsule, attested refusals, judgment ledger) needs the supervisor surface — that's Path B.

## Path B — the full capsule trio from a terminal

### 1. Start the governed proxy (standing mode)

macOS / Linux (POSIX shells):

```bash
export LYHNA_API_KEY=<your key>                      # or: export LYHNA_PROXY_BIND_MODE=demo
export LYHNA_PROXY_CONTROL_SOCKET=/tmp/lyhna-control.sock
export LYHNA_PROXY_UPSTREAM_COMMAND=npx
export LYHNA_PROXY_UPSTREAM_ARGS_JSON='["-y","@modelcontextprotocol/server-filesystem","'"$PWD"'"]'

npx -y @lyhna/mcp &
```

Windows (PowerShell) — runs as written. Unix sockets are POSIX-only, so the control
channel is a loopback TCP port here; `ctl` and `export-pack` read the same env vars:

```powershell
New-Item -ItemType Directory -Force ./workdir | Out-Null

$env:LYHNA_API_KEY = '<your key>'                    # or: $env:LYHNA_PROXY_BIND_MODE = 'demo'
$env:LYHNA_PROXY_CONTROL_PORT = '8790'
$env:LYHNA_PROXY_UPSTREAM_COMMAND = 'npx'
$env:LYHNA_PROXY_UPSTREAM_ARGS_JSON = '["-y","@modelcontextprotocol/server-filesystem","./workdir"]'

npx -y @lyhna/mcp
```

> Set the env vars in the SAME shell session that starts the proxy and run `npx` directly
> from it. Do not splice `LYHNA_PROXY_UPSTREAM_ARGS_JSON` through nested quoting
> (`Start-Process`, `cmd /c`, ssh one-liners): the inner quotes get stripped and the proxy
> refuses to start with a JSON parse error.

> The PowerShell block runs the proxy in the FOREGROUND. Run the supervisor commands of
> steps 2 and 4 (`ctl`, `export-pack`) from a SECOND PowerShell window, and give them the
> control target explicitly — append `--host 127.0.0.1 --port 8790` to each, e.g.
> `npx -y @lyhna/mcp ctl --host 127.0.0.1 --port 8790 --file open.json` — or set
> `$env:LYHNA_PROXY_CONTROL_PORT = '8790'` in that window first. A fresh window inherits
> neither variables nor the running proxy; the flags always win over the environment.

**If a default port is taken** (`8765` agent-facing, or your chosen control port): pick free
ones with `LYHNA_PROXY_HTTP_PORT` and `LYHNA_PROXY_CONTROL_PORT` — the `LYHNA_MCP_READY`
block prints the RESOLVED addresses; always use those. Supervisor verbs can also target a
specific proxy explicitly: `ctl --host 127.0.0.1 --port 8790 --file open.json` (same flags
on `export-pack`).

The `LYHNA_MCP_READY` block prints two RESOLVED addresses: the agent-facing MCP URL
(`http://127.0.0.1:8765/mcp/<session_id>` with the defaults — read yours from the block,
the port moves with `LYHNA_PROXY_HTTP_PORT`) and the supervisor control address. The agent
only ever gets its session URL — it has no verb to open, close, or read a loop. You (the
supervisor) drive the control channel.

### 2. Open a loop with a sealed scope

Save as `open.json` (adjust the lane to your task), then send it:

```json
{
  "cmd": "open",
  "session_id": "s1",
  "loop_id": "loop-quickstart-1",
  "goal": "fix the checkout bug",
  "scope_class_map": {
    "read_file": "read", "read_text_file": "read", "list_directory": "read",
    "directory_tree": "read", "search_files": "read", "get_file_info": "read",
    "list_allowed_directories": "read",
    "write_file": "write", "edit_file": "write", "create_directory": "write",
    "move_file": "write"
  },
  "scope_capsule": {
    "structural": {
      "capsule_type": "scope_capsule",
      "capsule_version": "scope-capsule/v1",
      "loop_id": "loop-quickstart-1",
      "goal_hash": "",
      "privacy_mode": "verified_context",
      "allowed_action_classes": ["read", "write"]
    },
    "sidecar": {
      "goal_summary": "fix the checkout bug",
      "planned_steps": ["read the failing code", "write the fix"]
    }
  }
}
```

```bash
npx -y @lyhna/mcp ctl --file open.json
```

The response carries the sealed `scope_ref` — the content-blind hash identity of the lane
this loop is allowed to run in. (`goal_hash` is filled at open from the loop's goal.)

### 3. Point your agent at its session URL and let it work

Any MCP client works. The URL is your session's `agent_mcp_url` from the `LYHNA_MCP_READY`
block (shown here with the default port). For Claude Code, a project `.mcp.json`:

```json
{
  "mcpServers": {
    "lyhna-governed": { "type": "http", "url": "http://127.0.0.1:8765/mcp/s1" }
  }
}
```

In-lane calls are approved, forwarded, and earn signed receipts. An out-of-lane call is
**refused before execution** and attested as a scope event — it becomes part of the proof,
not a silent error.

### 4. Close, export, verify, hand off

Save as `close.json`:

```json
{ "cmd": "close", "session_id": "s1", "outcome": "COMPLETED", "reason": "done" }
```

```bash
# seal the loop (supervisor verb — the agent cannot do this)
npx -y @lyhna/mcp ctl --file close.json

# export the full proof pack — the capsule trio — in one command
npx -y @lyhna/mcp export-pack --loop loop-quickstart-1 --out ./proof-pack

# verify it yourself: offline, trust-no-one, no Lyhna account
npx -y lyhna-verify --chain ./proof-pack/receipts.json

# print the paste-ready handoff for your next agent session
npx -y @lyhna/mcp handoff ./proof-pack

# optional: post the Card to a PR — with YOUR OWN gh credentials, no Lyhna tokens
npx -y @lyhna/mcp post --pr 42 ./proof-pack --repo your-org/your-repo
```

`./proof-pack` now holds `receipts.json` (the verifier input, untouched), `bundle.json`,
`proof-card.md`, `HANDOFF.md`, `scope-capsule.json`, `continuation-capsule.json`,
`scope-events.json` (if anything was refused), `judgment-ledger.json`/`.md`,
`memory-injection.json`, and `verify-instructions.md`.

### Recording what the run settled (optional, supervisor-only)

While the loop is open you can attach declared state deltas to approved turns; they fold
into the continuation/handoff (`settled` / `open_questions` / `next_actions` / `changed`).
Save as `dump.json` and `delta.json`:

```json
{ "cmd": "dump_judgment", "loop_id": "loop-quickstart-1" }
```

```json
{ "cmd": "record_delta", "loop_id": "loop-quickstart-1", "turn_ref": "<an approved turn_ref>", "delta": { "settled": ["checkout fix written"] } }
```

```bash
npx -y @lyhna/mcp ctl --file dump.json
npx -y @lyhna/mcp ctl --file delta.json
```

This is a control-channel verb: the agent can never declare its own deltas, and deltas are
during-run only — a sealed loop refuses them.

> Advanced (POSIX shells only): `ctl` also accepts the JSON inline as a single-quoted
> argument, e.g. `npx -y @lyhna/mcp ctl '{"cmd":"status"}'`. Quoting rules differ across
> shells (PowerShell and cmd.exe mangle it) — `--file` is the documented form.

---

## Privacy modes, in one paragraph

`verified_context` packs carry the supervisor-declared plaintext sidecar (settled / open /
next, the handoff prompt). `proof` packs are **content-blind**: hashes and structural facts
only — no goal text, no plan, no file paths. A loop sealed in proof mode can never be
exported as verified-context (fail closed); downgrading any loop to a proof pack is always
allowed: `export-pack --mode proof`.

## If something refuses to start

- `LYHNA_API_KEY is required.` — hosted mode was selected but the key is empty.
- `Hosted bind mode always targets the hosted gate; LYHNA_PROXY_BIND_URL is not allowed here.`
  — your key only ever travels to `api.lyhna.com`; use the guarded `http` mode (see
  `RUNNING.md`) for a custom bind URL.
- The proxy exits with `MCP error -32001: Request timed out` at startup — the upstream
  `npx` download took longer than the 60s connect window. Warm the download once
  (`npm install @modelcontextprotocol/server-filesystem` in your project — the npx cache
  then has it) and restart. Simply starting the proxy again also works: the partial
  download resumes from cache.
- A call fails with a refusal — check the scope: the tool's `action_class` must be in
  `allowed_action_classes`. The class comes from your `scope_class_map`; a tool you did
  not map falls back to a name heuristic (`*test*` → `run_tests`; `*write*`/`*edit*`/
  `*create*`/`*delete*` → `write`; `*read*`/`*get*`/`*list*`/`*search*` → `read`;
  anything else → `other`, which is refused unless you allowed it). Map every tool you
  care about explicitly — the map is sealed into `scope_ref`, so it is part of the proof.
  A refusal is the gate working; widen the lane deliberately with the supervisor `amend`
  verb, never by loosening after the fact.
