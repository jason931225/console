#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! M1 security fix — four-eyes approvals must BIND to the action and be CONSUMED
//! single-use. Exercised as the genuine non-owner role `console_rt` (NOSUPERUSER,
//! NOBYPASSRLS, FORCE RLS): seed as owner, run every gate check/consume as `console_rt`
//! so the tenant policy and grants are faithfully exercised.
//!
//! Before this fix a gate resolved approval with only
//! `WHERE request_ref = $1` — any approved row in the org satisfied any gate,
//! replayably. Each test below is one hole the fix closes:
//!   * happy path — a matching, unconsumed approval passes and is consumed once;
//!   * wrong-kind ref — an approval decided under a different action kind denies;
//!   * wrong-target ref — an approval bound to a different object denies;
//!   * cross-purpose approved ref — an unrelated approved ref never satisfies;
//!   * replay — the same ref used twice denies the second time;
//!   * concurrent double-consume — two racing consumers, exactly one wins;
//!   * peek — the preview check never consumes;
//!   * grant binding — an approval signed for one BODY cannot be spent on another
//!     body against the same (kind, target), and a decision with no pending request
//!     behind it satisfies no grant-bound gate at all.

use console_governance_adapter_postgres::PgGovernanceStore;
use console_governance_application::{
    ApprovalDecision, CreateApprovalCommand, DecideApprovalCommand,
};
use console_kernel_core::{OrgId, TraceContext, UserId};
use console_platform_request_context::scope_org;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_00F4);
const KIND: &str = "workflow.publish";

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(6)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

async fn seed_org(pool: &PgPool) {
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, 'org-4eyes', 'Org 4eyes')")
        .bind(ORG)
        .execute(pool)
        .await
        .unwrap();
}

async fn seed_user(pool: &PgPool, name: &str) -> UserId {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(name)
    .bind(["SUPER_ADMIN"].as_slice())
    .bind(ORG)
    .fetch_one(pool)
    .await
    .unwrap();
    UserId::from_uuid(id)
}

/// Record a distinct-approver `approved` decision bound to (`KIND`, `target`) and
/// return its `request_ref`.
async fn approve(
    store: &PgGovernanceStore,
    requester: UserId,
    approver: UserId,
    kind: &str,
    target: Uuid,
) -> Uuid {
    let request_ref = Uuid::new_v4();
    scope_org(OrgId::from_uuid(ORG), async {
        store
            .decide_approval(DecideApprovalCommand {
                approver,
                request_ref,
                kind: kind.to_owned(),
                requested_by: requester,
                target_ref: Some(target),
                decision: ApprovalDecision::Approved,
                trace: TraceContext::generate(),
                occurred_at: time::OffsetDateTime::now_utc(),
            })
            .await
    })
    .await
    .unwrap();
    request_ref
}

async fn consumption_count(owner_pool: &PgPool, request_ref: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM gov_approval_consumptions c \
         JOIN gov_approvals a ON a.id = c.approval_id WHERE a.request_ref = $1",
    )
    .bind(request_ref)
    .fetch_one(owner_pool)
    .await
    .unwrap()
}

// Happy path: a matching, unconsumed approval passes and is consumed exactly once.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn matching_approval_passes_and_is_consumed_once(owner_pool: PgPool) {
    seed_org(&owner_pool).await;
    let requester = seed_user(&owner_pool, "requester").await;
    let approver = seed_user(&owner_pool, "approver").await;
    let actor = seed_user(&owner_pool, "actor").await;
    let store = PgGovernanceStore::new(runtime_role_pool(&owner_pool).await);
    let target = Uuid::new_v4();
    let request_ref = approve(&store, requester, approver, KIND, target).await;

    let passed = scope_org(OrgId::from_uuid(ORG), async {
        store
            .four_eyes_consume(request_ref, KIND, Some(target), None, actor)
            .await
    })
    .await
    .unwrap();
    assert_eq!(passed, Some(true), "a matching approval must pass the gate");
    assert_eq!(
        consumption_count(&owner_pool, request_ref).await,
        1,
        "the approval must be consumed exactly once"
    );
}

// Wrong kind: an approval decided under a different action kind must not satisfy.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn wrong_kind_ref_denied(owner_pool: PgPool) {
    seed_org(&owner_pool).await;
    let requester = seed_user(&owner_pool, "requester").await;
    let approver = seed_user(&owner_pool, "approver").await;
    let actor = seed_user(&owner_pool, "actor").await;
    let store = PgGovernanceStore::new(runtime_role_pool(&owner_pool).await);
    let target = Uuid::new_v4();
    // Approved for a DIFFERENT kind ("evidence.hold.release").
    let request_ref = approve(&store, requester, approver, "evidence.hold.release", target).await;

    let denied = scope_org(OrgId::from_uuid(ORG), async {
        store
            .four_eyes_consume(request_ref, KIND, Some(target), None, actor)
            .await
    })
    .await
    .unwrap();
    assert_eq!(denied, Some(false), "a wrong-kind approval must deny");
    assert_eq!(
        consumption_count(&owner_pool, request_ref).await,
        0,
        "a denied gate must consume nothing"
    );
}

// Wrong target: an approval bound to a different object must not satisfy.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn wrong_target_ref_denied(owner_pool: PgPool) {
    seed_org(&owner_pool).await;
    let requester = seed_user(&owner_pool, "requester").await;
    let approver = seed_user(&owner_pool, "approver").await;
    let actor = seed_user(&owner_pool, "actor").await;
    let store = PgGovernanceStore::new(runtime_role_pool(&owner_pool).await);
    let approved_target = Uuid::new_v4();
    let request_ref = approve(&store, requester, approver, KIND, approved_target).await;

    // Same kind + ref, but the gate acts on a DIFFERENT object.
    let denied = scope_org(OrgId::from_uuid(ORG), async {
        store
            .four_eyes_consume(request_ref, KIND, Some(Uuid::new_v4()), None, actor)
            .await
    })
    .await
    .unwrap();
    assert_eq!(denied, Some(false), "a wrong-target approval must deny");
    assert_eq!(consumption_count(&owner_pool, request_ref).await, 0);
}

// An unrelated approved ref (approved for another kind AND target) never satisfies
// a gate — the pre-fix bypass where any approved row in the org sufficed.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn unrelated_approved_ref_never_satisfies(owner_pool: PgPool) {
    seed_org(&owner_pool).await;
    let requester = seed_user(&owner_pool, "requester").await;
    let approver = seed_user(&owner_pool, "approver").await;
    let actor = seed_user(&owner_pool, "actor").await;
    let store = PgGovernanceStore::new(runtime_role_pool(&owner_pool).await);
    // A perfectly valid approval for a totally unrelated action.
    let unrelated_ref = approve(
        &store,
        requester,
        approver,
        "console_view.deploy",
        Uuid::new_v4(),
    )
    .await;

    let denied = scope_org(OrgId::from_uuid(ORG), async {
        store
            .four_eyes_consume(unrelated_ref, KIND, Some(Uuid::new_v4()), None, actor)
            .await
    })
    .await
    .unwrap();
    assert_eq!(
        denied,
        Some(false),
        "an unrelated approved ref must never satisfy a different gate"
    );
}

// Replay: the same approval used a second time is denied (single-use).
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn replay_of_same_ref_is_denied(owner_pool: PgPool) {
    seed_org(&owner_pool).await;
    let requester = seed_user(&owner_pool, "requester").await;
    let approver = seed_user(&owner_pool, "approver").await;
    let actor = seed_user(&owner_pool, "actor").await;
    let store = PgGovernanceStore::new(runtime_role_pool(&owner_pool).await);
    let target = Uuid::new_v4();
    let request_ref = approve(&store, requester, approver, KIND, target).await;

    let first = scope_org(OrgId::from_uuid(ORG), async {
        store
            .four_eyes_consume(request_ref, KIND, Some(target), None, actor)
            .await
    })
    .await
    .unwrap();
    let second = scope_org(OrgId::from_uuid(ORG), async {
        store
            .four_eyes_consume(request_ref, KIND, Some(target), None, actor)
            .await
    })
    .await
    .unwrap();
    assert_eq!(first, Some(true), "the first use consumes the approval");
    assert_eq!(second, Some(false), "the replay is denied");
    assert_eq!(
        consumption_count(&owner_pool, request_ref).await,
        1,
        "an approval can be consumed at most once"
    );
}

// Concurrent double-consume: two racing consumers of the SAME approval — exactly
// one wins (the `(org_id, approval_id)` unique index serializes them).
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn concurrent_double_consume_admits_exactly_one(owner_pool: PgPool) {
    seed_org(&owner_pool).await;
    let requester = seed_user(&owner_pool, "requester").await;
    let approver = seed_user(&owner_pool, "approver").await;
    let actor = seed_user(&owner_pool, "actor").await;
    let store = PgGovernanceStore::new(runtime_role_pool(&owner_pool).await);
    let target = Uuid::new_v4();
    let request_ref = approve(&store, requester, approver, KIND, target).await;

    let (a, b) = scope_org(OrgId::from_uuid(ORG), async {
        tokio::join!(
            store.four_eyes_consume(request_ref, KIND, Some(target), None, actor),
            store.four_eyes_consume(request_ref, KIND, Some(target), None, actor),
        )
    })
    .await;
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(
        [a, b].iter().filter(|r| **r == Some(true)).count(),
        1,
        "exactly one concurrent consumer may win (got {a:?}, {b:?})"
    );
    assert_eq!(
        consumption_count(&owner_pool, request_ref).await,
        1,
        "the race must leave exactly one consumption"
    );
}

// The preview peek reports the gate would pass but NEVER consumes; once the
// approval is actually consumed, the peek then reports it would fail closed.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn peek_does_not_consume(owner_pool: PgPool) {
    seed_org(&owner_pool).await;
    let requester = seed_user(&owner_pool, "requester").await;
    let approver = seed_user(&owner_pool, "approver").await;
    let actor = seed_user(&owner_pool, "actor").await;
    let store = PgGovernanceStore::new(runtime_role_pool(&owner_pool).await);
    let target = Uuid::new_v4();
    let request_ref = approve(&store, requester, approver, KIND, target).await;

    for _ in 0..2 {
        let peek = scope_org(OrgId::from_uuid(ORG), async {
            store
                .four_eyes_approved(request_ref, KIND, Some(target))
                .await
        })
        .await
        .unwrap();
        assert_eq!(peek, Some(true), "the peek sees an unconsumed approval");
    }
    assert_eq!(
        consumption_count(&owner_pool, request_ref).await,
        0,
        "peeking must never consume"
    );

    scope_org(OrgId::from_uuid(ORG), async {
        store
            .four_eyes_consume(request_ref, KIND, Some(target), None, actor)
            .await
    })
    .await
    .unwrap();
    let after = scope_org(OrgId::from_uuid(ORG), async {
        store
            .four_eyes_approved(request_ref, KIND, Some(target))
            .await
    })
    .await
    .unwrap();
    assert_eq!(
        after,
        Some(false),
        "a consumed approval no longer peeks as available"
    );
}

// ---------------------------------------------------------------------------
// Grant binding — the approval must match WHAT IS BEING DONE, not only what to.
// ---------------------------------------------------------------------------

/// Open a pending request carrying `grant` under `payload_summary.grant`, then
/// record a distinct approver's `approved` decision for it. Returns the
/// `request_ref` — the same two steps a real requester/approver pair performs.
async fn request_and_approve_grant(
    store: &PgGovernanceStore,
    requester: UserId,
    approver: UserId,
    target: Uuid,
    grant: serde_json::Value,
) -> Uuid {
    let request_ref = Uuid::new_v4();
    scope_org(OrgId::from_uuid(ORG), async {
        store
            .create_approval(CreateApprovalCommand {
                requester,
                request_ref,
                kind: KIND.to_owned(),
                target_ref: Some(target),
                payload_summary: serde_json::json!({ "grant": grant }),
                trace: TraceContext::generate(),
                occurred_at: time::OffsetDateTime::now_utc(),
            })
            .await
    })
    .await
    .unwrap();
    scope_org(OrgId::from_uuid(ORG), async {
        store
            .decide_approval(DecideApprovalCommand {
                approver,
                request_ref,
                kind: KIND.to_owned(),
                requested_by: requester,
                target_ref: Some(target),
                decision: ApprovalDecision::Approved,
                trace: TraceContext::generate(),
                occurred_at: time::OffsetDateTime::now_utc(),
            })
            .await
    })
    .await
    .unwrap();
    request_ref
}

/// THE HOLE THE (kind, target) BINDING LEAVES OPEN. Approver signs a NARROW body
/// — one condition — and the same approval is spent on a BROADER body against the
/// identical (kind, target). Without the grant conjunct the second signature
/// approves the object, not the change made to it.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn an_approval_signed_for_one_body_cannot_be_spent_on_another(owner_pool: PgPool) {
    seed_org(&owner_pool).await;
    let requester = seed_user(&owner_pool, "requester").await;
    let approver = seed_user(&owner_pool, "approver").await;
    let actor = seed_user(&owner_pool, "actor").await;
    let store = PgGovernanceStore::new(runtime_role_pool(&owner_pool).await);
    let target = Uuid::new_v4();

    let narrow = serde_json::json!({
        "activity": "read_field",
        "effect": "permit",
        "conditions": [{ "attr": "roles", "op": "contains", "value": "HR" }],
    });
    let broad = serde_json::json!({
        "activity": "read_field",
        "effect": "permit",
        "conditions": [],
    });
    let request_ref =
        request_and_approve_grant(&store, requester, approver, target, narrow.clone()).await;

    // Same ref, same kind, same target — only the body differs.
    let widened = scope_org(OrgId::from_uuid(ORG), async {
        store
            .four_eyes_consume(request_ref, KIND, Some(target), Some(broad), actor)
            .await
    })
    .await
    .unwrap();
    assert_eq!(
        widened,
        Some(false),
        "an approval signed for a narrow grant must not be spendable on a broader one"
    );
    assert_eq!(
        consumption_count(&owner_pool, request_ref).await,
        0,
        "a refused grant-bound consume must not burn the approval"
    );

    // POSITIVE CONTROL: the body the approver actually signed still passes, so the
    // refusal above is the binding and not a broken gate. Key order differs from
    // the request on purpose — jsonb is the normalization, so it must not matter.
    let reordered = serde_json::json!({
        "conditions": [{ "value": "HR", "op": "contains", "attr": "roles" }],
        "effect": "permit",
        "activity": "read_field",
    });
    let matched = scope_org(OrgId::from_uuid(ORG), async {
        store
            .four_eyes_consume(request_ref, KIND, Some(target), Some(reordered), actor)
            .await
    })
    .await
    .unwrap();
    assert_eq!(
        matched,
        Some(true),
        "the body the approver signed must still pass, key order notwithstanding"
    );
    assert_eq!(
        consumption_count(&owner_pool, request_ref).await,
        1,
        "and it is consumed exactly once"
    );
}

/// `decide_approval` only takes `requested_by` from a pending request WHEN ONE
/// EXISTS. So an approver can record an approved decision naming a requester who
/// never asked — and against a (kind, target)-only gate that decision is valid. A
/// grant-bound gate has no request row to match and refuses.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn a_decision_with_no_pending_request_satisfies_no_grant_bound_gate(owner_pool: PgPool) {
    seed_org(&owner_pool).await;
    let requester = seed_user(&owner_pool, "requester").await;
    let approver = seed_user(&owner_pool, "approver").await;
    let actor = seed_user(&owner_pool, "actor").await;
    let store = PgGovernanceStore::new(runtime_role_pool(&owner_pool).await);
    let target = Uuid::new_v4();
    let grant =
        serde_json::json!({ "activity": "read_field", "effect": "permit", "conditions": [] });

    // No create_approval — the decision is recorded straight from the approver.
    let request_ref = approve(&store, requester, approver, KIND, target).await;

    let bound = scope_org(OrgId::from_uuid(ORG), async {
        store
            .four_eyes_consume(request_ref, KIND, Some(target), Some(grant), actor)
            .await
    })
    .await
    .unwrap();
    assert_eq!(
        bound,
        Some(false),
        "a decision with no request behind it declares no grant, so it satisfies none"
    );

    // The same decision still satisfies an UNBOUND gate — proof the refusal above
    // is the grant conjunct alone and not something else about the row.
    let unbound = scope_org(OrgId::from_uuid(ORG), async {
        store
            .four_eyes_consume(request_ref, KIND, Some(target), None, actor)
            .await
    })
    .await
    .unwrap();
    assert_eq!(unbound, Some(true), "an unbound gate is unchanged");
}
