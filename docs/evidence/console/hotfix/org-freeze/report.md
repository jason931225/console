# Hotfix — org 변경 동결창 (change freeze window) enforcement on effectuate

Lane `hf-org-freeze` · worktree `hf-org-freeze-20260725` · 2026-07-25

## 1. The defect

DESIGN.md §3.9.1 lists **변경 동결 창(freeze window)** as one of the six
governance mechanisms every org change is subject to:

> **변경 동결 창(freeze window)**: 급여 마감·회계 결산 중 조직 변경 제한.

The org-change engine implemented five of the six. The freeze window existed
only as an **advisory chip pushed unconditionally on every preflight**
(`compute_preflight`, `FREEZE_WINDOW_REVIEW` — its own comment read *"imperative
reminders, not computed claims"*), and **no gate at all on the apply path**:

- `PgOrgChangeStore::effectuate` gated on status (`APPROVED`) and on the
  effective date (`today_kst() < effective_date`) — nothing else.
- `PgOrgChangeStore::archive` replays the deferred DISSOLVE ops (branch/region
  deactivation) and had the same hole.

So an approved org change could be applied with an effective date inside a
closed payroll or accounting period, rewriting the scope and attribution of a
run that is already sealed. Proven, not asserted — see §5 (red run).

## 2. The mechanism reused (no second freeze concept)

`period_locks` (migration `0107_create_period_locks_versioning_lifecycle.sql`)
already is the platform's freeze-window enforcement: an append-only row with
`unlocked_at IS NULL` closes `[period_start, period_end]` for one domain
(`payroll` | `accounting`), FORCE RLS + `org_isolation`, one-shot-unlock
trigger, `GRANT SELECT, INSERT, UPDATE … TO mnt_rt`. Its Rust half is
`mnt_platform_db::period_lock::{assert_period_open, assert_period_open_range}`,
already consumed by `mnt-financial-adapter-postgres` (cost ledger) and
`mnt-workflow-adapter-postgres` (payroll draft drain).

This lane **adds no table, no migration, no new error vocabulary and no second
lock concept** — it calls the existing guard. The refusal message is the shared
one (`"<domain> period <start>..<end> is locked; write dated … refused"`), which
already reaches clients from the financial surface; inventing a second phrasing
for the same refusal was rejected deliberately.

## 3. What changed

`backend/crates/orgchange/adapter-postgres/src/lib.rs`

1. **`assert_change_window_open(tx, effective_date)`** — checks
   `assert_period_open` for **both** freeze domains (§3.9.1 names 급여 마감 *and*
   회계 결산) inside the caller's already-armed transaction, so the lookup is
   RLS-scoped to the caller's tenant and a refusal rolls the whole apply back.
2. **Called from `apply_ops`**, which is the single function both live-apply
   entry points route through (`effectuate` for NEW/REORG, `archive` for the
   deferred DISSOLVE ops) — the root-cause placement, not a per-caller patch.
   Plus one explicit call in `effectuate`'s `Dissolve` arm, which opens
   settlement without going through `apply_ops`.
3. **`PgOrgChangeError::Frozen(KernelError)`** — a typed variant distinct from
   `Domain`, so the refusal is recognisable to the caller. It maps through the
   existing `kind()`/`message()` surface to the canonical envelope
   `409 {"error":{"code":"conflict","message":"…"}}` naming the blocking domain
   and window. No REST change, no openapi change (status code and envelope are
   unchanged; `409` was already documented for this route).
4. **`record_freeze_refusal`** — the refused business transaction rolls back and
   takes every audit row inside it with it, so the §3.10-⑥ detection record is
   committed in its **own** transaction: action
   `org_change.effectuate.refused` / `org_change.archive.refused`,
   `target_type = org_change_request`, `anomaly = true`, `reason` = the refusal
   message. Anything but a `Frozen` outcome passes through untouched.
5. **`compute_preflight` freeze signal is now computed.** The unconditional
   `FREEZE_WINDOW_REVIEW` chip is replaced by a real read of the same period
   locks for the request's effective date; the warning appears only when a lock
   genuinely covers it, and its label names that window. It stays a *warning*
   rather than a *blocker* because a lock can be lifted before the effective
   date arrives — the hard stop lives at effectuate (§3.10 예방 gate).
   A non-conflict error from the lock read propagates; it is not swallowed into
   a warning.

## 4. Legitimate paths preserved

- Effective date outside every active lock → applies, **even while the tenant
  has other active locks** over different periods (asserted).
- Another tenant's lock over the same window is invisible: the read is
  RLS-scoped (asserted with a second org's active lock covering today).
- Status/effective-date/SoD gates are unchanged; a refused apply leaves the
  request `APPROVED` and retryable.

## 5. Evidence

All backend assertions execute through the assembled HTTP router against a
**runtime-role (`mnt_rt`) pool** — `runtime_role_pool()` issues `SET ROLE
mnt_rt` on every connection and `app_state` is built from it, so RLS is real
and superuser BYPASSRLS cannot mask it. Superuser is used only to seed fixtures.

Harness: disposable PostgreSQL 18.4 container with the repo's own topology
bootstrap (`ops/postgres-reconcile-topology.sh`), `mnt_buck_admin` +
`mnt.sqlx_test_bootstrap=buck-sqlx-superuser-v1`, `SQLX_OFFLINE=true`. The
shared dev stack was not touched.

### Red — the defect reproduced

With `assert_change_window_open` neutered to `Ok(())` and nothing else changed:

```
test effectuate_is_frozen_inside_a_locked_period_and_records_the_attempt ... FAILED
  left: 200, right: 409
  → "status":"APPLIED" … "action":"effectuate","fromStatus":"APPROVED","toStatus":"APPLIED"
```

i.e. the org change applied cleanly **inside an active payroll lock**.

### Green

```
cd backend && SQLX_OFFLINE=true <pg-harness> cargo test -p mnt-app --test org_change_api
running 4 tests
test authorization_denies_without_leakage_and_conceals_other_tenants ... ok
test dissolve_settles_then_archives_with_referential_net ... ok
test effectuate_is_frozen_inside_a_locked_period_and_records_the_attempt ... ok
test reorg_lifecycle_runs_draft_to_applied_with_ordered_sod ... ok
test result: ok. 4 passed; 0 failed
```

`effectuate_is_frozen_inside_a_locked_period_and_records_the_attempt`
(`backend/app/tests/org_change_api.rs`) asserts, as `mnt_rt`:

| # | Assertion |
|---|---|
| 1 | Preflight surfaces exactly one `FREEZE_WINDOW_REVIEW` warning, naming the blocking `payroll` window — computed from the lock, not pushed |
| 2 | `POST …/effectuate` inside an active **payroll** lock → `409`, message names `payroll` and the window |
| 3 | Same for an active **accounting** lock |
| 4 | The request stays `APPROVED` after each refusal |
| 5 | No org row was written (`branches` count 0) and **zero** `org_change.effectuate` audit rows |
| 6 | Exactly two `org_change.effectuate.refused` audit rows, each `org_id` = KNL, `actor` = the applying executive, `anomaly = true`, `reason` naming the blocking domain |
| 7 | With both locks lifted but an own-tenant lock over a *past* month still active **and** a foreign tenant's lock covering today still active → `effectuate` returns `200 APPLIED` and the region really renamed |
| 8 | A fresh draft whose effective date falls outside those still-active locks carries **no** freeze warning |

`dissolve_settles_then_archives_with_referential_net` gained the sibling proof:
a lock opened after effectuate refuses `archive` with a `409` naming
`accounting`, the branch stays active, one `org_change.archive.refused` audit
row lands, and after unlock the archive applies the deferred deactivation.

### Gates

```
cargo fmt --check                                          # clean (whole workspace)
cargo clippy -p mnt-orgchange-adapter-postgres \
             -p mnt-orgchange-domain -p mnt-orgchange-rest \
             --all-targets -- -D warnings                  # clean
cargo test -p mnt-orgchange-domain                         # 8 passed
cargo run -p mnt-gate-audit-coverage                       # PASSED
cargo run -p mnt-gate-tenant-isolation                     # PASSED
cargo run -p mnt-gate-rls-arming                           # PASSED
cargo run -p mnt-gate-dev-auth-absence                     # PASSED
```

## 6. Honest gaps

- **Pre-existing, not this lane:** workspace-wide
  `cargo clippy --all-targets -- -D warnings` fails on
  `backend/crates/dispatch/application/src/lib.rs:267`
  (`clippy::double_must_use` on `DispatchQueueCursor::encode`). Byte-identical
  on the integration spine, so it is not a wave-4 regression — but CI's clippy
  step is workspace-wide and will be red until someone owning that crate drops
  the redundant `#[must_use]`. Out of this lane's roots.
- **`OPEN_DOCS_REVIEW` is still an unconditional reminder chip.** The sibling
  §3.9.1 signal has no existing mechanism to reuse (there is no "open
  approvals/postings" query surface yet), so it was left as found rather than
  fabricated. Registered follow-up.
- **No Buck2 run.** Verified with cargo; `buck2 test //backend/...` was not
  executed in this lane.
- **`docs/evidence/console/CAP-ORG-CONSOLE/backend-verification.md:101`** still
  describes `FREEZE_WINDOW_REVIEW` as a `count: null` reminder chip. That file
  is another lane's root; the description is now stale for the freeze half.
- **Frontend untouched.** The console renders `error.message` and the preflight
  warnings as-is, so the refusal and the computed warning surface without a web
  change; no Korean-localised freeze copy was added (the shared platform message
  is English, matching the financial surface). If a Korean-only console string
  is required, that is a follow-up in the web lane, not a backend change.
- **No migration, no openapi/client change** — deliberately. Nothing was
  emitted to the integrator manifests.
