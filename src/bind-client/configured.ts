import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

import type { BindClient, BindOutcome, BindRequest, BindResponse } from "../bind.js";
import type {
  StdioUpstreamConfig,
  StreamableHttpUpstreamConfig,
  UpstreamConfig
} from "../transport/mcp-sdk.js";
import { createSyntheticDemoBindClient } from "./synthetic-demo.js";

export type BindMode = "stub" | "http" | "demo" | "hosted";

export type ProxyRuntimeConfig = {
  bindMode: BindMode;
  bindClient: BindClient;
  bindDescription: string;
  upstream: UpstreamConfig;
};

const DEFAULT_STUB_OUTCOME: BindOutcome = "REFUSED";
const PRODUCTION_BIND_HOST = "api.lyhna.com";
// The hosted gate endpoint is FIXED in hosted mode: the customer's Bearer key can only ever be
// sent to Lyhna's hosted bind, never to an attacker-supplied URL riding in via the environment.
const HOSTED_BIND_URL = "https://api.lyhna.com/v1/bind";

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
  const bindMode = parseBindMode(env.LYHNA_PROXY_BIND_MODE, env);
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

  if (bindMode === "demo") {
    // Synthetic, offline, UNSIGNED full-shaped receipts for the local golden-path demo.
    // Honest by construction: receipts carry an obvious stub signature and cold-verify as
    // structural-pass + crypto-fail-by-absence (never green). Never reaches the network.
    return {
      bindMode,
      bindClient: createSyntheticDemoBindClient(),
      bindDescription: "demo:synthetic-unsigned",
      upstream
    };
  }

  if (bindMode === "hosted") {
    // The CUSTOMER path: setting LYHNA_API_KEY is the deliberate opt-in. The endpoint is the
    // fixed hosted gate — a URL override here is refused rather than silently ignored (point a
    // custom URL through the guarded `http` mode instead, with its explicit opt-in flags).
    if (env.LYHNA_PROXY_BIND_URL?.trim()) {
      throw new Error(
        "Hosted bind mode always targets the hosted gate; LYHNA_PROXY_BIND_URL is not allowed here. " +
          "Use LYHNA_PROXY_BIND_MODE=http (with its explicit opt-in flags) for a custom bind URL."
      );
    }
    return {
      bindMode,
      bindClient: createHttpBindClient({
        bindUrl: HOSTED_BIND_URL,
        apiKey: requireEnv(env, "LYHNA_API_KEY")
      }),
      bindDescription: `hosted:${PRODUCTION_BIND_HOST}`,
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

function parseBindMode(value: string | undefined, env: NodeJS.ProcessEnv): BindMode {
  if (!value) {
    // Stranger path: a present LYHNA_API_KEY (the customer-held tenant key from the dashboard)
    // selects the hosted gate with no further flags — supplying YOUR key IS the opt-in. With no
    // key and no mode, the default stays the fail-closed local stub (nothing live, ever).
    return env.LYHNA_API_KEY?.trim() ? "hosted" : "stub";
  }
  if (value === "stub" || value === "http" || value === "demo" || value === "hosted") {
    return value;
  }
  throw new Error("LYHNA_PROXY_BIND_MODE must be 'stub', 'http', 'demo', or 'hosted'.");
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
