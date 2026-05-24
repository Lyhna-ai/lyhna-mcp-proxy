import path from "node:path";

import { loadProxyRuntimeConfig } from "../bind-client/configured.js";
import { createProxyCore } from "../proxy-core.js";
import { connectUpstream, serveStreamableHttpProxy } from "../transport/mcp-sdk.js";

const config = loadProxyRuntimeConfig(withHttpModeDefaults(process.env));
const upstream = await connectUpstream(config.upstream);
const core = createProxyCore({
  upstream: upstream.client,
  bindClient: config.bindClient
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
  `[lyhna-mcp-proxy] streamable_http listening at ${proxy.url}; bind=${config.bindDescription}; upstream=${config.upstream.description}\n`
);

async function shutdown(): Promise<void> {
  await proxy.close().catch(() => undefined);
  await upstream.close().catch(() => undefined);
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
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
