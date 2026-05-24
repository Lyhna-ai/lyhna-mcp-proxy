import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

let echoCallCount = 0;

const server = new Server(
  {
    name: "reference-upstream-mcp-server",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echoes a message and increments an internal call counter.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" }
        },
        required: ["message"]
      }
    },
    {
      name: "read_count",
      description: "Reads the echo tool call count without incrementing it.",
      inputSchema: {
        type: "object",
        properties: {}
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "echo": {
      echoCallCount += 1;
      const message = String(request.params.arguments?.message ?? "");
      return {
        content: [{ type: "text", text: message }],
        structuredContent: {
          message,
          echoCallCount
        }
      };
    }

    case "read_count":
      return {
        content: [{ type: "text", text: String(echoCallCount) }],
        structuredContent: {
          echoCallCount
        }
      };

    default:
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }]
      };
  }
});

await server.connect(new StdioServerTransport());
