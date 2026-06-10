// Capsule CLI verbs — `lyhna-mcp handoff` and `lyhna-mcp post`.
//
// These are READERS over an exported proof pack directory. They never bind, never sign, never
// mutate a pack, and never hold credentials:
//
//   handoff  — prints the paste-ready continuation prompt (THE HANDOFF) from a pack.
//   post     — posts THE CARD (proof-card.md) to a GitHub PR using the USER'S OWN `gh` CLI
//              identity. Lyhna holds no GitHub token, installs no app, receives no webhook —
//              the user is the courier, one command.
//
// Trust note (printed by `handoff`): a pack on disk is untrusted input until verified. These
// verbs read what the pack says; `lyhna-verify --chain receipts.json` is what makes it trustable.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ContinuationCapsule } from "./continuation-capsule.js";
import { buildHandoffPrompt, renderHandoffMarkdown } from "./handoff.js";

export type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

export const HANDOFF_USAGE =
  "usage: lyhna-mcp handoff [pack-dir] [--md]\n" +
  "  Prints the paste-ready next-agent handoff prompt from an exported proof pack\n" +
  "  (default pack-dir: current directory). --md prints the full HANDOFF.md rendering.\n";

export const POST_USAGE =
  "usage: lyhna-mcp post --pr <number> [pack-dir] [--repo <owner/name>]\n" +
  "  Posts the pack's proof card (proof-card.md) as a comment on a GitHub pull request\n" +
  "  using YOUR OWN GitHub CLI credentials (`gh auth login`). Lyhna never holds a GitHub\n" +
  "  token. Default pack-dir: current directory.\n";

/** Read and lightly shape-check the continuation capsule from a pack directory. */
function readContinuation(packDir: string, io: CliIo): ContinuationCapsule | null {
  const contPath = path.join(packDir, "continuation-capsule.json");
  if (!existsSync(contPath)) {
    io.stderr(
      `no continuation-capsule.json in ${path.resolve(packDir)} — point at an exported proof pack ` +
        `directory (the output of export-loop-proof).\n`
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(contPath, "utf8"));
  } catch (error) {
    io.stderr(`continuation-capsule.json is not valid JSON: ${(error as Error).message}\n`);
    return null;
  }
  const c = parsed as ContinuationCapsule;
  if (
    c === null ||
    typeof c !== "object" ||
    c.capsule_type !== "continuation_capsule" ||
    typeof c.loop_id !== "string" ||
    typeof c.scope_ref !== "string"
  ) {
    io.stderr(`continuation-capsule.json does not look like a continuation capsule (capsule_type/loop_id/scope_ref).\n`);
    return null;
  }
  return c;
}

/** `lyhna-mcp handoff [pack-dir] [--md]` — print the handoff prompt (or full HANDOFF.md). */
export function runHandoff(argv: string[], io: CliIo): number {
  let packDir = ".";
  let full = false;
  for (const a of argv) {
    if (a === "--md") full = true;
    else if (a === "--help" || a === "-h") {
      io.stdout(HANDOFF_USAGE);
      return 0;
    } else if (a.startsWith("-")) {
      io.stderr(`unknown flag ${a}\n${HANDOFF_USAGE}`);
      return 1;
    } else packDir = a;
  }
  const continuation = readContinuation(packDir, io);
  if (!continuation) return 1;
  io.stdout(full ? renderHandoffMarkdown(continuation) : `${buildHandoffPrompt(continuation)}\n`);
  // Reader honesty: stderr only (stdout stays clean for piping/pasting).
  io.stderr(
    `[lyhna] handoff read from ${path.join(packDir, "continuation-capsule.json")} — a pack is untrusted ` +
      `until verified: npx lyhna-verify --chain ${path.join(packDir, "receipts.json")}\n`
  );
  return 0;
}

export type SpawnGh = (args: string[]) => { status: number | null; error?: Error };

const defaultSpawnGh: SpawnGh = (args) => {
  const result = spawnSync("gh", args, { stdio: "inherit" });
  return { status: result.status, error: result.error };
};

/** Build the exact `gh` argv for posting the card (pure; covered by tests). */
export function buildGhPostArgs(pr: number, cardPath: string, repo?: string): string[] {
  return ["pr", "comment", String(pr), "--body-file", cardPath, ...(repo ? ["--repo", repo] : [])];
}

const REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `lyhna-mcp post --pr <n> [pack-dir] [--repo owner/name]` — post THE CARD with the user's gh. */
export function runPost(argv: string[], io: CliIo, spawnGh: SpawnGh = defaultSpawnGh): number {
  let packDir = ".";
  let pr: number | undefined;
  let repo: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--pr") {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        io.stderr(`--pr must be a positive integer (got ${JSON.stringify(raw)})\n${POST_USAGE}`);
        return 1;
      }
      pr = n;
    } else if (a === "--repo") {
      const raw = argv[++i];
      if (!raw || !REPO_SHAPE.test(raw)) {
        io.stderr(`--repo must be owner/name (got ${JSON.stringify(raw)})\n${POST_USAGE}`);
        return 1;
      }
      repo = raw;
    } else if (a === "--help" || a === "-h") {
      io.stdout(POST_USAGE);
      return 0;
    } else if (a.startsWith("-")) {
      io.stderr(`unknown flag ${a}\n${POST_USAGE}`);
      return 1;
    } else packDir = a;
  }
  if (pr === undefined) {
    io.stderr(`--pr <number> is required.\n${POST_USAGE}`);
    return 1;
  }
  const cardPath = path.join(packDir, "proof-card.md");
  if (!existsSync(cardPath)) {
    io.stderr(
      `no proof-card.md in ${path.resolve(packDir)} — export the proof pack first (export-loop-proof ` +
        `with --scope-capsule/--continuation).\n`
    );
    return 1;
  }
  const ghArgs = buildGhPostArgs(pr, cardPath, repo);
  io.stderr(`[lyhna] posting ${cardPath} to PR #${pr} with YOUR gh credentials: gh ${ghArgs.join(" ")}\n`);
  const result = spawnGh(ghArgs);
  if (result.error) {
    io.stderr(
      `could not run the GitHub CLI (gh): ${result.error.message}\n` +
        `Install it (https://cli.github.com) and authenticate with \`gh auth login\`. ` +
        `Lyhna never holds your GitHub credentials — this command posts as you.\n`
    );
    return 1;
  }
  return result.status ?? 1;
}
