import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

import type { BindClient, BindOutcome, BindRequest, BindResponse } from "../bind.js";
import type {
  StdioUpstreamConfig,
  StreamableHttpUpstreamConfig,
  UpstreamConfig
} from "../transport/mcp-sdk.js";

export type BindMode = "stub" | "http";

export type ProxyRuntimeConfig = {
  bindMode: BindMode;
  bindClient: BindClient;
  bindDescription: string;
  upstream: UpstreamConfig;
};

const DEFAULT_STUB_OUTCOME: BindOutcome = "REFUSED";
const PRODUCTION_BIND_HOST = "api.lyhna.com";

export function createStubBindClient(outcome: BindOutcome = DEFAULT_STUB_OUTCOME): BindClient {
  return {
    async bind(request) {
      return {
        outcome,
        receipt_id: `stub_${outcome.toLowerCase()}_${request.action_type}`,
        signature: "stub-signature",
        environment: "stub",
        action_type: request.action_type
      };
    }
  };
}

export function loadProxyRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): ProxyRuntimeConfig {
  const bindMode = parseBindMode(env.LYHNA_PROXY_BIND_MODE);
  const upstream = loadUpstreamConfig(env, cwd);

  if (bindMode === "stub") {
    const outcome = parseStubOutcome(env.LYHNA_PROXY_STUB_OUTCOME);
    return {
      bindMode,
      bindClient: createStubBindClient(outcome),
      bindDescription: `stub:${outcome}`,
      upstream
    };
  }

  const bindUrl = requireEnv(env, "LYHNA_PROXY_BIND_URL");
  requireRealBindOptIn(env, bindUrl);

  return {
    bindMode,
    bindClient: createHttpBindClient({
      bindUrl,
      apiKey: requireEnv(env, "LYHNA_PROXY_BIND_API_KEY")
    }),
    bindDescription: `http:${redactBindUrl(bindUrl)}`,
    upstream
  };
}

function createHttpBindClient(options: { bindUrl: string; apiKey: string }): BindClient {
  return {
    async bind(request: BindRequest): Promise<BindResponse> {
      const response = await fetch(options.bindUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${options.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        throw new Error(`Bind HTTP request failed with status ${response.status}.`);
      }

      const body = (await response.json()) as { receipt?: unknown };
      const receipt = body.receipt ?? body;

      if (!isBindResponse(receipt)) {
        throw new Error("Bind HTTP response did not contain a signed receipt.");
      }

      return receipt;
    }
  };
}

function loadUpstreamConfig(env: NodeJS.ProcessEnv, cwd: string): UpstreamConfig {
  const upstreamMode = parseUpstreamMode(env);

  if (upstreamMode === "streamable_http") {
    const url = requireEnv(env, "LYHNA_PROXY_UPSTREAM_URL");
    return {
      transport: "streamable_http",
      description: `streamable_http:${redactBindUrl(url)}`,
      url,
      headers: env.LYHNA_PROXY_UPSTREAM_HEADERS_JSON
        ? parseJsonStringRecord(
            env.LYHNA_PROXY_UPSTREAM_HEADERS_JSON,
            "LYHNA_PROXY_UPSTREAM_HEADERS_JSON"
          )
        : undefined
    } satisfies StreamableHttpUpstreamConfig;
  }

  const command = env.LYHNA_PROXY_UPSTREAM_COMMAND ?? process.execPath;
  const args = env.LYHNA_PROXY_UPSTREAM_ARGS_JSON
    ? parseJsonStringArray(env.LYHNA_PROXY_UPSTREAM_ARGS_JSON, "LYHNA_PROXY_UPSTREAM_ARGS_JSON")
    : defaultReferenceUpstreamArgs(cwd);

  return {
    transport: "stdio",
    description: `stdio:${command} ${args.join(" ")}`.trim(),
    serverParams: {
      command,
      args,
      cwd,
      stderr: "pipe"
    }
  } satisfies StdioUpstreamConfig;
}

function defaultReferenceUpstreamArgs(cwd: string): string[] {
  return [
    path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(cwd, "tests", "fixtures", "reference-upstream-mcp-server.ts")
  ];
}

function parseBindMode(value: string | undefined): BindMode {
  if (!value) {
    return "stub";
  }
  if (value === "stub" || value === "http") {
    return value;
  }
  throw new Error("LYHNA_PROXY_BIND_MODE must be either 'stub' or 'http'.");
}

function parseUpstreamMode(env: NodeJS.ProcessEnv): UpstreamConfig["transport"] {
  const value = env.LYHNA_PROXY_UPSTREAM_MODE;

  if (!value) {
    return env.LYHNA_PROXY_UPSTREAM_URL ? "streamable_http" : "stdio";
  }

  if (value === "stdio" || value === "streamable_http") {
    return value;
  }

  throw new Error("LYHNA_PROXY_UPSTREAM_MODE must be either 'stdio' or 'streamable_http'.");
}

function parseStubOutcome(value: string | undefined): BindOutcome {
  if (!value) {
    return DEFAULT_STUB_OUTCOME;
  }
  if (value === "APPROVED" || value === "REFUSED" || value === "ESCALATED") {
    return value;
  }
  throw new Error("LYHNA_PROXY_STUB_OUTCOME must be APPROVED, REFUSED, or ESCALATED.");
}

function requireRealBindOptIn(env: NodeJS.ProcessEnv, bindUrl: string): void {
  if (env.LYHNA_PROXY_ALLOW_REAL_BIND !== "true") {
    throw new Error(
      "Real bind mode requires LYHNA_PROXY_ALLOW_REAL_BIND=true. The proxy defaults to stub bind."
    );
  }

  const host = new URL(bindUrl).hostname;
  if (host === PRODUCTION_BIND_HOST && env.LYHNA_PROXY_ALLOW_PRODUCTION_BIND !== "true") {
    throw new Error(
      "Refusing to start against production api.lyhna.com. Set LYHNA_PROXY_ALLOW_PRODUCTION_BIND=true only for a deliberate production cutover."
    );
  }
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parseJsonStringArray(raw: string, name: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error(`${name} must be a JSON string array.`);
  }
  return parsed;
}

function parseJsonStringRecord(raw: string, name: string): Record<string, string> {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object with string values.`);
  }

  const entries = Object.entries(parsed);
  if (entries.some((entry) => typeof entry[1] !== "string")) {
    throw new Error(`${name} must be a JSON object with string values.`);
  }

  return Object.fromEntries(entries);
}

function isBindResponse(value: unknown): value is BindResponse {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.outcome === "APPROVED" ||
      record.outcome === "REFUSED" ||
      record.outcome === "ESCALATED") &&
    typeof record.receipt_id === "string" &&
    typeof record.signature === "string"
  );
}

function redactBindUrl(bindUrl: string): string {
  const url = new URL(bindUrl);
  return `${url.protocol}//${url.host}${url.pathname}`;
}
