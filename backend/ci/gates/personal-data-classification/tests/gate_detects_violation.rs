//! The gate is only worth its CI minute if it still REJECTS.
//!
//! `cargo run -p console-gate-personal-data-classification` against this tree
//! exits 0, and so does a gate whose scan root stopped resolving — "green" and
//! "scanned nothing" are indistinguishable from the outside. These tests plant
//! each violation in a throwaway tree and assert the rejection, so a de-fanged
//! gate fails the job instead of passing it quietly.

use console_gate_personal_data_classification::{ViolationKind, check_tree};
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// A throwaway tree holding one migration file.
fn tree(name: &str, sql: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "console-pd-classification-{name}-{}-{unique}",
        std::process::id()
    ));
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    let migrations = dir.join("migrations");
    fs::create_dir_all(&migrations)?;
    fs::write(migrations.join("0001_test.sql"), sql)?;
    Ok(dir)
}

fn empty_baseline() -> BTreeSet<String> {
    BTreeSet::new()
}

fn baseline(tables: &[&str]) -> BTreeSet<String> {
    tables.iter().map(|t| (*t).to_owned()).collect()
}

/// The headline behaviour: a column nobody classified fails the gate.
#[test]
fn gate_rejects_an_unclassified_column() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tree(
        "unclassified",
        "CREATE TABLE staff (id UUID PRIMARY KEY, name TEXT NOT NULL);
         COMMENT ON COLUMN staff.id IS 'pd:personal — surrogate key of a person row';",
    )?;
    let result = check_tree(&dir, &empty_baseline())?;
    assert!(!result.passed(), "expected the unclassified column to fail");
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::UnclassifiedColumn
                && v.detail.contains("staff.name")),
        "expected UnclassifiedColumn for staff.name, got {:#?}",
        result.violations
    );
    Ok(())
}

/// The same tree passes once the column is classified — the gate is satisfiable
/// by classifying, not only by deleting the column.
#[test]
fn gate_accepts_a_fully_classified_table() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tree(
        "classified",
        "CREATE TABLE staff (id UUID PRIMARY KEY, name TEXT NOT NULL);
         COMMENT ON COLUMN staff.id IS 'pd:personal — surrogate key of a person row';
         COMMENT ON COLUMN staff.name IS 'pd:personal — direct identifier';",
    )?;
    let result = check_tree(&dir, &empty_baseline())?;
    assert!(
        result.passed(),
        "expected a fully classified table to pass, got {:#?}",
        result.violations
    );
    assert_eq!(result.classified_columns, 2);
    Ok(())
}

/// A column added by a LATER migration must be classified too. This is the
/// drift the baseline cannot absorb: the table is already off the baseline.
#[test]
fn gate_rejects_a_column_added_by_a_later_migration() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tree(
        "later-add",
        "CREATE TABLE staff (id UUID PRIMARY KEY);
         COMMENT ON COLUMN staff.id IS 'pd:personal — surrogate key of a person row';",
    )?;
    fs::write(
        dir.join("migrations").join("0002_add.sql"),
        "ALTER TABLE staff ADD COLUMN rrn TEXT, ADD COLUMN note TEXT;",
    )?;
    let result = check_tree(&dir, &empty_baseline())?;
    let unclassified: Vec<_> = result
        .violations
        .iter()
        .filter(|v| v.kind == ViolationKind::UnclassifiedColumn)
        .collect();
    assert_eq!(
        unclassified.len(),
        2,
        "the multi-ADD COLUMN form must yield BOTH columns, got {unclassified:#?}"
    );
    Ok(())
}

/// The vocabulary is closed. An invented token is not a classification.
#[test]
fn gate_rejects_a_token_outside_the_closed_vocabulary() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tree(
        "unknown-token",
        "CREATE TABLE staff (id UUID PRIMARY KEY);
         COMMENT ON COLUMN staff.id IS 'pd:top-secret — invented';",
    )?;
    let result = check_tree(&dir, &empty_baseline())?;
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::UnknownToken),
        "expected UnknownToken, got {:#?}",
        result.violations
    );
    Ok(())
}

/// 개인정보 보호법 시행령 제19조 is a closed set of four, and 고시 제2026-9호
/// 제7조제3항제2호 makes 주민등록번호 unconditional while the other three may be
/// scoped. A bare `unique-id` erases that, so the gate refuses it.
#[test]
fn gate_rejects_unique_id_without_its_subtoken() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tree(
        "bare-unique-id",
        "CREATE TABLE staff (id UUID PRIMARY KEY);
         COMMENT ON COLUMN staff.id IS 'pd:unique-id — which of the four?';",
    )?;
    let result = check_tree(&dir, &empty_baseline())?;
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::BadSubtoken),
        "expected BadSubtoken, got {:#?}",
        result.violations
    );
    Ok(())
}

/// A sub-token outside its class's list is not a classification either.
#[test]
fn gate_rejects_an_unknown_subtoken() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tree(
        "bad-subtoken",
        "CREATE TABLE staff (id UUID PRIMARY KEY);
         COMMENT ON COLUMN staff.id IS 'pd:unique-id/social-security — not a Korean identifier';",
    )?;
    let result = check_tree(&dir, &empty_baseline())?;
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::BadSubtoken),
        "expected BadSubtoken, got {:#?}",
        result.violations
    );
    Ok(())
}

/// Defence in depth over Postgres's own migration-time error: a marker naming a
/// column that does not exist is caught here too, because `DROP COLUMN`
/// silently discards a comment and a drop-then-recreate would otherwise leave
/// the classification pointing at nothing.
#[test]
fn gate_rejects_a_marker_for_a_column_that_does_not_exist() -> Result<(), Box<dyn std::error::Error>>
{
    let dir = tree(
        "ghost-column",
        "CREATE TABLE staff (id UUID PRIMARY KEY);
         COMMENT ON COLUMN staff.id IS 'pd:personal — surrogate key of a person row';
         COMMENT ON COLUMN staff.vanished IS 'pd:sensitive/health — column was dropped';",
    )?;
    let result = check_tree(&dir, &empty_baseline())?;
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::MarkerForUnknownColumn),
        "expected MarkerForUnknownColumn, got {:#?}",
        result.violations
    );
    Ok(())
}

/// The baseline is a ratchet. Once a listed table is fully classified the entry
/// must go, or the list would silently re-acquire slack for the next column.
#[test]
fn gate_rejects_a_baseline_entry_that_is_now_fully_classified()
-> Result<(), Box<dyn std::error::Error>> {
    let dir = tree(
        "ratchet",
        "CREATE TABLE staff (id UUID PRIMARY KEY);
         COMMENT ON COLUMN staff.id IS 'pd:personal — surrogate key of a person row';",
    )?;
    let result = check_tree(&dir, &baseline(&["staff"]))?;
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::BaselineEntryFullyClassified),
        "expected BaselineEntryFullyClassified, got {:#?}",
        result.violations
    );
    Ok(())
}

/// The baseline may not rot into a list of tables nobody can find.
#[test]
fn gate_rejects_a_baseline_entry_for_a_table_that_no_longer_exists()
-> Result<(), Box<dyn std::error::Error>> {
    let dir = tree(
        "stale-baseline",
        "CREATE TABLE staff (id UUID PRIMARY KEY);
         COMMENT ON COLUMN staff.id IS 'pd:personal — surrogate key of a person row';",
    )?;
    let result = check_tree(&dir, &baseline(&["long_gone"]))?;
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::BaselineEntryUnknownTable),
        "expected BaselineEntryUnknownTable, got {:#?}",
        result.violations
    );
    Ok(())
}

/// A baselined table's unclassified columns are debt, not a failure — otherwise
/// the gate could not land against an unclassified codebase at all.
#[test]
fn gate_tolerates_unclassified_columns_in_a_baselined_table()
-> Result<(), Box<dyn std::error::Error>> {
    let dir = tree(
        "baselined",
        "CREATE TABLE staff (id UUID PRIMARY KEY, name TEXT);",
    )?;
    let result = check_tree(&dir, &baseline(&["staff"]))?;
    assert!(
        result.passed(),
        "expected a baselined table to be tolerated, got {:#?}",
        result.violations
    );
    Ok(())
}

/// A dropped column is no longer classifiable and must not be demanded.
#[test]
fn gate_ignores_a_dropped_column() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tree(
        "dropped",
        "CREATE TABLE staff (id UUID PRIMARY KEY, legacy TEXT);
         COMMENT ON COLUMN staff.id IS 'pd:personal — surrogate key of a person row';
         ALTER TABLE staff DROP COLUMN legacy;",
    )?;
    let result = check_tree(&dir, &empty_baseline())?;
    assert!(
        result.passed(),
        "expected the dropped column to be ignored, got {:#?}",
        result.violations
    );
    Ok(())
}

/// THE FAIL-OPEN CLASS, which is the one that matters.
///
/// Every construct below used to make the parser return early WITHOUT
/// registering the table. A table that is never registered has no columns to
/// check, and a table with no columns to check passes — so the gate reported
/// green over relations it had not read. `CREATE TABLE … AS SELECT` and
/// `SELECT … INTO` were invisible; `(LIKE parent INCLUDING ALL)` was skipped as
/// if `LIKE` were a table constraint, discarding every inherited column.
///
/// For a gate whose entire purpose is "no personal-data column goes
/// unclassified", unparseable must mean FAIL. Each of these now names the
/// construct that defeated the parser.
#[test]
fn gate_rejects_ddl_it_cannot_parse_instead_of_passing_it() -> Result<(), Box<dyn std::error::Error>>
{
    // (case name, SQL, substring the finding must name)
    let cases: &[(&str, &str, &str)] = &[
        (
            "create-table-as-select",
            "CREATE TABLE staff_copy AS SELECT * FROM staff;",
            "AS SELECT",
        ),
        (
            "select-into",
            "SELECT * INTO staff_copy FROM staff;",
            "SELECT … INTO",
        ),
        (
            "create-table-like",
            "CREATE TABLE staff_copy (LIKE staff INCLUDING ALL);",
            "(LIKE … )",
        ),
        (
            "partition-of",
            "CREATE TABLE staff_2026 PARTITION OF staff FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');",
            "PARTITION OF",
        ),
        (
            "inherits",
            "CREATE TABLE contractor (day_rate NUMERIC) INHERITS (staff);",
            "INHERITS",
        ),
        (
            "syntax-error",
            "CREATE TABLE staff_copy (id UUID PRIMARY KEY, name TEXT;",
            "balanced",
        ),
    ];

    for (name, sql, expected) in cases {
        let dir = tree(name, sql)?;
        let result = check_tree(&dir, &empty_baseline())?;
        assert!(
            !result.passed(),
            "'{name}' must FAIL the gate: a construct the parser cannot read is a table \
             whose columns cannot be proved classified. Got a pass."
        );
        assert!(
            result
                .violations
                .iter()
                .any(|v| v.kind == ViolationKind::UnsupportedDdl && v.detail.contains(expected)),
            "'{name}' must be reported as UnsupportedDdl naming '{expected}', got {:#?}",
            result.violations
        );
    }
    Ok(())
}

/// The baseline claims to be shrink-only. Without this it was not: the gate has
/// no memory of the previous baseline — CI checks out a single commit with no
/// history — so appending one line admitted a whole new personal-data table
/// with no signal at all.
///
/// Migration numbers supply the missing clock. A column introduced after the
/// freeze is outside what the backlog declared, whether it arrived on a new
/// table or on one already listed.
#[test]
fn gate_rejects_a_table_appended_to_the_baseline_after_the_freeze()
-> Result<(), Box<dyn std::error::Error>> {
    let dir = tree(
        "baseline-append",
        "CREATE TABLE staff (id UUID PRIMARY KEY);
         COMMENT ON COLUMN staff.id IS 'pd:personal — surrogate key of a person row';",
    )?;
    fs::write(
        dir.join("migrations").join("9999_new_table.sql"),
        "CREATE TABLE medical_notes (id UUID PRIMARY KEY, diagnosis TEXT NOT NULL);",
    )?;

    // Without the entry the new table simply fails as unclassified.
    let unlisted = check_tree(&dir, &empty_baseline())?;
    assert!(!unlisted.passed());

    // Appending it to the baseline must NOT buy silence.
    let listed = check_tree(&dir, &baseline(&["medical_notes"]))?;
    assert!(
        listed
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::BaselineGrew
                && v.detail.contains("medical_notes.diagnosis")),
        "appending a post-freeze table to the baseline must fail, got {:#?}",
        listed.violations
    );
    Ok(())
}

/// The same clock closes the hole the table-level baseline opened by
/// construction: a NEW column on an ALREADY-listed table used to need no
/// classification at all, because the shelter was granted per table.
#[test]
fn gate_rejects_a_new_column_on_an_already_baselined_table()
-> Result<(), Box<dyn std::error::Error>> {
    let dir = tree(
        "baseline-column-growth",
        "CREATE TABLE staff (id UUID PRIMARY KEY, legacy TEXT);",
    )?;
    fs::write(
        dir.join("migrations").join("9999_add_rrn.sql"),
        "ALTER TABLE staff ADD COLUMN rrn TEXT;",
    )?;
    let result = check_tree(&dir, &baseline(&["staff"]))?;
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::BaselineGrew && v.detail.contains("staff.rrn")),
        "a post-freeze column on a baselined table must fail, got {:#?}",
        result.violations
    );
    assert!(
        !result
            .violations
            .iter()
            .any(|v| v.detail.contains("staff.legacy")),
        "a pre-freeze column on a baselined table is still debt, not a failure: {:#?}",
        result.violations
    );
    Ok(())
}

/// Build residue is not our schema, and a gate whose verdict depends on whether
/// anyone has run Buck locally is not reproducible.
///
/// Buck materialises every third-party crate's source under `buck-out`, and
/// several ship migrations of their own — `apalis-postgres` has
/// `migrations/*.sql`, `sqlx` has SQLite test fixtures under a `migrations`
/// directory. Before this was excluded the gate demanded classifications for
/// `jobs`, `workers`, `user`, `post` and `comment`: 31 violations on a developer
/// machine that had built once, and silence on a fresh CI checkout where
/// `buck-out` does not exist. Neither number was about this repo's data.
#[test]
fn gate_ignores_migrations_vendored_under_buck_out() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tree(
        "buck-out",
        "CREATE TABLE staff (id UUID PRIMARY KEY);
         COMMENT ON COLUMN staff.id IS 'pd:personal — surrogate key of a person row';",
    )?;
    let vendored = dir.join("buck-out/v2/art/root/third-party/rust/__apalis-postgres__/migrations");
    fs::create_dir_all(&vendored)?;
    fs::write(
        vendored.join("20220530084123_jobs_workers.sql"),
        "CREATE TABLE jobs (id TEXT PRIMARY KEY, attempts INTEGER NOT NULL);",
    )?;
    let result = check_tree(&dir, &empty_baseline())?;
    assert!(
        result.passed(),
        "a third-party migration under buck-out must be invisible, got {:#?}",
        result.violations
    );
    assert_eq!(
        result.total_tables, 1,
        "only the first-party table may be counted"
    );
    Ok(())
}

/// DDL built inside a plpgsql body is not schema. Lexing into a dollar-quoted
/// body would invent tables (and, in this repo, drop real ones — 0005 builds
/// `DROP TABLE` strings for `location_pings` day partitions).
#[test]
fn gate_does_not_read_ddl_out_of_a_dollar_quoted_body() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tree(
        "plpgsql",
        "CREATE TABLE staff (id UUID PRIMARY KEY);
         COMMENT ON COLUMN staff.id IS 'pd:personal — surrogate key of a person row';
         CREATE FUNCTION f() RETURNS VOID LANGUAGE plpgsql AS $$
         BEGIN
             EXECUTE format('CREATE TABLE %I (secret TEXT)', 'ghost');
             EXECUTE format('DROP TABLE %I', 'staff');
         END;
         $$;",
    )?;
    let result = check_tree(&dir, &empty_baseline())?;
    assert!(
        result.passed(),
        "expected plpgsql-built DDL to be invisible, got {:#?}",
        result.violations
    );
    assert_eq!(
        result.total_tables, 1,
        "the ghost table must not be created"
    );
    Ok(())
}
