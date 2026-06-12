// `lyhna-mcp verify-cross-loop` — offline two-pack cross-loop linkage checker (Stage E).
//
// Pure, local, deterministic: reads the PRIOR and CURRENT proof-pack directories and re-verifies
// the cross-loop inheritance claims from the artifacts alone. NEVER verifies Ed25519 signatures
// and never shells out — every report says so and prints the lyhna-verify commands to run.

import type { CliIo } from "../capsule-cli.js";
import { CROSS_LOOP_SUCCESS_WORDING, verifyCrossLoopLinkage } from "../cross-loop-verify.js";

export const VERIFY_CROSS_LOOP_USAGE =
  "usage: lyhna-mcp verify-cross-loop --prior <prior-pack-dir> --current <current-pack-dir> [--json]\n" +
  "  Re-verifies a cross-loop inheritance linkage OFFLINE from the two exported proof packs:\n" +
  "  the child's sealed inherits_loop triple recomputes against the prior pack's continuation,\n" +
  "  the prior judgment ledger re-folds to the state its continuation publishes, that state\n" +
  "  hashes to the child's sealed inherits_state_hash, both chains pass the STRUCTURAL check,\n" +
  "  and the commitment-bearing scope_ref is stamped by a signed in-loop receipt.\n" +
  "  Signature verification is OUT OF SCOPE here: re-run lyhna-verify on both receipts.json\n" +
  "  files to trust the signatures (the report prints the exact commands).\n";

export function runVerifyCrossLoop(argv: string[], io: CliIo): number {
  let prior: string | undefined;
  let current: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--prior" || a === "--current") {
      const value = argv[i + 1];
      if (value === undefined) {
        io.stderr(`${a} requires a value.\n${VERIFY_CROSS_LOOP_USAGE}`);
        return 1;
      }
      i += 1;
      if (a === "--prior") prior = value;
      else current = value;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      io.stdout(VERIFY_CROSS_LOOP_USAGE);
      return 0;
    } else {
      io.stderr(`unknown argument ${a}\n${VERIFY_CROSS_LOOP_USAGE}`);
      return 1;
    }
  }
  if (!prior || !current) {
    io.stderr(`--prior and --current are required.\n${VERIFY_CROSS_LOOP_USAGE}`);
    return 1;
  }

  const result = verifyCrossLoopLinkage({ prior_pack_dir: prior, current_pack_dir: current });

  if (json) {
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  for (const check of result.checks) {
    io.stdout(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}\n`);
  }
  io.stdout("\n");
  if (result.ok) {
    io.stdout(`${CROSS_LOOP_SUCCESS_WORDING}\n`);
  } else {
    io.stdout(`Linkage NOT verified (fail closed). ${result.signature_notice}\n`);
  }
  io.stdout(`  ${result.verify_commands[0]}\n  ${result.verify_commands[1]}\n`);
  return result.ok ? 0 : 1;
}
