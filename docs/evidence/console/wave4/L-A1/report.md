# L-A1 — ontology catalog additive-upgrade path

**Lane** `w4-a1-catalog` · **worktree** `/Users/jasonlee/Developer/maintenance-worktrees/w4-a1-catalog-20260725`
· **branch** `claude/w4-a1-catalog-20260725` · **migration slot** 0211
· **date** 2026-07-25

> **Slot history.** L-A1 was first assigned 0203 and committed against it. The
> integrator then swapped 0203↔0211 in ledger commit `b33cbc4d`, and
> `0203_leave_api_revoke_directory_manager_helper.sql` merged onto the spine
> under the old number. The migration and every reference to it were renumbered
> to **0211** before this lane finished; no `0203` reference survives anywhere
> in L-A1's diff.

---

## 1. The blocker, restated from evidence

`ontology_api.install_builtin_catalog` (migration
`0165_ontology_object_type_key_revisions.sql`) had two fail-closed guards and no
way past either:

| Guard | Line (0165) | Error |
|---|---|---|
| tenant already installed a *different* catalog version | 1136 | `ontology_builtin.different_catalog_already_installed` (23505) |
| tenant has **any** pre-existing `ont_object_types` row | 1140 | `ontology_builtin.empty_org_required` (23514) |

Consequence: no seeded tenant could ever receive a 28th built-in object type.
Reproduced as a red test before the fix — see §4.1.

## 2. What was built

One migration, `backend/crates/platform/db/migrations/0211_ontology_catalog_additive_upgrade.sql`.
No new tables, no Rust API change, no OpenAPI/client change.

**`ont_builtin_catalog_installs` becomes an append-only per-tenant history.**
Primary key moves from `(org_id)` to `(org_id, catalog_version)`. `mnt_ontology_writer`
keeps its 0165 `SELECT, INSERT` and still has **no UPDATE**: an upgrade appends a
row, it never rewrites the tenant's install record. Nothing in the repo FKs to
this table.

**`install_builtin_catalog` becomes additive.** Same signature, same
`RETURNS TABLE(installed BOOLEAN, object_type_count BIGINT)`, so no caller
changes. New behaviour once the manifest is trusted:

1. **The digest chain is untouched and still the sole authority.** A manifest is
   accepted only when `sha256(canonical jsonb text)` equals the migration-owned
   `ont_builtin_catalog_allowlist` row for the presented catalog version.
2. **Exact re-application is a no-op.** Decided on the recorded
   `(org_id, catalog_version, manifest_digest)` triple, before any work. Because
   markers are now history, re-applying an *older* recorded version after an
   upgrade is also a no-op rather than a silent downgrade.
3. **Keys the tenant lacks are created** exactly as before — published
   `schema_version` 1, full child snapshot, one
   `ontology.object_type.builtin_install` audit row each.
4. **Keys the tenant already holds are left alone.** Never updated, never
   restaged, never renumbered, never republished, and they gain no links.
5. **Pass-2 link resolution binds to the tenant's published head**
   (`lifecycle_state = 'published'`) instead of `schema_version = 1`, so a newly
   installed type can link to a type that arrived with an earlier catalog
   version. On a fresh install the two predicates select the same row.
6. **The pristine-tenant guard is deliberately KEPT for a tenant's first
   install.** `empty_org_required` still fires when there is no marker and the
   org already has object types — bootstrap must not interleave with
   hand-authored types. Additive behaviour is reachable only as an *upgrade*.
   The existing race/non-empty assertions in
   `key_write_cas_as_runtime_role.rs` therefore pass unchanged.
7. **A retained key may not contradict the projection contract.** If an existing
   key's `backing_kind` / `backing_table` / `primary_key_property` differ from
   the manifest's, the whole install rolls back with
   `ontology_builtin.existing_key_projection_conflict` (23514). Without this,
   a hand-authored type could silently stand in for a built-in of the same name
   — for a `projected` type that means reads against a different physical table.
8. **The marker append is audited.** One
   `ontology.builtin_catalog.install` / `.upgrade` row per applying call,
   `target_type = 'ont_builtin_catalog_installs'`, carrying `catalog_version`,
   `manifest_digest`, `installed_keys[]` and `retained_keys[]`. On an upgrade
   that adds no key this is the only state change, so it is the only thing that
   would otherwise be unaudited. Neither action name is in the protected set of
   `ontology_api.protected_audit_writer_guard`, and neither is used to satisfy
   `require_current_transaction_audit` — the per-type `builtin_install` rows
   still do that on their own.

Also in this lane: `seed.rs`'s doc comment on `create_action` claimed
`PgOntologyStore::transition_lifecycle` reuses it to auto-attach a create action
on publish. It does not — `transition_lifecycle` only calls
`ontology_api.transition_object_type`, and the auto-attach lives in that
routine's SQL (0165). Comment corrected to say so.

## 3. Ownership and shared roots

| Path | Owned? | Note |
|---|---|---|
| `backend/crates/ontology/**` | yes | test + BUCK target + seed.rs doc fix |
| `docs/evidence/console/wave4/L-A1/**` | yes | this report + manifests |
| `backend/crates/platform/db/migrations/0211_*.sql` | **shared** | slot 0211 assigned to L-A1 by the ledger; written in-tree per the ledger's recorded integrator deviation (§5 note, 2026-07-25). Manifest: `manifests/shared-roots.json` |
| `tools/buck/gen_first_party.py` | **foreign** | one appended dict line registering the new test's postgres resource. Manifest: `manifests/shared-roots.json` |

Untouched: `web/**`, `backend/openapi/openapi.yaml`, `clients/**`,
`backend/app/src/lib.rs`, `backend/app/src/objects.rs`, `ko.ts`, `nav.ts`,
`registry.ts`.

## 4. Proof

Harness: a disposable PostgreSQL 18.4 container mirroring
`tools/buck/test_needs_postgres.sh` — `mnt_buck_admin` superuser with the
`mnt.sqlx_test_bootstrap=buck-sqlx-superuser-v1` startup marker (required by
migration 0196) and the full seven-role topology from
`ops/postgres-reconcile-topology.sh`. The shared `mnt-dev` stack was never
brought down; nothing was run against it.

New test file:
`backend/crates/ontology/adapter-postgres/tests/builtin_catalog_additive_upgrade_as_runtime_role.rs`
(4 tests). Every tenant-visible read goes through a pooled **`mnt_rt`**
connection with `app.current_org` armed — FORCE RLS is actually exercised, not
bypassed by the owner.

### 4.1 Red before green

With `0211_*.sql` removed from the migrations directory:

```
test additive_upgrade_adds_only_new_keys_and_is_idempotent_as_runtime_role ... FAILED
test retained_key_contradicting_the_projection_contract_fails_closed_as_runtime_role ... FAILED
  Err: PgDatabaseError { code: "23505",
       message: "ontology_builtin.different_catalog_already_installed",
       where: "PL/pgSQL function ontology_api.install_builtin_catalog(...) line 49 at RAISE" }
test result: FAILED. 1 passed; 2 failed
```

With the migration restored: `4 passed; 0 failed`.

### 4.2 What each test asserts

| Test | Claim |
|---|---|
| `shipped_catalog_digest_matches_its_migration_allowlist_row` | the manifest Rust builds today hashes to exactly the row a migration pinned for `BUILTIN_CATALOG_VERSION`; on failure it prints the `decode('<hex>','hex')` literal a new allowlist migration needs |
| `additive_upgrade_adds_only_new_keys_and_is_idempotent_as_runtime_role` | seed at `2026-07-19.1` (27 types) then upgrade to a 28-type version. Every one of the 27 pre-existing keys is **byte-identical** afterwards, compared as `mnt_rt` over a fingerprint that includes row ids, `schema_version`, `lifecycle_state`, `created_at`/`updated_at`, the key-revision sidecar (`validator_id`, `revision`), and every property / link / action / analytic row. The new type is published at v1, its logical link resolves to **this tenant's `customer` type installed by the earlier version**, zero cross-tenant links. Audits: 28 `builtin_install` rows (exactly one for the new key), 1 `builtin_catalog.install`, 1 `builtin_catalog.upgrade` whose `installed_keys` is `["catalog_upgrade_probe"]` and `retained_keys` has 27 entries. Then re-applying the upgrade **and** re-applying the older version both return `installed=false` and leave every registry row, marker and audit unchanged |
| `upgraded_catalog_installs_whole_on_a_fresh_tenant_and_stays_isolated_as_runtime_role` | a tenant with no catalog receives all 28 whole; a tenant that took only `2026-07-19.1` sees 27 and cannot see the new key; as `mnt_rt` each tenant's fingerprint contains only its own `org_id`; no `ont_link_types` row anywhere targets another tenant's type |
| `retained_key_contradicting_the_projection_contract_fails_closed_as_runtime_role` | a third version that redeclares an already-installed `instance` key as `projected` raises `ontology_builtin.existing_key_projection_conflict` and leaves **zero** residue — registry fingerprint, marker history and audit footprint all identical to before the attempt |

### 4.3 Commands run

| Command | Result |
|---|---|
| `cargo test -p mnt-ontology-adapter-postgres --test builtin_catalog_additive_upgrade_as_runtime_role -- --test-threads=1` | **4 passed, 0 failed** |
| `cargo test -p mnt-ontology-adapter-postgres --test key_write_cas_as_runtime_role` (x3) | **7 passed** each — the security-reviewed installer contract, unchanged |
| `cargo test -p mnt-ontology-adapter-postgres --test key_revision_migration_upgrade -- --test-threads=1` (x3) | **3 passed** each |
| `--test c_chain / config_object_types / niche_config_object_types / projected_instances_read / instances_rls_surfaces / instances_residual_filter / registry_rls_surfaces` | **2 / 2 / 2 / 2 / 3 / 2 / 16 passed**, 0 failed |
| `cargo test -p mnt-ontology-adapter-postgres` (lib unit) | **4 passed** |
| `cargo test -p mnt-ontology-rest --test action_execute / ont_gaps / projected_dispatch / publish_auto_create_action` | **9 / 5 / 5 / 2 passed**, 0 failed |
| `cargo test -p mnt-platform-rest --test onboard_seeds_config_objects` | **1 passed** |
| `cargo fmt --check -p mnt-ontology-adapter-postgres` | clean |
| `cargo clippy -p mnt-ontology-adapter-postgres --all-targets -- -D warnings` | clean |
| `cargo run -p mnt-gate-tenant-isolation` | **PASSED** |
| `cargo run -p mnt-gate-audit-coverage` | **PASSED** |
| `cargo run -p mnt-gate-rls-arming` | **PASSED** |
| `cargo run -p mnt-gate-migration-safety` | **FAILED — contiguity only, no duplicate**, see §5.1 |

## 5. Honest residuals

### 5.1 `mnt-gate-migration-safety` — no duplicate; 9 contiguity gaps, none actionable here

After the renumber the gate reports **no `DuplicateMigrationVersion`** — the
0203 collision with the merged
`0203_leave_api_revoke_directory_manager_helper.sql` is gone. What remains is
contiguity:

```
mnt-gate-migration-safety: FAILED - 9 violation(s):
  [NonContiguousMigrationVersion] missing migration version 0201 before 0202
  [NonContiguousMigrationVersion] missing migration version 0203 before 0211
  ... 0204, 0205, 0206, 0207, 0208, 0209, 0210 before 0211
```

Two distinct causes, neither this lane's to fix:

- **0201** — the ledger's deliberate reserved gap. Reproduced with `0211_*.sql`
  removed (gate then reports exactly this one violation). **Taken by the
  integrator on 2026-07-25**; L-A1 was instructed not to fill or renumber
  around it.
- **0203–0210** — an artifact of lane isolation. This worktree holds only
  L-A1's migration, so every sibling slot below 0211 reads as missing. All
  eight are real and land on merge: 0203 (leave, already on the spine) and
  0204–0210 (CRM lanes L-X1…L-X5, L-X7, L-X8 per ledger §4). The gate can
  therefore only go green **on the merged spine**, never in this worktree.

**One thing for the integrator to watch:** L-A1 now holds the highest slot, so
if any of 0204–0210 is dropped rather than landed, 0211 leaves a permanent
contiguity gap behind it.

### 5.2 `tools/buck/gen_first_party.py` — resolved elsewhere; this lane's target verified

Reported by this lane: the generator aborted on **14 pre-existing unregistered
test targets** from other lanes (mnt-app `board_ack_api`,
`evaluation_cycle_api`, `field_visit_api`, `maintenance_chain_api`,
`notif_routing_api`, `org_change_api`, `recruiting_pipeline_api`;
`mnt-orgchange-domain` unit; `mnt-payroll-adapter-postgres`
`payroll_lifecycle_rls_as_runtime_role` + unit; `mnt-payroll-rest`
`run_lifecycle_api`; `mnt-recruiting-application` unit;
`mnt-recruiting-domain` unit; `mnt-workorder-domain` `settlement_fsm`).

**Fixed by the `hf-buck-preflight` lane** (`claude/hf-buck-preflight-20260725`
@ `b84c2598`), which reports that intervening spine commits supplied most of
the declarations and that it added the remainder, including one
(`mnt-platform-db` `tests/lifecycle_maker_checker.rs`) introduced by the
four-eyes merge. With that table, `gen_first_party.py` and
`tools/buck/preflight.sh` both exit 0. Not independently re-verified by L-A1 —
that lane's branch is not merged here.

**This lane's hand-written target is confirmed byte-identical to generator
output.** That lane took L-A1's evidence commit into a throwaway worktree,
merged its own branch in to supply the full declaration table, and re-ran the
generator: 166 BUCK files generated, exit 0, `git status --short` empty —
`backend/crates/ontology/adapter-postgres/BUCK` came back unchanged. No
follow-up needed beyond taking the spine.

L-A1 keeps its one appended `TEST_RESOURCE_REQUIREMENTS` line; that is the
declaration and it is correct. Until this branch takes the spine (or that
lane's branch) its local copy of the table has only L-A1's entry, so the
generator still raises here — expected, not a new break.

### 5.3 `mnt-ontology-rest --test object_type_cas_as_runtime_role` is red on this branch

`blocker_queue_is_tenant_scoped_cascades_and_attachment_effects_are_write_checked`
and `instance_list_composes_enforced_permit_forbid_and_tenant_scope` fail with
`"unable to evaluate object visibility policy"`. Verified **identical with and
without 0211** — pre-existing, not this lane's. Reported to the integrator
2026-07-25; acknowledged and being routed.

### 5.4 `key_revision_migration_upgrade.rs` is racy under one shared PostgreSQL

It rewrites **cluster-global** role attributes (`ALTER ROLE mnt_app ...`,
`REVOKE mnt_ontology_writer FROM ...`) to reduce the schema to its pre-0165
shape, so two cargo test binaries hitting the same server can clobber each
other. Reproduced **without** 0211 (2 of 3 baseline runs red). Green 3/3 when
run alone. Buck gives every target its own disposable PostgreSQL plus
`RUST_TEST_THREADS=1`, so CI is unaffected. Not fixed here — it is not this
lane's file to redesign.

### 5.5 Deliberate limits of the additive path

- **Retained keys gain no links.** A new type's *outbound* links resolve against
  existing types. The reverse edge — an already-installed type linking *to* a new
  type — is not installed, because that would mutate a retained key. A catalog
  version that needs the reverse direction must express it on the new type, or
  wait for a real staged revision of the existing one.
- **A retained key is trusted for everything except its projection contract.**
  Title, properties, actions and analytics of a hand-authored key that collides
  with a built-in are not compared. The `retained_keys` audit array is the
  record that the installer stood down; divergence is observable, not prevented.
- **No downgrade.** Re-applying an older recorded version is a no-op; it does
  not remove keys. Removing a built-in type remains out of scope for the
  installer entirely.

### 5.6 What this lane does NOT do

It adds **no** new built-in object type and does **not** bump
`BUILTIN_CATALOG_VERSION`. It builds the path; CRM's L-X7 walks it.

## 6. Handoff to L-X7 (deal / listing / inquiry ontology projections)

To land a new built-in type on top of this:

1. `backend/crates/ontology/adapter-postgres/src/seed.rs` — add the `*_KEY`
   const, the draft builder, and an entry in the `drafts` vec of
   `builtin_catalog_manifest()` (plus `PROJECTED_DOMAIN_KEYS` if projected).
   Link targets must be catalog stable keys; the installer rejects physical
   link ids (`ontology_builtin.physical_link_id_forbidden`).
2. Bump `BUILTIN_CATALOG_VERSION` (`seed.rs:68`). Do **not** edit a draft
   without bumping — the digest chain will reject every install.
3. Get the new digest: run
   `cargo test -p mnt-ontology-adapter-postgres --test builtin_catalog_additive_upgrade_as_runtime_role -- --exact shipped_catalog_digest_matches_its_migration_allowlist_row`.
   It fails and prints the exact literal for step 4.
4. Request a migration slot from the ledger; that migration is one statement:
   `INSERT INTO ont_builtin_catalog_allowlist (catalog_version, manifest_digest)
   VALUES ('<new-version>', decode('<hex from step 3>','hex'));`
   Re-run the test — it goes green, and every seeded tenant can now upgrade.
5. Projected types only: add the backing table to `allowlisted_projected_table`
   (`adapter-postgres/src/instances.rs:955-974`). Without it the type registers
   and then 400s on every list. Note `validate_draft` does **not** check this —
   the failure surfaces at read time.
6. Nothing else. No OpenAPI change, no client regen, no
   `backend/app/src/lib.rs` edit, no analytics registration.

Seeded tenants pick the new version up the next time a seeder runs
(`backend/app/src/lib.rs:2847`, `TenantConfigSeeder`), which is now an additive
upgrade instead of a raise.
