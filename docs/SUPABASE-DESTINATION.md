# Supabase Destination Contract v1 — `lyhna-mcp push-pack`

Push one closed, exported Lyhna proof pack into one row of a Supabase table and read it back
with matching refs and digests. This is the **accumulation** gate: the row is the structured
memory record of a verified loop.

```
lyhna-mcp push-pack --pack ./proof-pack --destination supabase [--json]
```

Design contract (do not weaken):

- **Proof export stays pure.** `export-pack` writes the pack locally with no destination
  configured; `push-pack` only ever READS a pack. Supabase is never required for export.
- **No custody transfer.** `receipts.json` is required, digest-bound input — it is **never
  uploaded**. The row carries `receipts_digest`, not the signed chain.
- **Strict Gate-2 packs only.** All ten required artifacts must be present: `receipts.json`,
  `bundle.json`, `graph-node.json`, `scope-capsule.json`, `continuation-capsule.json`,
  `memory-injection.json`, `judgment-ledger.json`, `proof-card.md`, `HANDOFF.md`,
  `verify-instructions.md`. Legacy / judgment-less packs fail closed.
- **Idempotent on `capsule_ref`.** Re-pushing the identical pack reports `already_persisted`
  (exit 0, no second row). A different pack (differing `receipts_digest`) under the same
  `capsule_ref` fails closed — two claims under one capsule_ref never coexist. There is no
  UPDATE and no DELETE path.
- **Read-back verified.** Success is printed only after a SEPARATE read-back request returns
  a row whose refs and digests match what was computed locally.
- **Content-blind Proof Mode is enforced at push time.** A pack claiming `proof` mode whose
  continuation / memory injection / scope capsule carries plaintext state fails closed.
- **Signature verification is OUT OF SCOPE.** `verification_status` records push-pack's own
  structural/digest checks only. To trust the signatures, run:
  `npx -y lyhna-verify --chain <pack>/receipts.json` (the report prints the exact command).

## Table

Create the table once per project (SQL editor or migration). `unique (capsule_ref)` is part of
the contract — the idempotency and conflict semantics depend on it.

```sql
create table lyhna_loop_artifacts (
  id                            uuid primary key default gen_random_uuid(),
  created_at                    timestamptz not null default now(),
  loop_id                       text not null,
  tenant_hash                   text not null,
  scope_ref                     text not null,
  final_turn_ref                text,
  capsule_ref                   text not null unique,
  parent_capsule_ref            text,
  parent_scope_ref              text,
  parent_final_turn_ref         text,
  inherits_state_hash           text,
  mode                          text not null check (mode in ('proof', 'verified_context')),
  sealed                        boolean not null,
  action_count                  integer not null,
  receipt_count                 integer not null,
  proof_bundle                  jsonb not null,
  graph_node                    jsonb not null,
  continuation_capsule          jsonb not null,
  memory_injection              jsonb not null,
  judgment_ledger               jsonb not null,
  proof_card_markdown           text not null,
  handoff_markdown              text not null,
  verify_instructions_markdown  text not null,
  receipts_digest               text not null,
  bundle_digest                 text not null,
  verification_status           text not null,
  verified_at                   timestamptz not null,
  source_env                    text not null,
  exported_at                   timestamptz not null
);

create index lyhna_loop_artifacts_loop_id_idx            on lyhna_loop_artifacts (loop_id);
create index lyhna_loop_artifacts_tenant_hash_idx        on lyhna_loop_artifacts (tenant_hash);
create index lyhna_loop_artifacts_parent_capsule_ref_idx on lyhna_loop_artifacts (parent_capsule_ref);
create index lyhna_loop_artifacts_created_at_idx         on lyhna_loop_artifacts (created_at);
-- capsule_ref is indexed by its unique constraint.
```

Notes:

- A **non-inheriting** pack stores `null` in `parent_capsule_ref` / `parent_scope_ref` /
  `parent_final_turn_ref` / `inherits_state_hash`. Inheritance fields are read ONLY from the
  sealed scope's `inherits_loop` edge — never invented, never trusted from unsigned sidecars
  alone.
- `bundle_digest` does **not** participate in row identity (`exported_at` varies across
  re-exports of the same chain); `capsule_ref` + `receipts_digest` do.
- Verified Context rows carry the loop's plaintext judgment state by design (durable structured
  memory). The Supabase project and its service-role key are therefore part of your trust
  surface — scope access accordingly (RLS for any non-service consumers).

## Environment

```bash
export LYHNA_SUPABASE_URL=https://<project>.supabase.co
export LYHNA_SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
# optional; defaults to lyhna_loop_artifacts, must match ^[A-Za-z_][A-Za-z0-9_]{0,62}$
export LYHNA_SUPABASE_TABLE=lyhna_loop_artifacts
```

**Never commit keys.** The service-role key is read from the environment only; it is never
logged, never echoed in error output, and must never appear in git, CI config, or a pack.
Missing/invalid env fails closed before any network call. CI runs fully mocked — no live
Supabase dependency.

## Manual smoke (real Supabase, out-of-band)

```bash
# 1. export a closed loop's pack (pure, local — works with NO Supabase env set)
lyhna-mcp export-pack --loop <loop_id> --out ./proof-pack

# 2. configure the destination (env only)
export LYHNA_SUPABASE_URL=... LYHNA_SUPABASE_SERVICE_ROLE_KEY=...

# 3. push + read back + verify; prints row id + key refs
lyhna-mcp push-pack --pack ./proof-pack --destination supabase

# 4. re-push to confirm idempotency: already_persisted, exit 0, still one row
lyhna-mcp push-pack --pack ./proof-pack --destination supabase
```

## Failure modes (all fail closed, exit 1, no partial-success wording)

Missing pack path · any required artifact missing/unreadable · malformed JSON · digest cannot
be computed or does not bind (`receipts.json` vs `bundle.json`/`graph-node.json`) ·
cross-artifact ref mismatch (loop_id / goal_hash / scope_ref / capsule_ref / final_turn_ref /
counts) · `tenant_id` present or `tenant_hash` missing/mixed · Proof Mode boundary violated ·
missing/invalid env · unsafe table name · insert HTTP failure · `capsule_ref` conflict with a
differing `receipts_digest` · read-back missing or mismatched (the orphan row id is named so
the operator can inspect it, but the run still fails).
