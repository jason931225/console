#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The erasure ledger's refusals and its restore-detection verdicts, proven as
//! the GENUINE runtime role `console_rt` (NOSUPERUSER, NOBYPASSRLS, FORCE RLS) —
//! never the BYPASSRLS superuser the default `#[sqlx::test]` pool connects as,
//! which would mask a missing REVOKE or a broken policy.
//!
//! Append-only is proven in TWO layers, because they fail independently and
//! each one alone passes a test shaped for the other. PostgreSQL checks
//! privileges BEFORE it fires triggers, so as `console_rt` the refusal must be
//! `42501`, which proves the REVOKE and would still pass with the trigger
//! dropped; while as the table owner, who keeps the privilege, it must be
//! `P0001`, which proves the trigger and would still pass with the REVOKE
//! dropped. A table carrying only one of the two is mutable in one of the two
//! environments — `ALTER DEFAULT PRIVILEGES` fires for the production applier
//! and not for the `#[sqlx::test]` superuser applier — so both layers are
//! asserted every time.
//!
//! Wording is a constraint here: rows named by this ledger were DELETED FROM THE
//! LIVE CLUSTER and remain reconstructable from the WAL archive. Nothing in this
//! file calls that destruction (ADR-0037 constraint 3).

use console_kernel_core::OrgId;
use console_platform_erasure_ledger::{
    ErasureFacts, LedgerWitness, RestoreVerdict, append, classify, entries_since, head,
};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

const ORG_A: Uuid = Uuid::from_u128(0x0e0a_0e0a_0e0a_0e0a_0e0a_0e0a_0e0a_0e0a);
const ORG_B: Uuid = Uuid::from_u128(0x0e0b_0e0b_0e0b_0e0b_0e0b_0e0b_0e0b_0e0b);

/// The recorded fact set, as the ledger's contract states it. `seq`,
/// `prev_entry_hash` and `entry_hash` are placeholders: the database assigns all
/// three, which is what makes the chain something a caller holding only INSERT
/// cannot forge. A caller-supplied value here must be overwritten.
const SEED_ENTRY_SQL: &str = "INSERT INTO erasure_ledger (\
     org_id, seq, subject_kind, subject_digest, erased_relation, erased_selector, \
     erased_row_count, effective_at, actor, authority, prev_entry_hash, entry_hash) \
     VALUES ($1, 0, 'user', decode(repeat('a1', 32), 'hex'), 'users', $2, 1, \
     now(), 'tester', 'record-only; no legal conclusion asserted', \
     decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'))";

fn database_error_code(error: &sqlx::Error) -> Option<String> {
    error
        .as_database_error()?
        .code()
        .map(|code| code.into_owned())
}

fn facts(selector: &str) -> ErasureFacts {
    ErasureFacts {
        subject_kind: "user".to_owned(),
        subject_id: Uuid::from_u128(0x51b1_0000_0000_0000_0000_0000_0000_0001),
        erased_relation: "users".to_owned(),
        erased_selector: selector.to_owned(),
        erased_row_count: 1,
        effective_at: OffsetDateTime::now_utc(),
        actor: "tester".to_owned(),
        authority: "record-only; no legal conclusion asserted".to_owned(),
    }
}

/// Seed one ledger entry as the migration owner, bypassing the runtime role
/// entirely: the refusal tests must observe the DATABASE refusing a mutation of
/// an EXISTING row, not an empty table quietly matching zero rows.
async fn seed_entry(owner_pool: &PgPool, org: Uuid, selector: &str) {
    sqlx::query(SEED_ENTRY_SQL)
        .bind(org)
        .bind(selector)
        // rls-arming: ok test fixture seeds as owner during setup, before the console_rt role switch
        .execute(owner_pool)
        .await
        .expect("migration 0207 must create erasure_ledger with the recorded fact set");
}

/// Arm the tenant GUC transaction-locally, exactly as `with_org_conn` does.
async fn arm_org(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, org: Uuid) {
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(&mut **tx)
        .await
        .unwrap();
}

/// A point-in-time restore is a CLUSTER event, not a role action: it is not
/// bound by the append-only trigger or by RLS. `session_replication_role =
/// replica` disables user triggers; the superuser owner already bypasses RLS.
/// This is the only honest way to simulate the ledger losing entries it had
/// already recorded.
async fn simulate_restore_losing_entries_after(owner_pool: &PgPool, org: Uuid, keep_through: i64) {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM erasure_ledger WHERE org_id = $1 AND seq > $2")
        .bind(org)
        .bind(keep_through)
        .execute(&mut *tx)
        .await
        .expect("migration 0207 must create erasure_ledger");
    tx.commit().await.unwrap();
}

// ---------------------------------------------------------------------------
// (a) An UPDATE against a ledger row is refused BY THE DATABASE.
// ---------------------------------------------------------------------------

#[sqlx::test(migrations = "../db/migrations")]
async fn update_of_a_ledger_row_is_refused_by_the_database(owner_pool: PgPool) {
    seed_org_and_super_admin(&owner_pool, ORG_A, "A").await;
    seed_entry(&owner_pool, ORG_A, "id = 1").await;
    let rt = runtime_role_pool(&owner_pool).await;

    // Layer 1 — the REVOKE. The GUC is armed to the row's OWN org so the row is
    // VISIBLE: under FORCE RLS an UPDATE against an invisible row affects zero
    // rows and returns Ok, and a bare `expect_err` would then pass for a reason
    // that has nothing to do with append-only.
    let mut tx = rt.begin().await.unwrap();
    arm_org(&mut tx, ORG_A).await;
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM erasure_ledger WHERE org_id = $1")
        .bind(ORG_A)
        .fetch_one(&mut *tx)
        .await
        .expect("console_rt must be granted SELECT on erasure_ledger");
    assert_eq!(
        visible, 1,
        "the row the UPDATE targets must be visible to console_rt"
    );
    let runtime_error =
        sqlx::query("UPDATE erasure_ledger SET actor = 'rewritten' WHERE org_id = $1")
            .bind(ORG_A)
            .execute(&mut *tx)
            .await
            .expect_err("console_rt must not hold UPDATE on erasure_ledger");
    assert_eq!(
        database_error_code(&runtime_error).as_deref(),
        Some("42501"),
        "console_rt's UPDATE must be refused as a privilege violation, got: {runtime_error}"
    );
    drop(tx);

    // Layer 2 — the trigger. The owner KEEPS the privilege, so a REVOKE-only
    // table would let this through.
    let mut owner_tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *owner_tx)
        .await
        .unwrap();
    let owner_error =
        sqlx::query("UPDATE erasure_ledger SET actor = 'rewritten' WHERE org_id = $1")
            .bind(ORG_A)
            .execute(&mut *owner_tx)
            .await
            .expect_err("the append-only trigger must refuse UPDATE even for the table owner");
    assert_eq!(
        database_error_code(&owner_error).as_deref(),
        Some("P0001"),
        "the owner's UPDATE must be refused by the append-only trigger, got: {owner_error}"
    );
}

// ---------------------------------------------------------------------------
// (b) A DELETE against a ledger row is refused BY THE DATABASE.
// ---------------------------------------------------------------------------

#[sqlx::test(migrations = "../db/migrations")]
async fn delete_of_a_ledger_row_is_refused_by_the_database(owner_pool: PgPool) {
    seed_org_and_super_admin(&owner_pool, ORG_A, "A").await;
    seed_entry(&owner_pool, ORG_A, "id = 1").await;
    let rt = runtime_role_pool(&owner_pool).await;

    let mut tx = rt.begin().await.unwrap();
    arm_org(&mut tx, ORG_A).await;
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM erasure_ledger WHERE org_id = $1")
        .bind(ORG_A)
        .fetch_one(&mut *tx)
        .await
        .expect("console_rt must be granted SELECT on erasure_ledger");
    assert_eq!(
        visible, 1,
        "the row the DELETE targets must be visible to console_rt"
    );
    let runtime_error = sqlx::query("DELETE FROM erasure_ledger WHERE org_id = $1")
        .bind(ORG_A)
        .execute(&mut *tx)
        .await
        .expect_err("console_rt must not hold DELETE on erasure_ledger");
    assert_eq!(
        database_error_code(&runtime_error).as_deref(),
        Some("42501"),
        "console_rt's DELETE must be refused as a privilege violation, got: {runtime_error}"
    );
    drop(tx);

    let mut owner_tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *owner_tx)
        .await
        .unwrap();
    let owner_error = sqlx::query("DELETE FROM erasure_ledger WHERE org_id = $1")
        .bind(ORG_A)
        .execute(&mut *owner_tx)
        .await
        .expect_err("the append-only trigger must refuse DELETE even for the table owner");
    assert_eq!(
        database_error_code(&owner_error).as_deref(),
        Some("P0001"),
        "the owner's DELETE must be refused by the append-only trigger, got: {owner_error}"
    );
}

// ---------------------------------------------------------------------------
// (c) Restore detection. The load-bearing test of the slice.
// ---------------------------------------------------------------------------

/// The negative half, and it is not decoration: a detector that fires in normal
/// operation is a detector nobody will keep switched on.
#[sqlx::test(migrations = "../db/migrations")]
async fn restore_detection_stays_silent_in_normal_operation(owner_pool: PgPool) {
    seed_org_and_super_admin(&owner_pool, ORG_A, "A").await;
    let rt = runtime_role_pool(&owner_pool).await;
    let org = OrgId::from_uuid(ORG_A);

    for n in 1..=3 {
        append(&rt, org, &facts(&format!("id = {n}")))
            .await
            .unwrap();
    }
    let witness = head(&rt, org)
        .await
        .unwrap()
        .expect("a written ledger has a head");
    assert_eq!(witness.seq, 3);

    for n in 4..=5 {
        append(&rt, org, &facts(&format!("id = {n}")))
            .await
            .unwrap();
    }

    assert_eq!(
        classify(&rt, org, &witness).await.unwrap(),
        RestoreVerdict::Consistent { head_seq: 5 },
        "appending past a witness must not read as a restore"
    );
}

/// The ledger loses entries it had already recorded and never regains them.
#[sqlx::test(migrations = "../db/migrations")]
async fn restore_detection_fires_when_the_ledger_falls_behind_its_witness(owner_pool: PgPool) {
    seed_org_and_super_admin(&owner_pool, ORG_A, "A").await;
    let rt = runtime_role_pool(&owner_pool).await;
    let org = OrgId::from_uuid(ORG_A);

    for n in 1..=3 {
        append(&rt, org, &facts(&format!("id = {n}")))
            .await
            .unwrap();
    }
    let witness = head(&rt, org)
        .await
        .unwrap()
        .expect("a written ledger has a head");
    assert_eq!(witness.seq, 3);

    simulate_restore_losing_entries_after(&owner_pool, ORG_A, 1).await;

    assert_eq!(
        classify(&rt, org, &witness).await.unwrap(),
        RestoreVerdict::RolledBack {
            head_seq: 1,
            witness_seq: 3
        },
        "a head behind the witness must be reported as a rollback"
    );
}

/// The scenario a sequence-only detector calls healthy, and the reason this
/// slice exists: the ledger is rolled back and then WRITTEN FORWARD AGAIN, so
/// the head reaches the witness's sequence carrying different content. Comparing
/// sequences alone returns `Consistent` here — evidence that reads as intact
/// while the entries it claims to hold are gone.
#[sqlx::test(migrations = "../db/migrations")]
async fn restore_detection_fires_when_the_witnessed_sequence_holds_other_content(
    owner_pool: PgPool,
) {
    seed_org_and_super_admin(&owner_pool, ORG_A, "A").await;
    let rt = runtime_role_pool(&owner_pool).await;
    let org = OrgId::from_uuid(ORG_A);

    for n in 1..=3 {
        append(&rt, org, &facts(&format!("id = {n}")))
            .await
            .unwrap();
    }
    let witness = head(&rt, org)
        .await
        .unwrap()
        .expect("a written ledger has a head");
    assert_eq!(witness.seq, 3);

    simulate_restore_losing_entries_after(&owner_pool, ORG_A, 2).await;
    append(
        &rt,
        org,
        &facts("id = 99 (a different erasure, same position)"),
    )
    .await
    .unwrap();

    let resumed = head(&rt, org)
        .await
        .unwrap()
        .expect("a written ledger has a head");
    assert_eq!(
        resumed.seq, witness.seq,
        "the fixture must recreate the witnessed SEQUENCE, or this proves nothing a rollback test does not"
    );
    assert_ne!(
        resumed.entry_hash, witness.entry_hash,
        "the fixture must recreate it with DIFFERENT content"
    );

    assert_eq!(
        classify(&rt, org, &witness).await.unwrap(),
        RestoreVerdict::Forked { witness_seq: 3 },
        "a witnessed sequence holding other content must not be reported as consistent"
    );
}

// ---------------------------------------------------------------------------
// (d) An append that omits a required fact is refused.
// ---------------------------------------------------------------------------

#[sqlx::test(migrations = "../db/migrations")]
async fn an_append_omitting_a_required_fact_is_refused(owner_pool: PgPool) {
    seed_org_and_super_admin(&owner_pool, ORG_A, "A").await;
    let rt = runtime_role_pool(&owner_pool).await;

    let mut tx = rt.begin().await.unwrap();
    arm_org(&mut tx, ORG_A).await;

    // Absent: an entry that cannot say under what authority it was performed.
    let missing = sqlx::query(
        "INSERT INTO erasure_ledger (\
         org_id, seq, subject_kind, subject_digest, erased_relation, erased_selector, \
         erased_row_count, effective_at, actor, authority, prev_entry_hash, entry_hash) \
         VALUES ($1, 0, 'user', decode(repeat('a1', 32), 'hex'), 'users', 'id = 1', 1, \
         now(), 'tester', NULL, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'))",
    )
    .bind(ORG_A)
    .execute(&mut *tx)
    .await
    .expect_err("an entry with no authority is not evidence");
    assert_eq!(
        database_error_code(&missing).as_deref(),
        Some("23502"),
        "an absent required fact must be refused as a not-null violation, got: {missing}"
    );
    drop(tx);

    // Present but empty. A blank string satisfies NOT NULL and says nothing, so
    // the not-null constraint alone does not make the entry evidence.
    let mut tx = rt.begin().await.unwrap();
    arm_org(&mut tx, ORG_A).await;
    let blank = sqlx::query(
        "INSERT INTO erasure_ledger (\
         org_id, seq, subject_kind, subject_digest, erased_relation, erased_selector, \
         erased_row_count, effective_at, actor, authority, prev_entry_hash, entry_hash) \
         VALUES ($1, 0, 'user', decode(repeat('a1', 32), 'hex'), 'users', 'id = 1', 1, \
         now(), 'tester', '   ', decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'))",
    )
    .bind(ORG_A)
    .execute(&mut *tx)
    .await
    .expect_err("a blank authority is not evidence either");
    assert_eq!(
        database_error_code(&blank).as_deref(),
        Some("23514"),
        "a blank required fact must be refused as a check violation, got: {blank}"
    );
}

// ---------------------------------------------------------------------------
// (e) Tenant isolation.
// ---------------------------------------------------------------------------

#[sqlx::test(migrations = "../db/migrations")]
async fn one_org_cannot_reach_another_orgs_ledger_entries(owner_pool: PgPool) {
    seed_org_and_super_admin(&owner_pool, ORG_A, "A").await;
    seed_org_and_super_admin(&owner_pool, ORG_B, "B").await;
    seed_entry(&owner_pool, ORG_A, "org A erasure").await;
    seed_entry(&owner_pool, ORG_B, "org B erasure").await;
    let rt = runtime_role_pool(&owner_pool).await;

    let mut tx = rt.begin().await.unwrap();
    arm_org(&mut tx, ORG_A).await;

    // The WRITE refusal is asserted FIRST and deliberately so: if it is asserted
    // after another statement, a refusal originating anywhere else satisfies it
    // and the isolation proof quietly evaporates while the assertion still passes.
    let cross_org = sqlx::query(SEED_ENTRY_SQL)
        .bind(ORG_B)
        .bind("smuggled into org B")
        .execute(&mut *tx)
        .await
        .expect_err("org A must not write into org B's ledger");
    assert_eq!(
        database_error_code(&cross_org).as_deref(),
        Some("42501"),
        "the cross-org append must be refused by row-level security, got: {cross_org}"
    );
    drop(tx);

    let mut tx = rt.begin().await.unwrap();
    arm_org(&mut tx, ORG_A).await;
    let visible: Vec<String> = sqlx::query_scalar("SELECT erased_selector FROM erasure_ledger")
        .fetch_all(&mut *tx)
        .await
        .expect("console_rt must be granted SELECT on erasure_ledger");
    tx.commit().await.unwrap();

    // Both directions. Asserting only the absence passes against a table that
    // returns nothing at all, which is not isolation — it is a broken grant.
    assert!(
        visible.iter().any(|s| s == "org A erasure"),
        "org A must see its own ledger entry, saw: {visible:?}"
    );
    assert!(
        !visible.iter().any(|s| s == "org B erasure"),
        "org A must not see org B's ledger entry, saw: {visible:?}"
    );
}

// ---------------------------------------------------------------------------
// The read path a re-applier depends on.
// ---------------------------------------------------------------------------

/// Deliverable 4's read path: after a restore is detected, something has to
/// replay what the ledger recorded past the witness. That replay is only
/// possible if the entries come back in sequence order carrying the SCOPE —
/// relation, selector, row count — not merely the fact that something happened.
#[sqlx::test(migrations = "../db/migrations")]
async fn entries_since_returns_the_replay_set_in_order_with_its_scope(owner_pool: PgPool) {
    seed_org_and_super_admin(&owner_pool, ORG_A, "A").await;
    let rt = runtime_role_pool(&owner_pool).await;
    let org = OrgId::from_uuid(ORG_A);

    let mut witnesses: Vec<LedgerWitness> = Vec::new();
    for n in 1..=3 {
        witnesses.push(
            append(&rt, org, &facts(&format!("id = {n}")))
                .await
                .unwrap(),
        );
    }

    let replay = entries_since(&rt, org, 1).await.unwrap();
    assert_eq!(
        replay.iter().map(|e| e.seq).collect::<Vec<_>>(),
        vec![2, 3],
        "the replay set must be everything after the witness, in sequence order"
    );
    assert_eq!(replay[0].erased_relation, "users");
    assert_eq!(replay[0].erased_selector, "id = 2");
    assert_eq!(replay[0].erased_row_count, 1);
    assert_eq!(
        replay[1].entry_hash, witnesses[2].entry_hash,
        "the replayed entry must be the one the witness names"
    );
    assert_eq!(
        replay[1].prev_entry_hash, witnesses[1].entry_hash,
        "the chain must link each replayed entry to its predecessor"
    );

    // A witness at the head has nothing to replay.
    assert!(entries_since(&rt, org, 3).await.unwrap().is_empty());
}
