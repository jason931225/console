#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The production roster writer, proven against a real PostgreSQL.
//!
//! `payroll_draft_lines` had no production writer: its only writer was a
//! hand-run SQL script, so every run production code created had an empty
//! roster and — once the close preflight required `roster_total > 0` — could
//! never close. `roster::materialise_roster_in_tx` is the port of that script.
//!
//! These tests exist because the port could go wrong in ways that all look like
//! success: a roster built from material nobody applied, from the wrong month,
//! from blank cells, or one line per spreadsheet row instead of per person. Each
//! is a NEAR-MISS fixture with an exact-count assertion, not a smoke test.

use console_payroll_adapter_postgres::roster::materialise_roster_in_tx;
use sqlx::PgPool;
use time::macros::date;
use uuid::Uuid;

const PERIOD_START: time::Date = date!(2026 - 06 - 01);
const PERIOD_END: time::Date = date!(2026 - 06 - 30);

struct Fixture {
    org: Uuid,
    run: Uuid,
}

async fn seed_org_and_run(pool: &PgPool) -> Fixture {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Roster Org')")
        .bind(org)
        .bind(format!("roster-{}", &org.to_string()[..8]))
        .execute(pool)
        .await
        .unwrap();
    let run: Uuid = sqlx::query_scalar(
        "INSERT INTO payroll_draft_runs (org_id, period_start, period_end, source_label) \
         VALUES ($1, $2, $3, 'roster-test') RETURNING id",
    )
    .bind(org)
    .bind(PERIOD_START)
    .bind(PERIOD_END)
    .fetch_one(pool)
    .await
    .unwrap();
    Fixture { org, run }
}

async fn seed_employee(pool: &PgPool, org: Uuid, source_key: &str, name: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key) \
         VALUES ($1, 'KNL', $2, 'book.xlsx', 's', 1, $3) RETURNING id",
    )
    .bind(org)
    .bind(name)
    .bind(source_key)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// One import run for the given period/status, and one row for `employee_key`.
#[allow(clippy::too_many_arguments)]
async fn seed_import(
    pool: &PgPool,
    org: Uuid,
    status: &str,
    row_status: &str,
    period: (time::Date, time::Date),
    employee_key: &str,
    raw_row: serde_json::Value,
) {
    let run_id = Uuid::new_v4();
    // An employee_hr run cannot be INSERTed already APPLIED: 0166's writer guard
    // raises 42501 (`employee_import_run.command_required`). It CAN be updated
    // into APPLIED by `console_leave_definer`, which is the role the guard names
    // and the only one 0166 grants UPDATE on this table. So the fixture inserts
    // DRY_RUN and transitions — exercising the guard rather than routing round it.
    sqlx::query(
        "INSERT INTO data_import_runs \
         (id, org_id, entity_type, status, source_filename, source_format, source_sha256, \
          pay_period_start, pay_period_end) \
         VALUES ($1, $2, 'employee_hr', $3, 'book.xlsx', 'xlsx', repeat('a', 64), $4, $5)",
    )
    .bind(run_id)
    .bind(org)
    .bind(if status == "APPLIED" {
        "DRY_RUN"
    } else {
        status
    })
    .bind(period.0)
    .bind(period.1)
    .execute(pool)
    .await
    .unwrap();
    if status == "APPLIED" {
        // The DRY_RUN -> APPLIED transition is governed by 0166's writer guard,
        // which requires ALL of: the `console_leave_definer` role, an armed
        // `app.current_org` (the table is under org-isolation RLS, and without it
        // the UPDATE matches zero rows and succeeds SILENTLY), and exactly one
        // same-transaction `data_import.apply` audit row whose actor is an active
        // user in the org and equals `applied_by`. The fixture satisfies the
        // guard rather than routing around it, so these tests exercise the real
        // apply path.
        let actor = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, org_id, display_name) VALUES ($1, $2, 'Importer')")
            .bind(actor)
            .bind(org)
            .execute(pool)
            .await
            .unwrap();
        let mut conn = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL ROLE console_leave_definer")
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org.to_string())
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE data_import_runs SET status = 'APPLIED', applied_by = $3, \
             applied_at = now(), updated_at = now() WHERE org_id = $1 AND id = $2",
        )
        .bind(org)
        .bind(run_id)
        .bind(actor)
        .execute(&mut *conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO audit_events \
             (actor, action, target_type, target_id, before_snap, after_snap, trace_id, span_id, occurred_at, org_id) \
             VALUES ($1, 'data_import.apply', 'data_import_run', $2, NULL, '{}'::jsonb, \
                     '0123456789abcdef0123456789abcdef', '0123456789abcdef', now(), $3)",
        )
        .bind(actor)
        .bind(run_id.to_string())
        .bind(org)
        .execute(&mut *conn)
        .await
        .unwrap();
        conn.commit().await.unwrap();
        let applied: bool =
            sqlx::query_scalar("SELECT status = 'APPLIED' FROM data_import_runs WHERE id = $1")
                .bind(run_id)
                .fetch_one(pool)
                .await
                .unwrap();
        assert!(
            applied,
            "the fixture must actually reach APPLIED, not silently no-op"
        );
    }
    sqlx::query(
        "INSERT INTO data_import_rows \
         (org_id, run_id, source_sheet, source_row, source_key, row_status, raw_row, canonical_row) \
         VALUES ($1, $2, 's', 1, $3, $4, $5, jsonb_build_object('source_key', $6::text))",
    )
    .bind(org)
    .bind(run_id)
    .bind(format!("filename:book.xlsx|sheet:s|row:{}", Uuid::new_v4()))
    .bind(row_status)
    .bind(&raw_row)
    .bind(employee_key)
    .execute(pool)
    .await
    .unwrap();
}

fn attendance_row() -> serde_json::Value {
    serde_json::json!({ "출근": "09:00", "근무시간": "8", "근무일수": "1" })
}

async fn roster(pool: &PgPool, f: &Fixture) -> Vec<(String, i32, i32)> {
    sqlx::query_as(
        "SELECT employee_source_key, payroll_source_row_count, attendance_source_row_count \
         FROM payroll_draft_lines WHERE run_id = $1 ORDER BY employee_source_key",
    )
    .bind(f.run)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn materialise(pool: &PgPool, f: &Fixture) -> u64 {
    let mut tx = pool.begin().await.unwrap();
    let n = materialise_roster_in_tx(&mut tx, f.org, f.run, PERIOD_START, PERIOD_END)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    n
}

/// POSITIVE CONTROL. Without this, every refusal below could be produced by a
/// writer that writes nothing at all.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn an_applied_in_period_row_becomes_exactly_one_roster_line(pool: PgPool) {
    let f = seed_org_and_run(&pool).await;
    seed_employee(&pool, f.org, "emp-1", "홍길동").await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        (PERIOD_START, PERIOD_END),
        "emp-1",
        attendance_row(),
    )
    .await;

    let diag: (i64, i64, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM data_import_runs WHERE org_id=$1 AND status='APPLIED'), \
                (SELECT count(*) FROM data_import_rows WHERE org_id=$1), \
                (SELECT canonical_row->>'source_key' FROM data_import_rows WHERE org_id=$1 LIMIT 1), \
                (SELECT source_key FROM employees WHERE org_id=$1 LIMIT 1)",
    ).bind(f.org).fetch_one(&pool).await.unwrap();
    assert_eq!(
        materialise(&pool, &f).await,
        1,
        "one employee, one line; diag={diag:?}"
    );
    let lines = roster(&pool, &f).await;
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].0, "emp-1");
    assert!(
        lines[0].2 > 0,
        "attendance material must be counted: {lines:?}"
    );
}

/// TWO import rows for the SAME person still make ONE line.
///
/// `data_import_rows.source_key` is `filename:…|sheet:…|row:…`, so a writer that
/// grouped on it would produce a roster of spreadsheet rows rather than people —
/// and a two-sheet workbook would silently double the roster.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn two_rows_for_one_person_make_one_line(pool: PgPool) {
    let f = seed_org_and_run(&pool).await;
    seed_employee(&pool, f.org, "emp-1", "홍길동").await;
    for _ in 0..2 {
        seed_import(
            &pool,
            f.org,
            "APPLIED",
            "CANDIDATE",
            (PERIOD_START, PERIOD_END),
            "emp-1",
            attendance_row(),
        )
        .await;
    }
    assert_eq!(
        materialise(&pool, &f).await,
        1,
        "one PERSON, not one per row"
    );
    assert_eq!(roster(&pool, &f).await.len(), 1);
}

/// Material declared for a DIFFERENT period is not this run's material.
///
/// The near-miss is deliberate: a period that OVERLAPS but is not equal. A writer
/// using overlap instead of equality would admit it.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn a_different_period_is_not_this_runs_material(pool: PgPool) {
    let f = seed_org_and_run(&pool).await;
    seed_employee(&pool, f.org, "emp-1", "홍길동").await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        (date!(2026 - 01 - 01), date!(2026 - 12 - 31)),
        "emp-1",
        attendance_row(),
    )
    .await;
    assert_eq!(
        materialise(&pool, &f).await,
        0,
        "an overlapping period is not an equal one"
    );
    assert!(roster(&pool, &f).await.is_empty());
}

/// Material nobody applied is not material.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn unapplied_and_errored_material_is_refused(pool: PgPool) {
    let f = seed_org_and_run(&pool).await;
    seed_employee(&pool, f.org, "emp-1", "홍길동").await;
    for (status, row_status) in [
        ("DRY_RUN", "CANDIDATE"),
        ("PREVIEWED", "CANDIDATE"),
        ("FAILED", "CANDIDATE"),
        ("APPLIED", "ERROR"),
    ] {
        seed_import(
            &pool,
            f.org,
            status,
            row_status,
            (PERIOD_START, PERIOD_END),
            "emp-1",
            attendance_row(),
        )
        .await;
    }
    assert_eq!(
        materialise(&pool, &f).await,
        0,
        "only APPLIED, non-ERROR rows are material"
    );
    assert!(roster(&pool, &f).await.is_empty());
}

/// A row whose cells are blank says nothing, so it is not source material.
///
/// The columns are PRESENT — this is the near-miss for a key-presence test.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn a_row_of_blank_cells_is_not_source_material(pool: PgPool) {
    let f = seed_org_and_run(&pool).await;
    seed_employee(&pool, f.org, "emp-1", "홍길동").await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        (PERIOD_START, PERIOD_END),
        "emp-1",
        serde_json::json!({ "출근": "", "근무시간": "  ", "기본급": "" }),
    )
    .await;
    assert_eq!(
        materialise(&pool, &f).await,
        0,
        "present-but-blank columns are not evidence"
    );
}

/// An employee with leave but no imported material gets no line.
///
/// The script admitted them via `OR leave_remaining > 0`. Such a line carries no
/// attendance evidence, so it can only ever block the close.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn an_employee_with_no_imported_material_is_not_admitted(pool: PgPool) {
    let f = seed_org_and_run(&pool).await;
    seed_employee(&pool, f.org, "emp-1", "홍길동").await;
    // NOTE ON THE NEAR-MISS. Ideally this employee would carry
    // `leave_remaining > 0`, since that is the exact disjunct the script used to
    // admit them on. `employees.leave_remaining` cannot be set from a test: the
    // write raises 42501 `leave_write.command_required`, because leave balances
    // are command-governed. So this proves the weaker, still load-bearing half —
    // an employee with NO imported material gets no line — and the disjunct's
    // absence is additionally pinned by the reviewer note in roster.rs.
    assert_eq!(
        materialise(&pool, &f).await,
        0,
        "an employee with no imported material must not be admitted to the roster"
    );
}

/// Re-materialising is idempotent and does not duplicate the roster.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn re_materialising_updates_rather_than_duplicates(pool: PgPool) {
    let f = seed_org_and_run(&pool).await;
    seed_employee(&pool, f.org, "emp-1", "홍길동").await;
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        (PERIOD_START, PERIOD_END),
        "emp-1",
        attendance_row(),
    )
    .await;
    assert_eq!(materialise(&pool, &f).await, 1);
    assert_eq!(
        materialise(&pool, &f).await,
        1,
        "the second pass updates the same line"
    );
    assert_eq!(roster(&pool, &f).await.len(), 1, "no duplicate line");
}
