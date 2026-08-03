#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Proof that a field-level policy is ENFORCED, not merely computed.
//!
//! Before this slice, `ont_property_policies` existed with FORCE RLS and
//! append-only triggers, `ont_property_defs.in_property_policy` was carried
//! faithfully through every key revision and served over HTTP, and
//! `authorize_property_field` computed a field decision and stamped it into the
//! append-only Integrity feed — and nothing anywhere acted on any of it. There
//! was no HTTP path that wrote the attachment table at all, and every principal
//! who could read an instance read every field of it.
//!
//! The LOAD-BEARING premise of the enforcement design is that attribute serving
//! has a small enumerable set of exits. [`a_read_denied_field_is_absent_from_every_route`]
//! is the falsifier for exactly that: it hits EVERY route in `router()` and
//! asserts the withheld values appear in ZERO response bodies. If the premise is
//! false, that test is red and the redaction has to move down into the adapter's
//! row -> JSON construction instead of the REST gate.
//!
//! Every request traverses the real ontology router, a signed-JWT request
//! context, and a genuine `console_rt` pool, so RLS, the transactional audit
//! path and the enforced-policy residual are all part of the proof rather than
//! mocked away. A superuser or `BYPASSRLS` read would make every assertion here
//! vacuous.

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use console_governance_adapter_postgres::PgGovernanceStore;
use console_governance_rest::GovernanceRestState;
use console_kernel_core::{OrgId, TraceContext, UserId};
use console_ontology_adapter_postgres::PgOntologyStore;
use console_ontology_adapter_postgres::instances::{CreateInstance, PgInstanceStore};
use console_ontology_domain::ObjectTypeId;
use console_ontology_rest::{OntologyRestState, router};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use console_platform_request_context::scope_org;
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::rand_core::OsRng;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;
use uuid::Uuid;

const TEST_ISSUER: &str = "console-platform-auth";
const TEST_AUDIENCE: &str = "console-api";

/// The object type every case below publishes. Its five properties are the whole
/// experiment:
///
/// | property     | `in_property_policy` | attached `read_field` policy      | served? |
/// |--------------|----------------------|-----------------------------------|---------|
/// | `owner`      | no                   | —                                 | yes     |
/// | `code`       | no                   | —                                 | yes     |
/// | `open_note`  | yes                  | permit `roles contains SUPER_ADMIN` | yes   |
/// | `role_note`  | yes                  | permit `roles contains MECHANIC`  | NO      |
/// | `bare_note`  | yes                  | none                              | NO      |
///
/// The last three are the three distinct reasons a field can be withheld and the
/// first two are the positive controls that keep the whole file from being
/// satisfiable by a gate that simply redacts everything. `role_note` is the one
/// that proves the CONDITION decides rather than the mere presence of a policy:
/// a `SUPER_ADMIN` token carries exactly one role and `MECHANIC` is not it.
const TYPE_KEY: &str = "fieldpolicy";

const OPEN_VALUE: &str = "OPEN-NOTE-VALUE";
const ROLE_VALUE: &str = "ROLE-NOTE-VALUE";
const BARE_VALUE: &str = "BARE-NOTE-VALUE";
const CODE_VALUE: &str = "CODE-FIELDPOLICY";

/// Every value that must never reach this principal, in one place, so a new
/// assertion cannot check a subset by accident.
const WITHHELD_VALUES: &[&str] = &[ROLE_VALUE, BARE_VALUE];

/// The four-eyes `kind` a field-policy attach is decided under, spelled as a
/// literal so this file pins the wire contract rather than the constant's name.
const FIELD_POLICY_APPROVAL_KIND: &str = "ontology.property_policy";

fn object_policies_path(stable_key: &str) -> String {
    format!("/api/v1/ontology/object-types/{stable_key}/policies")
}

/// The route this slice ships, spelled as a literal rather than imported, so this
/// file pins the wire contract a client depends on and not the name the crate
/// happens to give the constant.
fn field_policies_path(stable_key: &str, property_key: &str) -> String {
    format!("/api/v1/ontology/object-types/{stable_key}/properties/{property_key}/policies")
}

// ---------------------------------------------------------------------------
// 1. THE FALSIFIER. The design's premise is that attribute serving has a small
//    enumerable set of exits; this is the test that says so or does not.
// ---------------------------------------------------------------------------

/// Sweep EVERY route in `router()` and assert the withheld values appear in zero
/// response bodies, while the permitted ones still arrive.
///
/// If any route leaks a withheld value, the "one gate, every exit" premise is
/// FALSE and redaction belongs in `instances.rs`'s row -> JSON construction
/// rather than in the REST gate. That is a real possible outcome of this test and
/// it changes the file set of the change, which is why it is written first.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn a_read_denied_field_is_absent_from_every_route(owner_pool: PgPool) {
    let fx = Fixture::build(&owner_pool, "field-sweep").await;
    let type_id = fx.publish_policied_type().await;
    let instance = fx.seed_instance(type_id, "sweep-row").await;

    // POSITIVE CONTROL, FIRST and unconditional. Every absence assertion below
    // is also satisfied by a gate that serves nothing at all, and a fixture whose
    // row was invisible would make the entire sweep vacuous.
    let read = fx
        .get(&format!("/api/v1/ontology/instances/{instance}"))
        .await;
    assert_eq!(read.status, StatusCode::OK, "{:?}", read.body);
    let attributes = &read.body["revision"]["attributes"];
    assert_eq!(
        attributes["open_note"],
        json!(OPEN_VALUE),
        "the PERMITTED field must still be served, or every absence below proves \
         only that the gate denies everything: {attributes:?}"
    );
    assert_eq!(
        attributes["code"],
        json!(CODE_VALUE),
        "an unflagged property is untouched by field policy: {attributes:?}"
    );

    // SAP's `field ( suppress ) f;` "removes field from BDEF derived types" —
    // REMOVAL, not nulling. A null is indistinguishable from a real null and
    // invites a read-modify-write that erases the value.
    for key in ["role_note", "bare_note"] {
        assert!(
            attributes.get(key).is_none(),
            "{key} must be ABSENT from the served bag, not present-and-null: {attributes:?}"
        );
    }

    // --- the sweep ---------------------------------------------------------
    let command_id = Uuid::new_v4();
    let routes: Vec<(&str, &str, String, Value)> = vec![
        (
            "list_instances",
            "GET",
            format!("/api/v1/ontology/instances?type={type_id}"),
            Value::Null,
        ),
        (
            "get_instance",
            "GET",
            format!("/api/v1/ontology/instances/{instance}"),
            Value::Null,
        ),
        (
            "get_instance_as_of",
            "GET",
            format!(
                "/api/v1/ontology/instances/{instance}?as_of={}",
                urlencode(&now_rfc3339())
            ),
            Value::Null,
        ),
        (
            "get_instance_history",
            "GET",
            format!("/api/v1/ontology/instances/{instance}/history"),
            Value::Null,
        ),
        (
            "traverse_instance",
            "GET",
            format!("/api/v1/ontology/instances/{instance}/traverse"),
            Value::Null,
        ),
        (
            "instance_acting",
            "GET",
            format!("/api/v1/ontology/instances/{instance}/acting"),
            Value::Null,
        ),
        (
            "resolve_code",
            "GET",
            format!("/api/v1/ontology/resolve?code={CODE_VALUE}"),
            Value::Null,
        ),
        (
            "get_object_type",
            "GET",
            format!("/api/v1/ontology/object-types/{TYPE_KEY}"),
            Value::Null,
        ),
        (
            "list_object_types",
            "GET",
            "/api/v1/ontology/object-types".to_owned(),
            Value::Null,
        ),
        (
            "object_type_acting",
            "GET",
            format!("/api/v1/ontology/object-types/{TYPE_KEY}/acting"),
            Value::Null,
        ),
        (
            "action_preflight",
            "POST",
            "/api/v1/ontology/actions/set_open/preflight".to_owned(),
            json!({
                "object_type_id": type_id.to_string(),
                "instance_id": instance.to_string(),
                "params": { "open_note": "PREFLIGHT-OPEN" },
                "expected_revision": 1
            }),
        ),
        (
            "action_execute",
            "POST",
            "/api/v1/ontology/actions/set_open/execute".to_owned(),
            json!({
                "object_type_id": type_id.to_string(),
                "instance_id": instance.to_string(),
                "params": { "open_note": "EXECUTE-OPEN" },
                "expected_revision": 1,
                "command_id": command_id.to_string()
            }),
        ),
        (
            "commit_lifecycle",
            "POST",
            format!("/api/v1/ontology/instances/{instance}/lifecycle"),
            json!({ "to_state": "active", "checklist_all_acknowledged": true }),
        ),
    ];

    for (name, method, uri, body) in routes {
        let res = fx.request(method, &uri, body).await;
        let text = body_text(&res.body);
        for withheld in WITHHELD_VALUES {
            assert!(
                !text.contains(withheld),
                "{name} ({method} {uri}) served a read-denied field value {withheld}: {text}"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 2. History: fixity and redaction are in direct conflict, so the read is refused
// ---------------------------------------------------------------------------

/// `history` cannot redact — `verify_chain` breaks on the first `prev_hash` gap,
/// so a per-revision filter would masquerade as a tamper alarm. The stated
/// decision is to refuse the read instead, with the adapter's own `not_found` so
/// the refusal is not an existence oracle.
///
/// The control is the same route on a type with NOTHING withheld: it must still
/// serve the chain, or this file has proven only that history is broken.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn history_fails_closed_when_a_field_is_withheld_and_is_untouched_otherwise(
    owner_pool: PgPool,
) {
    let fx = Fixture::build(&owner_pool, "field-history").await;
    let policied = fx.publish_policied_type().await;
    let hidden_row = fx.seed_instance(policied, "history-withheld").await;

    let refused = fx
        .get(&format!("/api/v1/ontology/instances/{hidden_row}/history"))
        .await;
    assert_eq!(
        refused.status,
        StatusCode::NOT_FOUND,
        "a chain that cannot be served whole must not be served at all: {:?}",
        refused.body
    );
    assert!(
        !body_text(&refused.body).contains("field"),
        "the refusal must be the adapter's own not_found, not one that says a \
         field policy was the reason: {:?}",
        refused.body
    );

    // CONTROL: a type declaring no policy-bearing property is entirely
    // unaffected, which is what makes the refusal above a field-policy behaviour
    // rather than a broken endpoint.
    let plain = fx.publish("plaintype", plain_type_draft("plaintype")).await;
    fx.attach_object_view_permit("plaintype").await;
    let plain_row = fx
        .seed_instance_with(
            plain,
            "history-plain",
            json!({ "owner": fx.actor.to_string() }),
        )
        .await;
    let served = fx
        .get(&format!("/api/v1/ontology/instances/{plain_row}/history"))
        .await;
    assert_eq!(served.status, StatusCode::OK, "{:?}", served.body);
    assert_eq!(
        served.body.as_array().map(Vec::len),
        Some(1),
        "the control type's chain must still be served whole: {:?}",
        served.body
    );
}

// ---------------------------------------------------------------------------
// 3. The write half. SAP's authorization field represents "activities such as
//    reading OR CHANGING"; a read mask alone is half of it.
// ---------------------------------------------------------------------------

/// An action whose declared edits touch a field this principal may not CHANGE is
/// denied before any writeback opens, and the sibling action over a field they
/// may change still commits.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn an_action_editing_a_change_denied_field_is_refused_before_any_writeback(
    owner_pool: PgPool,
) {
    let fx = Fixture::build(&owner_pool, "field-edit").await;
    let type_id = fx.publish_policied_type().await;
    let instance = fx.seed_instance(type_id, "edit-row").await;

    let denied = fx
        .post(
            "/api/v1/ontology/actions/set_role/execute",
            json!({
                "object_type_id": type_id.to_string(),
                "instance_id": instance.to_string(),
                "params": { "role_note": "OVERWRITTEN" },
                "expected_revision": 1,
                "command_id": Uuid::new_v4().to_string()
            }),
        )
        .await;
    assert_eq!(
        denied.status,
        StatusCode::FORBIDDEN,
        "an edit of a change-denied field must be refused: {:?}",
        denied.body
    );
    assert_eq!(
        fx.revision_count(instance).await,
        1,
        "the refusal must precede the writeback, not be reported after one"
    );
    assert_eq!(
        fx.stored_attribute(instance, "role_note").await,
        json!(ROLE_VALUE),
        "the stored value must be untouched"
    );

    // POSITIVE CONTROL: the permitted edit commits. Without it this test is
    // satisfied by an engine that denies every action.
    let allowed = fx
        .post(
            "/api/v1/ontology/actions/set_open/execute",
            json!({
                "object_type_id": type_id.to_string(),
                "instance_id": instance.to_string(),
                "params": { "open_note": "SET-BY-ACTION" },
                "expected_revision": 1,
                "command_id": Uuid::new_v4().to_string()
            }),
        )
        .await;
    assert_eq!(
        allowed.status,
        StatusCode::OK,
        "the permitted edit must commit: {:?}",
        allowed.body
    );
    assert_eq!(
        fx.revision_count(instance).await,
        2,
        "the permitted edit must have appended a revision"
    );

    // THE ERASURE THE SUPPRESS SEMANTICS WARN ABOUT. `apply_edits` merges onto
    // the base bag and `stage_revision_in_tx` persists the whole result, so a
    // redacted base would have silently DELETED every withheld field on the very
    // first action. It is checked in the DATABASE, not in the response: the
    // response is redacted by design and would show the same absence either way.
    for (key, value) in [("role_note", ROLE_VALUE), ("bare_note", BARE_VALUE)] {
        assert_eq!(
            fx.stored_attribute(instance, key).await,
            json!(value),
            "an action by a principal who may not READ {key} must not erase it \
             from the new revision"
        );
    }
    // ...and the committed response still withholds them.
    let text = body_text(&allowed.body);
    for withheld in WITHHELD_VALUES {
        assert!(
            !text.contains(withheld),
            "the execute response served a read-denied value {withheld}: {text}"
        );
    }
}

// ---------------------------------------------------------------------------
// 4. The attach route, and the ontology -> policy join it enforces
// ---------------------------------------------------------------------------

/// `in_property_policy` meant nothing anywhere in the system before this slice.
/// It is now the tenant's declaration of which fields are policy-bearing, and a
/// policy cannot be attached to a field that was never declared one — refused at
/// the route AND, independently, in SQL.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn the_attach_route_refuses_undeclared_properties_row_dependent_and_unknown_activities(
    owner_pool: PgPool,
) {
    let fx = Fixture::build(&owner_pool, "field-attach").await;
    fx.publish_policied_type().await;
    let bare_note = fx.property_def_id(TYPE_KEY, "bare_note").await;

    // Every case below carries a GENUINE, approved, unconsumed four-eyes ref bound
    // to BOTH the property and the exact body it will be posted with, so each
    // refusal is the refusal it claims to be and not the separation-of-duty gate
    // standing in for it. That every one of them is still unconsumed at the end is
    // asserted last, and is the property that keeps a typo from costing a second
    // principal's signature.
    let undeclared_body = json!({ "activity": "read_field", "effect": "permit", "conditions": [role_is("SUPER_ADMIN")] });
    let row_dependent_body = json!({
        "activity": "read_field",
        "effect": "permit",
        "conditions": [{
            "attr": "owner",
            "op": "eq",
            "value": { "kind": "subject_attr", "value": "user_id" }
        }],
    });
    let unsatisfiable_body = json!({
        "activity": "read_field",
        "effect": "permit",
        "conditions": [{
            "attr": "clearance_keys",
            "op": "contains",
            "value": { "kind": "literal", "value": "PII" }
        }],
    });
    let unknown_activity_body =
        json!({ "activity": "view", "effect": "permit", "conditions": [role_is("SUPER_ADMIN")] });
    let live_refs = [
        fx.approved_field_policy_ref(
            fx.property_def_id(TYPE_KEY, "owner").await,
            &undeclared_body,
        )
        .await,
        fx.approved_field_policy_ref(bare_note, &row_dependent_body)
            .await,
        fx.approved_field_policy_ref(bare_note, &unsatisfiable_body)
            .await,
        fx.approved_field_policy_ref(bare_note, &unknown_activity_body)
            .await,
    ];

    // `owner` is a real property of this type and is NOT declared policy-bearing.
    let mut undeclared_post = undeclared_body.clone();
    undeclared_post["four_eyes_request_ref"] = json!(live_refs[0]);
    let undeclared = fx
        .post(&field_policies_path(TYPE_KEY, "owner"), undeclared_post)
        .await;
    assert_eq!(
        undeclared.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "a property not declared in_property_policy must not be policyable: {:?}",
        undeclared.body
    );

    let unknown_property = fx
        .post(
            &field_policies_path(TYPE_KEY, "no_such_property"),
            json!({ "activity": "read_field", "effect": "permit", "conditions": [], "four_eyes_request_ref": Uuid::new_v4() }),
        )
        .await;
    assert_eq!(
        unknown_property.status,
        StatusCode::NOT_FOUND,
        "{:?}",
        unknown_property.body
    );

    // Row-dependence. The decision is taken ONCE per (principal, type, property)
    // and applied to every row in the response, so a condition over a row
    // attribute would be evaluated against no row and then applied to all of them.
    let mut row_dependent_post = row_dependent_body;
    row_dependent_post["four_eyes_request_ref"] = json!(live_refs[1]);
    let row_dependent = fx
        .post(
            &field_policies_path(TYPE_KEY, "bare_note"),
            row_dependent_post,
        )
        .await;
    assert_eq!(
        row_dependent.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "a row-dependent field condition must be refused: {:?}",
        row_dependent.body
    );

    // UNSATISFIABLE, which is the worse failure of the two. The authoring schema
    // declares `clearance_keys` and `validate_blocks` accepts a condition over it,
    // but nothing in this system resolves a clearance set for a request principal
    // — so this would attach 201 CREATED and then deny the field forever, with the
    // tenant believing they had authored a grant. It is refused at write time,
    // where the message can still reach whoever typed it.
    let mut unsatisfiable_post = unsatisfiable_body;
    unsatisfiable_post["four_eyes_request_ref"] = json!(live_refs[2]);
    let unsatisfiable = fx
        .post(
            &field_policies_path(TYPE_KEY, "bare_note"),
            unsatisfiable_post,
        )
        .await;
    assert_eq!(
        unsatisfiable.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "a condition on a subject attribute this system never populates must be \
         refused at attach, not accepted and then denied forever: {:?}",
        unsatisfiable.body
    );
    assert!(
        body_text(&unsatisfiable.body).contains("clearance_keys"),
        "the refusal must name the vocabulary it rejects: {:?}",
        unsatisfiable.body
    );

    let mut unknown_activity_post = unknown_activity_body;
    unknown_activity_post["four_eyes_request_ref"] = json!(live_refs[3]);
    let unknown_activity = fx
        .post(
            &field_policies_path(TYPE_KEY, "bare_note"),
            unknown_activity_post,
        )
        .await;
    assert_eq!(
        unknown_activity.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "`view` is a ROW activity; a field policy may only be read_field or edit: {:?}",
        unknown_activity.body
    );

    // And the refusals above left nothing behind: the whole point of an
    // append-only attachment table is that a rejected attach is not a partial one.
    assert_eq!(
        fx.property_policy_count().await,
        3,
        "publish_policied_type attaches exactly three field policies and no \
         refused attach may have added a fourth"
    );
    // Nor did any of them spend the approval it carried. A refused attach that
    // burned a second principal's signature would make every typo cost a round of
    // separation of duty.
    assert_eq!(
        fx.unconsumed_approvals().await,
        i64::try_from(live_refs.len()).expect("four fits in an i64"),
        "every approval minted for a REFUSED attach must still be unconsumed"
    );
}

// ---------------------------------------------------------------------------
// 5. The redaction set comes from the INSTANCE'S OWN type, never the caller's
// ---------------------------------------------------------------------------

/// `execute` takes `object_type_id` from the CALLER and `instance_id` from the
/// caller, and nothing requires them to agree — the writeback only uses
/// `object_type_id` for a create. So a redaction set derived from the command's
/// type, applied to a bag that came from the instance's type, is a one-request
/// bypass: name a type that declares no policy-bearing property, hand it an
/// instance of a type that does, and the withheld fields come back in the
/// response.
///
/// The gate is resolved from the instance's own `object_type_id` — the rule
/// `visible_head_inner` states — and this test is the one place the two differ.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn the_withheld_set_follows_the_instance_not_the_commands_object_type(owner_pool: PgPool) {
    let fx = Fixture::build(&owner_pool, "field-crosstype").await;
    let policied = fx.publish_policied_type().await;
    let instance = fx.seed_instance(policied, "crosstype-row").await;

    // A SECOND type that declares no policy-bearing property at all, carrying an
    // action whose edits name a property the policied type has never heard of.
    let unpoliced = fx.publish("unpoliced", unpoliced_actor_draft()).await;
    assert_ne!(
        unpoliced.as_uuid(),
        policied.as_uuid(),
        "the two types must actually differ or this test proves nothing"
    );

    let crossed = fx
        .post(
            "/api/v1/ontology/actions/set_alias/execute",
            json!({
                // The CALLER'S type: `unpoliced`, which withholds nothing.
                "object_type_id": unpoliced.as_uuid().to_string(),
                // The TARGET: a row of `fieldpolicy`, which withholds two fields.
                "instance_id": instance.to_string(),
                "params": { "code": "CROSS-TYPE" },
                "expected_revision": 1,
                "command_id": Uuid::new_v4().to_string()
            }),
        )
        .await;
    assert_eq!(
        crossed.status,
        StatusCode::OK,
        "the cross-type execute must actually reach the response this test \
         inspects — if it is refused for some other reason the assertion below \
         is vacuous: {:?}",
        crossed.body
    );

    let text = body_text(&crossed.body);
    for withheld in WITHHELD_VALUES {
        assert!(
            !text.contains(withheld),
            "the redaction set must follow the INSTANCE'S object type, not the \
             caller-supplied {unpoliced}: {withheld} was served: {text}"
        );
    }
    // POSITIVE CONTROL: the row really was the policied one, and the permitted
    // field really did come back — so the absence above is redaction and not a
    // 404 dressed as a 200.
    assert_eq!(
        crossed.body["instance"]["revision"]["attributes"]["open_note"],
        json!(OPEN_VALUE),
        "{:?}",
        crossed.body
    );
    // ...and the withheld values are still IN THE DATABASE, unerased.
    for (key, value) in [("role_note", ROLE_VALUE), ("bare_note", BARE_VALUE)] {
        assert_eq!(
            fx.stored_attribute(instance, key).await,
            json!(value),
            "a cross-type action must not erase {key} either"
        );
    }
}

/// THE CONFIDENTIALITY BOUNDARY. A control its own subject can lift in one
/// request is not a control.
///
/// Every ontology route authorizes on org-wide `role_manage`; the matrix grants
/// it to `SUPER_ADMIN` alone and a tenant-owned custom role may never hold it, so
/// the set of principals a field policy can withhold from is EXACTLY the set that
/// can reach the attach route. There is no higher role to promote the attach to.
/// The authority that is strictly higher is a second, distinct principal — which
/// is what this test spends four assertions establishing the subject cannot fake.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn a_withheld_principal_cannot_self_grant_a_field_permit(owner_pool: PgPool) {
    let fx = Fixture::build(&owner_pool, "field-selfgrant").await;
    let type_id = fx.publish_policied_type().await;
    let instance = fx.seed_instance(type_id, "selfgrant-row").await;
    let bare_note = fx.property_def_id(TYPE_KEY, "bare_note").await;

    // The premise: `bare_note` is withheld from this principal right now.
    let before = fx
        .get(&format!("/api/v1/ontology/instances/{instance}"))
        .await;
    assert_eq!(before.status, StatusCode::OK, "{:?}", before.body);
    assert!(
        before.body["revision"]["attributes"]
            .get("bare_note")
            .is_none(),
        "premise: bare_note must be withheld before the self-grant is attempted: {:?}",
        before.body
    );

    // 1. The one-request self-grant, verbatim: a permit for a role this principal
    //    holds, no second signature offered.
    let bare_grant = json!({ "activity": "read_field", "effect": "permit", "conditions": [role_is("SUPER_ADMIN")] });
    let unapproved = fx
        .post(
            &field_policies_path(TYPE_KEY, "bare_note"),
            bare_grant.clone(),
        )
        .await;
    assert_eq!(
        unapproved.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "an attach with no four_eyes_request_ref at all must not be accepted: {:?}",
        unapproved.body
    );

    // 2. A request_ref this principal minted but nobody approved.
    let unapproved_ref = Uuid::new_v4();
    let requested = fx
        .post(
            "/api/v1/governance/approvals",
            json!({
                "request_ref": unapproved_ref,
                "kind": FIELD_POLICY_APPROVAL_KIND,
                "target_ref": bare_note,
                "payload_summary": { "grant": grant_of(&bare_grant) }
            }),
        )
        .await;
    assert_eq!(
        requested.status,
        StatusCode::CREATED,
        "{:?}",
        requested.body
    );
    let mut with_ref = bare_grant.clone();
    with_ref["four_eyes_request_ref"] = json!(unapproved_ref);
    let undecided = fx
        .post(
            &field_policies_path(TYPE_KEY, "bare_note"),
            with_ref.clone(),
        )
        .await;
    assert_eq!(
        undecided.status,
        StatusCode::FORBIDDEN,
        "a request nobody decided is not an approval: {:?}",
        undecided.body
    );

    // 3. The subject decides its OWN request. This is the attempt the whole
    //    control exists to stop, and it is refused one layer before the attach.
    let self_decided = fx
        .post(
            "/api/v1/governance/approvals/decide",
            json!({
                "request_ref": unapproved_ref,
                "kind": FIELD_POLICY_APPROVAL_KIND,
                "requested_by": fx.actor.as_uuid().to_string(),
                "decision": "approved"
            }),
        )
        .await;
    assert_ne!(
        self_decided.status,
        StatusCode::CREATED,
        "a principal must not be able to approve its own field-policy request: {:?}",
        self_decided.body
    );
    let still_refused = fx
        .post(&field_policies_path(TYPE_KEY, "bare_note"), with_ref)
        .await;
    assert_eq!(
        still_refused.status,
        StatusCode::FORBIDDEN,
        "{:?}",
        still_refused.body
    );

    // 4. An approval the approver DID sign, but for a different property. A
    //    signature must not be redirectable onto a more sensitive field.
    let other_ref = fx
        .approved_field_policy_ref(fx.property_def_id(TYPE_KEY, "open_note").await, &bare_grant)
        .await;
    let mut redirected = bare_grant.clone();
    redirected["four_eyes_request_ref"] = json!(other_ref);
    let misbound = fx
        .post(&field_policies_path(TYPE_KEY, "bare_note"), redirected)
        .await;
    assert_eq!(
        misbound.status,
        StatusCode::FORBIDDEN,
        "an approval bound to open_note must not attach a policy to bare_note: {:?}",
        misbound.body
    );

    // Nothing was written by any of the four attempts, and the field is still
    // withheld — the response, not just the table, is the thing that matters.
    assert_eq!(
        fx.property_policy_count().await,
        3,
        "no refused self-grant may have attached a fourth field policy"
    );
    let after = fx
        .get(&format!("/api/v1/ontology/instances/{instance}"))
        .await;
    assert!(
        !body_text(&after.body).contains(BARE_VALUE),
        "bare_note must still be withheld after every self-grant attempt: {:?}",
        after.body
    );

    // POSITIVE CONTROL. With the approver's signature the very same attach
    // succeeds, so the four refusals above prove separation of duty and not a
    // broken route. It is spent on `bare_note` LAST so nothing earlier could have
    // benefited from it.
    let approved_ref = fx.approved_field_policy_ref(bare_note, &bare_grant).await;
    let mut approved = bare_grant;
    approved["four_eyes_request_ref"] = json!(approved_ref);
    let attached = fx
        .post(&field_policies_path(TYPE_KEY, "bare_note"), approved)
        .await;
    assert_eq!(
        attached.status,
        StatusCode::CREATED,
        "the same attach with a second principal's approval must succeed: {:?}",
        attached.body
    );
    let served = fx
        .get(&format!("/api/v1/ontology/instances/{instance}"))
        .await;
    assert_eq!(
        served.body["revision"]["attributes"]["bare_note"],
        json!(BARE_VALUE),
        "and the field is served once the policy the approver signed exists: {:?}",
        served.body
    );
}

/// THE SIGNATURE APPROVES THE GRANT, NOT THE PROPERTY.
///
/// The redirection case above binds `target_ref` and so catches an approval spent
/// on a DIFFERENT field. It cannot catch this one: right property, right kind, right
/// two principals, and only the policy BODY swapped between the signature and the
/// spend. Bind the property alone and the second signature means "a field policy may
/// be written here" — never "this one" — so an approver's yes to a permit gated on a
/// role the requester does not hold becomes a yes to an unconditional permit, and
/// the field they meant to keep withheld is served.
///
/// Both halves are asserted: the swapped body is REFUSED, and the signed body then
/// still attaches, so the refusal is the binding and not a broken route.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn an_approval_signed_for_one_grant_cannot_attach_another_to_the_same_property(
    owner_pool: PgPool,
) {
    let fx = Fixture::build(&owner_pool, "field-grantswap").await;
    let type_id = fx.publish_policied_type().await;
    let instance = fx.seed_instance(type_id, "grantswap-row").await;
    let bare_note = fx.property_def_id(TYPE_KEY, "bare_note").await;

    // What the approver signs: a permit for MECHANIC — a role this principal does
    // NOT hold, so honouring it leaves `bare_note` withheld.
    let signed = json!({
        "activity": "read_field",
        "effect": "permit",
        "conditions": [role_is("MECHANIC")],
    });
    let request_ref = fx.approved_field_policy_ref(bare_note, &signed).await;

    // What the requester tries to spend it on: the same field, the same activity,
    // no condition at all. This is the escalation the property binding permits.
    let mut widened = json!({
        "activity": "read_field",
        "effect": "permit",
        "conditions": [],
        "four_eyes_request_ref": request_ref,
    });
    let swapped = fx
        .post(&field_policies_path(TYPE_KEY, "bare_note"), widened.clone())
        .await;
    assert_eq!(
        swapped.status,
        StatusCode::FORBIDDEN,
        "an approval signed for a MECHANIC-only permit must not attach an \
         unconditional one to the same property: {:?}",
        swapped.body
    );

    // Nor does merely REORDERING the signed conditions or dropping a condition from
    // a longer list get through — the comparison is the whole normalized body.
    widened["conditions"] = json!([role_is("SUPER_ADMIN")]);
    let substituted = fx
        .post(&field_policies_path(TYPE_KEY, "bare_note"), widened)
        .await;
    assert_eq!(
        substituted.status,
        StatusCode::FORBIDDEN,
        "substituting the condition is the same swap: {:?}",
        substituted.body
    );

    // Nothing landed and nothing was spent: a refused swap must not burn the
    // approver's signature, or one attempted escalation would cost the tenant a
    // round of separation of duty.
    assert_eq!(
        fx.property_policy_count().await,
        3,
        "no swapped grant may have attached a fourth field policy"
    );
    assert_eq!(
        fx.unconsumed_approvals().await,
        1,
        "a refused grant-bound attach must leave the approval unconsumed"
    );

    // POSITIVE CONTROL. The body the approver DID sign attaches with the very same
    // ref, so the two refusals are the grant binding and not a dead route.
    let mut as_signed = signed;
    as_signed["four_eyes_request_ref"] = json!(request_ref);
    let honoured = fx
        .post(&field_policies_path(TYPE_KEY, "bare_note"), as_signed)
        .await;
    assert_eq!(
        honoured.status,
        StatusCode::CREATED,
        "the grant the approver signed must still attach: {:?}",
        honoured.body
    );
    assert_eq!(
        fx.unconsumed_approvals().await,
        0,
        "and spending it consumes the approval"
    );

    // And the grant that landed is the NARROW one: `bare_note` is still withheld
    // from this principal, which is the outcome the approver actually authorized.
    let served = fx
        .get(&format!("/api/v1/ontology/instances/{instance}"))
        .await;
    assert!(
        !body_text(&served.body).contains(BARE_VALUE),
        "the MECHANIC-only permit the approver signed must not serve bare_note to \
         a SUPER_ADMIN: {:?}",
        served.body
    );
}

/// A four-eyes approval is SINGLE-USE. Without this, one signature is a standing
/// licence to re-author the field policy on every later version of the property.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn a_field_policy_approval_cannot_be_spent_twice(owner_pool: PgPool) {
    let fx = Fixture::build(&owner_pool, "field-replay").await;
    fx.publish_policied_type().await;
    let bare_note = fx.property_def_id(TYPE_KEY, "bare_note").await;

    let mut body = json!({
        "activity": "read_field",
        "effect": "permit",
        "conditions": [role_is("SUPER_ADMIN")],
    });
    let request_ref = fx.approved_field_policy_ref(bare_note, &body).await;
    body["four_eyes_request_ref"] = json!(request_ref);
    let first = fx
        .post(&field_policies_path(TYPE_KEY, "bare_note"), body.clone())
        .await;
    assert_eq!(first.status, StatusCode::CREATED, "{:?}", first.body);

    // The same ref spent again on the body it was signed for — so the approval is
    // still grant-matched and target-matched and ONLY the consumption can stop it.
    // The status is what separates the two: consumption runs before the write, so
    // a burnt approval is 403; the unique key, if it were doing the work here,
    // would surface as 409.
    let second = fx
        .post(&field_policies_path(TYPE_KEY, "bare_note"), body)
        .await;
    assert_eq!(
        second.status,
        StatusCode::FORBIDDEN,
        "a consumed approval must not authorize a second attach: {:?}",
        second.body
    );
    assert_eq!(
        fx.property_policy_count().await,
        4,
        "exactly one attach may have landed"
    );
}

/// The runtime role held INSERT on `ont_property_policies` from 0154 and nothing
/// ever took it back — 0205 performed exactly this revoke for the object twin and
/// skipped this one. While nothing read the decision that was only a skewed
/// what-if; the moment the read path started REMOVING fields it became a
/// self-authorization primitive.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn console_rt_cannot_attach_a_field_policy_directly(owner_pool: PgPool) {
    let fx = Fixture::build(&owner_pool, "field-grant").await;
    fx.publish_policied_type().await;

    // No org arming and no transaction: the privilege check fires before RLS ever
    // runs, which is the point — this must fail for want of the GRANT itself and
    // not because the tenant floor happened to catch it.
    let refused = sqlx::query(
        "INSERT INTO ont_property_policies (org_id, property_def_id, cedar_policy_id, activity) \
         SELECT $1, p.id, c.id, 'read_field' \
         FROM ont_property_defs p, cedar_policy_catalog_entries c \
         WHERE p.key = 'bare_note' AND c.status = 'enforced' LIMIT 1",
    )
    .bind(fx.org.as_uuid())
    .execute(&fx.runtime_pool)
    .await;

    let error = refused.expect_err("console_rt must not hold INSERT on ont_property_policies");
    let message = error.to_string();
    assert!(
        message.contains("permission denied for table ont_property_policies"),
        "the refusal must be the missing INSERT privilege itself, not RLS or a \
         trigger standing in for it: {message}"
    );
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

struct Fixture {
    org: OrgId,
    actor: UserId,
    token: String,
    /// A SECOND `SUPER_ADMIN`. Not a convenience: a field-policy attach spends a
    /// four-eyes approval, `gov_approvals` carries `CHECK (approver_id <>
    /// requested_by)`, and no principal in this file can attach anything without
    /// this one.
    approver_token: String,
    owner_pool: PgPool,
    runtime_pool: PgPool,
    service: axum::Router,
}

impl Fixture {
    async fn build(owner_pool: &PgPool, tag: &str) -> Self {
        let org = OrgId::knl();
        let actor = seed_org_and_super_admin(owner_pool, *org.as_uuid(), tag).await;
        let approver =
            seed_org_and_super_admin(owner_pool, *org.as_uuid(), &format!("{tag}-approver")).await;
        let runtime_pool = runtime_role_pool(owner_pool).await;
        let command_pool = command_role_pool(owner_pool).await;
        let signing_key = SIGNING_KEY.with(SigningKey::clone);
        let verifier = verifier_for(&signing_key);
        // Merged exactly as `build_router` merges them: publishing a type consumes
        // four-eyes evidence authored through the governance routes, so a fixture
        // that cannot reach them cannot reach a published type either.
        let service = router(OntologyRestState::new(
            PgOntologyStore::new(runtime_pool.clone()).with_command_pool(command_pool.clone()),
            PgInstanceStore::new(runtime_pool.clone()),
            PgGovernanceStore::new(runtime_pool.clone()),
            Some(verifier.clone()),
        ))
        .merge(console_governance_rest::router(GovernanceRestState::new(
            PgGovernanceStore::new(runtime_pool.clone()),
            Some(verifier),
        )));
        Self {
            org,
            actor,
            token: issue_token(&signing_key, actor, org),
            approver_token: issue_token(&signing_key, approver, org),
            owner_pool: owner_pool.clone(),
            runtime_pool,
            service,
        }
    }

    /// Publish [`TYPE_KEY`], attach the row-visibility permit every read here
    /// needs, and attach the three field policies the table in this file's header
    /// describes.
    async fn publish_policied_type(&self) -> ObjectTypeId {
        let type_id = self.publish(TYPE_KEY, policied_type_draft()).await;
        self.attach_object_view_permit(TYPE_KEY).await;

        // `open_note`: readable AND writable by this principal.
        for activity in ["read_field", "edit"] {
            self.attach_field_policy("open_note", activity, role_is("SUPER_ADMIN"))
                .await;
        }
        // `role_note`: a policy EXISTS, and its condition names a role this
        // principal does not hold. This is what separates "the condition decides"
        // from "any attachment permits".
        self.attach_field_policy("role_note", "read_field", role_is("MECHANIC"))
            .await;
        // `bare_note`: flagged and unpoliced. Deny-by-omission, exactly as an
        // unattached object type serves no rows.
        type_id
    }

    async fn attach_object_view_permit(&self, stable_key: &str) {
        let attached = self
            .post(
                &object_policies_path(stable_key),
                json!({
                    "effect": "permit",
                    "conditions": [{
                        "attr": "owner",
                        "op": "eq",
                        "value": { "kind": "subject_attr", "value": "user_id" }
                    }]
                }),
            )
            .await;
        assert_eq!(
            attached.status,
            StatusCode::CREATED,
            "the row permit must attach, or every read here is 404 for the wrong \
             reason: {:?}",
            attached.body
        );
    }

    async fn attach_field_policy(&self, property_key: &str, activity: &str, condition: Value) {
        let property_def_id = self.property_def_id(TYPE_KEY, property_key).await;
        let mut body = json!({
            "activity": activity,
            "effect": "permit",
            "conditions": [condition],
        });
        let request_ref = self.approved_field_policy_ref(property_def_id, &body).await;
        body["four_eyes_request_ref"] = json!(request_ref);
        let attached = self
            .post(&field_policies_path(TYPE_KEY, property_key), body)
            .await;
        assert_eq!(
            attached.status,
            StatusCode::CREATED,
            "attach {activity} on {property_key}: {:?}",
            attached.body
        );
    }

    /// The `ont_property_defs` row id a field-policy approval binds to, read off
    /// the PUBLIC object-type route rather than the database — because a client
    /// has to be able to obtain it the same way in order to request the approval
    /// at all, and reading it out of Postgres here would hide a design that could
    /// not be driven from the API.
    async fn property_def_id(&self, type_key: &str, property_key: &str) -> Uuid {
        let detail = self
            .get(&format!("/api/v1/ontology/object-types/{type_key}"))
            .await;
        assert_eq!(detail.status, StatusCode::OK, "{:?}", detail.body);
        detail.body["properties"]
            .as_array()
            .expect("object-type detail must carry properties")
            .iter()
            .find(|property| property["key"] == json!(property_key))
            .unwrap_or_else(|| panic!("object type {type_key} declares no property {property_key}"))
            ["id"]
            .as_str()
            .expect("a property definition must carry its id")
            .parse()
            .expect("a property definition id must be a UUID")
    }

    /// One approved, unconsumed four-eyes decision bound to `property_def_id` AND
    /// to `body` — the attach body it will be spent on — requested by
    /// [`Self::actor`] and decided by [`Self::approver`]. Returns the `request_ref`
    /// the attach spends.
    ///
    /// Taking the body rather than just the property is the point: the approver
    /// signs the grant. `payload_summary.grant` is the server's normalization of
    /// the three client-controlled fields, which is what the route recomputes and
    /// the consume compares against.
    async fn approved_field_policy_ref(&self, property_def_id: Uuid, body: &Value) -> Uuid {
        let request_ref = Uuid::new_v4();
        let requested = self
            .post(
                "/api/v1/governance/approvals",
                json!({
                    "request_ref": request_ref,
                    "kind": FIELD_POLICY_APPROVAL_KIND,
                    "target_ref": property_def_id,
                    "payload_summary": {
                        "property_def_id": property_def_id,
                        "grant": grant_of(body),
                    }
                }),
            )
            .await;
        assert_eq!(
            requested.status,
            StatusCode::CREATED,
            "request: {:?}",
            requested.body
        );
        let decided = self
            .request_as(
                "POST",
                "/api/v1/governance/approvals/decide",
                &self.approver_token,
                json!({
                    "request_ref": request_ref,
                    "kind": FIELD_POLICY_APPROVAL_KIND,
                    "requested_by": self.actor.as_uuid().to_string(),
                    "decision": "approved"
                }),
            )
            .await;
        assert_eq!(
            decided.status,
            StatusCode::CREATED,
            "decide: {:?}",
            decided.body
        );
        request_ref
    }

    async fn publish(&self, stable_key: &str, draft: Value) -> ObjectTypeId {
        let created = self.post("/api/v1/ontology/object-types", draft).await;
        assert_eq!(
            created.status,
            StatusCode::CREATED,
            "publish {stable_key}: {:?}",
            created.body
        );
        ObjectTypeId::from_uuid(
            created.body["id"]
                .as_str()
                .expect("object-type create response must carry an id")
                .parse()
                .expect("object-type id must be a UUID"),
        )
    }

    async fn seed_instance(&self, type_id: ObjectTypeId, title: &str) -> Uuid {
        self.seed_instance_with(
            type_id,
            title,
            json!({
                "owner": self.actor.to_string(),
                "code": CODE_VALUE,
                "open_note": OPEN_VALUE,
                "role_note": ROLE_VALUE,
                "bare_note": BARE_VALUE
            }),
        )
        .await
    }

    async fn seed_instance_with(
        &self,
        type_id: ObjectTypeId,
        title: &str,
        attributes: Value,
    ) -> Uuid {
        scope_org(self.org, async {
            PgInstanceStore::new(self.runtime_pool.clone())
                .create_instance(
                    self.actor,
                    CreateInstance {
                        object_type_id: type_id,
                        title: title.to_owned(),
                        attributes,
                        valid_from: None,
                        action_type_id: None,
                        reason: Some("field-policy fixture".to_owned()),
                    },
                    TraceContext::generate(),
                    OffsetDateTime::now_utc(),
                )
                .await
                .expect("seed instance through console_rt")
        })
        .await
        .instance
        .id
        .as_uuid()
        .to_owned()
    }

    /// Read the STORED value, on the owner pool, deliberately bypassing every
    /// serving path: the point of these assertions is what the database holds,
    /// which no redacted response can answer.
    async fn stored_attribute(&self, instance_id: Uuid, key: &str) -> Value {
        let attributes: Value = sqlx::query_scalar(
            "SELECT r.attributes FROM ont_instances i \
             JOIN ont_instance_revisions r ON r.id = i.current_revision_id WHERE i.id = $1",
        )
        .bind(instance_id)
        .fetch_one(&self.owner_pool)
        .await
        .expect("read the stored attribute bag");
        attributes.get(key).cloned().unwrap_or(Value::Null)
    }

    async fn revision_count(&self, instance_id: Uuid) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM ont_instance_revisions WHERE instance_id = $1")
            .bind(instance_id)
            .fetch_one(&self.owner_pool)
            .await
            .expect("count revisions")
    }

    /// Approved, unspent field-policy approvals in this org.
    async fn unconsumed_approvals(&self) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM gov_approvals a \
             WHERE a.org_id = $1 AND a.kind = $2 AND a.decision = 'approved' \
               AND NOT EXISTS (SELECT 1 FROM gov_approval_consumptions c WHERE c.approval_id = a.id)",
        )
        .bind(self.org.as_uuid())
        .bind(FIELD_POLICY_APPROVAL_KIND)
        .fetch_one(&self.owner_pool)
        .await
        .expect("count unconsumed approvals")
    }

    async fn property_policy_count(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM ont_property_policies WHERE org_id = $1")
            .bind(self.org.as_uuid())
            .fetch_one(&self.owner_pool)
            .await
            .expect("count property policies")
    }

    async fn get(&self, uri: &str) -> HttpResponse {
        self.request("GET", uri, Value::Null).await
    }

    async fn post(&self, uri: &str, body: Value) -> HttpResponse {
        self.request("POST", uri, body).await
    }

    async fn request(&self, method: &str, uri: &str, body: Value) -> HttpResponse {
        self.request_as(method, uri, &self.token, body).await
    }

    async fn request_as(&self, method: &str, uri: &str, token: &str, body: Value) -> HttpResponse {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {token}"));
        if body != Value::Null {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
        }
        let payload = if body == Value::Null {
            Body::empty()
        } else {
            Body::from(serde_json::to_vec(&body).unwrap())
        };
        let response = self
            .service
            .clone()
            .oneshot(builder.body(payload).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        HttpResponse {
            status,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        }
    }
}

struct HttpResponse {
    status: StatusCode,
    body: Value,
}

thread_local! {
    /// One key per test thread so a second principal's token verifies against the
    /// router's single verifier.
    static SIGNING_KEY: SigningKey = SigningKey::random(&mut OsRng);
}

fn settings() -> JwtSettings {
    JwtSettings {
        issuer: TEST_ISSUER.to_owned(),
        audience: TEST_AUDIENCE.to_owned(),
        access_token_ttl: Duration::minutes(15),
    }
}

fn issuer_for(signing_key: &SigningKey) -> JwtIssuer {
    let private_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    JwtIssuer::from_es256_pem(settings(), private_pem.as_bytes(), public_pem.as_bytes()).unwrap()
}

fn verifier_for(signing_key: &SigningKey) -> JwtVerifier {
    let public_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    JwtVerifier::from_es256_public_pem(settings(), public_pem.as_bytes()).unwrap()
}

/// A `SUPER_ADMIN` token, and ONLY `SUPER_ADMIN`: `role_note`'s permit names
/// `MECHANIC`, so this claim set is what makes that field withheld.
fn issue_token(signing_key: &SigningKey, user_id: UserId, org: OrgId) -> String {
    issuer_for(signing_key)
        .issue_access_token(AccessTokenInput {
            subject: user_id,
            org_id: org,
            roles: vec!["SUPER_ADMIN".to_owned()],
            branches: Vec::new(),
            platform: false,
            view_as: false,
            read_only: false,
            display_name: None,
            feature_grants: Vec::new(),
            authz_subject_version: 0,
            authz_policy_version: 0,
            session_generation: 0,
            issued_at: OffsetDateTime::now_utc(),
        })
        .expect("issue access token")
}

async fn command_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_ontology_cmd")
                    .execute(conn)
                    .await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

// ---------------------------------------------------------------------------
// Drafts and blocks
// ---------------------------------------------------------------------------

fn text_property(key: &str, in_property_policy: bool, required: bool) -> Value {
    json!({
        "key": key, "title": key, "field_type": "text", "config": {},
        "backing_column": null, "required": required,
        "in_property_policy": in_property_policy
    })
}

fn policied_type_draft() -> Value {
    json!({
        "stable_key": TYPE_KEY,
        "title": "Field policy case",
        "backing_kind": "instance",
        "properties": [
            text_property("owner", false, true),
            text_property("code", false, false),
            text_property("open_note", true, false),
            text_property("role_note", true, false),
            text_property("bare_note", true, false)
        ],
        "links": [],
        "actions": [
            {
                "stable_key": "set_open",
                "title": "Set the open note",
                "params_schema": { "open_note": { "required": true } },
                "edits": [{ "property": "open_note", "param": "open_note" }],
                "submission_criteria": [],
                "side_effects": [],
                "dispatch": "instance_revision",
                "dispatch_target": null,
                "control_points": ["authority"]
            },
            {
                "stable_key": "set_role",
                "title": "Set the role-gated note",
                "params_schema": { "role_note": { "required": true } },
                "edits": [{ "property": "role_note", "param": "role_note" }],
                "submission_criteria": [],
                "side_effects": [],
                "dispatch": "instance_revision",
                "dispatch_target": null,
                "control_points": ["authority"]
            }
        ],
        "analytics": []
    })
}

/// A type declaring NO policy-bearing property, but carrying an ACTION. It is
/// the caller-supplied `object_type_id` in
/// [`the_withheld_set_follows_the_instance_not_the_commands_object_type`]: the
/// action resolves against this type while the row it edits belongs to
/// [`TYPE_KEY`], which is exactly the disagreement the redaction set must not be
/// resolved from.
fn unpoliced_actor_draft() -> Value {
    json!({
        "stable_key": "unpoliced",
        "title": "Unpoliced actor",
        "backing_kind": "instance",
        // `code` is declared on BOTH types. It has to be: the writeback validates
        // every attribute against the INSTANCE'S schema, so an edit naming a
        // property only the caller's type declares is refused before the redaction
        // set is ever consulted, and the test would prove nothing.
        "properties": [
            text_property("owner", false, true),
            text_property("code", false, false)
        ],
        "links": [],
        "actions": [{
            "stable_key": "set_alias",
            "title": "Set the code through a foreign type's action",
            "params_schema": { "code": { "required": true } },
            "edits": [{ "property": "code", "param": "code" }],
            "submission_criteria": [],
            "side_effects": [],
            "dispatch": "instance_revision",
            "dispatch_target": null,
            "control_points": ["authority"]
        }],
        "analytics": []
    })
}

/// A type declaring NO policy-bearing property: the control that keeps every
/// refusal in this file a field-policy behaviour rather than a broken route.
fn plain_type_draft(stable_key: &str) -> Value {
    json!({
        "stable_key": stable_key,
        "title": "No field policy",
        "backing_kind": "instance",
        "properties": [text_property("owner", false, true)],
        "links": [],
        "actions": [],
        "analytics": []
    })
}

/// The only condition shape a field policy may carry: set-membership over a
/// subject attribute, which makes the decision provably row-independent.
fn role_is(role: &str) -> Value {
    json!({
        "attr": "roles",
        "op": "contains",
        "value": { "kind": "literal", "value": role }
    })
}

/// The grant an approval for `body` must carry — the three client-controlled
/// fields, normalized exactly as `attach_property_policy` normalizes them (an
/// absent `conditions` is `[]`). Written here rather than inlined at each call
/// site so a test cannot accidentally sign something the route would not.
fn grant_of(body: &Value) -> Value {
    json!({
        "activity": body["activity"],
        "effect": body["effect"],
        "conditions": body.get("conditions").cloned().unwrap_or_else(|| json!([])),
    })
}

fn body_text(body: &Value) -> String {
    serde_json::to_string(body).unwrap_or_default()
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .expect("format the as-of instant")
}

fn urlencode(value: &str) -> String {
    value
        .chars()
        .map(|c| match c {
            ':' => "%3A".to_owned(),
            '+' => "%2B".to_owned(),
            other => other.to_string(),
        })
        .collect()
}
