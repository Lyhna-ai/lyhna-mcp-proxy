import { loadProxyRuntimeConfig } from "../bind-client/configured.js";
import {
  closeLoopWithRetry,
  loadLoopCloseTuning,
  loadLoopContextFromEnv,
  LoopSession
} from "../loop.js";
import { createProxyCore } from "../proxy-core.js";
import { connectUpstream, serveStdioProxy } from "../transport/mcp-sdk.js";

const config = loadProxyRuntimeConfig();
const loopContext = loadLoopContextFromEnv();
const loopSession = loopContext ? new LoopSession(loopContext) : undefined;
const closeTuning = loadLoopCloseTuning();

const upstream = await connectUpstream(config.upstream);
const core = createProxyCore({
  upstream: upstream.client,
  bindClient: config.bindClient,
  loopSession
});
const server = await serveStdioProxy(core, {
  name: "lyhna-mcp-proxy-local",
  version: "0.1.0"
});

process.stderr.write(
  `[lyhna-mcp-proxy] running with bind=${config.bindDescription}; upstream=${config.upstream.description}` +
    `${loopContext ? `; loop=${loopContext.loop_id}` : "; loop=disabled"}\n`
);

// SIGTERM is the proxy-controlled close trigger: the boundary seals the loop on
// controlled shutdown. The close POST is awaited (with retry inside the grace
// window) BEFORE the upstream/bind transport is torn down. SIGINT is treated as an
// abrupt interrupt and does not seal the chain (it is left detectably unsealed).
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

  await server.close().catch(() => undefined);
  await upstream.close().catch(() => undefined);
}

process.on("SIGINT", () => {
  void shutdown(false, "SIGINT").finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown(true, "SIGTERM").finally(() => process.exit(0));
});
