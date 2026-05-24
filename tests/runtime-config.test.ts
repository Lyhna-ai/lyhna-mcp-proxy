import { describe, expect, it } from "vitest";
import { loadProxyRuntimeConfig } from "../src/bind-client/configured.js";

describe("proxy runtime bind configuration", () => {
  it("defaults to stub bind with fail-closed REFUSED outcome", async () => {
    const config = loadProxyRuntimeConfig({}, process.cwd());

    expect(config.bindMode).toBe("stub");
    expect(config.bindDescription).toBe("stub:REFUSED");
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
});
