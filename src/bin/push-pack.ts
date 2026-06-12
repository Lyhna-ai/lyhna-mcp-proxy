// `lyhna-mcp push-pack` — push one exported proof pack into one Supabase row, read it back,
// and verify refs + digests (Supabase Destination Contract v1).
//
// Composable by construction: export-pack writes the pack locally with no destination configured;
// push-pack READS that pack. Missing destination env fails closed here BEFORE any network call
// and before the pack is even opened, so proof export can never come to depend on Supabase.

import type { CliIo } from "../capsule-cli.js";
import { createSupabaseLoopArtifactClient, resolveSupabaseEnv } from "../destinations/supabase.js";
import { pushPack } from "../push-pack.js";

export const PUSH_PACK_USAGE =
  "usage: lyhna-mcp push-pack --pack <pack-dir> --destination supabase [--json]\n" +
  "  Pushes a closed, exported Gate-2 proof pack into ONE row of the lyhna_loop_artifacts table\n" +
  "  and reads it back: all ten required artifacts are validated and cross-checked, receipts/\n" +
  "  bundle digests are recomputed, and success prints the row id + key refs ONLY after a\n" +
  "  separate read-back matches. Idempotent on capsule_ref: re-pushing the identical pack\n" +
  "  reports already_persisted (exit 0, no second row); a DIFFERENT pack under the same\n" +
  "  capsule_ref fails closed. receipts.json is digest-bound input but is never uploaded.\n" +
  "  Env: LYHNA_SUPABASE_URL, LYHNA_SUPABASE_SERVICE_ROLE_KEY,\n" +
  "       LYHNA_SUPABASE_TABLE (default lyhna_loop_artifacts). Never commit keys.\n" +
  "  Signature verification is OUT OF SCOPE here: re-run lyhna-verify on the pack's\n" +
  "  receipts.json to trust the signatures (the report prints the exact command).\n";

export async function runPushPack(
  argv: string[],
  io: CliIo,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  let pack: string | undefined;
  let destination: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--pack" || a === "--destination") {
      const value = argv[i + 1];
      if (value === undefined) {
        io.stderr(`${a} requires a value.\n${PUSH_PACK_USAGE}`);
        return 1;
      }
      i += 1;
      if (a === "--pack") pack = value;
      else destination = value;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      io.stdout(PUSH_PACK_USAGE);
      return 0;
    } else {
      io.stderr(`unknown argument ${a}\n${PUSH_PACK_USAGE}`);
      return 1;
    }
  }
  if (!pack || !destination) {
    io.stderr(`--pack and --destination are required.\n${PUSH_PACK_USAGE}`);
    return 1;
  }
  if (destination !== "supabase") {
    io.stderr(`unknown destination ${JSON.stringify(destination)}; only "supabase" is supported.\n${PUSH_PACK_USAGE}`);
    return 1;
  }
  // Env resolution fails closed BEFORE any network call and before the pack is read.
  const resolved = resolveSupabaseEnv(env);
  if (!resolved.ok) {
    io.stderr(`${resolved.detail}\n`);
    return 1;
  }
  const client = createSupabaseLoopArtifactClient(resolved.config, fetchImpl);
  const report = await pushPack({ pack_dir: pack, table: resolved.config.table, client });

  if (json) {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }
  for (const check of report.checks) {
    io.stdout(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}\n`);
  }
  io.stdout("\n");
  if (report.ok && report.refs && report.row_id) {
    io.stdout(
      `${report.status === "already_persisted" ? "Already persisted" : "Persisted"} to ${report.table} (read-back verified).\n`
    );
    io.stdout(`row_id: ${report.row_id}\n`);
    for (const [key, value] of Object.entries(report.refs)) {
      io.stdout(`${key}: ${value ?? "null"}\n`);
    }
    io.stdout(`\n${report.signature_notice}\n  ${report.verify_command}\n`);
    return 0;
  }
  io.stdout(`Push FAILED closed — no verified row. See the FAIL line above.\n`);
  return 1;
}
