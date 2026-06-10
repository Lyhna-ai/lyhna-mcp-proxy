#!/usr/bin/env node
// lyhna-mcp — verb dispatcher.
//
//   lyhna-mcp                 start the MCP proxy (unchanged default; config via env)
//   lyhna-mcp proxy           same, explicit
//   lyhna-mcp handoff [dir]   print the next-agent handoff prompt from an exported pack
//   lyhna-mcp post --pr <n>   post the pack's proof card to a PR with the USER'S gh CLI
//   lyhna-mcp help            this text
//
// Backward compatible: with no arguments the bin behaves exactly as before (the proxy reads
// all configuration from the environment and ignores argv). An unknown verb fails loudly
// instead of silently starting a governed proxy under a typo.

import { runHandoff, runPost, HANDOFF_USAGE, POST_USAGE } from "../capsule-cli.js";
import { runCtl, runExportPack, CTL_USAGE, EXPORT_PACK_USAGE } from "../supervisor-cli.js";

const HELP =
  "lyhna-mcp — Lyhna MCP proxy + capsule tools\n\n" +
  "  lyhna-mcp                 start the MCP proxy, Streamable HTTP (config via LYHNA_PROXY_* env)\n" +
  "  lyhna-mcp proxy           same, explicit\n" +
  "  lyhna-mcp stdio           start the MCP proxy over stdio (for MCP client config blocks)\n" +
  "  lyhna-mcp ctl --file <f>  send one supervisor control command from a JSON file (open/close/status/dump/...)\n" +
  "  lyhna-mcp export-pack     export a closed loop's full proof pack in one command\n" +
  "  lyhna-mcp handoff [dir]   print the paste-ready next-agent handoff from a proof pack\n" +
  "  lyhna-mcp post --pr <n>   post the pack's proof card to a GitHub PR (uses YOUR gh login)\n" +
  "  lyhna-mcp export …        package an existing receipts.json (see export-loop-proof usage)\n" +
  "  lyhna-mcp help            show this help\n\n" +
  HANDOFF_USAGE +
  "\n" +
  POST_USAGE +
  "\n" +
  CTL_USAGE +
  "\n" +
  EXPORT_PACK_USAGE;

const argv = process.argv.slice(2);
const verb = argv[0];
const io = {
  stdout: (text: string) => process.stdout.write(text),
  stderr: (text: string) => process.stderr.write(text)
};

// Verbs set process.exitCode and let the process drain naturally — process.exit() can
// truncate piped stdout mid-flush (e.g. a large `ctl dump` response redirected to a file),
// because stdout writes may complete on later event-loop ticks.
if (verb === undefined || verb === "proxy") {
  // The proxy entry registers its own signal handlers and runs until terminated.
  await import("./http-proxy.js");
} else if (verb === "stdio") {
  // The stdio proxy entry (one MCP server on stdin/stdout) — the shape MCP client config
  // blocks expect for a command-launched server.
  await import("./local-proxy.js");
} else if (verb === "export") {
  // Delegate to the export-loop-proof CLI, which parses process.argv.slice(2) itself —
  // remove the verb so its positional receipts.json argument is read correctly.
  process.argv.splice(2, 1);
  await import("./export-loop-proof.js");
} else if (verb === "ctl") {
  process.exitCode = await runCtl(argv.slice(1), io);
} else if (verb === "export-pack") {
  process.exitCode = await runExportPack(argv.slice(1), io);
} else if (verb === "handoff") {
  process.exitCode = runHandoff(argv.slice(1), io);
} else if (verb === "post") {
  process.exitCode = runPost(argv.slice(1), io);
} else if (verb === "help" || verb === "--help" || verb === "-h") {
  io.stdout(HELP);
} else {
  io.stderr(`unknown command ${JSON.stringify(verb)}\n\n${HELP}`);
  process.exitCode = 1;
}
