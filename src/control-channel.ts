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
// distinct. If the agent could close its own loop here, the whole proof collapses. The
// Capsule Gate 2 verbs `dump_judgment` (read the ordered judgment ledger) and `record_delta`
// (attach a supervisor-declared, Verified-Context-only state delta to a turn) live ONLY here
// for the same reason — the agent can neither read the ledger nor forge settled/open/next state.
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

import type { ReceiptSource } from "./receipt-recorder.js";
import type { LoopSessionRegistry } from "./session-registry.js";
import type { ScopeCapsule, ScopePrivacyMode } from "./scope-capsule.js";
import type { ScopeEventSource } from "./scope-event-recorder.js";
import { projectTurn } from "./judgment-ledger.js";
import type { JudgmentLedgerRecorder } from "./judgment-recorder.js";

export type ControlChannelLogger = (line: string) => void;

export type ControlChannelOptions =
  | {
      transport: "unix";
      socketPath: string;
      registry: LoopSessionRegistry;
      /**
       * Optional read-only receipt source backing the supervisor `dump` verb. When
       * omitted, `dump` is unavailable (fails closed). Never on the agent path.
       */
      receiptSource?: ReceiptSource;
      /**
       * Optional read-only scope-event source backing the supervisor `dump_scope` verb. When
       * omitted, `dump_scope` returns scope history only. Never on the agent path.
       */
      scopeEventSource?: ScopeEventSource;
      /**
       * Optional judgment-ledger recorder backing the supervisor `dump_judgment` and `record_delta`
       * verbs (Capsule Gate 2). When omitted, those verbs fail closed. Supervisor-only: it lives on
       * the control channel, which the agent's MCP path never reaches.
       */
      judgmentRecorder?: JudgmentLedgerRecorder;
      logger?: ControlChannelLogger;
    }
  | {
      transport: "tcp";
      host?: string;
      port?: number;
      registry: LoopSessionRegistry;
      receiptSource?: ReceiptSource;
      scopeEventSource?: ScopeEventSource;
      judgmentRecorder?: JudgmentLedgerRecorder;
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
    handleConnection(socket, options.registry, options.receiptSource, options.scopeEventSource, options.judgmentRecorder, log);
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
  // FAIL CLOSED (loopback-only invariant): the control plane (open/close/dump/dump_scope) is
  // supervisor-only and topologically separate from the agent transport. The TCP fallback is a
  // weaker, same-host convenience — binding it to a non-loopback interface (0.0.0.0, ::, or a LAN
  // address) would publish those verbs to anyone who can reach the interface, letting a non-supervisor
  // seal/close/dump a loop. Refuse any non-loopback host here so a stray LYHNA_PROXY_CONTROL_HOST can
  // never expose the control plane remotely; use a unix-domain socket (preferred) for stronger isolation.
  if (!isLoopbackHost(host)) {
    throw new Error(
      `Control channel TCP host ${JSON.stringify(host)} is not loopback; the control plane is ` +
        `supervisor-only and must never be published to a non-loopback interface (fail closed). ` +
        `Use a 127.0.0.0/8 / ::1 host, or a unix-domain socket.`
    );
  }
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
  receiptSource: ReceiptSource | undefined,
  scopeEventSource: ScopeEventSource | undefined,
  judgmentRecorder: JudgmentLedgerRecorder | undefined,
  log: ControlChannelLogger
): void {
  socket.setEncoding("utf8");
  let buffer = "";
  // Serialize commands PER CONNECTION: a newline-delimited line protocol must process
  // commands in the order received, each completing before the next starts. Without this,
  // a fast read pipelined right after a slow command races it — e.g. `dump` (a synchronous
  // recorder read) sent right after `close` (which awaits bind) could resolve FIRST and
  // return the pre-close, UNSEALED chain, so the exported proof would miss the terminal
  // loop_close despite the supervisor issuing close -> dump in order. Serialization is
  // per-socket only; distinct supervisor connections still run concurrently.
  let queue: Promise<void> = Promise.resolve();

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        queue = queue.then(async () => {
          const response = await dispatchLine(line, registry, receiptSource, scopeEventSource, judgmentRecorder, log);
          if (!socket.destroyed) {
            socket.write(JSON.stringify(response) + "\n");
          }
        }).catch(() => {
          // One command's failure must not stall the queue. dispatchLine resolves its own
          // errors into a response; this guards only an unexpected write failure.
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
  receiptSource: ReceiptSource | undefined,
  scopeEventSource: ScopeEventSource | undefined,
  judgmentRecorder: JudgmentLedgerRecorder | undefined,
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
        // Optional Capsule Gate 1 scope material, sealed at open by this supervisor boundary.
        // FAIL CLOSED: a PRESENT scope_capsule / scope_class_map key must be a real object. A
        // null/falsy/malformed value (e.g. `scope_capsule: null`) must NOT be treated as "omitted" —
        // that would silently open an UNSCOPED baseline session and run future tools/call without the
        // Capsule Gate (or drop a supervisor classifier override that governs enforcement).
        if (command.scope_capsule !== undefined && !isRecord(command.scope_capsule)) {
          return { ok: false, error: "open `scope_capsule` must be an object when present (fail closed)." };
        }
        if (command.scope_class_map !== undefined && !isRecord(command.scope_class_map)) {
          return { ok: false, error: "open `scope_class_map` must be an object when present (fail closed)." };
        }
        const scope_capsule = isRecord(command.scope_capsule)
          ? (command.scope_capsule as unknown as ScopeCapsule)
          : undefined;
        const scope_class_map = isRecord(command.scope_class_map)
          ? (command.scope_class_map as Record<string, string>)
          : undefined;
        const session = registry.openLoop({ session_id, loop_id, goal, scope_capsule, scope_class_map });
        if (scope_capsule) {
          const scope = registry.getScope(session_id);
          log(`[control] opened loop session=${session_id} loop=${loop_id} scope_ref=${scope?.sealed.scope_ref ?? "(no recorder)"}`);
          return { ok: true, session_id, loop_id, scope_ref: scope?.sealed.scope_ref ?? null };
        }
        // Touch `session` so the no-scope path keeps the same return shape as before.
        void session;
        log(`[control] opened loop session=${session_id} loop=${loop_id}`);
        return { ok: true, session_id, loop_id };
      }

      case "amend": {
        // SUPERVISOR-ONLY scope amendment: seal a NEW scope_ref version chained to the prior.
        const session_id = requireString(command, "session_id");
        if (!isRecord(command.scope_capsule)) {
          return { ok: false, error: "amend requires a `scope_capsule` object." };
        }
        const sealed = registry.amendLoop({
          session_id,
          scope_capsule: command.scope_capsule as unknown as ScopeCapsule
        });
        log(`[control] amended scope session=${session_id} scope_ref=${sealed.scope_ref} prior=${sealed.prior_scope_ref}`);
        return { ok: true, session_id, scope_ref: sealed.scope_ref, prior_scope_ref: sealed.prior_scope_ref };
      }

      case "dump_scope": {
        // Read-only supervisor verb: hand back the sealed scope seal-history (original +
        // amendments) and the attested scope events for a loop, so the supervisor can package the
        // Continuation Capsule and the Proof Pack scope artifacts. Keyed by loop_id, like `dump`.
        const loop_id = requireString(command, "loop_id");
        const scope_history = registry.scopeHistoryForLoop(loop_id);
        const scope_events = scopeEventSource ? scopeEventSource.scopeEventsForLoop(loop_id) : [];
        return { ok: true, loop_id, scope_history, scope_events };
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

      case "dump": {
        // Read-only: hand back the receipts recorded for a loop so the supervisor can
        // package them into a LoopProofBundle. Supervisor-only by construction — this
        // verb lives on the control channel, which the agent's MCP path never reaches.
        // Keyed by loop_id (not session_id) so it survives the post-close session removal:
        // the supervisor opened the loop and already knows its loop_id.
        if (!receiptSource) {
          return { ok: false, error: "Receipt dump is not enabled on this control channel." };
        }
        const loop_id = requireString(command, "loop_id");
        const receipts = receiptSource.receiptsForLoop(loop_id);
        return { ok: true, loop_id, count: receipts.length, receipts };
      }

      case "dump_judgment": {
        // Read-only supervisor verb (Capsule Gate 2): hand back the ordered judgment ledger for a
        // loop so the supervisor can package the Continuation Capsule / Proof Pack judgment artifacts.
        // Supervisor-only by construction — this verb lives on the control channel, which the agent's
        // MCP path never reaches. Addressable by loop_id OR session_id (the loop survives close).
        //
        // MODE CONTRACT: turns are projected under the loop's SEALED privacy_mode by default. A
        // verified_context projection (which may expose plaintext deltas) is granted ONLY when BOTH
        // the requested mode and the sealed scope are verified_context; otherwise it downgrades to
        // Proof Mode (strictly more restrictive — always safe), so a proof-mode loop can never leak
        // a plaintext delta through this verb.
        if (!judgmentRecorder) {
          return { ok: false, error: "Judgment dump is not enabled on this control channel." };
        }
        const loop_id = resolveJudgmentLoopId(command, registry);
        if (!loop_id) {
          return { ok: false, error: "dump_judgment requires a `loop_id`, or a `session_id` for a known loop." };
        }
        const sealedMode = registry.privacyModeForLoop(loop_id) ?? "proof";
        const requested = normalizeProjectionMode(command.mode) ?? sealedMode;
        const mode: ScopePrivacyMode =
          requested === "verified_context" && sealedMode === "verified_context" ? "verified_context" : "proof";
        const turns = judgmentRecorder.judgmentLedgerForLoop(loop_id).map((t) => projectTurn(t, mode));
        return { ok: true, loop_id, mode, count: turns.length, turns };
      }

      case "record_delta": {
        // SUPERVISOR-ONLY (Capsule Gate 2): attach a declared state delta to an existing judgment
        // turn. Control-channel only; never on the agent path (so the agent cannot forge
        // settled/open/next state). The delta is a PLAINTEXT sidecar — Verified Context Mode ONLY:
        // a proof-mode loop fails closed (deltas never enter a content-blind loop). It is additive,
        // attaches by turn_ref (fail-closed on an unknown turn_ref), and never enters
        // bind/core/gate/signing/canonicalization.
        if (!judgmentRecorder) {
          return { ok: false, error: "record_delta is not enabled on this control channel." };
        }
        const turn_ref = requireString(command, "turn_ref");
        const loop_id = resolveJudgmentLoopId(command, registry);
        if (!loop_id) {
          return { ok: false, error: "record_delta requires a `loop_id`, or a `session_id` for a known loop." };
        }
        const sealedMode = registry.privacyModeForLoop(loop_id);
        if (sealedMode !== "verified_context") {
          return {
            ok: false,
            error: `record_delta is Verified Context Mode only; loop ${loop_id} is ${JSON.stringify(sealedMode ?? null)} (fail closed).`
          };
        }
        if (!isRecord(command.delta)) {
          return { ok: false, error: "record_delta requires a `delta` object (settled/open_questions/next_actions/changed)." };
        }
        // attachDelta validates the delta (fail-closed on a malformed/unknown field) and fail-closes
        // on an unknown turn_ref; its throw is caught below and returned as { ok:false, error }.
        const turn = judgmentRecorder.attachDelta(loop_id, turn_ref, command.delta as never);
        log(`[control] record_delta loop=${loop_id} turn_ref=${turn_ref}`);
        return { ok: true, loop_id, turn_ref, declared_delta: turn.declared_delta ?? {} };
      }

      default:
        return { ok: false, error: `Unknown control command: ${command.cmd}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Control command failed." };
  }
}

/**
 * Resolve the loop_id a judgment verb addresses: an explicit `loop_id`, else the loop the
 * supervisor opened for a `session_id` (which survives close). Returns undefined when neither
 * resolves, so the caller fails closed.
 */
function resolveJudgmentLoopId(command: Record<string, unknown>, registry: LoopSessionRegistry): string | undefined {
  if (typeof command.loop_id === "string" && command.loop_id.length > 0) {
    return command.loop_id;
  }
  if (typeof command.session_id === "string" && command.session_id.length > 0) {
    return registry.loopIdForSession(command.session_id);
  }
  return undefined;
}

/** Normalize an optional projection mode argument; undefined when absent, throws on a bad value. */
function normalizeProjectionMode(value: unknown): ScopePrivacyMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "verified_context" || value === "verified-context") return "verified_context";
  if (value === "proof") return "proof";
  throw new Error(`mode must be "proof" or "verified-context", received ${JSON.stringify(value)}.`);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Control command requires a non-empty string \`${key}\`.`);
  }
  return value;
}

/**
 * A host is loopback iff it names the local machine only: `localhost`, the IPv6 loopback `::1`, or
 * any IPv4 in 127.0.0.0/8 (incl. its IPv4-mapped IPv6 form `::ffff:127.x.x.x`). Everything else —
 * `0.0.0.0`, `::`, an empty/unspecified host, or a routable LAN/WAN address — is non-loopback and is
 * refused so the supervisor-only control plane cannot be published off-host.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  const v4 = h.startsWith("::ffff:") ? h.slice("::ffff:".length) : h;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (!m) return false;
  const octets = m.slice(1).map((n) => Number(n));
  return octets.every((n) => n <= 255) && octets[0] === 127;
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
