# Authority tip — REG-P4: payroll calculation rows made append-only in the database

**Date:** 2026-08-17
**Kind:** lane record for candidate PR #793, written to satisfy [AGENTS.md](../../../AGENTS.md) L8.
**Base:** `3785fe3bd` (origin/main, post-#792). Lane head at the time of writing: see the PR; the merge SHA is recorded by the closeout, not predicted here.
**Review:** automated adversarial review by `chatgpt-codex-connector[bot]` on head `0e3bf6be89`, verdict **COMMENTED**, three P1 findings. All three accepted; two changed the migration, one produced this file. No human reviewer identity is recorded because branch protection requires zero approvals — that gap is register row V6 and is not resolved here.
**Scope:** `backend/crates/platform/db/migrations/0222_payroll_payable_runtime_write_revoked.sql` (new), `backend/crates/payroll/adapter-postgres/tests/payroll_lifecycle_rls_as_runtime_role.rs` (one added test), `docs/program/executed-tests-baseline.json` (ratchet), this ledger. No Cargo.toml/Cargo.lock, no OpenAPI, no `ci.yml`.
**Not product authority.** Clears no HOLD. Authorizes no production, payment, issuance, or compliance action.

## Summary

Migration 0186 declares `payroll_line_calculations` rows *"append-only ... only the `payable` flip is a legal update"*. Neither half was enforced. `console_rt` — the role the application runs as — held table-wide INSERT and UPDATE. Measured against a PostgreSQL 18.4 replica of the CI role topology with all 221 migrations applied: as `console_rt`, `UPDATE payroll_line_calculations SET payable = TRUE` **succeeded**.

0222 revokes INSERT and UPDATE at table scope and re-grants **INSERT only**, on every column except `payable`. The runtime role can therefore append a calculation and nothing else.

## Pre-mortem

The way this change kills payroll is by revoking too much: if `console_rt` loses a privilege the calculation writer needs, `calculate` fails closed for every tenant and no draft can be produced. The second failure mode is revoking too little and believing otherwise — the shape the first revision actually took.

## What the review changed

- **Re-granting UPDATE was wrong.** The first revision re-granted UPDATE on every non-`payable` column to avoid disturbing the writer. Nothing in the tree updates this table: the only writer is a plain INSERT with an explicit column list, and there is no `ON CONFLICT DO UPDATE` against it. The re-grant preserved an unused privilege that left `gross_won`, `deductions`, `net_won` and `tax_table_version` rewritable after calculation and review, and those columns are read straight into payslip issuance. Removed.
- **The stated rationale was false.** The candidate claimed `payable` gates payslip issuance. It does not: `load_payslip_issuance_in_tx` validates `legal_basis` and never selects or checks `payable`. The migration is still correct — append-only is the declared contract — but it is justified by that contract, not by an issuance gate that does not exist. **`payable` gates nothing on the production path today; that gap is unresolved and out of scope here.**

## Blast radius

`payroll_line_calculations` only, and only the `console_rt` grant. `console_app` (migration owner) is untouched, so the release path `payable` exists for remains buildable by a later, separately reviewed change. No data is read, written, or migrated; this is a privilege change against an empty-by-default grant surface.

## Detection

The migration proves its own effect and refuses to apply otherwise: it raises `payroll_payable.runtime_update_not_revoked` if any UPDATE survives, `payroll_payable.runtime_insert_not_revoked` if `payable` remains insertable, and `payroll_payable.runtime_lost_legitimate_insert` if the writer's own columns were dropped. In service, the symptom of over-revocation is `calculate` returning insufficient-privilege (SQLSTATE 42501) rather than a wrong number.

## Rollback

Additive and reversible by a corrective migration that re-grants what 0222 removed. Applied migrations are never edited. There is no data change to undo.

## Stop conditions

Halt and reverse if any payroll calculation write fails with SQLSTATE 42501 in any environment, if the migration's own assertions raise on a real database, or if a writer of this table is discovered that this record claims does not exist.

## Verification

- Migration applied cleanly as `console_app` on a fresh database carrying all 222 migrations, after `ops/postgres-reconcile-topology.sh` reconciled the seven-role topology.
- Fail-closed matrix, as `console_rt`: `UPDATE ... SET payable = TRUE` **denied**; `INSERT ... (payable)` **denied**; `UPDATE ... SET net_won` / `gross_won` / `tax_table_version` **denied**; `INSERT` omitting `payable` **allowed**; `SELECT payable` **allowed**.
- `cargo test -p console-payroll-adapter-postgres --test payroll_lifecycle_rls_as_runtime_role` — 2 passed (the new test plus the pre-existing RLS test).
- Mutation proof: **RED** with 0222 removed, **GREEN** restored. This required forcing a rebuild — `#[sqlx::test(migrations = ...)]` embeds the migration set at **compile time**, so moving the file out and back leaves a stale binary that silently tests the old schema. Two earlier attempts at this proof were invalid for exactly that reason and were discarded.
- `cargo fmt --all -- --check` and `cargo clippy --all-targets -- -D warnings` green. Note `cargo fmt` without `--all` does not format `tests/` and exits "Failed to find targets" against this workspace; an earlier run of it reported success while formatting nothing.

## Remaining HOLDs

- `payable` still gates no production path. Issuance validates `legal_basis` only.
- No human review identity. Branch protection requires zero approvals (register V6).
- The register's REG-P4 row should be amended to drop the issuance-gate claim.
