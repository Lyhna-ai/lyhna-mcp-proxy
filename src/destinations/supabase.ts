// Supabase destination (PostgREST over global fetch — zero new dependencies, Node >= 20).
//
// The ONLY destination in Contract v1. Deliberately minimal: select-by-capsule_ref, insert,
// select-by-id. No update, no delete, no schema management — the table (with its
// unique(capsule_ref) constraint) is created out-of-band per docs/SUPABASE-DESTINATION.md.
//
// Configuration comes from the environment ONLY (LYHNA_SUPABASE_URL /
// LYHNA_SUPABASE_SERVICE_ROLE_KEY / LYHNA_SUPABASE_TABLE) and fails closed when missing or
// unsafe. The service-role key is never logged, never echoed in errors, and never committed.

import type { LoopArtifactDestinationClient, LoopArtifactRow } from "../push-pack.js";

export const DEFAULT_SUPABASE_TABLE = "lyhna_loop_artifacts";

/**
 * Postgres-identifier-safe table names only (<= 63 chars, no quoting, no path or query
 * metacharacters). The name is placed in a URL path segment, never interpolated into SQL,
 * but an unsafe name still fails closed here.
 */
export const SUPABASE_TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export type SupabaseEnvConfig = {
  url: string;
  service_role_key: string;
  table: string;
};

/** Resolve + validate the destination env. Fails closed BEFORE any network call. */
export function resolveSupabaseEnv(env: NodeJS.ProcessEnv): { ok: true; config: SupabaseEnvConfig } | { ok: false; detail: string } {
  const url = env.LYHNA_SUPABASE_URL?.trim();
  if (!url) return { ok: false, detail: "LYHNA_SUPABASE_URL is not set (fail closed)." };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Never echo the value: a malformed paste could embed the key.
    return { ok: false, detail: "LYHNA_SUPABASE_URL is not a valid URL (value not echoed; fail closed)." };
  }
  // TRANSPORT HARDENING (adjudicated, P2): the service-role key rides in headers on every request,
  // so plaintext http: is refused except to loopback (local Supabase stacks). Neither the key nor
  // the full URL is ever printed.
  const isLoopbackHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost)) {
    return {
      ok: false,
      detail:
        "LYHNA_SUPABASE_URL must be an https: URL — http: is permitted only for loopback hosts " +
        "(localhost, 127.0.0.1, ::1); the service-role key is never sent over plaintext (fail closed)."
    };
  }
  const key = env.LYHNA_SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) {
    return { ok: false, detail: "LYHNA_SUPABASE_SERVICE_ROLE_KEY is not set (fail closed; read it from the environment — never from git)." };
  }
  const table = env.LYHNA_SUPABASE_TABLE?.trim() || DEFAULT_SUPABASE_TABLE;
  if (!SUPABASE_TABLE_NAME_PATTERN.test(table)) {
    return {
      ok: false,
      detail: `LYHNA_SUPABASE_TABLE ${JSON.stringify(table)} is not a safe table name (expected ${SUPABASE_TABLE_NAME_PATTERN}); fail closed.`
    };
  }
  return { ok: true, config: { url: url.replace(/\/+$/, ""), service_role_key: key, table } };
}

/** HTTP failure detail: status + PostgREST code/message when parseable — NEVER the request key. */
function httpDetail(status: number, bodyText: string): string {
  try {
    const body = JSON.parse(bodyText) as { code?: unknown; message?: unknown };
    if (typeof body === "object" && body !== null && (body.code !== undefined || body.message !== undefined)) {
      return `HTTP ${status} (code ${JSON.stringify(body.code ?? null)}: ${String(body.message ?? "").slice(0, 300)})`;
    }
  } catch {
    // non-JSON body — fall through to the bare status
  }
  return `HTTP ${status}`;
}

export function createSupabaseLoopArtifactClient(
  config: SupabaseEnvConfig,
  fetchImpl: typeof fetch = fetch
): LoopArtifactDestinationClient {
  const endpoint = `${config.url}/rest/v1/${config.table}`;
  const headers = {
    apikey: config.service_role_key,
    authorization: `Bearer ${config.service_role_key}`,
    "content-type": "application/json"
  };

  // REDIRECT HARDENING (Codex review on 5474025): fetch follows redirects by default and custom
  // headers (apikey) survive cross-origin redirects, so ANY endpoint — including the loopback
  // http: exception — could 3xx the service-role key off-host. PostgREST never redirects in
  // normal operation, so every redirect is unexpected: redirect: "error" makes fetch reject and
  // the caller fail closed before the key is re-sent anywhere.
  async function selectRows(query: string, what: string): Promise<Array<Record<string, unknown>>> {
    const response = await fetchImpl(`${endpoint}?${query}&select=*`, { method: "GET", headers, redirect: "error" });
    const bodyText = await response.text();
    if (!response.ok) throw new Error(`${what} failed: ${httpDetail(response.status, bodyText)}`);
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new Error(`${what} returned a non-JSON body (HTTP ${response.status}).`);
    }
    if (!Array.isArray(body) || body.some((r) => typeof r !== "object" || r === null)) {
      throw new Error(`${what} returned an unexpected shape (expected a JSON array of rows).`);
    }
    return body as Array<Record<string, unknown>>;
  }

  return {
    async selectByCapsuleRef(capsule_ref: string): Promise<Array<Record<string, unknown>>> {
      return selectRows(`capsule_ref=eq.${encodeURIComponent(capsule_ref)}`, "destination select by capsule_ref");
    },

    async insertRow(row: LoopArtifactRow): Promise<{ kind: "inserted"; row: Record<string, unknown> } | { kind: "conflict" }> {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { ...headers, prefer: "return=representation" },
        body: JSON.stringify(row),
        redirect: "error"
      });
      const bodyText = await response.text();
      // 409 = unique-constraint violation (unique(capsule_ref)) — the caller's race branch.
      if (response.status === 409) return { kind: "conflict" };
      if (!response.ok) throw new Error(`destination insert failed: ${httpDetail(response.status, bodyText)}`);
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        throw new Error(`destination insert returned a non-JSON body (HTTP ${response.status}).`);
      }
      if (!Array.isArray(body) || body.length !== 1 || typeof body[0] !== "object" || body[0] === null) {
        throw new Error("destination insert did not return exactly one representation row.");
      }
      return { kind: "inserted", row: body[0] as Record<string, unknown> };
    },

    async selectById(id: string): Promise<Record<string, unknown> | null> {
      const rows = await selectRows(`id=eq.${encodeURIComponent(id)}`, "destination select by id");
      if (rows.length > 1) throw new Error(`destination select by id returned ${rows.length} rows for one primary key.`);
      return rows[0] ?? null;
    }
  };
}
