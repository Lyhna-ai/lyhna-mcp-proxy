import { describe, expect, it } from "vitest";
import { buildBindRequest, resolveWrapperFamilyActionType } from "../src/index.js";
import type { BindClient, McpToolCall, UpstreamMcpClient } from "../src/index.js";
import { createProxyCore } from "../src/index.js";

const zapierWrapperToolName = "mcp_zapier_execute_zapier_write_action";

describe("wrapper-family registry", () => {
  it("resolves Google Drive + folder from the verified stringified argument shape", () => {
    const call: McpToolCall = {
      toolName: zapierWrapperToolName,
      arguments: JSON.stringify({
        app: "Google Drive",
        action: "folder",
        output: "...",
        params: { ignored: true },
        instructions: "ignored freeform text"
      })
    };

    expect(resolveWrapperFamilyActionType(call)).toBe("zapier.google_drive.folder");
    expect(buildBindRequest(call)).toMatchObject({
      action_type: "zapier.google_drive.folder",
      action_payload: {
        tool_name: zapierWrapperToolName,
        arguments: call.arguments
      },
      intent: "mcp:zapier.google_drive.folder"
    });
  });

  it("resolves Apify call-actor from the verified plain-object argument shape", () => {
    const call: McpToolCall = {
      toolName: "call-actor",
      arguments: {
        actor: "apify/hello-world",
        input: { ignored: true },
        async: true,
        previewOutput: false
      }
    };

    expect(resolveWrapperFamilyActionType(call)).toBe("apify.apify_hello-world");
    expect(buildBindRequest(call)).toMatchObject({
      action_type: "apify.apify_hello-world",
      action_payload: {
        tool_name: "call-actor",
        arguments: call.arguments
      },
      intent: "mcp:apify.apify_hello-world"
    });
  });

  it("leaves non-wrapper tools unchanged", () => {
    const call: McpToolCall = {
      toolName: "repo.search",
      arguments: { query: "zapier" }
    };

    expect(resolveWrapperFamilyActionType(call)).toBe("repo.search");
    expect(buildBindRequest(call).action_type).toBe("repo.search");
  });

  it("falls back to the Zapier wrapper action_type when arguments are unparseable", () => {
    const call: McpToolCall = {
      toolName: zapierWrapperToolName,
      arguments: "{\"app\":\"Google Drive\""
    };

    expect(resolveWrapperFamilyActionType(call)).toBe(zapierWrapperToolName);
    expect(buildBindRequest(call).action_type).toBe(zapierWrapperToolName);
  });

  it("falls back to the Zapier wrapper action_type when declared fields are missing or empty", () => {
    expect(
      resolveWrapperFamilyActionType({
        toolName: zapierWrapperToolName,
        arguments: JSON.stringify({ app: "Google Drive", instructions: "make a folder" })
      })
    ).toBe(zapierWrapperToolName);

    expect(
      resolveWrapperFamilyActionType({
        toolName: zapierWrapperToolName,
        arguments: JSON.stringify({ app: " ", action: "folder" })
      })
    ).toBe(zapierWrapperToolName);
  });

  it("falls back to the Apify wrapper action_type when actor is missing or empty", () => {
    expect(
      resolveWrapperFamilyActionType({
        toolName: "call-actor",
        arguments: { input: { query: "ignored" } }
      })
    ).toBe("call-actor");

    expect(
      resolveWrapperFamilyActionType({
        toolName: "call-actor",
        arguments: { actor: " ", input: { query: "ignored" } }
      })
    ).toBe("call-actor");
  });

  it("does not mutate a Zapier forwarded call while using the resolved action_type for bind only", async () => {
    const calls: McpToolCall[] = [];
    const originalCall: McpToolCall = {
      toolName: zapierWrapperToolName,
      arguments: JSON.stringify({
        app: "Google Drive",
        action: "folder",
        output: "...",
        params: { name: "Receipts" },
        instructions: "ignored"
      })
    };
    let boundActionType: string | undefined;
    let boundPayload: Record<string, unknown> | undefined;
    const bindClient: BindClient = {
      async bind(request) {
        boundActionType = request.action_type;
        boundPayload = request.action_payload;
        return { outcome: "APPROVED", receipt_id: "receipt_zapier", signature: "sig_zapier" };
      }
    };
    const upstream: UpstreamMcpClient = {
      async listTools() {
        return [];
      },
      async callTool(call) {
        calls.push(call);
        return { ok: true };
      }
    };
    const proxy = createProxyCore({ upstream, bindClient });

    await expect(proxy.callTool(originalCall)).resolves.toEqual({ ok: true });

    expect(boundActionType).toBe("zapier.google_drive.folder");
    expect(boundPayload).toEqual({
      tool_name: zapierWrapperToolName,
      arguments: originalCall.arguments
    });
    expect(calls).toEqual([originalCall]);
    expect(calls[0]).toBe(originalCall);
    expect(calls[0]?.arguments).toBe(originalCall.arguments);
  });

  it("does not mutate an Apify forwarded call while using the resolved action_type for bind only", async () => {
    const calls: McpToolCall[] = [];
    const originalCall: McpToolCall = {
      toolName: "call-actor",
      arguments: {
        actor: "apify/hello-world",
        input: { url: "https://example.com" },
        async: true,
        previewOutput: false
      }
    };
    let boundActionType: string | undefined;
    let boundPayload: Record<string, unknown> | undefined;
    const bindClient: BindClient = {
      async bind(request) {
        boundActionType = request.action_type;
        boundPayload = request.action_payload;
        return { outcome: "APPROVED", receipt_id: "receipt_apify", signature: "sig_apify" };
      }
    };
    const upstream: UpstreamMcpClient = {
      async listTools() {
        return [];
      },
      async callTool(call) {
        calls.push(call);
        return { ok: true };
      }
    };
    const proxy = createProxyCore({ upstream, bindClient });

    await expect(proxy.callTool(originalCall)).resolves.toEqual({ ok: true });

    expect(boundActionType).toBe("apify.apify_hello-world");
    expect(boundPayload).toEqual({
      tool_name: "call-actor",
      arguments: originalCall.arguments
    });
    expect(calls).toEqual([originalCall]);
    expect(calls[0]).toBe(originalCall);
    expect(calls[0]?.arguments).toBe(originalCall.arguments);
  });
});
