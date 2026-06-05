import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ControlChannelHandle,
  ProofReceipt,
  StandingHttpProxy,
  StreamableHttpUpstream,
  UpstreamMcpClient
} from "../src/index.js";
import {
  assertContentBlind,
  assertExternalScope,
  buildLoopProofBundle,
  connectStreamableHttpUpstream,
  createReceiptRecorder,
  createSyntheticDemoBindClient,
  LoopSessionRegistry,
  serveControlChannel,
  serveStandingHttpProxy,
  verifyLoopChain
} from "../src/index.js";

// In-process synthetic upstream (single echo tool) so the demo path is self-contained.
function syntheticUpstream(): UpstreamMcpClient {
  return {
    async listTools() {
      return [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: { message: { type: "string" } } } }];
    },
    async callTool(call) {
      const message = String((call.arguments as { message?: unknown } | undefined)?.message ?? "");
      return { content: [{ type: "text", text: message }], structuredContent: { message } };
    }
  };
}

function sendControl(socketPath: string, command: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(command) + "\n"));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const i = buffer.indexOf("\n");
      if (i !== -1) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, i)) as Record<string, unknown>);
      }
    });
    socket.on("error", reject);
  });
}

describe("golden-path demo: open -> route -> supervisor close -> dump -> bundle", () => {
  let standing: StandingHttpProxy | undefined;
  let control: ControlChannelHandle | undefined;
  const agents: StreamableHttpUpstream[] = [];

  afterEach(async () => {
    for (const agent of agents.splice(0)) await agent.close().catch(() => undefined);
    await control?.close().catch(() => undefined);
    await standing?.close().catch(() => undefined);
    control = undefined;
    standing = undefined;
  });

  async function start(withReceiptSource: boolean): Promise<{ socketPath: string }> {
    const recorder = createReceiptRecorder();
    const bindClient = recorder.wrap(createSyntheticDemoBindClient());
    const registry = new LoopSessionRegistry((r) => bindClient.bind(r), { graceMs: 200, retryDelayMs: 5 });
    standing = await serveStandingHttpProxy({ upstream: syntheticUpstream(), bindClient, registry, host: "127.0.0.1", port: 0, path: "/mcp" });
    const socketPath = join(tmpdir(), `lyhna-demo-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    control = await serveControlChannel(
      withReceiptSource
        ? { transport: "unix", socketPath, registry, receiptSource: recorder }
        : { transport: "unix", socketPath, registry }
    );
    return { socketPath };
  }

  async function connectAgent(sessionId: string): Promise<UpstreamMcpClient> {
    const agent = await connectStreamableHttpUpstream(standing!.sessionUrl(sessionId));
    agents.push(agent);
    return agent.client;
  }

  it("dumps the sealed synthetic chain, which bundles sealed and structurally verifies cold", async () => {
    const { socketPath } = await start(true);
    const LOOP = "loop-golden";

    await sendControl(socketPath, { cmd: "open", session_id: "s1", loop_id: LOOP, goal: "do the work" });
    const agent = await connectAgent("s1");
    for (let i = 0; i < 3; i += 1) await agent.callTool({ toolName: "echo", arguments: { message: `m${i}` } });
    const closed = await sendControl(socketPath, { cmd: "close", session_id: "s1", outcome: "COMPLETED", reason: "done" });
    expect(closed).toMatchObject({ ok: true, sealed: true });

    const dumped = await sendControl(socketPath, { cmd: "dump", loop_id: LOOP });
    expect(dumped).toMatchObject({ ok: true, loop_id: LOOP, count: 4 }); // 3 in-loop + 1 close
    const receipts = dumped.receipts as ProofReceipt[];

    // External-scope + content-blind hold on the emitted chain.
    expect(() => assertExternalScope(receipts)).not.toThrow();
    expect(() => assertContentBlind(receipts)).not.toThrow();

    // It packages as a sealed external bundle and verifies structurally cold.
    const built = buildLoopProofBundle({ receipts, source_env: "demo-test" });
    expect(built.bundle.loop).toMatchObject({ loop_id: LOOP, action_count: 3, sealed: true });
    expect(built.bundle.scope).toBe("external");

    const links = receipts.map((r) => ({
      receipt_id: String(r.receipt_id),
      loop: (r.constraints?.loop as never) ?? null,
      loop_close: (r.constraints?.loop_close as never) ?? null
    }));
    expect(verifyLoopChain(links)).toEqual({ valid: true, sealed: true, loop_id: LOOP, action_count: 3 });
  });

  it("dump is supervisor-only and survives post-close; the agent path has no dump verb", async () => {
    const { socketPath } = await start(true);
    await sendControl(socketPath, { cmd: "open", session_id: "s2", loop_id: "loop-2", goal: "g" });
    const agent = await connectAgent("s2");
    await agent.callTool({ toolName: "echo", arguments: { message: "x" } });

    // The agent's only verbs are listTools / callTool — there is no open/close/dump on it.
    expect(Object.keys(agent).sort()).toEqual(["callTool", "listTools"]);

    await sendControl(socketPath, { cmd: "close", session_id: "s2", outcome: "COMPLETED", reason: "done" });
    // Session is removed after close, but dump is keyed by loop_id and still resolves.
    const dumped = await sendControl(socketPath, { cmd: "dump", loop_id: "loop-2" });
    expect(dumped).toMatchObject({ ok: true, count: 2 });
  });

  it("dump fails closed when no receipt source is wired to the control channel", async () => {
    const { socketPath } = await start(false);
    await sendControl(socketPath, { cmd: "open", session_id: "s3", loop_id: "loop-3", goal: "g" });
    const res = await sendControl(socketPath, { cmd: "dump", loop_id: "loop-3" });
    expect(res).toMatchObject({ ok: false });
  });
});
