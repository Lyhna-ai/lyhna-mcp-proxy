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

const HELP =
  "lyhna-mcp — Lyhna MCP proxy + capsule tools\n\n" +
  "  lyhna-mcp                 start the MCP proxy (configuration via LYHNA_PROXY_* env)\n" +
  "  lyhna-mcp proxy           same, explicit\n" +
  "  lyhna-mcp handoff [dir]   print the paste-ready next-agent handoff from a proof pack\n" +
  "  lyhna-mcp post --pr <n>   post the pack's proof card to a GitHub PR (uses YOUR gh login)\n" +
  "  lyhna-mcp help            show this help\n\n" +
  HANDOFF_USAGE +
  "\n" +
  POST_USAGE;

const argv = process.argv.slice(2);
const verb = argv[0];
const io = {
  stdout: (text: string) => process.stdout.write(text),
  stderr: (text: string) => process.stderr.write(text)
};

if (verb === undefined || verb === "proxy") {
  // The proxy entry registers its own signal handlers and runs until terminated.
  await import("./http-proxy.js");
} else if (verb === "handoff") {
  process.exit(runHandoff(argv.slice(1), io));
} else if (verb === "post") {
  process.exit(runPost(argv.slice(1), io));
} else if (verb === "help" || verb === "--help" || verb === "-h") {
  io.stdout(HELP);
  process.exit(0);
} else {
  io.stderr(`unknown command ${JSON.stringify(verb)}\n\n${HELP}`);
  process.exit(1);
}
