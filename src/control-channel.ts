// Supervisor-only control channel for the standing proxy.
//
// This is the ONLY surface that may open or close a loop. It is a separate listener
// from the agent-facing MCP transport (a distinct unix-domain socket or loopback TCP
// port), and it inherits the exact isolation SIGTERM has today: it must be reachable
// ONLY by the supervisor identity, NEVER by the governed agent.
//
//   - Default transport is a unix-domain socket created owner-only (mode 0o600). A
//     process running under a different UID cannot connect(2) to it, so a different-UID
//     agent cannot speak open/close even if it can see the path. This is the principled
//     default: it is not reachable over any network at all.
//   - A loopback TCP fallback (127.0.0.1) exists for platforms/tests without unix
//     sockets. Loopback is weaker (any same-host process can reach it), so the unix
//     socket is preferred wherever the deployment can provide UID separation.
//
// NON-NEGOTIABLE (self-attestation guard): the agent's MCP path has no open/close verb
// and never reaches this listener. Agent path and control path are topologically
// distinct. If the agent could close its own loop here, the whole proof collapses.
//
// Wire protocol: newline-delimited JSON. One request object per line; one response
// object per line. Deliberately NOT HTTP and NOT MCP — there is no shared routing
// surface with the agent transport that could blur the two.
//
//   -> {"cmd":"open","session_id":"s1","loop_id":"loop_s1","goal":"..."}
//   <- {"ok":true,"session_id":"s1","loop_id":"loop_s1"}
//   -> {"cmd":"close","session_id":"s1","outcome":"COMPLETED","reason":"task_done"}
//   <- {"ok":true,"sealed":true,"receipt_id":"...","action_count":3}
//   -> {"cmd":"status"}
//   <- {"ok":true,"count":1,"sessions":[...]}

import { createServer, type Server as NetServer, type Socket } from "node:net";
import { chmod, unlink } from "node:fs/promises";

import type { LoopSessionRegistry } from "./session-registry.js";

export type ControlChannelLogger = (line: string) => void;

export type ControlChannelOptions =
  | {
      transport: "unix";
      socketPath: string;
      registry: LoopSessionRegistry;
      logger?: ControlChannelLogger;
    }
  | {
      transport: "tcp";
      host?: string;
      port?: number;
      registry: LoopSessionRegistry;
      logger?: ControlChannelLogger;
    };

export type ControlChannelHandle = {
  /** unix socket path, or `host:port` for tcp. */
  address: string;
  transport: "unix" | "tcp";
  server: NetServer;
  close(): Promise<void>;
};

type ControlResponse = Record<string, unknown> & { ok: boolean };

export async function serveControlChannel(
  options: ControlChannelOptions
): Promise<ControlChannelHandle> {
  const log = options.logger ?? (() => undefined);

  const server = createServer((socket) => {
    handleConnection(socket, options.registry, log);
  });

  if (options.transport === "unix") {
    // Best-effort removal of a stale socket file from a prior run.
    await unlink(options.socketPath).catch(() => undefined);

    await listen(server, { path: options.socketPath });

    // Owner-only: a different-UID process cannot connect(2). This is the OS-level half
    // of the isolation guarantee. (No-op semantics on win32; guarded by the caller.)
    await chmod(options.socketPath, 0o600).catch(() => undefined);

    return {
      address: options.socketPath,
      transport: "unix",
      server,
      close: () => closeServer(server, options.socketPath)
    };
  }

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  await listen(server, { host, port });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    address: `${host}:${actualPort}`,
    transport: "tcp",
    server,
    close: () => closeServer(server)
  };
}

function handleConnection(
  socket: Socket,
  registry: LoopSessionRegistry,
  log: ControlChannelLogger
): void {
  socket.setEncoding("utf8");
  let buffer = "";

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        void dispatchLine(line, registry, log).then((response) => {
          if (!socket.destroyed) {
            socket.write(JSON.stringify(response) + "\n");
          }
        });
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });

  socket.on("error", () => {
    // A control client dropping the connection is not fatal to the service.
  });
}

async function dispatchLine(
  line: string,
  registry: LoopSessionRegistry,
  log: ControlChannelLogger
): Promise<ControlResponse> {
  let command: unknown;
  try {
    command = JSON.parse(line);
  } catch {
    return { ok: false, error: "Control command must be a single JSON object per line." };
  }

  if (!isRecord(command) || typeof command.cmd !== "string") {
    return { ok: false, error: "Control command requires a string `cmd`." };
  }

  try {
    switch (command.cmd) {
      case "open": {
        const session_id = requireString(command, "session_id");
        const loop_id = requireString(command, "loop_id");
        const goal = requireString(command, "goal");
        registry.openLoop({ session_id, loop_id, goal });
        log(`[control] opened loop session=${session_id} loop=${loop_id}`);
        return { ok: true, session_id, loop_id };
      }

      case "close": {
        const session_id = requireString(command, "session_id");
        const outcome = typeof command.outcome === "string" ? command.outcome : "COMPLETED";
        const reason = typeof command.reason === "string" ? command.reason : "control_close";
        const result = await registry.closeLoop({ session_id, outcome, reason });
        if (result.sealed) {
          log(`[control] sealed loop session=${session_id} receipt=${result.receipt.receipt_id}`);
          return {
            ok: true,
            sealed: true,
            session_id,
            receipt_id: result.receipt.receipt_id
          };
        }
        log(`[control] WARNING loop session=${session_id} left UNSEALED`);
        return { ok: true, sealed: false, session_id };
      }

      case "status": {
        const sessions = registry.summaries();
        return { ok: true, count: sessions.length, sessions };
      }

      default:
        return { ok: false, error: `Unknown control command: ${command.cmd}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Control command failed." };
  }
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Control command requires a non-empty string \`${key}\`.`);
  }
  return value;
}

function listen(server: NetServer, options: { path: string } | { host: string; port: number }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    const done = () => {
      server.off("error", reject);
      resolve();
    };
    if ("path" in options) {
      server.listen({ path: options.path }, done);
    } else {
      server.listen({ host: options.host, port: options.port }, done);
    }
  });
}

async function closeServer(server: NetServer, socketPath?: string): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Proactively drop idle keep-alive connections so close resolves promptly.
    server.unref();
  });
  if (socketPath) {
    await unlink(socketPath).catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
