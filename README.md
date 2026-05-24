# lyhna-mcp-proxy

Standalone Lyhna MCP proxy.

This project sits in front of upstream MCP servers, mirrors their tool surface, intercepts `tools/call`, routes the call through the existing hosted Lyhna `bind()` contract, and forwards upstream only when bind allows it.

## Status

Baseline proxy and wrapper-family registry are built and tested.

Current verification: 23 tests passing across 5 test files.

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

## First Build Target

Baseline generic MCP proxy is implemented:
- `tools/list` mirroring
- `tools/call` interception
- bind then forward
- exact payload preservation
- fail-closed enforcement

Wrapper-family registry is implemented:
- Zapier: matches `execute_zapier_*_action`, reads stringified-JSON arguments, extracts only `app` and `action`, and resolves action types such as `zapier.google_drive.folder`
- Apify: matches `call-actor`, reads plain-object arguments, extracts only `actor`, and resolves action types such as `apify.apify_hello-world`

Adding a new wrapper family should be a verified descriptor entry: tool-name matcher, argument reader, declared operation field paths, and action-type composer. It should not require new extraction logic.
