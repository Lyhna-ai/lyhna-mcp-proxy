import { loadProxyRuntimeConfig } from "../bind-client/configured.js";
import { createProxyCore } from "../proxy-core.js";
import { connectStdioUpstream, serveStdioProxy } from "../transport/mcp-sdk.js";

const config = loadProxyRuntimeConfig();
const upstream = await connectStdioUpstream(config.upstream);
const core = createProxyCore({
  upstream: upstream.client,
  bindClient: config.bindClient
});
const server = await serveStdioProxy(core, {
  name: "lyhna-mcp-proxy-local",
  version: "0.1.0"
});

process.stderr.write(
  `[lyhna-mcp-proxy] running with bind=${config.bindDescription}; upstream=${config.upstream.command} ${(config.upstream.args ?? []).join(" ")}\n`
);

async function shutdown(): Promise<void> {
  await server.close().catch(() => undefined);
  await upstream.close().catch(() => undefined);
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
