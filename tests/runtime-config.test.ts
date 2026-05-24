import { describe, expect, it } from "vitest";
import { loadProxyRuntimeConfig } from "../src/bind-client/configured.js";

describe("proxy runtime bind configuration", () => {
  it("defaults to stub bind with fail-closed REFUSED outcome", async () => {
    const config = loadProxyRuntimeConfig({}, process.cwd());

    expect(config.bindMode).toBe("stub");
    expect(config.bindDescription).toBe("stub:REFUSED");
    expect(config.upstream.transport).toBe("stdio");
    await expect(
      config.bindClient.bind({
        action_type: "echo",
        action_payload: { tool_name: "echo", arguments: {} },
        intent: "mcp:echo",
        intent_version: "1.0"
      })
    ).resolves.toMatchObject({
      outcome: "REFUSED",
      environment: "stub"
    });
  });

  it("allows configurable stub outcomes", async () => {
    const config = loadProxyRuntimeConfig({ LYHNA_PROXY_STUB_OUTCOME: "APPROVED" }, process.cwd());

    await expect(
      config.bindClient.bind({
        action_type: "echo",
        action_payload: { tool_name: "echo", arguments: {} },
        intent: "mcp:echo",
        intent_version: "1.0"
      })
    ).resolves.toMatchObject({
      outcome: "APPROVED"
    });
  });

  it("refuses real bind mode without explicit real-bind opt-in", () => {
    expect(() =>
      loadProxyRuntimeConfig(
        {
          LYHNA_PROXY_BIND_MODE: "http",
          LYHNA_PROXY_BIND_URL: "https://dev-bind.example.test/v1/bind",
          LYHNA_PROXY_BIND_API_KEY: "dev_key"
        },
        process.cwd()
      )
    ).toThrow(/LYHNA_PROXY_ALLOW_REAL_BIND=true/);
  });

  it("refuses production bind URL unless explicit production cutover flag is set", () => {
    expect(() =>
      loadProxyRuntimeConfig(
        {
          LYHNA_PROXY_BIND_MODE: "http",
          LYHNA_PROXY_ALLOW_REAL_BIND: "true",
          LYHNA_PROXY_BIND_URL: "https://api.lyhna.com/v1/bind",
          LYHNA_PROXY_BIND_API_KEY: "dev_key"
        },
        process.cwd()
      )
    ).toThrow(/Refusing to start against production api\.lyhna\.com/);
  });

  it("uses a streamable_http upstream when LYHNA_PROXY_UPSTREAM_URL is provided", () => {
    const config = loadProxyRuntimeConfig(
      {
        LYHNA_PROXY_UPSTREAM_URL: "https://mcp.example.test/mcp",
        LYHNA_PROXY_UPSTREAM_HEADERS_JSON: JSON.stringify({
          "Authorization": "Bearer token",
          "X-Test": "value"
        })
      },
      process.cwd()
    );

    expect(config.upstream).toEqual({
      transport: "streamable_http",
      description: "streamable_http:https://mcp.example.test/mcp",
      url: "https://mcp.example.test/mcp",
      headers: {
        "Authorization": "Bearer token",
        "X-Test": "value"
      }
    });
  });

  it("rejects unsupported upstream transport modes", () => {
    expect(() =>
      loadProxyRuntimeConfig(
        {
          LYHNA_PROXY_UPSTREAM_MODE: "sse"
        },
        process.cwd()
      )
    ).toThrow(/LYHNA_PROXY_UPSTREAM_MODE must be either 'stdio' or 'streamable_http'/);
  });
});
