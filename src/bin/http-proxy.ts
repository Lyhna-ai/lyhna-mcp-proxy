#!/usr/bin/env node
import path from "node:path";

import { loadProxyRuntimeConfig } from "../bind-client/configured.js";
import { serveControlChannel, type ControlChannelHandle } from "../control-channel.js";
import {
  closeLoopWithRetry,
  loadLoopCloseTuning,
  loadLoopContextFromEnv,
  LoopSession
} from "../loop.js";
import { createProxyCore } from "../proxy-core.js";
import { createReceiptRecorder, type ReceiptSource } from "../receipt-recorder.js";
import { createScopeEventRecorder, type ScopeEventSource } from "../scope-event-recorder.js";
import { createJudgmentRecorder, type JudgmentLedgerRecorder } from "../judgment-recorder.js";
import { LoopSessionRegistry } from "../session-registry.js";
import { connectUpstream, serveStreamableHttpProxy } from "../transport/mcp-sdk.js";
import { serveStandingHttpProxy } from "../transport/standing-http.js";

const config = loadProxyRuntimeConfig(withHttpModeDefaults(process.env));
const closeTuning = loadLoopCloseTuning();

if (isStandingMode(process.env)) {
  await runStandingService();
} else {
  await runPerTaskService();
}

// Standing service: one process serves many concurrent sessions. Loops are opened and
// closed ONLY by the supervisor control channel (a separate listener from the agent's
// MCP transport). The agent holds only a per-session MCP URL; it can never open or close
// a loop. SIGTERM is a supervisor signal and seals any still-open loops on shutdown.
async function runStandingService(): Promise<void> {
  const upstream = await connectUpstream(config.upstream);

  // Observe-only recorder: capture every receipt bind() returns (real signed receipts in
  // http mode; synthetic unsigned ones in demo mode) so the supervisor `dump` verb can
  // hand back a loop's sealed chain for packaging. It wraps the ONE bind client shared by
  // both the in-loop path (proxy core) and the close path (registry), so the full chain —
  // in-loop links plus terminal loop_close — is captured in order.
  const recorder = createReceiptRecorder();
  const recordingBind = recorder.wrap(config.bindClient);
  // Capsule Gate 1: supervisor-only scope-event store for attested scope refusals/escalations.
  const scopeEvents = createScopeEventRecorder();
  // Capsule Gate 2: supervisor-only judgment-ledger store for ordered judgment turns. Like the
  // receipt + scope-event stores, it is read back ONLY through the control channel.
  const judgment = createJudgmentRecorder();
  const registry = new LoopSessionRegistry(
    (request) => recordingBind.bind(request),
    closeTuning,
    scopeEvents,
    judgment
  );

  const standing = await serveStandingHttpProxy({
    upstream: upstream.client,
    bindClient: recordingBind,
    registry,
    host: process.env.LYHNA_PROXY_HTTP_HOST ?? "127.0.0.1",
    port: parsePort(process.env.LYHNA_PROXY_HTTP_PORT),
    path: process.env.LYHNA_PROXY_HTTP_PATH ?? "/mcp",
    serverInfo: { name: "lyhna-mcp-proxy-standing", version: "0.1.0" }
  });

  const control = await startControlChannel(registry, recorder, scopeEvents, judgment);

  process.stderr.write(
    `[lyhna-mcp-proxy] STANDING service: mcp=${standing.url}/<session_id>; ` +
      `control=${control.transport}:${control.address}; bind=${config.bindDescription}; ` +
      `upstream=${config.upstream.description}\n`
  );

  const shutdown = async (sealOpenLoops: boolean, reason: string): Promise<void> => {
    if (sealOpenLoops && registry.size > 0) {
      const results = await registry.closeAll(reason);
      for (const [session_id, result] of results) {
        process.stderr.write(
          result.sealed
            ? `[lyhna-mcp-proxy] sealed loop session=${session_id} receipt=${result.receipt.receipt_id}\n`
            : `[lyhna-mcp-proxy] WARNING loop session=${session_id} left UNSEALED after ${reason}\n`
        );
      }
    }
    await control.close().catch(() => undefined);
    await standing.close().catch(() => undefined);
    await upstream.close().catch(() => undefined);
  };

  process.on("SIGINT", () => {
    void shutdown(false, "SIGINT").finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown(true, "SIGTERM").finally(() => process.exit(0));
  });
}

// Per-task service: the original single-loop topology. One env-injected loop, sealed on
// SIGTERM. Unchanged so the stdio/http per-task proofs keep working.
async function runPerTaskService(): Promise<void> {
  const loopContext = loadLoopContextFromEnv();
  const loopSession = loopContext ? new LoopSession(loopContext) : undefined;

  const upstream = await connectUpstream(config.upstream);
  const core = createProxyCore({
    upstream: upstream.client,
    bindClient: config.bindClient,
    loopSession
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
    `[lyhna-mcp-proxy] streamable_http listening at ${proxy.url}; bind=${config.bindDescription}; upstream=${config.upstream.description}` +
      `${loopContext ? `; loop=${loopContext.loop_id}` : "; loop=disabled"}\n`
  );

  // SIGTERM is the proxy-controlled close trigger: the boundary seals the loop on
  // controlled shutdown. The close POST is awaited (with retry inside the grace
  // window) BEFORE the upstream/bind transport is torn down. SIGINT is an abrupt
  // interrupt and does not seal the chain (it is left detectably unsealed).
  async function shutdown(emitLoopClose: boolean, terminationReason: string): Promise<void> {
    if (emitLoopClose && loopSession && !loopSession.closed) {
      const result = await closeLoopWithRetry(loopSession, (request) => config.bindClient.bind(request), {
        outcome: "COMPLETED",
        termination_reason: terminationReason,
        graceMs: closeTuning.graceMs,
        retryDelayMs: closeTuning.retryDelayMs
      });

      if (result.sealed) {
        process.stderr.write(
          `[lyhna-mcp-proxy] loop ${loopSession.loopId} sealed by loop_close receipt=${result.receipt.receipt_id} actions=${loopSession.actionCount}\n`
        );
      } else {
        process.stderr.write(
          `[lyhna-mcp-proxy] WARNING loop ${loopSession.loopId} left UNSEALED after ${terminationReason}; close POST failed within grace window\n`
        );
      }
    }

    await proxy.close().catch(() => undefined);
    await upstream.close().catch(() => undefined);
  }

  process.on("SIGINT", () => {
    void shutdown(false, "SIGINT").finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown(true, "SIGTERM").finally(() => process.exit(0));
  });
}

function isStandingMode(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.LYHNA_PROXY_CONTROL_SOCKET?.trim() || env.LYHNA_PROXY_CONTROL_PORT?.trim()
  );
}

function startControlChannel(
  registry: LoopSessionRegistry,
  receiptSource: ReceiptSource,
  scopeEventSource: ScopeEventSource,
  judgmentRecorder: JudgmentLedgerRecorder
): Promise<ControlChannelHandle> {
  const socketPath = process.env.LYHNA_PROXY_CONTROL_SOCKET?.trim();
  const logger = (line: string) => process.stderr.write(`${line}\n`);

  if (socketPath) {
    return serveControlChannel({ transport: "unix", socketPath, registry, receiptSource, scopeEventSource, judgmentRecorder, logger });
  }

  return serveControlChannel({
    transport: "tcp",
    // Empty/whitespace falls back to loopback; a non-loopback value is refused by serveControlChannel
    // (the control plane is supervisor-only and must never bind a non-loopback interface).
    host: process.env.LYHNA_PROXY_CONTROL_HOST?.trim() || "127.0.0.1",
    port: parsePort(process.env.LYHNA_PROXY_CONTROL_PORT),
    registry,
    receiptSource,
    scopeEventSource,
    judgmentRecorder,
    logger
  });
}

function withHttpModeDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    // A present LYHNA_API_KEY selects the hosted gate (the customer path); otherwise the
    // fail-closed local stub stays the default, exactly as before.
    LYHNA_PROXY_BIND_MODE: env.LYHNA_PROXY_BIND_MODE ?? (env.LYHNA_API_KEY?.trim() ? "hosted" : "stub"),
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
