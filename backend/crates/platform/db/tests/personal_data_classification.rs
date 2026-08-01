#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The field-level personal-data classification, and the obligation DERIVED
//! from it, proved against a real migrated database.
//!
//! WHY THIS TEST EXISTS AND NOT JUST THE GATE. The CI gate reads the migration
//! files as text. These assertions read `pg_attribute` after the migrations have
//! actually run, which is the only place the classification is real: a
//! `COMMENT ON COLUMN` naming a column that does not exist aborts the migration,
//! and a `DROP COLUMN` silently discards a comment. Text and catalog can
//! disagree, and the catalog is what the derivation reads.
//!
//! WHAT IS ASSERTED, AND WHAT IS NOT. These tests assert that the classification
//! is present and that the derivation computes from it. They assert nothing
//! about whether any statutory obligation is met — nothing here observes how
//! long access logs are actually retained — and they move no compliance control
//! off HOLD.

use sqlx::{PgPool, Row};

/// Remove every classification marker, so a single probe column can be the only
/// input to the derivation. `#[sqlx::test]` hands each test its own database, so
/// this mutates nothing another test can see.
async fn strip_all_markers(pool: &PgPool) {
    sqlx::query(
        r"
        DO $$
        DECLARE target RECORD;
        BEGIN
            FOR target IN SELECT rel_name, col_name FROM personal_data_columns()
            LOOP
                EXECUTE format('COMMENT ON COLUMN %I.%I IS NULL',
                               target.rel_name, target.col_name);
            END LOOP;
        END $$;
        ",
    )
    .execute(pool)
    .await
    .unwrap();

    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM personal_data_columns()")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0, "strip_all_markers left markers behind");
}

async fn floor_days(pool: &PgPool) -> i32 {
    sqlx::query_scalar("SELECT access_log_retention_floor_days()")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Create a one-column probe table carrying exactly the given classification.
///
/// `comment_sql` is a `&'static str` because sqlx 0.9 refuses a built query
/// string outright — which is the right default, and costs nothing here since
/// every probe classification is a literal.
async fn probe_with(pool: &PgPool, comment_sql: &'static str) {
    sqlx::query("CREATE TABLE pd_probe (probe_column TEXT)")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(comment_sql).execute(pool).await.unwrap();
}

const PROBE_SENSITIVE_HEALTH: &str =
    "COMMENT ON COLUMN pd_probe.probe_column IS 'pd:sensitive/health — probe'";
const PROBE_UNIQUE_ID_RRN: &str =
    "COMMENT ON COLUMN pd_probe.probe_column IS 'pd:unique-id/rrn — probe'";
const PROBE_PSEUDONYMOUS: &str =
    "COMMENT ON COLUMN pd_probe.probe_column IS 'pd:pseudonymous — probe'";
const PROBE_UNDECLARED: &str = "COMMENT ON COLUMN pd_probe.probe_column IS 'pd:undeclared — probe'";

/// The plaintext 주민등록번호 finding lives in the schema, not only in a
/// document. `0066_hr_core_employee_fields.sql` states in its own header that
/// resident-registration and disability values remain in `employees.raw_row`,
/// and `hr.rs` classifies the 주민 and 장애 import headers `restricted` under a
/// `retain_raw_mask_preview` policy — the mask applies to the preview
/// projection, not to storage. If that ever stops being true, this assertion is
/// where it gets noticed.
#[sqlx::test(migrations = "./migrations")]
async fn employees_raw_row_is_classified_unique_id_and_sensitive(pool: PgPool) {
    let tokens: Vec<String> = sqlx::query_scalar(
        "SELECT tokens FROM personal_data_columns()
          WHERE rel_name = 'employees' AND col_name = 'raw_row'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert!(
        tokens.iter().any(|t| t == "unique-id/rrn"),
        "employees.raw_row must name WHICH 고유식별정보 it holds; got {tokens:?}"
    );
    assert!(
        tokens.iter().any(|t| t == "sensitive/health"),
        "employees.raw_row must record the 장애 (건강) 민감정보; got {tokens:?}"
    );
}

/// The whole point of the control: the obligation is computed from the schema,
/// not hand-maintained.
#[sqlx::test(migrations = "./migrations")]
async fn shipped_classification_derives_the_two_year_floor(pool: PgPool) {
    assert_eq!(
        floor_days(&pool).await,
        730,
        "a schema classified 고유식별정보 must derive the 2-year 접속기록 floor \
         (고시 제2026-9호 제8조제1항제2호)"
    );
}

/// THE CORRECTION, and the reason this test is not optional.
///
/// 「개인정보의 안전성 확보조치 기준」 제8조제1항제2호 reads
/// `고유식별정보 **또는** 민감정보`. A derivation that fires the two-year floor
/// only off 고유식별정보 UNDER-RETAINS for a system holding 민감정보 and no
/// 고유식별정보 — and under-retention is the legally dangerous direction. This
/// asserts the 민감정보 limb fires on its own, with every 고유식별정보 marker
/// removed from the database.
#[sqlx::test(migrations = "./migrations")]
async fn sensitive_alone_raises_the_floor_with_no_unique_id_present(pool: PgPool) {
    strip_all_markers(&pool).await;
    probe_with(&pool, PROBE_SENSITIVE_HEALTH).await;

    let unique_id_columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM personal_data_columns() AS pdc,
                LATERAL unnest(pdc.tokens) AS token
          WHERE token LIKE 'unique-id%'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        unique_id_columns, 0,
        "the 민감정보 limb must be proved with no 고유식별정보 anywhere"
    );

    assert_eq!(
        floor_days(&pool).await,
        730,
        "민감정보 alone must raise the floor to 2 years"
    );
}

/// The 고유식별정보 limb, likewise on its own.
#[sqlx::test(migrations = "./migrations")]
async fn unique_id_alone_raises_the_floor(pool: PgPool) {
    strip_all_markers(&pool).await;
    probe_with(&pool, PROBE_UNIQUE_ID_RRN).await;
    assert_eq!(floor_days(&pool).await, 730);
}

/// 가명정보 is exempt from a list of duties that widens on 2026-09-11
/// (개보법 제28조의7, 개정 2026.3.10). It must not be what raises the floor.
#[sqlx::test(migrations = "./migrations")]
async fn pseudonymous_alone_does_not_raise_the_floor(pool: PgPool) {
    strip_all_markers(&pool).await;
    probe_with(&pool, PROBE_PSEUDONYMOUS).await;
    assert_eq!(
        floor_days(&pool).await,
        365,
        "가명정보 must not trigger 제8조제1항제2호"
    );
}

/// `undeclared` is an admission that the content is unknown. It must not be
/// read as a clean bill — but it is also not 민감정보, so it does not fabricate
/// a 2-year floor either. The floor falls back to 제8조제1항 본문's 1 year.
#[sqlx::test(migrations = "./migrations")]
async fn undeclared_alone_does_not_fabricate_a_two_year_floor(pool: PgPool) {
    strip_all_markers(&pool).await;
    probe_with(&pool, PROBE_UNDECLARED).await;
    assert_eq!(floor_days(&pool).await, 365);
}

/// With nothing classified at all the derivation must not invent an obligation.
/// This is the lower-bound property stated plainly: an empty classification
/// yields 제8조제1항 본문's floor, never the 제2호 floor.
#[sqlx::test(migrations = "./migrations")]
async fn an_empty_classification_derives_the_base_floor(pool: PgPool) {
    strip_all_markers(&pool).await;
    assert_eq!(floor_days(&pool).await, 365);
}

/// Every token that actually reached the catalog is in the closed vocabulary.
///
/// The CI gate checks this over migration TEXT. This checks it over what the
/// database ended up holding, which is what the derivation reads. The two can
/// disagree — a marker inside a plpgsql body, say — and only this side is
/// authoritative for the derivation.
#[sqlx::test(migrations = "./migrations")]
async fn every_catalog_token_is_in_the_closed_vocabulary(pool: PgPool) {
    const CLASSES: [&str; 7] = [
        "none",
        "personal",
        "sensitive",
        "unique-id",
        "credit",
        "pseudonymous",
        "undeclared",
    ];
    const UNIQUE_ID_SUBTOKENS: [&str; 4] = ["rrn", "passport", "driver-license", "arc"];
    const SENSITIVE_SUBTOKENS: [&str; 9] = [
        "belief",
        "union",
        "political",
        "health",
        "sex-life",
        "genetic",
        "criminal-record",
        "biometric-id",
        "race-ethnicity",
    ];

    let rows = sqlx::query(
        "SELECT rel_name, col_name, token
           FROM personal_data_columns() AS pdc,
                LATERAL unnest(pdc.tokens) AS token",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert!(
        !rows.is_empty(),
        "no classification reached the catalog at all"
    );

    for row in rows {
        let rel: String = row.get("rel_name");
        let col: String = row.get("col_name");
        let token: String = row.get("token");
        let (head, sub) = match token.split_once('/') {
            Some((head, sub)) => (head, Some(sub)),
            None => (token.as_str(), None),
        };
        assert!(
            CLASSES.contains(&head),
            "{rel}.{col}: '{token}' is outside the closed vocabulary"
        );
        match head {
            "unique-id" => assert!(
                sub.is_some_and(|s| UNIQUE_ID_SUBTOKENS.contains(&s)),
                "{rel}.{col}: 고유식별정보 must name which of the four (개인정보 보호법 \
                 시행령 제19조); got '{token}'"
            ),
            "sensitive" => assert!(
                sub.is_some_and(|s| SENSITIVE_SUBTOKENS.contains(&s)),
                "{rel}.{col}: 민감정보 must name its sub-category so the judgement is \
                 auditable; got '{token}'"
            ),
            _ => assert!(
                sub.is_none(),
                "{rel}.{col}: class '{head}' takes no sub-token; got '{token}'"
            ),
        }
    }
}

/// 신정법 제2조제7호's applicability to an HR and payroll console is unresolved,
/// so `credit` is a token a human must not yet use. The gate accepts it by
/// design; this asserts nobody has.
#[sqlx::test(migrations = "./migrations")]
async fn no_column_is_classified_credit_while_the_scope_question_is_open(pool: PgPool) {
    let credit_columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM personal_data_columns() AS pdc,
                LATERAL unnest(pdc.tokens) AS token
          WHERE token = 'credit' OR token LIKE 'credit/%'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        credit_columns, 0,
        "assigning 개인신용정보 is a legal act; 신용정보의 이용 및 보호에 관한 법률 \
         제2조제7호 scope is a question for counsel and is not answered in code"
    );
}

/// A ROLE WITHOUT THE GRANT IS REFUSED — and only then does the positive half
/// mean anything.
///
/// An earlier version of this file asserted only that `console_rt` may execute
/// the two functions, and the accompanying report called that "proven by test,
/// not assumed". It was not. Both functions are SECURITY DEFINER, and
/// PostgreSQL grants EXECUTE on a new function to PUBLIC by default; the
/// migration carried no `REVOKE ALL … FROM PUBLIC`, so every role in the
/// cluster already held EXECUTE and the assertion would have passed with the
/// `GRANT` lines deleted. The migration now revokes first, and this drives a
/// role holding no grant at all into `42501 insufficient_privilege` before
/// asserting the runtime role succeeds.
#[sqlx::test(migrations = "./migrations")]
async fn only_a_granted_role_may_execute_the_derivation(pool: PgPool) {
    // Unique per test database, so parallel runs on one cluster cannot race
    // over a shared role name. The identifier is a fixed prefix plus a UUID's
    // lowercase hex, so it cannot carry SQL metacharacters.
    let ungranted = format!("pd_ungranted_{}", uuid::Uuid::new_v4().simple());
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "CREATE ROLE \"{ungranted}\" NOLOGIN"
    )))
    .execute(&pool)
    .await
    .unwrap();

    // (1) The negative. A role nobody granted anything to must be refused.
    //     Both probes yield BIGINT so a success would decode cleanly and the
    //     assertion below would be about privileges, not about types.
    for probe in [
        "SELECT access_log_retention_floor_days()::BIGINT",
        "SELECT COUNT(*) FROM personal_data_columns()",
    ] {
        let mut tx = pool.begin().await.unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "SET LOCAL ROLE \"{ungranted}\""
        )))
        .execute(tx.as_mut())
        .await
        .unwrap();
        let refused = sqlx::query_scalar::<_, i64>(probe)
            .fetch_one(tx.as_mut())
            .await
            .expect_err(
                "a role with no EXECUTE grant must be REFUSED — if this succeeds the \
                 REVOKE ALL … FROM PUBLIC is missing and the positive assertion below \
                 proves nothing",
            );
        assert_eq!(
            refused
                .as_database_error()
                .and_then(|e| e.code())
                .as_deref(),
            Some("42501"),
            "expected insufficient_privilege for `{probe}`, got {refused:?}"
        );
        tx.rollback().await.unwrap();
    }

    // (2) The positive. The runtime role the application actually connects as
    //     must reach the derivation, or the route in `console-compliance-rest`
    //     fails at runtime while every owner-privileged test passes.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(tx.as_mut())
        .await
        .unwrap();

    let days: i32 = sqlx::query_scalar("SELECT access_log_retention_floor_days()")
        .fetch_one(tx.as_mut())
        .await
        .expect("console_rt must hold EXECUTE on access_log_retention_floor_days()");
    assert_eq!(days, 730);

    let classified: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM personal_data_columns()")
        .fetch_one(tx.as_mut())
        .await
        .expect("console_rt must hold EXECUTE on personal_data_columns()");
    assert!(classified > 0);

    tx.rollback().await.unwrap();

    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP ROLE \"{ungranted}\"")))
        .execute(&pool)
        .await
        .unwrap();
}
