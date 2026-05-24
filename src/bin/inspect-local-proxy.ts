import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const command = process.execPath;
const args = [
  path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
  path.join(process.cwd(), "src", "bin", "local-proxy.ts")
];

const client = new Client({
  name: "lyhna-mcp-proxy-inspector",
  version: "0.1.0"
});
const transport = new StdioClientTransport({
  command,
  args,
  cwd: process.cwd(),
  env: {
    LYHNA_PROXY_BIND_MODE: "stub",
    LYHNA_PROXY_STUB_OUTCOME: "APPROVED"
  },
  stderr: "pipe"
});

transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));

try {
  await client.connect(transport);
  const tools = await client.listTools();

  process.stdout.write(
    JSON.stringify(
      {
        status: "ok",
        tools: tools.tools.map((tool) => ({
          name: tool.name,
          description: tool.description
        }))
      },
      null,
      2
    ) + "\n"
  );
} finally {
  await client.close().catch(() => undefined);
}
