import { connect as netConnect } from "node:net";
import { request as httpRequest } from "node:http";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  BindClient,
  BindRequest,
  BindResponse,
  ControlChannelHandle,
  LoopChainLink,
  StandingHttpProxy,
  StreamableHttpUpstream,
  UpstreamMcpClient
} from "../src/index.js";
import {
  connectStreamableHttpUpstream,
  isLoopbackHost,
  LoopSessionRegistry,
  serveControlChannel,
  serveStandingHttpProxy,
  verifyLoopChain
} from "../src/index.js";

type BindRecord = { request: BindRequest; response: BindResponse };

// --- synthetic fixtures (no live bind, no hosted contract) -------------------

function recordingBindClient(): { client: BindClient; records: BindRecord[] } {
  let n = 0;
  const records: BindRecord[] = [];
  return {
    records,
    client: {
      async bind(request) {
        n += 1;
        const response: BindResponse = {
          outcome: "APPROVED",
          receipt_id: `rcpt_${n}`,
          signature: `sig_${n}`
        };
        records.push({ request, response });
        return response;
      }
    }
  };
}

// Upstream deliberately exposes a tool literally named "loop_close" — to prove the agent
// cannot forge a terminal close by naming a tool.
function syntheticUpstream(): UpstreamMcpClient {
  return {
    async listTools() {
      return [
        { name: "echo", description: "echo", inputSchema: { type: "object", properties: { message: { type: "string" } } } },
        { name: "loop_close", description: "adversarially named tool", inputSchema: { type: "object", properties: {} } }
      ];
    },
    async callTool(call) {
      const message = String((call.arguments as { message?: unknown } | undefined)?.message ?? call.toolName);
      return { content: [{ type: "text", text: message }], structuredContent: { message } };
    }
  };
}

function reconstructLinks(records: BindRecord[], loopId: string): LoopChainLink[] {
  return records
    .filter(({ request }) => {
      const loop = request.constraints?.loop as { loop_id?: string } | undefined;
      const close = request.constraints?.loop_close as { loop_id?: string } | undefined;
      return loop?.loop_id === loopId || close?.loop_id === loopId;
    })
    .map(({ request, response }) => ({
      receipt_id: response.receipt_id,
      loop: (request.constraints?.loop as LoopChainLink["loop"]) ?? null,
      loop_close: (request.constraints?.loop_close as LoopChainLink["loop_close"]) ?? null
    }));
}

// Supervisor control client: one connection per command, newline-delimited JSON.
function sendControl(socketPath: string, command: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(command) + "\n"));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        socket.end();
        resolve(JSON.parse(line) as Record<string, unknown>);
      }
    });
    socket.on("error", reject);
  });
}

// --- harness -----------------------------------------------------------------

describe("standing service: registry + supervisor control channel", () => {
  let standing: StandingHttpProxy | undefined;
  let control: ControlChannelHandle | undefined;
  const agents: StreamableHttpUpstream[] = [];

  afterEach(async () => {
    for (const agent of agents.splice(0)) {
      await agent.close().catch(() => undefined);
    }
    await control?.close().catch(() => undefined);
    await standing?.close().catch(() => undefined);
    control = undefined;
    standing = undefined;
  });

  async function start(): Promise<{ records: BindRecord[]; socketPath: string }> {
    const { client: bindClient, records } = recordingBindClient();
    const registry = new LoopSessionRegistry((r) => bindClient.bind(r), { graceMs: 200, retryDelayMs: 5 });

    standing = await serveStandingHttpProxy({
      upstream: syntheticUpstream(),
      bindClient,
      registry,
      host: "127.0.0.1",
      port: 0,
      path: "/mcp"
    });

    const socketPath = join(tmpdir(), `lyhna-control-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    control = await serveControlChannel({ transport: "unix", socketPath, registry });

    return { records, socketPath };
  }

  async function connectAgent(sessionId: string): Promise<UpstreamMcpClient> {
    const agent = await connectStreamableHttpUpstream(standing!.sessionUrl(sessionId));
    agents.push(agent);
    return agent.client;
  }

  it("runs multiple concurrent sessions, each opening and closing its own loop through the registry; sealed chains verify COLD", async () => {
    const { records, socketPath } = await start();
    const sessions = [
      { sid: "sess-A", loop: "loop_A", goal: "goal A", calls: 3 },
      { sid: "sess-B", loop: "loop_B", goal: "goal B", calls: 2 },
      { sid: "sess-C", loop: "loop_C", goal: "goal C", calls: 1 }
    ];

    // Supervisor opens every loop on the control channel.
    for (const s of sessions) {
      const res = await sendControl(socketPath, { cmd: "open", session_id: s.sid, loop_id: s.loop, goal: s.goal });
      expect(res).toMatchObject({ ok: true, session_id: s.sid });
    }

    // Agents (each holding only their URL) drive concurrent tool calls.
    await Promise.all(
      sessions.map(async (s) => {
        const agent = await connectAgent(s.sid);
        await expect(agent.listTools()).resolves.toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "echo" })])
        );
        for (let i = 0; i < s.calls; i += 1) {
          await agent.callTool({ toolName: "echo", arguments: { message: `${s.sid}-${i}` } });
        }
      })
    );

    // Supervisor closes every loop on the control channel.
    for (const s of sessions) {
      const res = await sendControl(socketPath, { cmd: "close", session_id: s.sid, outcome: "COMPLETED", reason: "task_done" });
      expect(res).toMatchObject({ ok: true, sealed: true, session_id: s.sid });
    }

    // COLD VERIFY: reconstruct each chain from emitted receipts and run the canonical
    // verifier. Each must be valid + sealed with its own action_count.
    for (const s of sessions) {
      const cold = verifyLoopChain(reconstructLinks(records, s.loop));
      expect(cold).toEqual({ valid: true, sealed: true, loop_id: s.loop, action_count: s.calls });
    }
  });

  it("agent-cannot-close: nothing the agent can do over MCP closes its loop; only the control channel does", async () => {
    const { records, socketPath } = await start();
    await sendControl(socketPath, { cmd: "open", session_id: "guard", loop_id: "loop_guard", goal: "do work" });

    const agent = await connectAgent("guard");

    // The agent exercises the entire MCP surface, including a tool literally named
    // "loop_close". None of it seals the chain.
    await agent.listTools();
    await agent.callTool({ toolName: "echo", arguments: { message: "one" } });
    await agent.callTool({ toolName: "loop_close", arguments: {} }); // adversarial name
    await agent.callTool({ toolName: "echo", arguments: { message: "two" } });

    // Loop is still open: status reports it; no terminal loop_close exists yet.
    const status = await sendControl(socketPath, { cmd: "status" });
    expect(status).toMatchObject({ ok: true, count: 1 });

    const beforeClose = reconstructLinks(records, "loop_guard");
    expect(beforeClose.some((link) => link.loop_close)).toBe(false); // no terminal forged
    // The "loop_close"-named tool call is just another in-loop action link.
    expect(verifyLoopChain(beforeClose)).toMatchObject({ valid: false }); // unsealed, by design

    // Only the supervisor channel closes it.
    const closed = await sendControl(socketPath, { cmd: "close", session_id: "guard", outcome: "COMPLETED", reason: "task_done" });
    expect(closed).toMatchObject({ ok: true, sealed: true });

    // The agent's 3 tool calls (echo, loop_close-named, echo) all count as in-loop actions.
    expect(verifyLoopChain(reconstructLinks(records, "loop_guard"))).toEqual({
      valid: true,
      sealed: true,
      loop_id: "loop_guard",
      action_count: 3
    });
  });

  it("fails closed for a session with no open loop, before and after close", async () => {
    const { socketPath } = await start();

    // Never opened: tools/call is refused (fail closed) as a verdict-led
    // isError result. Listing still mirrors.
    const stranger = await connectAgent("never-opened");
    await expect(stranger.listTools()).resolves.toBeDefined();
    await expect(
      stranger.callTool({ toolName: "echo", arguments: { message: "x" } })
    ).resolves.toMatchObject({ isError: true });

    // Open, use, close — then calls on the now-closed session fail closed again.
    await sendControl(socketPath, { cmd: "open", session_id: "ephemeral", loop_id: "loop_e", goal: "g" });
    const agent = await connectAgent("ephemeral");
    await agent.callTool({ toolName: "echo", arguments: { message: "live" } });
    await sendControl(socketPath, { cmd: "close", session_id: "ephemeral", outcome: "COMPLETED", reason: "done" });

    const afterClose = await connectAgent("ephemeral");
    await expect(
      afterClose.callTool({ toolName: "echo", arguments: { message: "too late" } })
    ).resolves.toMatchObject({ isError: true });
  });

  it("control channel is topologically distinct from the agent MCP transport and is owner-only", async () => {
    const { socketPath } = await start();

    // Distinct listeners: agent speaks HTTP to a TCP port; control is a unix socket path.
    expect(control!.transport).toBe("unix");
    expect(control!.address).toBe(socketPath);
    expect(standing!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(control!.address).not.toContain(standing!.url);

    // Owner-only socket: a different-UID process cannot connect(2). (POSIX only.)
    if (process.platform !== "win32") {
      const info = await stat(socketPath);
      expect(info.mode & 0o077).toBe(0); // no group/other permission bits
    }
  });

  it("fails closed with a JSON 404 for a malformed session encoding, without disrupting the proxy", async () => {
    const { socketPath } = await start();

    // An invalid percent-encoding in the agent URL path must not reject the async
    // listener — it returns a fail-closed 404 JSON error.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          method: "POST",
          host: standing!.host,
          port: standing!.port,
          path: `${standing!.path}/%E0%A4%A`,
          headers: { "content-type": "application/json", accept: "application/json" }
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    });
    expect(status).toBe(404);

    // The proxy is still alive: a normal session flow works afterward.
    await sendControl(socketPath, { cmd: "open", session_id: "alive", loop_id: "loop_alive", goal: "g" });
    const agent = await connectAgent("alive");
    await expect(agent.callTool({ toolName: "echo", arguments: { message: "still up" } })).resolves.toBeDefined();
  });

  it("rejects malformed control commands without affecting the registry", async () => {
    const { socketPath } = await start();
    await expect(sendControl(socketPath, { cmd: "bogus" })).resolves.toMatchObject({ ok: false });
    await expect(sendControl(socketPath, { cmd: "open", session_id: "s" })).resolves.toMatchObject({ ok: false });
    // A valid open still works afterward.
    await expect(
      sendControl(socketPath, { cmd: "open", session_id: "ok", loop_id: "loop_ok", goal: "g" })
    ).resolves.toMatchObject({ ok: true });
  });

  it("fails closed on a PRESENT-but-malformed scope_capsule rather than opening an unscoped baseline (round 31)", async () => {
    const { socketPath } = await start();
    // scope_capsule: null must NOT be silently treated as "omitted" (which would open unscoped).
    await expect(
      sendControl(socketPath, { cmd: "open", session_id: "n1", loop_id: "loop_n1", goal: "g", scope_capsule: null })
    ).resolves.toMatchObject({ ok: false });
    // Other non-object values fail closed too.
    await expect(
      sendControl(socketPath, { cmd: "open", session_id: "n2", loop_id: "loop_n2", goal: "g", scope_capsule: "nope" })
    ).resolves.toMatchObject({ ok: false });
    // A present-but-malformed scope_class_map (governs enforcement once sealed) also fails closed.
    await expect(
      sendControl(socketPath, { cmd: "open", session_id: "n3", loop_id: "loop_n3", goal: "g", scope_class_map: null })
    ).resolves.toMatchObject({ ok: false });
    // The session_ids were never opened (no half-open state) — reusing one for a real open succeeds.
    await expect(
      sendControl(socketPath, { cmd: "open", session_id: "n1", loop_id: "loop_n1b", goal: "g" })
    ).resolves.toMatchObject({ ok: true });
  });

  it("control TCP fallback is loopback-only: a non-loopback host fails closed (never published off-host)", async () => {
    const { client: bindClient } = recordingBindClient();
    const registry = new LoopSessionRegistry((r) => bindClient.bind(r), { graceMs: 50, retryDelayMs: 5 });
    // 0.0.0.0 / :: / a LAN address would expose open/close/dump/dump_scope to the network — refuse.
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", ""]) {
      await expect(serveControlChannel({ transport: "tcp", host, port: 0, registry })).rejects.toThrow(/loopback/i);
    }
    // Loopback hosts are accepted (and immediately closed so the test leaks no listener). Limited to
    // IPv4 loopback here because some CI sandboxes can't bind ::1; ::1/localhost acceptance is proven
    // by the isLoopbackHost unit test below (no socket bind).
    for (const host of ["127.0.0.1", "127.0.0.5"]) {
      const handle = await serveControlChannel({ transport: "tcp", host, port: 0, registry });
      expect(handle.transport).toBe("tcp");
      await handle.close();
    }
  });

  it("isLoopbackHost: only local-machine hosts are loopback", () => {
    for (const h of ["127.0.0.1", "127.0.0.5", "127.255.255.254", "::1", "localhost", "LOCALHOST", "::ffff:127.0.0.1"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ["0.0.0.0", "::", "", "   ", "192.168.0.1", "10.0.0.1", "8.8.8.8", "169.254.1.1", "example.com", "::ffff:10.0.0.1"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});
