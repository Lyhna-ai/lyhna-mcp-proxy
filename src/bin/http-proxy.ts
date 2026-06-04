#!/usr/bin/env node
import path from "node:path";

import { loadProxyRuntimeConfig } from "../bind-client/configured.js";
import {
  closeLoopWithRetry,
  loadLoopCloseTuning,
  loadLoopContextFromEnv,
  LoopSession
} from "../loop.js";
import { createProxyCore } from "../proxy-core.js";
import { connectUpstream, serveStreamableHttpProxy } from "../transport/mcp-sdk.js";

const config = loadProxyRuntimeConfig(withHttpModeDefaults(process.env));
const loopContext = loadLoopContextFromEnv();
const loopSession = loopContext ? new LoopSession(loopContext) : undefined;
const closeTuning = loadLoopCloseTuning();

const upstream = await connectUpstream(config.upstream);
const core = createProxyCore({
  upstream: upstream.client,
  bindClient: config.bindClient,
  loopSession
});
const proxy = await serveStreamableHttpProxy(core, {
  host: process.env.LYHNA_PROXY_HTTP_HOST ?? "127.0.0.1",
  port: parsePort(process.env.LYHNA_PROXY_HTTP_PORT),
  path: process.env.LYHNA_PROXY_HTTP_PATH ?? "/mcp",
  serverInfo: {
    name: "lyhna-mcp-proxy-http",
    version: "0.1.0"
  }
});

process.stderr.write(
  `[lyhna-mcp-proxy] streamable_http listening at ${proxy.url}; bind=${config.bindDescription}; upstream=${config.upstream.description}` +
    `${loopContext ? `; loop=${loopContext.loop_id}` : "; loop=disabled"}\n`
);

// SIGTERM is the proxy-controlled close trigger: the boundary seals the loop on
// controlled shutdown. The close POST is awaited (with retry inside the grace
// window) BEFORE the upstream/bind transport is torn down. SIGINT is an abrupt
// interrupt and does not seal the chain (it is left detectably unsealed).
async function shutdown(emitLoopClose: boolean, terminationReason: string): Promise<void> {
  if (emitLoopClose && loopSession && !loopSession.closed) {
    const result = await closeLoopWithRetry(loopSession, (request) => config.bindClient.bind(request), {
      outcome: "COMPLETED",
      termination_reason: terminationReason,
      graceMs: closeTuning.graceMs,
      retryDelayMs: closeTuning.retryDelayMs
    });

    if (result.sealed) {
      process.stderr.write(
        `[lyhna-mcp-proxy] loop ${loopSession.loopId} sealed by loop_close receipt=${result.receipt.receipt_id} actions=${loopSession.actionCount}\n`
      );
    } else {
      process.stderr.write(
        `[lyhna-mcp-proxy] WARNING loop ${loopSession.loopId} left UNSEALED after ${terminationReason}; close POST failed within grace window\n`
      );
    }
  }

  await proxy.close().catch(() => undefined);
  await upstream.close().catch(() => undefined);
}

process.on("SIGINT", () => {
  void shutdown(false, "SIGINT").finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown(true, "SIGTERM").finally(() => process.exit(0));
});

function withHttpModeDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    LYHNA_PROXY_BIND_MODE: env.LYHNA_PROXY_BIND_MODE ?? "stub",
    LYHNA_PROXY_STUB_OUTCOME: env.LYHNA_PROXY_STUB_OUTCOME ?? "APPROVED",
    LYHNA_PROXY_UPSTREAM_MODE: env.LYHNA_PROXY_UPSTREAM_MODE ?? "stdio",
    LYHNA_PROXY_UPSTREAM_COMMAND: env.LYHNA_PROXY_UPSTREAM_COMMAND ?? process.execPath,
    LYHNA_PROXY_UPSTREAM_ARGS_JSON:
      env.LYHNA_PROXY_UPSTREAM_ARGS_JSON ?? JSON.stringify(defaultFilesystemUpstreamArgs())
  };
}

function defaultFilesystemUpstreamArgs(): string[] {
  return [defaultFilesystemServerPath(), process.cwd()];
}

function defaultFilesystemServerPath(): string {
  return path.join(
    process.env.APPDATA ?? "",
    "Claude",
    "Claude Extensions",
    "ant.dir.ant.anthropic.filesystem",
    "dist",
    "index.js"
  );
}

function parsePort(value: string | undefined): number {
  if (!value) {
    return 8765;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("LYHNA_PROXY_HTTP_PORT must be an integer between 0 and 65535.");
  }

  return port;
}
