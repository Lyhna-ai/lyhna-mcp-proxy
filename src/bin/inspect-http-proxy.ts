import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import path from "node:path";

import { loadProxyRuntimeConfig } from "../bind-client/configured.js";
import { createProxyCore } from "../proxy-core.js";
import { connectStdioUpstream, serveStreamableHttpProxy } from "../transport/mcp-sdk.js";

const workspacePath = process.cwd();
const filesystemServerPath = path.join(
  process.env.APPDATA ?? "",
  "Claude",
  "Claude Extensions",
  "ant.dir.ant.anthropic.filesystem",
  "dist",
  "index.js"
);
const config = loadProxyRuntimeConfig({
  ...process.env,
  LYHNA_PROXY_BIND_MODE: "stub",
  LYHNA_PROXY_STUB_OUTCOME: "APPROVED",
  LYHNA_PROXY_UPSTREAM_COMMAND: process.execPath,
  LYHNA_PROXY_UPSTREAM_ARGS_JSON: JSON.stringify([filesystemServerPath, workspacePath])
});

const upstream = await connectStdioUpstream(config.upstream);
const core = createProxyCore({
  upstream: upstream.client,
  bindClient: config.bindClient
});
const proxy = await serveStreamableHttpProxy(core, {
  host: "127.0.0.1",
  port: 0,
  path: "/mcp",
  serverInfo: {
    name: "lyhna-mcp-proxy-http-inspect",
    version: "0.1.0"
  }
});

const client = new Client({
  name: "lyhna-mcp-proxy-http-inspector",
  version: "0.1.0"
});
const transport = new StreamableHTTPClientTransport(new URL(proxy.url));
const call = {
  name: "list_directory",
  arguments: {
    path: workspacePath
  }
};

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const result = await client.callTool(call);

  process.stdout.write(
    JSON.stringify(
      {
        status: "ok",
        transport: "streamable_http",
        url: proxy.url,
        bind: config.bindDescription,
        upstream: "@modelcontextprotocol/server-filesystem",
        mirrored_tools: tools.tools.map((tool) => ({
          name: tool.name,
          description: tool.description
        })),
        call,
        result
      },
      null,
      2
    ) + "\n"
  );
} finally {
  await client.close().catch(() => undefined);
  await proxy.close().catch(() => undefined);
  await upstream.close().catch(() => undefined);
}
