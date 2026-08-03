//! Ontology REST API — the §18 registry surface + the §2/§16 single mutation
//! path (action preflight / execute) that serves humans and automation alike.
//!
//! The object-type and instance endpoints are thin pass-throughs over the
//! registry + instance stores (which already own RLS + audit + fixity). The
//! action `preflight` / `execute` endpoints are the substance of this lane:
//!
//!  * `preflight` resolves the action, runs the §16 gate chain (authority via the
//!    legacy authorization contract → self-checklist → four-eyes read from the DB
//!    → egress derived from side effects) and returns each gate's status WITHOUT
//!    committing anything;
//!  * `execute` runs the same chain, and if it allows, opens ONE `with_audits`
//!    writeback transaction that **re-checks** the mutable gate (four-eyes) inside
//!    the tx (TOCTOU-safe), then dispatches: an `instance_revision` action appends
//!    a fixity-chained revision through the instance store's in-tx helper; a
//!    `projected_usecase` action routes through the [`ProjectedDispatchRegistry`]
//!    into the OWNING domain crate's use-case (which owns its own RLS, audit, and
//!    transaction) — the engine never writes a domain table itself (§9.3, no second
//!    source of truth); an unknown `dispatch_target` fails closed.
//!
//! `router(state)` self-applies `with_request_context`; `build_router` merges it
//! (L-WIRE), this crate does not.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use console_governance_adapter_postgres::{
    PgGovernanceError, PgGovernanceStore, authority_effect_from_cedar, four_eyes_consume_conn,
};
use console_governance_domain::{
    AuthorityEffect, GateChainConfig, GateChainOutcome, GateEvidence, LifecycleState,
    evaluate_gate_chain, validate_lifecycle_transition,
};
use console_kernel_core::{AuditAction, AuditEvent, ErrorKind, KernelError, TraceContext};
use console_ontology_adapter_postgres::instances::{
    CreateInstance, InstanceHead, InstanceState, PgInstanceStore, RevisionSummary, StageRevision,
    TraversalGraph, TraversalNode, create_instance_in_tx, stage_revision_in_tx,
};
use console_ontology_adapter_postgres::{
    ActingRule, ActionTypeSummary, CreateObjectTypeDraft, ObjectTypeSummary,
    ObjectTypeWritePrecondition, ObjectTypeWriteVersion, PgOntologyError, PgOntologyStore,
    PropertyDefSummary, ResolvedInstance,
};
use console_ontology_application::{
    ActionDispatch, apply_edits, egress_evidence, evaluate_submission_criteria, evaluation_context,
    parse_control_points, validate_params,
};
use console_ontology_domain::{
    FieldKind, InstanceId, InstanceLifecycleState, LinkTypeId, ObjectTypeId, SchemaLifecycleState,
};
use console_platform_auth::JwtVerifier;
use console_platform_authz::cedar_pbac::authoring::{
    self, Condition, ConditionOp, ConditionValue, DeclaredAttr, Effect, NoCodeBlocks,
};
use console_platform_authz::cedar_pbac::evaluate_legacy_contract;
use console_platform_authz::cedar_pbac::residual::{
    ObjectPolicy, Predicate, PredicateValue, ResidualOp, SqlValue, SubjectAttrs,
};
use console_platform_authz::{
    Action, AuthorizationRequest, AuthorizationResource, Feature, Principal, authorize_org_wide,
};
use console_platform_authz_rest::{
    AttachObjectPolicyCommand, AttachPropertyPolicyCommand, PROPERTY_POLICY_ACTIVITIES,
    PgCedarError, PgCedarPolicyStore, validate_property_policy_blocks,
};
use console_platform_db::{DbError, with_audits};
use console_platform_request_context::current_org;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::collections::{HashMap, HashSet, VecDeque, hash_map::Entry};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use time::OffsetDateTime;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// State + router
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct OntologyRestState {
    registry: PgOntologyStore,
    /// Sealed: see [`gate`]. Only `gate` can reach the unfiltered store inside.
    instances: gate::Instances,
    governance: PgGovernanceStore,
    policies: PgCedarPolicyStore,
    jwt_verifier: Option<JwtVerifier>,
    /// Routes a `projected_usecase` action to the OWNING domain crate's use-case.
    /// Empty by default ⇒ every projected dispatch fails closed (`NotWiredYet`),
    /// preserving the pre-wire dark behavior. The App composition root installs
    /// the real handlers via [`Self::with_projected_dispatch`].
    projected_dispatch: ProjectedDispatchRegistry,
}

impl OntologyRestState {
    #[must_use]
    pub fn new(
        registry: PgOntologyStore,
        instances: PgInstanceStore,
        governance: PgGovernanceStore,
        jwt_verifier: Option<JwtVerifier>,
    ) -> Self {
        // The attach route reaches `ont_policy_api.attach_object_policy` as
        // `console_ontology_cmd` (migration 0206), so the policy store needs the
        // SAME command credential the registry was built with. Derived from
        // `registry` rather than taken as a parameter: every composition root and
        // fixture that already wires the ontology command pool gets the policy one
        // for free, and none of them changes arity.
        let mut policies = PgCedarPolicyStore::new(registry.pool().clone());
        if let Some(command_pool) = registry.command_pool_opt() {
            policies = policies.with_command_pool(command_pool.clone());
        }
        Self {
            registry,
            // The public parameter stays a `PgInstanceStore`: sealing is internal
            // to this crate and no composition root or fixture changes.
            instances: gate::Instances::new(instances),
            policies,
            governance,
            jwt_verifier,
            projected_dispatch: ProjectedDispatchRegistry::new(),
        }
    }

    /// Install the projected-dispatch registry (target → domain use-case). Supplied
    /// by the App tier, which alone may depend on the domain adapters; the ontology
    /// REST tier stays free of a domain-adapter edge (dependency inversion, exactly
    /// like `TenantConfigSeeder`). An unregistered target still fails closed.
    #[must_use]
    pub fn with_projected_dispatch(mut self, registry: ProjectedDispatchRegistry) -> Self {
        self.projected_dispatch = registry;
        self
    }
}

// ---------------------------------------------------------------------------
// Projected dispatch registry (§18 D1/D2, arch §1a + §9.3)
// ---------------------------------------------------------------------------

/// Everything a domain use-case needs to service one `projected_usecase` action,
/// resolved from the action + command (HTTP-independent). The engine performs NO
/// writeback of its own for a projected action; the handler routes into the owning
/// domain crate's use-case, which owns its RLS + audit + transaction (§9.3: never a
/// second source of truth). Tenant scope is ambient via `app.current_org`
/// (the caller already scoped it), so no org travels in this struct.
#[derive(Debug, Clone)]
pub struct ProjectedDispatch {
    /// The signed-in principal (actor + org + scope) for the domain command.
    pub principal: Principal,
    /// The `dispatch_target` key the registry routes on (e.g. `registry.update_equipment`).
    pub target: String,
    /// The projected entity's primary key (equipment id, work-order id, …) — the
    /// domain row the action targets. `None` for a create-style projected action.
    pub target_id: Option<Uuid>,
    /// Validated action params (the edit values) for the domain command.
    pub params: Value,
    /// Optional caller reason, forwarded to the domain audit trail.
    pub reason: Option<String>,
    /// Deterministic occurrence time for the domain audit event.
    pub occurred_at: OffsetDateTime,
}

/// One projected-dispatch handler: an async adapter that invokes the owning
/// domain use-case. Returns a JSON summary of the domain result (opaque to the
/// engine) or a typed [`ActionError`] (fail-closed).
pub type ProjectedHandler = Arc<
    dyn Fn(ProjectedDispatch) -> Pin<Box<dyn Future<Output = Result<Value, ActionError>> + Send>>
        + Send
        + Sync,
>;

/// Maps each `dispatch_target` to its domain-use-case handler. Owns the
/// fail-closed contract: an **unknown target is a typed `NotWiredYet` error**, so
/// a mis-seeded or not-yet-wired action can never silently no-op or write.
#[derive(Clone, Default)]
pub struct ProjectedDispatchRegistry {
    handlers: HashMap<String, ProjectedHandler>,
}

impl ProjectedDispatchRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a handler for one `dispatch_target`. Chainable builder.
    #[must_use]
    pub fn register(mut self, target: impl Into<String>, handler: ProjectedHandler) -> Self {
        self.handlers.insert(target.into(), handler);
        self
    }

    /// Route to the target's handler, or fail closed on an unknown target.
    async fn dispatch(&self, input: ProjectedDispatch) -> Result<Value, ActionError> {
        match self.handlers.get(&input.target) {
            Some(handler) => handler(input).await,
            None => Err(ActionError::NotWiredYet {
                target: Some(input.target),
            }),
        }
    }
}

pub const OBJECT_TYPES_PATH: &str = "/api/v1/ontology/object-types";
pub const OBJECT_TYPE_KEY_PATH: &str = "/api/v1/ontology/object-types/{key}";
pub const OBJECT_TYPE_ACTING_PATH: &str = "/api/v1/ontology/object-types/{key}/acting";
pub const OBJECT_TYPE_LIFECYCLE_PATH: &str = "/api/v1/ontology/object-types/{key}/lifecycle";
pub const OBJECT_TYPE_POLICIES_PATH: &str = "/api/v1/ontology/object-types/{key}/policies";
pub const PROPERTY_POLICIES_PATH: &str =
    "/api/v1/ontology/object-types/{key}/properties/{property_key}/policies";
pub const INSTANCES_PATH: &str = "/api/v1/ontology/instances";
pub const INSTANCE_ID_PATH: &str = "/api/v1/ontology/instances/{id}";
pub const INSTANCE_HISTORY_PATH: &str = "/api/v1/ontology/instances/{id}/history";
pub const INSTANCE_TRAVERSE_PATH: &str = "/api/v1/ontology/instances/{id}/traverse";
pub const INSTANCE_LIFECYCLE_PATH: &str = "/api/v1/ontology/instances/{id}/lifecycle";
pub const INSTANCE_ACTING_PATH: &str = "/api/v1/ontology/instances/{id}/acting";
pub const RESOLVE_PATH: &str = "/api/v1/ontology/resolve";
pub const ACTION_PREFLIGHT_PATH: &str = "/api/v1/ontology/actions/{action_key}/preflight";
pub const ACTION_EXECUTE_PATH: &str = "/api/v1/ontology/actions/{action_key}/execute";

pub const ONTOLOGY_ROUTE_PATHS: &[&str] = &[
    OBJECT_TYPES_PATH,
    OBJECT_TYPE_KEY_PATH,
    OBJECT_TYPE_ACTING_PATH,
    OBJECT_TYPE_LIFECYCLE_PATH,
    OBJECT_TYPE_POLICIES_PATH,
    PROPERTY_POLICIES_PATH,
    INSTANCES_PATH,
    INSTANCE_ID_PATH,
    INSTANCE_HISTORY_PATH,
    INSTANCE_TRAVERSE_PATH,
    INSTANCE_LIFECYCLE_PATH,
    INSTANCE_ACTING_PATH,
    RESOLVE_PATH,
    ACTION_PREFLIGHT_PATH,
    ACTION_EXECUTE_PATH,
];

pub fn router(state: OntologyRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.registry.pool().clone();
    let router = Router::new()
        .route(
            OBJECT_TYPES_PATH,
            get(list_object_types).post(create_object_type),
        )
        .route(
            OBJECT_TYPE_KEY_PATH,
            get(get_object_type).put(stage_object_type_revision),
        )
        .route(OBJECT_TYPE_ACTING_PATH, get(object_type_acting))
        .route(
            OBJECT_TYPE_LIFECYCLE_PATH,
            post(transition_object_type_lifecycle),
        )
        .route(OBJECT_TYPE_POLICIES_PATH, post(attach_object_policy))
        .route(PROPERTY_POLICIES_PATH, post(attach_property_policy))
        .route(INSTANCES_PATH, get(list_instances))
        .route(INSTANCE_ID_PATH, get(get_instance))
        .route(INSTANCE_HISTORY_PATH, get(get_instance_history))
        .route(INSTANCE_TRAVERSE_PATH, get(traverse_instance))
        .route(INSTANCE_LIFECYCLE_PATH, post(commit_lifecycle))
        .route(INSTANCE_ACTING_PATH, get(instance_acting))
        .route(RESOLVE_PATH, get(resolve_code))
        .route(ACTION_PREFLIGHT_PATH, post(action_preflight))
        .route(ACTION_EXECUTE_PATH, post(action_execute))
        .with_state(state);
    console_platform_request_context::with_request_context(router, verifier, pool)
}

// ---------------------------------------------------------------------------
// Registry surface (thin over PgOntologyStore)
// ---------------------------------------------------------------------------

async fn list_object_types(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ObjectTypeSummary>>, RestError> {
    authorize_ontology(&state, &headers).await?;
    let types = state
        .registry
        .list_object_types()
        .await
        .map_err(RestError::from_ontology)?;
    Ok(Json(types))
}

fn object_type_response<T: Serialize>(
    status: StatusCode,
    value: T,
    write_version: &ObjectTypeWriteVersion,
) -> Result<Response, RestError> {
    let etag = axum::http::HeaderValue::from_str(&write_version.etag)
        .map_err(|_| RestError::internal("invalid ontology write validator"))?;
    let mut response = (status, Json(value)).into_response();
    response
        .headers_mut()
        .insert(axum::http::header::ETAG, etag);
    Ok(response)
}

fn required_object_type_write_precondition(
    headers: &HeaderMap,
) -> Result<ObjectTypeWritePrecondition, RestError> {
    let mut values = headers.get_all(axum::http::header::IF_MATCH).iter();
    let raw = values
        .next()
        .ok_or_else(RestError::write_precondition_required)?;
    if values.next().is_some() {
        return Err(RestError::invalid_write_precondition());
    }
    let raw = raw
        .to_str()
        .map_err(|_| RestError::invalid_write_precondition())?;
    if raw.starts_with("W/") || raw == "*" || raw.contains(',') {
        return Err(RestError::invalid_write_precondition());
    }
    let inner = raw
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .ok_or_else(RestError::invalid_write_precondition)?;
    let payload = inner
        .strip_prefix("ont-object-type-key:")
        .ok_or_else(RestError::invalid_write_precondition)?;
    let (validator, revision) = payload
        .split_once(":r")
        .ok_or_else(RestError::invalid_write_precondition)?;
    if validator.len() != 32
        || !validator
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || revision.is_empty()
        || (revision.len() > 1 && revision.starts_with('0'))
        || !revision.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(RestError::invalid_write_precondition());
    }
    let validator_id =
        Uuid::parse_str(validator).map_err(|_| RestError::invalid_write_precondition())?;
    let revision = revision
        .parse::<i64>()
        .ok()
        .filter(|revision| *revision >= 1)
        .ok_or_else(RestError::invalid_write_precondition)?;
    Ok(ObjectTypeWritePrecondition {
        validator_id,
        revision,
    })
}

async fn create_object_type(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Json(draft): Json<CreateObjectTypeDraft>,
) -> Result<impl IntoResponse, RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    let summary = state
        .registry
        .create_object_type(
            principal.user_id,
            draft,
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(RestError::from_ontology)?;
    let write_version = summary.write_version();
    object_type_response(StatusCode::CREATED, summary, &write_version)
}

#[derive(Debug, Deserialize)]
struct ObjectTypeVersionQuery {
    #[serde(default)]
    version: Option<i64>,
}

async fn get_object_type(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Query(query): Query<ObjectTypeVersionQuery>,
) -> Result<Response, RestError> {
    authorize_ontology(&state, &headers).await?;
    let detail = state
        .registry
        .get_object_type(&key, query.version)
        .await
        .map_err(RestError::from_ontology)?;
    let write_version = detail.object_type.write_version();
    object_type_response(StatusCode::OK, detail, &write_version)
}

async fn stage_object_type_revision(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Json(draft): Json<CreateObjectTypeDraft>,
) -> Result<impl IntoResponse, RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    let expected = required_object_type_write_precondition(&headers)?;
    let summary = state
        .registry
        .stage_revision(
            principal.user_id,
            &key,
            expected,
            draft,
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(RestError::from_ontology)?;
    let write_version = summary.write_version();
    object_type_response(StatusCode::CREATED, summary, &write_version)
}

#[derive(Debug, Deserialize)]
struct ObjectTypeLifecycleRequest {
    to_state: SchemaLifecycleState,
}

/// Drive the object-type schema FSM. The legal edge set lives in SQL
/// (`0165_ontology_object_type_key_revisions.sql:1015-1022`) and the
/// approval-consuming `review_pending -> published` branch is enforced there
/// too, so this handler holds NO transition table: every rejected edge arrives
/// as a mapped `PgOntologyError` and every new state costs zero rest-crate code.
async fn transition_object_type_lifecycle(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Query(query): Query<ObjectTypeVersionQuery>,
    Json(body): Json<ObjectTypeLifecycleRequest>,
) -> Result<Response, RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    let expected = required_object_type_write_precondition(&headers)?;
    // `transition_lifecycle` takes a VERSION id, and `get_object_type(key, None)`
    // returns the published-preferred head — so once v1 is published, a key-only
    // call would address v1 forever. `?version=` is how a staged v2 is reachable.
    let detail = state
        .registry
        .get_object_type(&key, query.version)
        .await
        .map_err(RestError::from_ontology)?;
    let summary = state
        .registry
        .transition_lifecycle(
            principal.user_id,
            detail.object_type.id,
            expected,
            body.to_state,
            true,
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(RestError::from_ontology)?;
    let write_version = summary.write_version();
    object_type_response(StatusCode::OK, summary, &write_version)
}

// ---------------------------------------------------------------------------
// Object-policy attachment (arch §5d authoring → the row-visibility residual)
// ---------------------------------------------------------------------------

/// The wire body carries the rule and NOTHING that identifies what it applies to.
///
/// `resource_type` is derived from the path `{key}` and `action` is fixed to
/// [`authoring::OBJECT_POLICY_ACTION`] on purpose: a persisted policy whose
/// `resource_type` disagrees with the object type's `stable_key` never matches
/// `applicable_object_policies`, so it denies forever at HTTP 200 `[]` — a
/// silent failure no post-hoc test can see. Deriving both makes it
/// unrepresentable, and is less code than accepting them.
#[derive(Debug, Deserialize)]
struct AttachObjectPolicyRequest {
    effect: Effect,
    #[serde(default)]
    conditions: Vec<Condition>,
}

#[derive(Debug, Serialize)]
struct AttachObjectPolicyResponse {
    id: Uuid,
}

/// The most AND-ed conditions one attached policy may PERSIST.
///
/// The authoring grammar bounds neither the count nor the literal lengths
/// (`authoring.rs:306-341`), and an attachment can never be revoked: both tables
/// are append-only (`0154:90-99`) and no role anywhere holds UPDATE on
/// `cedar_policy_catalog_entries` (`0150:118` revokes it from `console_rt`,
/// `0205:151` grants the writer only SELECT and INSERT), so a row can never
/// leave the `status = 'enforced'` the loader selects on (`store.rs:558`).
/// An oversized list is therefore permanent work charged to every later read of
/// the type — re-validated, re-rendered, re-normalized and lowered into the SQL
/// residual on the list, on all five single-instance paths, and once per
/// node-type group inside a traversal.
///
/// 32 is far above any authorable rule: a condition's left side comes from
/// `RESOURCE_ATTRS` (4), `SUBJECT_ATTRS` (4) or the type's declared Text/Boolean
/// properties. The bound is applied HERE and not in the validator on purpose —
/// tightening the validator would retroactively invalidate any already-enforced
/// row and 500 every read of its type, which is the failure this bound exists to
/// prevent.
const MAX_ATTACHED_CONDITIONS: usize = 32;

/// Author one enforced object policy and attach it to an object type.
///
/// This route asserts the authoring validator's verdict; it never re-encodes the
/// rule. A condition the validator cannot represent — for instance one over a
/// Date property, which [`declared_attrs`] cannot splice into the Cedar schema —
/// is refused here with the validator's own message rather than landing enforced
/// and 500-ing every later read of the type.
async fn attach_object_policy(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Json(body): Json<AttachObjectPolicyRequest>,
) -> Result<(StatusCode, Json<AttachObjectPolicyResponse>), RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    if body.conditions.len() > MAX_ATTACHED_CONDITIONS {
        return Err(RestError::from_kernel(KernelError::validation(format!(
            "a policy may carry at most {MAX_ATTACHED_CONDITIONS} conditions, got {}",
            body.conditions.len()
        ))));
    }
    let detail = state
        .registry
        .get_object_type(&key, None)
        .await
        .map_err(RestError::from_ontology)?;
    let blocks = NoCodeBlocks {
        effect: body.effect,
        action: authoring::OBJECT_POLICY_ACTION.to_owned(),
        resource_type: detail.object_type.stable_key.clone(),
        conditions: body.conditions,
    };
    // `stable_key`, `title` and `natural_language_rule` are NOT sent: all three
    // are functions of the object type, and a value the definer derives for
    // itself is a value a hand-crafted call to it cannot forge (0205 §4).
    let id = state
        .policies
        .attach_object_policy(AttachObjectPolicyCommand {
            actor: principal.user_id,
            object_type_id: *detail.object_type.id.as_uuid(),
            declared: declared_attrs(&detail.properties),
            blocks,
        })
        .await
        .map_err(RestError::from_cedar)?;
    Ok((StatusCode::CREATED, Json(AttachObjectPolicyResponse { id })))
}

#[derive(Debug, Deserialize)]
struct AttachPropertyPolicyRequest {
    /// `read_field` or `edit` — the activity the policy decides, which IS the
    /// Cedar action it is evaluated under and the value stored on the attachment.
    activity: String,
    effect: Effect,
    #[serde(default)]
    conditions: Vec<Condition>,
    /// The four-eyes approval this attach spends. REQUIRED — not `Option` —
    /// because it is the whole of [`PROPERTY_POLICY_FOUR_EYES_KIND`]'s reason to
    /// exist: an optional second signature is one a self-granting principal
    /// simply omits.
    ///
    /// Its request must have been opened with `payload_summary.grant` equal to
    /// `{"activity", "effect", "conditions"}` of THIS body — the approver signs
    /// the grant, not merely the property.
    four_eyes_request_ref: Uuid,
}

/// The four-eyes `kind` a field-policy attach is decided under, bound to the
/// `ont_property_defs` row it governs.
///
/// WHY THIS EXISTS, stated so it is not "optional hardening" the next edit drops.
/// Every ontology route gates on org-wide `RoleManage` (see
/// [`authorize_ontology`]). The matrix grants `RoleManage` to `SUPER_ADMIN`
/// alone, and `custom_role_runtime_feature_allowed` forbids a tenant-owned custom
/// role from ever holding it — so the set of principals that can READ a field is
/// exactly the set that can ATTACH a policy to it, and there is no higher ROLE in
/// this system to promote the attach to. A control whose own subject can lift it
/// in one request is not a control.
///
/// The authority that IS strictly higher is a SECOND, DISTINCT principal:
/// `gov_approvals` carries `CHECK (approver_id <> requested_by)` (0153) and
/// `PgGovernanceStore::decide_approval` refuses self-approval before it, and
/// `four_eyes_consume_conn` binds the decision to (kind, target) and makes it
/// single-use. So attaching a field policy requires the read authority PLUS an
/// approval no single principal can manufacture, which is strictly more than
/// reading the property the policy governs. It is the same primitive the action
/// and lifecycle paths already spend, not a new mechanism.
///
/// `target_ref` is the `property_def_id`, so an approval decided for one field
/// cannot be redirected onto another — including a more sensitive one on the same
/// type.
///
/// AND the approval is bound to the GRANT, not only to the property. Binding the
/// property alone means the second signature approves *that a field policy be
/// written here*, never *which one* — so a signature given for `roles contains
/// "HR"` could be spent attaching an unconditional permit to the same field, and
/// the approver would have endorsed the opposite of what shipped. The requester
/// records the exact grant under `payload_summary.grant` when opening the request;
/// `four_eyes_consume_conn` requires it to equal the body being attached.
///
/// That binding also removes the last way to fabricate the second principal:
/// `decide_approval` only takes `requested_by` from a pending request WHEN ONE
/// EXISTS, so without it an approver could record an approved decision naming a
/// requester who never asked. A grant-bound gate has no request row to match and
/// fails closed.
const PROPERTY_POLICY_FOUR_EYES_KIND: &str = "ontology.property_policy";

/// Author one enforced FIELD policy and attach it to one property of one
/// object-type version.
///
/// The property must be declared `in_property_policy` on that version. That flag
/// has existed since 0152 and meant nothing anywhere until migration 0211; it is
/// now the tenant's declaration of which fields are policy-bearing, enforced both
/// here (so the refusal names the property) and in SQL (so no credential can
/// route around it).
///
/// Everything else mirrors [`attach_object_policy`]: the route asserts the
/// authoring validator's verdict and never re-encodes the rule, and the catalog
/// row plus the attachment plus the audit row are written by one SECURITY DEFINER
/// owned by a NOBYPASSRLS role.
///
/// UNLIKE [`attach_object_policy`] it spends a four-eyes approval bound to the
/// property — see [`PROPERTY_POLICY_FOUR_EYES_KIND`] for why a field policy needs
/// authority its own subject cannot supply alone.
///
/// PER-VERSION, and the operational consequence is stated rather than left to be
/// discovered: `ont_property_defs` rows belong to one object-type VERSION, and a
/// staged revision mints new ones. A field policy attached to v1's property does
/// NOT carry to v2, exactly as an object policy does not. That is fail-closed —
/// the property is withheld again until the tenant re-attaches — but it IS a
/// re-attach the tenant has to perform, not a migration that happens for them.
async fn attach_property_policy(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path((key, property_key)): Path<(String, String)>,
    Json(body): Json<AttachPropertyPolicyRequest>,
) -> Result<(StatusCode, Json<AttachObjectPolicyResponse>), RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    if body.conditions.len() > MAX_ATTACHED_CONDITIONS {
        return Err(RestError::from_kernel(KernelError::validation(format!(
            "a policy may carry at most {MAX_ATTACHED_CONDITIONS} conditions, got {}",
            body.conditions.len()
        ))));
    }
    let detail = state
        .registry
        .get_object_type(&key, None)
        .await
        .map_err(RestError::from_ontology)?;
    let property = detail
        .properties
        .iter()
        .find(|property| property.key == property_key)
        // 404 with the registry's own vocabulary: an unknown property and a
        // property of a type this principal cannot resolve must not be
        // distinguishable.
        .ok_or_else(|| {
            RestError::from_kernel(KernelError::not_found(
                "object type declares no such property",
            ))
        })?;
    if !property.in_property_policy {
        return Err(RestError::from_kernel(KernelError::validation(format!(
            "property '{property_key}' is not declared in_property_policy on this object-type \
             version, so no field policy may be attached to it"
        ))));
    }
    let blocks = NoCodeBlocks {
        effect: body.effect,
        action: body.activity,
        resource_type: detail.object_type.stable_key.clone(),
        conditions: body.conditions,
    };
    let property_def_id = *property.id.as_uuid();

    // Everything judgeable from the blocks alone, BEFORE the approval is spent —
    // one four-eyes signature is not cheap and a typo must not burn it. The store
    // re-asserts the same function at the crate boundary for every other caller;
    // this is one definition called twice, not a copy.
    validate_property_policy_blocks(&blocks).map_err(RestError::from_kernel)?;

    // THE SEPARATION. Bound to the property the policy governs AND to the grant
    // itself, and consumed BEFORE the write, so an attach cannot happen without a
    // second principal's signature, and the signature cannot be replayed onto a
    // second field or spent on a policy the approver never saw.
    //
    // The grant is the server's own normalization of the three client-controlled
    // fields — the activity, the effect, and the conditions — NOT the raw body, so
    // an omitted `conditions` and an explicit `[]` are the same signature and a
    // reordered JSON object is too. `resource_type` is left out because it is
    // already implied by `property_def_id`, which `target_ref` binds.
    let grant = serde_json::json!({
        "activity": &blocks.action,
        "effect": &blocks.effect,
        "conditions": &blocks.conditions,
    });

    //
    // Consume-then-write rather than one transaction: the rows are written by
    // `ont_policy_api.attach_property_policy` on the `console_ontology_cmd`
    // command pool, and the approval lives under `console_rt` — there is no
    // shared tx to make atomic. The order is the fail-closed one: a failed attach
    // burns the approval and the tenant obtains a fresh one, whereas
    // write-then-consume would leave a lifted field policy behind whenever the
    // consume failed.
    let consumed = state
        .governance
        .four_eyes_consume(
            body.four_eyes_request_ref,
            PROPERTY_POLICY_FOUR_EYES_KIND,
            Some(property_def_id),
            Some(grant),
            principal.user_id,
        )
        .await
        .map_err(|error| RestError::from_ontology(governance_to_ontology(error)))?;
    if consumed != Some(true) {
        return Err(RestError::from_kernel(KernelError::forbidden(
            "attaching a field policy requires an unconsumed four-eyes approval of \
             kind 'ontology.property_policy' bound to this property, whose request \
             carries this exact grant under payload_summary.grant \
             ({\"activity\",\"effect\",\"conditions\"}), approved by a principal \
             other than the requester",
        )));
    }

    // The activity whitelist and the row-independence rule are asserted by
    // `attach_property_policy` at the store boundary, not duplicated here: they
    // are the invariants the READ path relies on, so they belong where every
    // caller crosses, and a copy here is how the two diverge.
    let id = state
        .policies
        .attach_property_policy(AttachPropertyPolicyCommand {
            actor: principal.user_id,
            property_def_id,
            blocks,
        })
        .await
        .map_err(RestError::from_cedar)?;
    Ok((StatusCode::CREATED, Json(AttachObjectPolicyResponse { id })))
}

// ---------------------------------------------------------------------------
// Instance surface (thin over PgInstanceStore)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct InstanceListQuery {
    /// Object-type VERSION id (0105 head) whose current-state instances to list.
    r#type: Uuid,
}

async fn list_instances(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Query(query): Query<InstanceListQuery>,
) -> Result<Json<Vec<InstanceState>>, RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    let gate = type_gate(&state, &principal, query.r#type)
        .await
        .map_err(RestError::from_ontology)?;
    let subject = ontology_subject(&principal);
    let list = state
        .instances
        .list_instances_filtered(ObjectTypeId::from_uuid(query.r#type), &subject, &gate)
        .await
        .map_err(RestError::from_ontology)?;
    Ok(Json(list))
}

/// The object type's own declared properties, which are admissible in policies
/// scoped to it. The residual lowering already reads arbitrary instance
/// attributes; supplying the declared set lets the authoring validator agree,
/// with each property spliced into the Cedar schema so reads stay proven.
/// Only Text and Boolean are representable as optional Cedar attributes; a
/// policy over any other kind fails closed in the validator.
///
/// Attach time and read time MUST derive this from the same function: the
/// loader re-validates every enforced row against the declared set and hard-
/// errors on disagreement, so two spellings would 500 the type forever.
///
/// CEILING (escalated, not fixed here): this is a point-in-time claim. A
/// property that is `Text` at attach and later revised to `Date` turns a valid
/// enforced row into a permanent 500 across every read path that shares
/// [`object_view_policies`]. The durable fix is revision-time re-validation.
fn declared_attrs(properties: &[PropertyDefSummary]) -> Vec<DeclaredAttr> {
    properties
        .iter()
        .filter_map(|property| match property.field_kind {
            FieldKind::Boolean => Some(DeclaredAttr {
                key: property.key.clone(),
                boolean: true,
            }),
            FieldKind::Text => Some(DeclaredAttr {
                key: property.key.clone(),
                boolean: false,
            }),
            _ => None,
        })
        .collect()
}

/// Every policy decision one object-type VERSION carries for one principal: which
/// ROWS the residual admits, and which FIELDS are withheld.
///
/// The two travel together because they are read together on every path, and
/// because computing them apart is how one of them gets forgotten on a new route.
struct TypeGate {
    policies: Vec<ObjectPolicy>,
    /// Property keys denied `read_field`. REMOVED from every served attribute
    /// bag — never nulled. SAP's `field ( suppress ) f;` "removes field from BDEF
    /// derived types", and the reason is not taste: a null is indistinguishable
    /// from a real null, and a client that reads-modifies-writes one erases the
    /// value it was never allowed to see.
    redacted: Vec<String>,
    /// Property keys denied `edit`. An action whose declared edits touch one is
    /// refused before any writeback opens.
    unwritable: Vec<String>,
}

impl TypeGate {
    /// Drop every withheld key from one served row.
    fn redact(&self, state: &mut InstanceState) {
        if self.redacted.is_empty() {
            return;
        }
        redact_attributes(&mut state.revision.attributes, &self.redacted);
    }
}

fn redact_attributes(attributes: &mut Value, keys: &[String]) {
    if let Some(map) = attributes.as_object_mut() {
        for key in keys {
            map.remove(key);
        }
    }
}

/// The field-decision request for one property of one object-type version.
///
/// `resource` deliberately carries NO `resource_id`, `owner`, `branch` or
/// `legal_hold`: this decision is taken once per (principal, type, property) and
/// applied to every row of that type in the response, so it must not be able to
/// depend on any one row. `PROPERTY_POLICY_CONDITION_RULE` makes that a checked
/// invariant rather than a hope — at attach AND on every read.
fn field_request(
    principal: &Principal,
    resource_type: &str,
    field: &str,
    activity: &str,
) -> authoring::SimRequest {
    authoring::SimRequest {
        subject: authoring::SimSubject {
            org: principal.org_id,
            user_id: principal.user_id.to_string(),
            roles: principal
                .roles
                .iter()
                .map(|role| role.as_str().to_owned())
                .collect(),
            // EMPTY, and no policy can depend on it: nothing in this system
            // resolves a clearance set for a request principal (`Principal` has
            // no such field and `ontology_subject`, the object-policy twin, omits
            // it too). `PROPERTY_POLICY_CONDITION_RULE` therefore refuses a
            // `clearance_keys` condition at attach and again on every read, so
            // this cannot silently deny a policy the tenant believed it authored.
            clearance_keys: Vec::new(),
        },
        action: activity.to_owned(),
        resource: authoring::SimResource {
            org: principal.org_id,
            resource_type: resource_type.to_owned(),
            resource_id: None,
            owner: None,
            branch: None,
            legal_hold: None,
        },
        purpose: None,
        field: Some(field.to_owned()),
    }
}

/// Everything the gate decides for one object-type VERSION id.
///
/// An unknown / cross-tenant version id is a 404 here, never an empty policy set
/// — an unresolvable type must not be mistaken for an unpoliced one.
///
/// The version is resolved BY ITS OWN ID through
/// [`PgOntologyStore::object_type_version`], never through the registry head;
/// that function's doc carries the reason, and it is the only reason it exists.
///
/// `declared` likewise comes from the instance's OWN version, not the head: the
/// loader re-validates each enforced row against it, and a policy authored over
/// a property the next version dropped would otherwise 500 forever.
/// Errors on [`PgOntologyError`], not [`RestError`], because BOTH the read
/// channel (`RestError::from_ontology`) and the action channel
/// (`ActionError::Store`) already consume it. That is what lets ONE gate serve
/// the read routes and the write routes without a second error currency — and
/// `RestError` is private, so an `ActionError` variant holding one is E0446.
///
/// COST, stated: a type with no `in_property_policy` property costs exactly what
/// it cost before this function grew field decisions — the loop below does not
/// execute. A flagged property costs two policy loads per read.
async fn type_gate(
    state: &OntologyRestState,
    principal: &Principal,
    object_type_id: Uuid,
) -> Result<TypeGate, PgOntologyError> {
    let (stable_key, schema_version) = state
        .registry
        .object_type_version(ObjectTypeId::from_uuid(object_type_id))
        .await?;
    let properties = state
        .registry
        .get_object_type(&stable_key, Some(schema_version))
        .await?
        .properties;
    let declared = declared_attrs(&properties);
    let blocks = state
        .policies
        .load_enforced_object_policy_blocks(object_type_id, &declared)
        .await
        .map_err(|error| {
            tracing::error!(%error, "ontology object-policy load failed");
            // Renders 500 / "internal" through `status_for_error_kind`, byte-identical
            // to the `RestError::internal` this replaced.
            PgOntologyError::Domain(KernelError::internal(
                "unable to evaluate object visibility policy",
            ))
        })?;

    let mut redacted = Vec::new();
    let mut unwritable = Vec::new();
    for property in properties.iter().filter(|p| p.in_property_policy) {
        for activity in PROPERTY_POLICY_ACTIVITIES {
            let request = field_request(principal, &stable_key, &property.key, activity);
            let outcome = state
                .policies
                .authorize_property_field(*property.id.as_uuid(), &request)
                .await
                .map_err(|error| {
                    tracing::error!(%error, "ontology property-policy load failed");
                    // Fail CLOSED and loudly. Degrading a field-policy load error
                    // to "allow" would serve the exact field the tenant declared
                    // sensitive, with the failure visible only in a log line.
                    PgOntologyError::Domain(KernelError::internal(
                        "unable to evaluate field visibility policy",
                    ))
                })?;
            if outcome.effect.is_allow() {
                continue;
            }
            if *activity == authoring::PROPERTY_POLICY_ACTION {
                redacted.push(property.key.clone());
            } else {
                unwritable.push(property.key.clone());
            }
        }
    }

    Ok(TypeGate {
        policies: applicable_object_policies(&blocks, &stable_key),
        redacted,
        unwritable,
    })
}

/// The gate, and the only module in this crate that can reach an ungated
/// single-row read.
///
/// [`PgInstanceStore::get_current`] serves any row the RLS org floor admits and
/// applies NO object-policy residual, so every call to it outside
/// [`visible_head_inner`] is a policy bypass. This module makes that
/// unrepresentable rather than merely reviewed: [`Instances`] wraps the store in
/// a private tuple field, and `lib.rs` is this module's PARENT, which cannot
/// reach a child's private field.
///
/// Wrapping alone is NOT the property, and claiming it was is how this hole
/// nearly shipped: `get_as_of`, `history` and `traverse` apply no residual
/// either, so re-exporting them by `InstanceId` would have let a new route read
/// every revision of a hidden row with the seal fully intact. Each of them takes
/// PROOF instead of an id:
///
///   * [`Instances::get_as_of`] and [`Instances::history`] take [`Visible`],
///     whose field is private to this module, so [`visible_head_inner`] is the
///     only thing in the crate that can produce one — `InstanceState` itself is
///     all-`pub` and a struct literal would forge it. The id is read off the
///     proof, so it cannot even be pointed at a different row than the one gated.
///   * `traverse` is not re-exported at all. [`visible_traversal`] is the whole
///     route body, so the raw graph never exists outside this module.
///
/// WHAT THIS SEAL DOES AND DOES NOT COVER — stated precisely, because an
/// earlier version of this comment claimed more than the code delivers and a
/// reviewer refuted it by execution.
///
/// It DOES make the specific hole that produced this slice unrepresentable:
/// `get_current` has exactly one call site and it is inside this module, so a
/// future route cannot fetch a single row's head unfiltered no matter how it is
/// classified in the route table.
///
/// It does NOT make every conceivable ungated read impossible. The passthroughs
/// above are re-exported, and a sufficiently determined new handler can compose
/// them into a read this module never anticipated. `NotInstanceBearing` in the
/// route-classification table therefore remains a DECLARATIVE label with no
/// enforcement behind it: a future route mislabelled there ships green. That is
/// a known, named gap, not a covered one — the honest compensating control is
/// that `Gated` IS load-bearing and is proven red by mutation, not that
/// mislabelling has been made harmless.
mod gate {
    use super::*;

    #[derive(Clone)]
    pub(super) struct Instances(PgInstanceStore);

    /// One instance head the object-policy residual admitted for this principal,
    /// together with the field decisions that apply to it.
    ///
    /// The fields are private to `gate`, which is the entire point: a value of
    /// this type is evidence that [`visible_head_inner`] ran, and no other module
    /// can manufacture one.
    pub(super) struct Visible {
        state: InstanceState,
        /// The field decisions for THIS ROW'S OWN object-type version — never the
        /// caller-supplied one. Carried on the proof so [`Instances::get_as_of`],
        /// [`Instances::history`] and the action path — which take the proof and
        /// not an id — need no second gate evaluation that could disagree with,
        /// or be resolved from a different type than, the one that admitted the
        /// row.
        gate: TypeGate,
    }

    impl Visible {
        /// The row AS SERVED: every withheld field is REMOVED from the bag.
        ///
        /// The REDACTING read is the one that keeps the short, obvious name, and
        /// that is the whole design: a new route reaching for the method it
        /// already knows gets the safe answer, and the unredacted read has to be
        /// asked for by a name that says what it is for.
        pub(super) fn into_inner(mut self) -> InstanceState {
            self.gate.redact(&mut self.state);
            self.state
        }

        /// The row AS STORED, withheld fields included, TOGETHER WITH the gate
        /// resolved from the row's own type — for computing the NEXT revision's
        /// attribute bag, and for nothing else.
        ///
        /// The two are returned as a pair on purpose. `command.object_type_id` is
        /// caller-supplied and nothing in the action path requires it to equal the
        /// instance's `object_type_id`, so deriving the redaction set from it
        /// while redacting a bag that came from the instance is the exact
        /// inversion [`visible_head_inner`] documents as forbidden. A caller that
        /// gets the base bag cannot get it without the matching gate.
        ///
        /// Serving this unredacted would be the bypass. Merging edits onto the
        /// REDACTED bag would be worse: `apply_edits` returns the merged map and
        /// `stage_revision_in_tx` persists it wholesale, so a principal who may
        /// edit one field would silently DELETE every field they may not read.
        /// That read-modify-write erasure is exactly what SAP's suppress
        /// semantics warn about, and it is why the two reads are different
        /// methods rather than a boolean.
        pub(super) fn into_writeback_base(self) -> (InstanceState, TypeGate) {
            (self.state, self.gate)
        }
    }

    impl Instances {
        pub(super) fn new(inner: PgInstanceStore) -> Self {
            Self(inner)
        }

        /// The list surface, already field-redacted. Takes the whole
        /// [`TypeGate`] rather than its `policies`, so a caller cannot obtain the
        /// row filter without also obtaining the field filter.
        pub(super) async fn list_instances_filtered(
            &self,
            object_type_id: ObjectTypeId,
            subject: &SubjectAttrs,
            gate: &TypeGate,
        ) -> Result<Vec<InstanceState>, PgOntologyError> {
            let mut rows = self
                .0
                .list_instances_filtered(object_type_id, subject, &gate.policies)
                .await?;
            for row in &mut rows {
                gate.redact(row);
            }
            Ok(rows)
        }

        pub(super) async fn visible_instances(
            &self,
            object_type_id: ObjectTypeId,
            ids: Option<&[Uuid]>,
            subject: &SubjectAttrs,
            policies: &[ObjectPolicy],
        ) -> Result<Vec<InstanceState>, PgOntologyError> {
            self.0
                .visible_instances(object_type_id, ids, subject, policies)
                .await
        }

        /// An earlier revision of a row whose HEAD the caller has already been
        /// granted. `head` is the proof — only [`visible_head_inner`] mints one
        /// — and the id is read off it, so this cannot be pointed at a row the
        /// residual never admitted.
        pub(super) async fn get_as_of(
            &self,
            head: &Visible,
            at: OffsetDateTime,
        ) -> Result<InstanceState, PgOntologyError> {
            let mut state = self.0.get_as_of(head.state.instance.id, at).await?;
            // The as-of revision carries the SAME schema and therefore the same
            // withheld keys as the head that admitted it. Redacting it here and
            // not at the route is what keeps `?as_of=` from being the time-travel
            // hole the head gate already refuses to be.
            head.gate.redact(&mut state);
            Ok(state)
        }

        /// The revision chain of a row whose HEAD the caller has already been
        /// granted, INTACT. Never filtered per revision: `verify_chain` breaks on
        /// the first `prev_hash` gap, so a per-revision security filter would
        /// masquerade as a tamper alarm.
        ///
        /// FAIL-CLOSED on any withheld field, and this is a STATED decision
        /// rather than an emergent one. Fixity and redaction are in direct
        /// conflict here: the chain is only evidence if it is served whole, and a
        /// bag with a key removed no longer hashes to its recorded `row_hash`.
        /// There is no third option that is both honest evidence and a redacted
        /// read, so the read is refused — with the adapter's own `not_found`, so
        /// a principal who may not read a field cannot use this endpoint to learn
        /// that the field, or the row, exists.
        ///
        /// It costs nothing when nothing is withheld, which is every type that
        /// declares no `in_property_policy` property.
        pub(super) async fn history(
            &self,
            head: &Visible,
        ) -> Result<Vec<RevisionSummary>, PgOntologyError> {
            if !head.gate.redacted.is_empty() {
                return Err(PgOntologyError::Domain(KernelError::not_found(
                    "instance was not found",
                )));
            }
            self.0.history(head.state.instance.id).await
        }
    }

    /// THE gate. Every path that serves, evaluates or mutates a single instance
    /// routes through here — the read routes via [`visible_head`], the action and
    /// lifecycle routes directly, because they carry the [`ActionError`] channel.
    /// One helper, one residual: a second gating path would let the two diverge.
    ///
    /// Returns the row the FILTER produced, never the unfiltered head, so what a
    /// caller is served is by construction what the residual permitted — a gate
    /// that read twice could let the two reads diverge.
    ///
    /// A denied row is `not_found` with the adapter's own message, byte-identical
    /// to `load_current_state_tx`'s, so a denied row and a nonexistent one are
    /// indistinguishable. **404, never 403**: a 403 turns the status code into an
    /// existence oracle.
    ///
    /// The object type is resolved from the INSTANCE'S OWN `object_type_id`, never
    /// from a caller-supplied one, so naming a type you can see while targeting an
    /// instance of a type you cannot is not a bypass.
    pub(super) async fn visible_head_inner(
        state: &OntologyRestState,
        principal: &Principal,
        id: Uuid,
    ) -> Result<Visible, PgOntologyError> {
        let head = state
            .instances
            .0
            .get_current(InstanceId::from_uuid(id))
            .await?;
        let object_type_id = head.instance.object_type_id;
        let gate = type_gate(state, principal, *object_type_id.as_uuid()).await?;
        let subject = ontology_subject(principal);
        state
            .instances
            .visible_instances(object_type_id, Some(&[id]), &subject, &gate.policies)
            .await?
            .into_iter()
            .next()
            // Stored UNREDACTED, with the gate resolved from THIS ROW'S OWN
            // `object_type_id` travelling beside it: the action path merges edits
            // onto this bag and persists the result, so redacting here would make
            // every action a silent erasure of every field the actor may not
            // read. Redaction happens on the way OUT, in `Visible::into_inner`.
            .map(|state| Visible { state, gate })
            .ok_or_else(|| {
                PgOntologyError::Domain(KernelError::not_found("instance was not found"))
            })
    }

    pub(super) async fn visible_head(
        state: &OntologyRestState,
        principal: &Principal,
        id: Uuid,
    ) -> Result<Visible, RestError> {
        visible_head_inner(state, principal, id)
            .await
            .map_err(RestError::from_ontology)
    }

    /// Walk the graph and filter it in ONE call, so the unfiltered
    /// [`TraversalGraph`] never leaves this module. [`Instances`] deliberately
    /// does not re-export `traverse`: a raw walk in the parent module would be an
    /// ungated read of every neighbour's id, type, title and lifecycle state.
    pub(super) async fn visible_traversal(
        state: &OntologyRestState,
        principal: &Principal,
        root: InstanceId,
        link_type_id: Option<LinkTypeId>,
        depth: u32,
    ) -> Result<TraversalGraph, RestError> {
        let graph = state
            .instances
            .0
            .traverse(root, link_type_id, depth)
            .await
            .map_err(RestError::from_ontology)?;
        visible_subgraph(state, principal, graph).await
    }

    /// Drop from a traversal every node the object-policy residual does not admit,
    /// every edge touching one, and everything the root can no longer reach.
    ///
    /// Gating only the root measurably disclosed both hidden neighbours' titles at
    /// depth 1. Nodes are grouped by `object_type_id` because a neighbour may be of
    /// a different type than the root — including a built-in catalog type — and each
    /// type carries its own attached policies.
    async fn visible_subgraph(
        state: &OntologyRestState,
        principal: &Principal,
        graph: TraversalGraph,
    ) -> Result<TraversalGraph, RestError> {
        let subject = ontology_subject(principal);
        let mut by_type: HashMap<ObjectTypeId, Vec<Uuid>> = HashMap::new();
        for node in &graph.nodes {
            by_type
                .entry(node.object_type_id)
                .or_default()
                .push(*node.instance_id.as_uuid());
        }
        let mut visible: HashSet<Uuid> = HashSet::new();
        for (object_type_id, ids) in by_type {
            // No redaction pass here, and none is missing: a `TraversalNode`
            // carries id, type, title, lifecycle and depth — never an attribute
            // bag. The gate is still evaluated for its ROW filter.
            let gate = type_gate(state, principal, *object_type_id.as_uuid())
                .await
                .map_err(RestError::from_ontology)?;
            let rows = state
                .instances
                .visible_instances(object_type_id, Some(&ids), &subject, &gate.policies)
                .await
                .map_err(RestError::from_ontology)?;
            visible.extend(rows.iter().map(|row| *row.instance.id.as_uuid()));
        }

        let root = *graph.root.as_uuid();
        if !visible.contains(&root) {
            return Err(RestError::from_kernel(KernelError::not_found(
                "instance was not found",
            )));
        }
        let edges: Vec<_> = graph
            .edges
            .into_iter()
            .filter(|edge| {
                visible.contains(edge.from_instance_id.as_uuid())
                    && visible.contains(edge.to_instance_id.as_uuid())
            })
            .collect();

        // Re-BFS from the root over what survives: a node whose only path ran
        // through a hidden one is no longer reachable, and its recorded depth would
        // otherwise disclose the length of that hidden path.
        //
        // FIFO, not LIFO. `depth` is the SHORTEST hop count — `PgInstanceStore::
        // traverse` computes it level by level — and the `Vacant` guard below writes
        // each node's depth exactly once, so the first visit has to be the shortest
        // one. A stack visits the long arm of a diamond first, records its length,
        // and then declines to lower it: measured `far` at 3 when it was 2 hops
        // away, with nothing hidden at all.
        let mut depths: HashMap<Uuid, u32> = HashMap::from([(root, 0)]);
        let mut frontier = VecDeque::from([root]);
        while let Some(current) = frontier.pop_front() {
            let depth = depths[&current];
            for edge in &edges {
                if *edge.from_instance_id.as_uuid() == current {
                    let next = *edge.to_instance_id.as_uuid();
                    if let Entry::Vacant(slot) = depths.entry(next) {
                        slot.insert(depth + 1);
                        frontier.push_back(next);
                    }
                }
            }
        }
        let mut nodes: Vec<_> = graph
            .nodes
            .into_iter()
            .filter_map(|node| {
                depths
                    .get(node.instance_id.as_uuid())
                    .map(|depth| TraversalNode {
                        depth: *depth,
                        ..node
                    })
            })
            .collect();
        // `traverse` hands its nodes over sorted by `(depth, id)`; a recomputed
        // depth can violate that, so restore the order the response contract states.
        nodes.sort_by_key(|node| (node.depth, *node.instance_id.as_uuid()));
        let edges = edges
            .into_iter()
            .filter(|edge| {
                depths.contains_key(edge.from_instance_id.as_uuid())
                    && depths.contains_key(edge.to_instance_id.as_uuid())
            })
            .collect();
        Ok(TraversalGraph {
            root: graph.root,
            nodes,
            edges,
        })
    }
}

use gate::{visible_head, visible_head_inner, visible_traversal};

/// Convert only the already-validated no-code row-policy subset into the SQL
/// residual grammar. A condition unsupported by residual lowering is retained
/// as an intentionally untranslatable predicate, making the adapter return
/// `WHERE FALSE`; it can never silently widen a list.
fn applicable_object_policies(blocks: &[NoCodeBlocks], stable_key: &str) -> Vec<ObjectPolicy> {
    blocks
        .iter()
        .filter(|block| block.action == "view" && block.resource_type == stable_key)
        .map(|block| ObjectPolicy {
            effect: block.effect,
            predicates: block.conditions.iter().map(residual_predicate).collect(),
        })
        .collect()
}

fn residual_predicate(
    condition: &console_platform_authz::cedar_pbac::authoring::Condition,
) -> Predicate {
    let op = match condition.op {
        ConditionOp::Eq => ResidualOp::Eq,
        ConditionOp::Ne => ResidualOp::Ne,
        // `contains` has no row-field equivalent. Use a deliberately missing
        // subject attribute so lowering fails closed for the whole request.
        ConditionOp::Contains => ResidualOp::In,
    };
    let value = match (&condition.op, &condition.value) {
        (ConditionOp::Contains, _) => {
            PredicateValue::SubjectAttr("__unsupported_contains__".to_owned())
        }
        (_, ConditionValue::Literal(value)) => {
            PredicateValue::Literal(SqlValue::Text(value.clone()))
        }
        (_, ConditionValue::Bool(value)) => PredicateValue::Literal(SqlValue::Bool(*value)),
        (_, ConditionValue::SubjectAttr(value)) => PredicateValue::SubjectAttr(value.clone()),
    };
    Predicate {
        field: condition.attr.clone(),
        op,
        value,
    }
}

fn ontology_subject(principal: &Principal) -> SubjectAttrs {
    SubjectAttrs::default()
        .with_scalar("user_id", principal.user_id.to_string())
        .with_scalar("org", principal.org_id.to_string())
        .with_set(
            "roles",
            principal
                .roles
                .iter()
                .map(|role| role.as_str().to_owned())
                .collect(),
        )
}

#[derive(Debug, Deserialize)]
struct AsOfQuery {
    /// RFC3339 instant for a bi-temporal as-of read; absent = current head.
    #[serde(default, with = "time::serde::rfc3339::option")]
    as_of: Option<OffsetDateTime>,
}

async fn get_instance(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(query): Query<AsOfQuery>,
) -> Result<Json<InstanceState>, RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    // The HEAD is what the gate decides on, including for an as-of read:
    // gating the as-of revision instead would be a time-travel bypass — a
    // caller could read a hidden row at an instant before the attribute the
    // policy matches on took its current value.
    let head = visible_head(&state, &principal, id).await?;
    match query.as_of {
        Some(at) => Ok(Json(
            state
                .instances
                .get_as_of(&head, at)
                .await
                .map_err(RestError::from_ontology)?,
        )),
        None => Ok(Json(head.into_inner())),
    }
}

async fn get_instance_history(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<RevisionSummary>>, RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    // The gated head is the ARGUMENT, not a discarded precondition: `history`
    // takes proof, so this cannot decay into an ungated read by deleting a line.
    let head = visible_head(&state, &principal, id).await?;
    let history = state
        .instances
        .history(&head)
        .await
        .map_err(RestError::from_ontology)?;
    Ok(Json(history))
}

#[derive(Debug, Deserialize)]
struct TraverseQuery {
    #[serde(default)]
    link_type: Option<Uuid>,
    #[serde(default = "default_depth")]
    depth: u32,
}

const fn default_depth() -> u32 {
    2
}

async fn traverse_instance(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(query): Query<TraverseQuery>,
) -> Result<Json<TraversalGraph>, RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    // The root is gated by `visible_traversal` along with every other node, from
    // ONE residual evaluation. A separate pre-gate would be a second read of the
    // same fact, free to diverge from the one that decides the node set. The walk
    // and the filter are ONE call because the unfiltered graph must not be
    // nameable here: `traverse` is not re-exported from `gate` at all.
    Ok(Json(
        visible_traversal(
            &state,
            &principal,
            InstanceId::from_uuid(id),
            query.link_type.map(LinkTypeId::from_uuid),
            query.depth,
        )
        .await?,
    ))
}

// ---------------------------------------------------------------------------
// Action preflight / execute (§2 single mutation path, §16 gate chain)
// ---------------------------------------------------------------------------

/// Typed action command (HTTP-independent) shared by preflight + execute, so the
/// same single mutation path is drivable from a test / automation caller without
/// a live HTTP request. `object_type_id` disambiguates the `action_key` (an action
/// key is unique only per object type); the target is `instance_id` for an edit,
/// or absent for a create (which then needs a `title`).
#[derive(Debug, Clone)]
pub struct ActionCommand {
    pub object_type_id: ObjectTypeId,
    pub instance_id: Option<InstanceId>,
    pub title: Option<String>,
    pub params: Value,
    pub reason: Option<String>,
    pub valid_from: Option<OffsetDateTime>,
    /// Client-supplied self-checklist acknowledgement (there is no checklist
    /// object store yet; §16 gate 2 reads this witness, fail-closed when absent).
    pub checklist_all_acknowledged: Option<bool>,
    /// Four-eyes request ref; its decision is read from the DB, never trusted
    /// from the caller.
    pub four_eyes_request_ref: Option<Uuid>,
    /// Stable client id reused for a network retry of this command.
    pub command_id: Option<Uuid>,
    /// Required current revision for an instance edit (create has no prior head).
    pub expected_revision: Option<i64>,
}

/// The HTTP body for both preflight and execute (JSON with bare UUIDs); converted
/// to a typed [`ActionCommand`] before it touches the orchestration.
#[derive(Debug, Deserialize)]
struct ActionRequest {
    object_type_id: Uuid,
    #[serde(default)]
    instance_id: Option<Uuid>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    valid_from: Option<OffsetDateTime>,
    #[serde(default)]
    checklist_all_acknowledged: Option<bool>,
    #[serde(default)]
    four_eyes_request_ref: Option<Uuid>,
    #[serde(default)]
    command_id: Option<Uuid>,
    #[serde(default)]
    expected_revision: Option<i64>,
}

impl ActionRequest {
    fn into_command(self) -> ActionCommand {
        ActionCommand {
            object_type_id: ObjectTypeId::from_uuid(self.object_type_id),
            instance_id: self.instance_id.map(InstanceId::from_uuid),
            title: self.title,
            params: self.params,
            reason: self.reason,
            valid_from: self.valid_from,
            checklist_all_acknowledged: self.checklist_all_acknowledged,
            four_eyes_request_ref: self.four_eyes_request_ref,
            command_id: self.command_id,
            expected_revision: self.expected_revision,
        }
    }
}

/// Outcome of a preflight — each gate's status plus whether submit criteria hold,
/// without committing anything.
#[derive(Debug, Clone, Serialize)]
pub struct PreflightOutcome {
    pub dispatch: ActionDispatch,
    pub dispatch_target: Option<String>,
    pub config: GateChainConfig,
    pub gates: GateChainOutcome,
    pub criteria_ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub criteria_error: Option<String>,
    /// Would `execute` proceed? (gates allow AND criteria hold).
    pub would_execute: bool,
}

/// Outcome of a successful execute — the gate chain that admitted it plus the
/// dispatch result. Exactly one of `instance` / `projected` is populated per the
/// `dispatch` kind; both are `Option` so the serialized shape stays backward-
/// compatible (an `instance_revision` result still carries the same top-level
/// `instance` key it always did — the console reads it unchanged).
#[derive(Debug, Clone, Serialize)]
pub struct ExecuteOutcome {
    pub dispatch: ActionDispatch,
    pub gates: GateChainOutcome,
    /// The appended revision head — present for an `instance_revision` dispatch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<InstanceState>,
    /// The domain use-case's JSON summary — present for a `projected_usecase`
    /// dispatch (the engine wrote nothing; the owning domain crate did).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projected: Option<Value>,
    /// Immutable evidence for an instance-revision command. Projected actions
    /// retain their established domain-owned contract and have no engine receipt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<CommandReceipt>,
}

/// Immutable, replayable evidence of one accepted instance action command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandReceipt {
    pub command_id: Uuid,
    pub payload_digest: String,
    pub instance: InstanceState,
    pub gates: GateChainOutcome,
}

/// Typed action failure, distinct from a raw DB error so callers (and tests) can
/// tell a gate deny from a not-yet-wired dispatch from a validation failure.
#[derive(Debug)]
pub enum ActionError {
    /// No action of that key on the given object type (or cross-tenant → hidden).
    NotFound,
    /// Params / control-point / edit shape rejected (fail-closed).
    Validation(String),
    /// A §16 gate blocked the action; nothing was written.
    GateDenied(String),
    /// A submission criterion did not hold; nothing was written.
    CriteriaFailed(String),
    /// A `projected_usecase` action whose `dispatch_target` has no registered
    /// domain handler (unwired or misconfigured). Fail-closed: no table write.
    NotWiredYet { target: Option<String> },
    /// A store / DB / context error.
    Store(PgOntologyError),
}

impl ActionError {
    /// Wrap a domain use-case's [`KernelError`] as a projected-dispatch failure,
    /// preserving its kind so the REST layer maps it to the right status (a domain
    /// `forbidden`/`conflict`/`not_found` stays a 403/409/404). The canonical way a
    /// [`ProjectedHandler`] surfaces a domain rejection without depending on the
    /// ontology adapter's error type.
    #[must_use]
    pub fn domain(error: KernelError) -> Self {
        Self::Store(PgOntologyError::Domain(error))
    }
}

/// Everything resolved for an action request, shared by preflight + execute.
struct Prepared {
    action: ActionTypeSummary,
    config: GateChainConfig,
    params: Value,
    /// The target's CURRENT attributes, UNREDACTED — this is the base the next
    /// revision is merged onto and persisted from. See
    /// [`gate::Visible::into_writeback_base`] for why a redacted base would be an
    /// erasure rather than a protection.
    base_attrs: Value,
    criteria: Result<(), KernelError>,
    /// Property keys withheld from this principal on the acting object type;
    /// stripped from the outcome this action returns.
    redacted: Vec<String>,
}

impl OntologyRestState {
    /// Preflight an action: resolve it, run the §16 gate chain and evaluate submit
    /// criteria, and report the per-gate status WITHOUT committing anything.
    pub async fn preflight_action(
        &self,
        principal: &Principal,
        action_key: &str,
        command: ActionCommand,
    ) -> Result<PreflightOutcome, ActionError> {
        let prepared = self.prepare(principal, action_key, &command).await?;
        let gates = self.evaluate_gates(principal, &prepared, &command).await?;
        let criteria_ok = prepared.criteria.is_ok();
        let criteria_error = prepared.criteria.as_ref().err().map(|e| e.message.clone());
        Ok(PreflightOutcome {
            dispatch: prepared.action.dispatch,
            dispatch_target: prepared.action.dispatch_target.clone(),
            config: prepared.config,
            would_execute: gates.allow && criteria_ok,
            gates,
            criteria_ok,
            criteria_error,
        })
    }

    /// Execute an action — the core single mutation path for humans + automation.
    /// Fail-closed: an unmet gate, a failed submit criterion, or a malformed edit
    /// denies BEFORE any writeback opens. `instance_revision` then appends a
    /// fixity-chained revision inside one audited tx that re-checks the mutable
    /// gate; `projected_usecase` routes to the owning domain use-case via the
    /// [`ProjectedDispatchRegistry`] (unknown target ⇒ [`ActionError::NotWiredYet`]).
    pub async fn execute_action(
        &self,
        principal: &Principal,
        action_key: &str,
        command: ActionCommand,
    ) -> Result<ExecuteOutcome, ActionError> {
        let prepared = self.prepare(principal, action_key, &command).await?;

        if let Err(err) = &prepared.criteria {
            return Err(ActionError::CriteriaFailed(err.message.clone()));
        }

        match prepared.action.dispatch {
            ActionDispatch::ProjectedUsecase => {
                let gates = self.evaluate_gates(principal, &prepared, &command).await?;
                if !gates.allow {
                    return Err(ActionError::GateDenied(
                        "an action gate is not satisfied".to_owned(),
                    ));
                }
                // No engine writeback: route to the owning domain crate's use-case,
                // which owns its own RLS + audit + tx (§9.3 — no second source of
                // truth). An unwired/unknown target fails closed (`NotWiredYet`).
                //
                // The §16 gate chain was already enforced fail-closed above. TOCTOU-
                // safety of the domain MUTATION is the domain use-case's own
                // responsibility and varies by use-case (a work-order transition
                // locks its row + guards the from-state; an equipment update is
                // last-write-wins with non-destructive version capture) — the engine
                // makes no claim about it here.
                //
                // Fail-closed on config the engine cannot honor: in v1 the engine
                // cannot read a projected domain row generically, so a submission
                // criterion (which would evaluate against an EMPTY base and could
                // silently pass — fail-open) is not faithfully evaluable for a
                // projected action. Reject it rather than dispatch on a criterion we
                // did not really check. Params-scoped projected criteria return with
                // the projected-state-read follow-up.
                if prepared
                    .action
                    .submission_criteria
                    .as_array()
                    .is_some_and(|criteria| !criteria.is_empty())
                {
                    return Err(ActionError::CriteriaFailed(
                        "submission criteria are not evaluable for a projected_usecase \
                         action in v1 (the engine cannot read the projected domain row); \
                         nothing was dispatched"
                            .to_owned(),
                    ));
                }
                let target = prepared.action.dispatch_target.clone().ok_or(
                    // A projected action with no target can never resolve a handler.
                    ActionError::NotWiredYet { target: None },
                )?;
                // The §16 chain (incl. the four-eyes peek) passed above, but a
                // projected use-case owns its own tx we cannot join, so we bind-match
                // AND consume the approval in our own committed step right before
                // dispatch (single-use — a replay is denied). A failed dispatch spends
                // the approval: fail-closed, the requester re-requests.
                if let Some(request_ref) = command
                    .four_eyes_request_ref
                    .filter(|_| prepared.config.four_eyes)
                {
                    let (kind, bound_target) = action_four_eyes_binding(&prepared, &command);
                    let consumed = self
                        .governance
                        .four_eyes_consume(
                            request_ref,
                            kind,
                            Some(bound_target),
                            None,
                            principal.user_id,
                        )
                        .await
                        .map_err(|e| ActionError::Store(governance_to_ontology(e)))?;
                    if consumed != Some(true) {
                        return Err(ActionError::GateDenied(
                            "four-eyes approval was already consumed or does not \
                             match this action"
                                .to_owned(),
                        ));
                    }
                }
                let projected = self
                    .projected_dispatch
                    .dispatch(ProjectedDispatch {
                        principal: principal.clone(),
                        target,
                        target_id: command.instance_id.map(|id| *id.as_uuid()),
                        params: prepared.params.clone(),
                        reason: command.reason.clone(),
                        occurred_at: OffsetDateTime::now_utc(),
                    })
                    .await?;
                Ok(ExecuteOutcome {
                    dispatch: ActionDispatch::ProjectedUsecase,
                    gates,
                    instance: None,
                    projected: Some(projected),
                    receipt: None,
                })
            }
            ActionDispatch::InstanceRevision => {
                // Resolve the declarative edits into the new attribute bag.
                let new_attrs = apply_edits(
                    &prepared.action.edits,
                    &prepared.params,
                    &prepared.base_attrs,
                )
                .map_err(|e| ActionError::Validation(e.message))?;
                let mut receipt = self
                    .execute_instance_revision(
                        principal, action_key, &command, &prepared, new_attrs,
                    )
                    .await
                    .map_err(|error| match &error {
                        PgOntologyError::Domain(kernel)
                            if kernel.kind == ErrorKind::Forbidden
                                && kernel.message
                                    == "action gate re-check failed inside the writeback transaction" =>
                        {
                            ActionError::GateDenied("an action gate is not satisfied".to_owned())
                        }
                        _ => ActionError::Store(error),
                    })?;
                // The PERSISTED receipt (`ont_action_command_receipts`) keeps the
                // full bag: it is the replay evidence for this command_id, and a
                // redacted one would hand a differently-redacted answer back to
                // whoever replays it. Redaction happens on the copy that leaves,
                // after the writeback has committed.
                redact_attributes(
                    &mut receipt.instance.revision.attributes,
                    &prepared.redacted,
                );
                Ok(ExecuteOutcome {
                    dispatch: ActionDispatch::InstanceRevision,
                    gates: receipt.gates.clone(),
                    instance: Some(receipt.instance.clone()),
                    projected: None,
                    receipt: Some(receipt),
                })
            }
        }
    }

    /// Resolve the action, validate params, load the target's current attributes,
    /// evaluate submission criteria — the deterministic prep both paths share.
    async fn prepare(
        &self,
        principal: &Principal,
        action_key: &str,
        command: &ActionCommand,
    ) -> Result<Prepared, ActionError> {
        let action = self
            .registry
            .get_action_type(command.object_type_id, action_key)
            .await
            .map_err(ActionError::Store)?
            .ok_or(ActionError::NotFound)?;

        let config = parse_control_points(&action.control_points)
            .map_err(|e| ActionError::Validation(e.message))?;
        let params = validate_params(&action.params_schema, &command.params)
            .map_err(|e| ActionError::Validation(e.message))?;

        // Load the edit target's current attributes (empty for a create) so submit
        // criteria can read both the pending params and the object's current state.
        // Only an `instance_revision` target lives in `ont_instances`; a projected
        // action's target_id is a DOMAIN row (equipment, work order, …) that the
        // engine does not own, so we never resolve it here (submit criteria for a
        // projected action read params only) — and gating it would 404 every
        // projected dispatch against a row this crate cannot even see.
        //
        // Read THROUGH the gate: what an action evaluates is by construction what
        // the residual permitted. Both callers reach this before any write opens,
        // so a hidden row is refused before a revision, an approval or a dispatch
        // can be spent. A denied row raises the adapter's own `not_found`, so it
        // is indistinguishable from a genuinely missing one — 404, never 403.
        let (base_attrs, instance_gate) = match (action.dispatch, command.instance_id) {
            (ActionDispatch::InstanceRevision, Some(id)) => {
                // UNREDACTED on purpose: `apply_edits` merges the action's edits
                // onto this map and `stage_revision_in_tx` persists the whole
                // result. Handing it a redacted bag would make every action a
                // silent DELETE of every field the actor may not read — a worse
                // outcome than the disclosure it looks like it is preventing.
                // What the caller is SERVED is redacted below.
                let (state, gate) = visible_head_inner(self, principal, *id.as_uuid())
                    .await
                    .map_err(ActionError::Store)?
                    .into_writeback_base();
                (state.revision.attributes, Some(gate))
            }
            _ => (Value::Object(serde_json::Map::new()), None),
        };

        // Field policy on the WRITE side. SAP's authorization field is the
        // smallest unit of an authorization object and represents "activities
        // such as reading OR CHANGING"; a field policy that only masked reads
        // would be half of it, and the half that does not stop an automation.
        //
        // Resolved from the INSTANCE'S OWN `object_type_id` whenever there is an
        // instance — the same rule `visible_head_inner` states, and for the same
        // reason. `command.object_type_id` is caller-supplied and nothing here
        // requires it to equal the target's type, so deriving the withheld set
        // from it would let a caller name a type with no field policy and be
        // handed another type's row with nothing removed. Only a CREATE falls
        // back to the command's type, and only because there is no instance to
        // derive one from.
        let gate = match instance_gate {
            Some(gate) => gate,
            None => type_gate(self, principal, *command.object_type_id.as_uuid())
                .await
                .map_err(ActionError::Store)?,
        };
        if !gate.unwritable.is_empty() {
            // Declared edits, read straight off the stored action. `apply_edits`
            // performs the authoritative parse and rejects a malformed list; this
            // only needs the property names, and a name it cannot see is a name
            // no edit can write.
            let blocked: Vec<&str> = action
                .edits
                .as_array()
                .map(|edits| {
                    edits
                        .iter()
                        .filter_map(|edit| edit.get("property").and_then(Value::as_str))
                        .filter(|property| gate.unwritable.iter().any(|denied| denied == property))
                        .collect()
                })
                .unwrap_or_default();
            if !blocked.is_empty() {
                // BEFORE any writeback opens, and before a four-eyes approval can
                // be spent: `prepare` is the first thing both `preflight_action`
                // and `execute_action` call.
                return Err(ActionError::GateDenied(format!(
                    "a field policy denies changing {}",
                    blocked.join(", ")
                )));
            }
        }

        let context = evaluation_context(&base_attrs, &params);
        let criteria = evaluate_submission_criteria(&action.submission_criteria, &context);

        Ok(Prepared {
            action,
            config,
            params,
            base_attrs,
            criteria,
            redacted: gate.redacted,
        })
    }

    /// Gather gate evidence and evaluate the chain. Authority is the legacy
    /// authorization contract's effect (the sole enforcer today; the seam is
    /// `authority_effect_from_cedar`); four-eyes is read from the DB; egress is
    /// derived from declared side effects; checklist is client-supplied.
    async fn evaluate_gates(
        &self,
        principal: &Principal,
        prepared: &Prepared,
        command: &ActionCommand,
    ) -> Result<GateChainOutcome, ActionError> {
        let authority = authority_effect(principal);
        // Non-consuming peek only — the authoritative bind-match + single-use
        // consume happens inside the writeback tx (`instance_revision_writeback`).
        let (expected_kind, expected_target) = action_four_eyes_binding(prepared, command);
        let four_eyes_approved = match command.four_eyes_request_ref {
            Some(request_ref) => self
                .governance
                .four_eyes_approved(request_ref, expected_kind, Some(expected_target))
                .await
                .map_err(|e| ActionError::Store(governance_to_ontology(e)))?,
            None => None,
        };
        let evidence = GateEvidence {
            authority: Some(authority),
            checklist_all_acknowledged: command.checklist_all_acknowledged,
            four_eyes_approved,
            egress_cleared: egress_evidence(&prepared.action.side_effects),
        };
        Ok(evaluate_gate_chain(prepared.config, &evidence))
    }

    async fn execute_instance_revision(
        &self,
        principal: &Principal,
        action_key: &str,
        command: &ActionCommand,
        prepared: &Prepared,
        new_attrs: Value,
    ) -> Result<CommandReceipt, PgOntologyError> {
        instance_revision_writeback(self, principal, action_key, command, prepared, new_attrs).await
    }
}

/// The §16 Authority gate input: today the legacy role matrix is the sole
/// enforcer, evaluated through the typed authorization contract and mapped onto
/// the gate's [`AuthorityEffect`] via the governance seam. Ontology is an
/// org-scoped admin surface, so this authorizes org-wide `RoleManage` (matching
/// the governance console); L-WIRE may introduce a dedicated ontology feature.
fn authority_effect(principal: &Principal) -> AuthorityEffect {
    let request = AuthorizationRequest::new(
        principal.clone(),
        Action::new(Feature::RoleManage),
        AuthorizationResource::org_wide(principal.org_id, "ontology_action"),
    );
    authority_effect_from_cedar(evaluate_legacy_contract(&request).effect)
}

/// The (action_kind, target) a four-eyes approval must be bound to for this action:
/// the action's stable key, and the object it acts on — the instance for an edit,
/// or the object type for a create (which has no instance target yet). Both are
/// server-derived, never trusted from the caller, so an approval decided for a
/// different action or object can never satisfy this gate.
fn action_four_eyes_binding<'a>(
    prepared: &'a Prepared,
    command: &ActionCommand,
) -> (&'a str, Uuid) {
    let target = command
        .instance_id
        .map_or_else(|| *command.object_type_id.as_uuid(), |id| *id.as_uuid());
    (prepared.action.stable_key.as_str(), target)
}

/// The four-eyes `kind` a lifecycle-transition approval is decided under. A
/// lifecycle transition has no action key, so the kind is fixed and the approval
/// binds to the specific instance (its `target_ref`).
const LIFECYCLE_FOUR_EYES_KIND: &str = "ontology.lifecycle";

async fn action_preflight(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(action_key): Path<String>,
    Json(body): Json<ActionRequest>,
) -> Result<Json<PreflightOutcome>, RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    let outcome = state
        .preflight_action(&principal, &action_key, body.into_command())
        .await
        .map_err(RestError::from_action)?;
    Ok(Json(outcome))
}

async fn action_execute(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(action_key): Path<String>,
    Json(body): Json<ActionRequest>,
) -> Result<Json<ExecuteOutcome>, RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    let outcome = state
        .execute_action(&principal, &action_key, body.into_command())
        .await
        .map_err(RestError::from_action)?;
    Ok(Json(outcome))
}

/// The instance-revision writeback: ONE `with_audits` tx that re-checks the
/// mutable gate (four-eyes) INSIDE the tx (TOCTOU-safe), then appends the
/// revision through the store's in-tx helper and writes the action's audit row —
/// all atomic. A re-check failure returns `Err` so the tx rolls back with zero
/// rows written.
async fn instance_revision_writeback(
    state: &OntologyRestState,
    principal: &Principal,
    action_key: &str,
    command: &ActionCommand,
    prepared: &Prepared,
    new_attrs: Value,
) -> Result<CommandReceipt, PgOntologyError> {
    let body = command;
    let org = current_org().map_err(KernelError::from)?;
    let actor = principal.user_id;
    let action_type_id = prepared.action.id;
    let config = prepared.config;
    let authority = authority_effect(principal);
    let checklist = body.checklist_all_acknowledged;
    let egress = egress_evidence(&prepared.action.side_effects);
    let four_eyes_ref = body.four_eyes_request_ref;
    let instance_id = body.instance_id;
    let object_type_id = body.object_type_id;
    let title = body.title.clone();
    let reason = body.reason.clone();
    let valid_from = body.valid_from;
    let expected_revision = body.expected_revision;
    let (expected_kind, expected_target) = action_four_eyes_binding(prepared, command);
    let expected_kind = expected_kind.to_owned();
    let action_key = action_key.to_owned();
    let command_id = body.command_id.ok_or_else(|| {
        KernelError::validation("command_id is required for instance_revision actions")
    })?;
    if instance_id.is_some() && body.expected_revision.is_none() {
        return Err(
            KernelError::validation("expected_revision is required for an instance edit").into(),
        );
    }
    let payload_digest = action_command_digest(&action_key, body, &new_attrs)?;

    with_audits::<_, CommandReceipt, PgOntologyError>(state.registry.pool(), org, move |tx| {
        Box::pin(async move {
            // Serialize same-id attempts before inspecting the immutable receipt.
            // This is tenant-scoped by the receipt key and keeps a retry from
            // consuming approvals or appending another revision.
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
                .bind(command_id.to_string())
                .execute(tx.as_mut()).await?;
            if let Some(row) = sqlx::query(
                "SELECT actor_id, payload_digest, receipt FROM ont_action_command_receipts WHERE org_id = $1 AND command_id = $2",
            )
            .bind(*org.as_uuid()).bind(command_id).fetch_optional(tx.as_mut()).await? {
                let receipt_actor: Uuid = row.try_get("actor_id")?;
                if receipt_actor != *actor.as_uuid() {
                    return Err(KernelError::forbidden("command_id belongs to another principal").into());
                }
                let stored: Vec<u8> = row.try_get("payload_digest")?;
                if stored != payload_digest {
                    return Err(KernelError::conflict("command_id was already used with a different payload").into());
                }
                return Ok((row.try_get::<serde_json::Value, _>("receipt")
                    .map_err(|e| KernelError::validation(format!("invalid command receipt: {e}")))
                    .and_then(|value| serde_json::from_value(value).map_err(|e| KernelError::validation(format!("invalid command receipt: {e}"))))?, vec![]));
            }

            // Lock and compare the edit head before consuming a four-eyes approval.
            if let (Some(id), Some(expected)) = (instance_id, expected_revision) {
                let current: i64 = sqlx::query_scalar(
                    "SELECT r.version FROM ont_instances i JOIN ont_instance_revisions r ON r.id = i.current_revision_id WHERE i.id = $1 FOR UPDATE",
                ).bind(*id.as_uuid()).fetch_optional(tx.as_mut()).await?
                    .ok_or_else(|| KernelError::not_found("instance was not found"))?;
                if current != expected {
                    return Err(PgOntologyError::ActionPreconditionFailed { current });
                }
            }
            // TOCTOU re-check: bind-match AND consume the four-eyes approval inside
            // THIS tx, then re-run the whole chain. Anything not satisfied now ⇒ deny
            // ⇒ rollback (0 rows, and the consumption rolls back too so a legitimate
            // retry can re-use the approval).
            let four_eyes_approved = match four_eyes_ref {
                Some(request_ref) => four_eyes_consume_conn(
                    tx.as_mut(),
                    request_ref,
                    &expected_kind,
                    Some(expected_target),
                    None,
                    actor,
                )
                .await
                .map_err(governance_to_ontology)?,
                None => None,
            };
            let evidence = GateEvidence {
                authority: Some(authority),
                checklist_all_acknowledged: checklist,
                four_eyes_approved,
                egress_cleared: egress,
            };
            let gates = evaluate_gate_chain(config, &evidence);
            if !gates.allow {
                return Err(KernelError::forbidden(
                    "action gate re-check failed inside the writeback transaction",
                )
                .into());
            }

            let now = OffsetDateTime::now_utc();
            let result = match instance_id {
                Some(id) => {
                    stage_revision_in_tx(
                        tx,
                        actor,
                        org,
                        id,
                        StageRevision {
                            attributes: new_attrs,
                            valid_from,
                            action_type_id: Some(action_type_id),
                            reason,
                        },
                        now,
                    )
                    .await?
                }
                None => {
                    create_instance_in_tx(
                        tx,
                        actor,
                        org,
                        CreateInstance {
                            object_type_id,
                            title: title.unwrap_or_default(),
                            attributes: new_attrs,
                            valid_from,
                            action_type_id: Some(action_type_id),
                            reason,
                        },
                        now,
                    )
                    .await?
                }
            };

            let event = AuditEvent::new(
                Some(actor),
                AuditAction::new("ontology.action.execute")?,
                "ont_instances",
                result.instance.id.to_string(),
                TraceContext::generate(),
                now,
            )
            .with_org(org)
            .with_snapshots(
                None,
                Some(serde_json::json!({
                    "action_key": action_key,
                    "version": result.revision.version,
                    "attributes": result.revision.attributes,
                })),
            );
            let receipt = CommandReceipt {
                command_id,
                payload_digest: digest_hex(&payload_digest),
                instance: result,
                gates,
            };
            sqlx::query(
                "INSERT INTO ont_action_command_receipts (org_id, command_id, actor_id, payload_digest, receipt, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
            ).bind(*org.as_uuid()).bind(command_id).bind(*actor.as_uuid()).bind(&payload_digest)
                .bind(serde_json::to_value(&receipt).map_err(|e| KernelError::validation(format!("command receipt did not serialize: {e}")))?)
                .bind(now).execute(tx.as_mut()).await?;
            Ok((receipt, vec![event]))
        })
    })
    .await
    // Side-effects (notify / webhook / WORM attachment) run AFTER commit and must
    // be idempotent. None are dispatched in v1.
    // ponytail: side-effect dispatch lands with the §13 egress / comms lane.
}

fn action_command_digest(
    action_key: &str,
    command: &ActionCommand,
    _attributes: &Value,
) -> Result<Vec<u8>, PgOntologyError> {
    let canonical = serde_json::json!({
        "action_key": action_key,
        "object_type_id": command.object_type_id.to_string(),
        "instance_id": command.instance_id.map(|id| id.to_string()),
        "title": command.title.clone(),
        "params": command.params.clone(),
        "reason": command.reason.clone(),
        "valid_from": command.valid_from,
        "checklist_all_acknowledged": command.checklist_all_acknowledged,
        "four_eyes_request_ref": command.four_eyes_request_ref,
        "expected_revision": command.expected_revision,
    });
    let bytes = serde_json::to_vec(&canonical_json(&canonical))
        .map_err(|e| KernelError::validation(format!("command payload did not serialize: {e}")))?;
    Ok(Sha256::digest(bytes).to_vec())
}

/// Recursively sort JSON object keys before digesting a client command. The
/// digest intentionally excludes derived/current instance attributes: those can
/// change after a transport loss without changing the command being retried.
fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonical_json).collect()),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), canonical_json(value)))
                .collect(),
        ),
        primitive => primitive.clone(),
    }
}

fn digest_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Map the governance store error onto the ontology error so both can flow
/// through one `with_audits` closure error type. Same two-variant shape.
fn governance_to_ontology(error: PgGovernanceError) -> PgOntologyError {
    match error {
        PgGovernanceError::Db(db) => PgOntologyError::Db(db),
        PgGovernanceError::Domain(kernel) => PgOntologyError::Domain(kernel),
    }
}

// ---------------------------------------------------------------------------
// Lifecycle commit (§3b governance-gated instance-lifecycle transition)
// ---------------------------------------------------------------------------

/// Typed lifecycle-transition command (HTTP-independent) — the write counterpart
/// to the governance `lifecycle/preflight` read: the console preflights the edge,
/// then hands the allowed transition here to commit it.
#[derive(Debug, Clone)]
pub struct LifecycleCommand {
    pub to_state: InstanceLifecycleState,
    pub reason: Option<String>,
    /// Client-supplied self-checklist witness (§16 gate 2; fail-closed when absent).
    pub checklist_all_acknowledged: Option<bool>,
    /// Four-eyes request ref; its decision is read from the DB, never trusted from
    /// the caller.
    pub four_eyes_request_ref: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
struct LifecycleRequest {
    to_state: InstanceLifecycleState,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    checklist_all_acknowledged: Option<bool>,
    #[serde(default)]
    four_eyes_request_ref: Option<Uuid>,
}

impl LifecycleRequest {
    fn into_command(self) -> LifecycleCommand {
        LifecycleCommand {
            to_state: self.to_state,
            reason: self.reason,
            checklist_all_acknowledged: self.checklist_all_acknowledged,
            four_eyes_request_ref: self.four_eyes_request_ref,
        }
    }
}

/// Outcome of a committed transition — the new instance head plus the gate chain
/// that admitted it (mirrors [`ExecuteOutcome`]).
#[derive(Debug, Clone, Serialize)]
pub struct LifecycleOutcome {
    pub instance: InstanceHead,
    pub config: GateChainConfig,
    pub gates: GateChainOutcome,
}

/// The instance lifecycle FSM and the governance lifecycle FSM are the same five
/// states under different casings; map onto the governance state for validation +
/// config lookup (which the console preflight already speaks).
const fn to_governance_state(state: InstanceLifecycleState) -> LifecycleState {
    match state {
        InstanceLifecycleState::Draft => LifecycleState::Draft,
        InstanceLifecycleState::Active => LifecycleState::Active,
        InstanceLifecycleState::Locked => LifecycleState::Locked,
        InstanceLifecycleState::Archived => LifecycleState::Archived,
        InstanceLifecycleState::Disposed => LifecycleState::Disposed,
    }
}

impl OntologyRestState {
    /// Commit a §3b instance-lifecycle transition — the write counterpart to the
    /// governance lifecycle preflight. Validated against the base FSM AND the
    /// per-object-type `gov_lifecycle_transitions` config (an unconfigured edge is
    /// fail-closed), gated by the §16 chain (authority via the legacy contract,
    /// four-eyes read from the DB, checklist client-supplied), then committed in ONE
    /// audited tx that re-checks four-eyes and guards the from-state (TOCTOU-safe).
    pub async fn commit_lifecycle(
        &self,
        principal: &Principal,
        instance_id: InstanceId,
        command: LifecycleCommand,
    ) -> Result<LifecycleOutcome, ActionError> {
        // Load the target THROUGH the gate (RLS floor + object-policy residual):
        // a cross-org, missing OR policy-hidden id ⇒ NotFound, no leak. This is the
        // first statement, so refusal precedes `lifecycle_writeback` and the
        // four-eyes consume inside it — and precedes the 403 below, whose message
        // interpolates the row's CURRENT STATE.
        let head = visible_head_inner(self, principal, *instance_id.as_uuid())
            .await
            .map_err(|e| match e {
                PgOntologyError::Domain(k) if k.kind == ErrorKind::NotFound => {
                    ActionError::NotFound
                }
                other => ActionError::Store(other),
            })?
            .into_inner()
            .instance;
        let from = to_governance_state(head.lifecycle_state);
        let to = to_governance_state(command.to_state);

        // Base FSM: an illegal edge can never commit (preserves the kernel kind, so
        // an illegal edge is a 409, a disposed source is a conflict).
        validate_lifecycle_transition(from, to)
            .map_err(|k| ActionError::Store(PgOntologyError::Domain(k)))?;

        // Per-object-type config: an unconfigured edge is fail-closed (deny).
        let reqs = self
            .governance
            .transition_requirements(*head.object_type_id.as_uuid(), from, to)
            .await
            .map_err(|e| ActionError::Store(governance_to_ontology(e)))?
            .ok_or_else(|| {
                ActionError::GateDenied(format!(
                    "lifecycle transition {} -> {} is not configured for this object type",
                    from.as_db_str(),
                    to.as_db_str()
                ))
            })?;

        // `requires_reason` is a config precondition, not a §16 gate.
        let has_reason = command
            .reason
            .as_deref()
            .is_some_and(|r| !r.trim().is_empty());
        if reqs.requires_reason && !has_reason {
            return Err(ActionError::CriteriaFailed(
                "this lifecycle transition requires a reason".to_owned(),
            ));
        }

        let config = GateChainConfig {
            authority: true,
            self_checklist: reqs.requires_checklist,
            four_eyes: reqs.requires_four_eyes,
            // A pure lifecycle transition has no outbound side-effects to classify.
            egress_dlp: false,
        };

        // Fail-closed pre-tx gate evaluation.
        let gates = self
            .evaluate_lifecycle_gates(principal, instance_id, config, &command)
            .await?;
        if !gates.allow {
            let reason = gates.first_blocking().map_or_else(
                || "a lifecycle gate is not satisfied".to_owned(),
                |g| format!("gate {:?} blocked: {:?}", g.gate, g.status),
            );
            return Err(ActionError::GateDenied(reason));
        }

        // Audited writeback with TOCTOU re-check + from-state guard.
        let instance = lifecycle_writeback(self, principal, instance_id, command, config, head)
            .await
            .map_err(ActionError::Store)?;
        Ok(LifecycleOutcome {
            instance,
            config,
            gates,
        })
    }

    async fn evaluate_lifecycle_gates(
        &self,
        principal: &Principal,
        instance_id: InstanceId,
        config: GateChainConfig,
        command: &LifecycleCommand,
    ) -> Result<GateChainOutcome, ActionError> {
        let authority = authority_effect(principal);
        // Non-consuming peek only — the authoritative consume is in the writeback.
        let four_eyes_approved = match command.four_eyes_request_ref {
            Some(request_ref) => self
                .governance
                .four_eyes_approved(
                    request_ref,
                    LIFECYCLE_FOUR_EYES_KIND,
                    Some(*instance_id.as_uuid()),
                )
                .await
                .map_err(|e| ActionError::Store(governance_to_ontology(e)))?,
            None => None,
        };
        let evidence = GateEvidence {
            authority: Some(authority),
            checklist_all_acknowledged: command.checklist_all_acknowledged,
            four_eyes_approved,
            egress_cleared: None,
        };
        Ok(evaluate_gate_chain(config, &evidence))
    }
}

async fn commit_lifecycle(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<LifecycleRequest>,
) -> Result<Json<LifecycleOutcome>, RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    let outcome = state
        .commit_lifecycle(&principal, InstanceId::from_uuid(id), body.into_command())
        .await
        .map_err(RestError::from_action)?;
    Ok(Json(outcome))
}

/// The lifecycle writeback: ONE `with_audits` tx that re-reads four-eyes evidence
/// INSIDE the tx (TOCTOU-safe) and re-runs the chain, then updates the head state
/// with a from-state guard (`WHERE lifecycle_state = <expected>`) so a concurrent
/// transition can never be double-applied — a mismatch or a re-check failure rolls
/// the tx back with zero rows written.
async fn lifecycle_writeback(
    state: &OntologyRestState,
    principal: &Principal,
    instance_id: InstanceId,
    command: LifecycleCommand,
    config: GateChainConfig,
    head: InstanceHead,
) -> Result<InstanceHead, PgOntologyError> {
    let org = current_org().map_err(KernelError::from)?;
    let actor = principal.user_id;
    let authority = authority_effect(principal);
    let checklist = command.checklist_all_acknowledged;
    let four_eyes_ref = command.four_eyes_request_ref;
    let to = command.to_state;
    let reason = command.reason.clone();
    let expected_from = head.lifecycle_state;
    let expected_target = *instance_id.as_uuid();

    with_audits::<_, InstanceHead, PgOntologyError>(state.registry.pool(), org, move |tx| {
        Box::pin(async move {
            // TOCTOU re-check: bind-match AND consume the four-eyes approval inside
            // THIS tx (single-use), re-run the chain. Not satisfied ⇒ rollback.
            let four_eyes_approved = match four_eyes_ref {
                Some(request_ref) => four_eyes_consume_conn(
                    tx.as_mut(),
                    request_ref,
                    LIFECYCLE_FOUR_EYES_KIND,
                    Some(expected_target),
                    None,
                    actor,
                )
                .await
                .map_err(governance_to_ontology)?,
                None => None,
            };
            let evidence = GateEvidence {
                authority: Some(authority),
                checklist_all_acknowledged: checklist,
                four_eyes_approved,
                egress_cleared: None,
            };
            if !evaluate_gate_chain(config, &evidence).allow {
                return Err(KernelError::forbidden(
                    "lifecycle gate re-check failed inside the writeback transaction",
                )
                .into());
            }

            let now = OffsetDateTime::now_utc();
            // From-state guard: the transition applies iff the state is still the one
            // preflight validated (also covers cross-org/missing → 0 rows).
            let result = sqlx::query(
                "UPDATE ont_instances SET lifecycle_state = $2, updated_at = $3 \
                 WHERE id = $1 AND lifecycle_state = $4",
            )
            .bind(*instance_id.as_uuid())
            .bind(to.as_db_str())
            .bind(now)
            .bind(expected_from.as_db_str())
            .execute(tx.as_mut())
            .await?;
            if result.rows_affected() == 0 {
                return Err(KernelError::conflict(
                    "instance lifecycle state changed during the transition; retry",
                )
                .into());
            }

            let event = AuditEvent::new(
                Some(actor),
                AuditAction::new("ontology.instance.transition")?,
                "ont_instances",
                instance_id.to_string(),
                TraceContext::generate(),
                now,
            )
            .with_org(org)
            .with_snapshots(
                Some(serde_json::json!({ "lifecycle_state": expected_from.as_db_str() })),
                Some(serde_json::json!({
                    "lifecycle_state": to.as_db_str(),
                    "reason": reason,
                })),
            );
            Ok((
                InstanceHead {
                    lifecycle_state: to,
                    ..head
                },
                vec![event],
            ))
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// Acting-read (§2 dynamics chips) + code→instance resolve
// ---------------------------------------------------------------------------

async fn instance_acting(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<ActingRule>>, RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    // Measured existence oracle before the gate: an ungated 200 here confirmed a
    // hidden row existed AND named the policies attached to it.
    visible_head(&state, &principal, id).await?;
    let acting = state
        .registry
        .acting_on_instance(id)
        .await
        .map_err(RestError::from_ontology)?;
    Ok(Json(acting))
}

async fn object_type_acting(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> Result<Json<Vec<ActingRule>>, RestError> {
    authorize_ontology(&state, &headers).await?;
    let acting = state
        .registry
        .acting_on_type(&key)
        .await
        .map_err(RestError::from_ontology)?;
    Ok(Json(acting))
}

#[derive(Debug, Deserialize)]
struct ResolveQuery {
    code: String,
}

async fn resolve_code(
    State(state): State<OntologyRestState>,
    headers: HeaderMap,
    Query(query): Query<ResolveQuery>,
) -> Result<Json<ResolvedInstance>, RestError> {
    let principal = authorize_ontology(&state, &headers).await?;
    // Deny-by-omission: an unknown / cross-tenant code is a 404, never a 403.
    let unresolvable =
        || RestError::from_kernel(KernelError::not_found("no instance resolves that code"));
    let resolved = state
        .registry
        .resolve_by_code(&query.code)
        .await
        .map_err(RestError::from_ontology)?
        .ok_or_else(unresolvable)?;
    // `ResolvedInstance` carries no `object_type_id`, so the gate resolves it
    // from the instance itself. Measured before the gate: this route returned
    // the id, type and title of a policy-hidden row.
    //
    // The gate's own 404 says "instance was not found" — a DIFFERENT body than
    // this route's miss, and the only gated route where the two diverge. Object
    // codes are human-meaningful and enumerable, so two distinguishable 404s
    // answer "does this code exist?" for rows the policy hides. Restate the
    // route's own miss; only a NotFound is rewritten, so a policy-loader failure
    // still surfaces as the 500 it is instead of a silent "no such code".
    visible_head(&state, &principal, resolved.id)
        .await
        .map_err(|error| match error.status {
            StatusCode::NOT_FOUND => unresolvable(),
            _ => error,
        })?;
    Ok(Json(resolved))
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/// Ontology is an org-scoped admin surface, so it authorizes org-wide.
// ponytail: dark/unwired surface — every endpoint gates on org-wide RoleManage
// (the existing PBAC-admin capability, as the governance console does). L-WIRE
// assigns per-endpoint ontology features when it merges this router live.
async fn authorize_ontology(
    state: &OntologyRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let principal = principal_from_headers(state, headers).await?;
    authorize_org_wide(&principal, Action::new(Feature::RoleManage))
        .map_err(RestError::from_kernel)?;
    Ok(principal)
}

async fn principal_from_headers(
    state: &OntologyRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for ontology API")
    })?;
    console_platform_request_context::resolve_principal(verifier, state.registry.pool(), headers)
        .await
        .map_err(rest_error_from_request_context)
}

// ---------------------------------------------------------------------------
// Errors (mirrors the governance rest error surface)
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct RestError {
    status: StatusCode,
    code: &'static str,
    message: String,
    current: Option<ObjectTypeWriteVersion>,
}

impl RestError {
    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: message.into(),
            current: None,
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "unavailable",
            message: message.into(),
            current: None,
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: message.into(),
            current: None,
        }
    }

    /// A §16 gate denied the action (nothing was written).
    fn gate_denied(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "gate_denied",
            message: message.into(),
            current: None,
        }
    }

    /// A `projected_usecase` action whose real domain dispatch is not yet wired
    /// (L-WIRE). Typed so callers can distinguish "not implemented" from a deny.
    fn not_wired_yet(target: Option<&str>) -> Self {
        let message = target.map_or_else(
            || {
                "projected_usecase dispatch is not wired yet (lands in L-WIRE); nothing was written"
                    .to_owned()
            },
            |t| {
                format!(
                    "projected_usecase dispatch to '{t}' is not wired yet (lands in L-WIRE); nothing was written"
                )
            },
        );
        Self {
            status: StatusCode::NOT_IMPLEMENTED,
            code: "not_wired_yet",
            message,
            current: None,
        }
    }

    fn write_precondition_required() -> Self {
        Self {
            status: StatusCode::PRECONDITION_REQUIRED,
            code: "ontology_write_precondition_required",
            message: "If-Match is required for ontology object type writes".to_owned(),
            current: None,
        }
    }

    fn invalid_write_precondition() -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_ontology_write_precondition",
            message: "If-Match must contain exactly one strong ontology key validator".to_owned(),
            current: None,
        }
    }

    fn from_kernel(error: KernelError) -> Self {
        Self {
            status: status_for_error_kind(error.kind),
            code: code_for_error_kind(error.kind),
            message: error.message,
            current: None,
        }
    }

    fn from_ontology(error: PgOntologyError) -> Self {
        match error {
            PgOntologyError::Domain(kernel) => Self::from_kernel(kernel),
            PgOntologyError::Db(db) => Self::from_db(db),
            PgOntologyError::PreconditionFailed { current } => Self {
                status: StatusCode::PRECONDITION_FAILED,
                code: "ontology_write_precondition_failed",
                message: "stale ontology object type write validator".to_owned(),
                current: Some(current),
            },
            PgOntologyError::ActionPreconditionFailed { current } => Self {
                status: StatusCode::PRECONDITION_FAILED,
                code: "ontology_action_revision_precondition_failed",
                message: format!("stale action revision; current revision is {current}"),
                current: None,
            },
            PgOntologyError::CommandUnavailable => Self {
                status: StatusCode::SERVICE_UNAVAILABLE,
                code: "ontology_command_unavailable",
                message: "ontology command database is not configured or unavailable".to_owned(),
                current: None,
            },
        }
    }

    fn from_action(error: ActionError) -> Self {
        match error {
            ActionError::NotFound => Self::from_kernel(KernelError::not_found(
                "action type was not found for that object type",
            )),
            ActionError::Validation(message) => Self {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "validation",
                message,
                current: None,
            },
            ActionError::GateDenied(message) => Self::gate_denied(message),
            ActionError::CriteriaFailed(message) => Self {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "criteria_failed",
                message,
                current: None,
            },
            ActionError::NotWiredYet { target } => Self::not_wired_yet(target.as_deref()),
            ActionError::Store(error) => Self::from_ontology(error),
        }
    }

    /// The Cedar policy store's error surface. `Domain` already carries the
    /// kernel `ErrorKind`, so a validation failure at attach maps to 422 with the
    /// validator's own message and needs no new mapping. `CommandUnavailable` is
    /// a deployment fault and maps to 503, exactly like
    /// `PgOntologyError::CommandUnavailable`: a 500 would be indistinguishable
    /// from a real database fault.
    fn from_cedar(error: PgCedarError) -> Self {
        match error {
            PgCedarError::Domain(error) => Self::from_kernel(error),
            PgCedarError::Db(error) => Self::from_db(error),
            PgCedarError::CommandUnavailable => Self {
                status: StatusCode::SERVICE_UNAVAILABLE,
                code: "ontology_command_unavailable",
                message: "ontology command database is not configured or unavailable".to_owned(),
                current: None,
            },
        }
    }

    fn from_db(error: DbError) -> Self {
        match error {
            DbError::Sqlx(sqlx::Error::RowNotFound) => {
                Self::from_kernel(KernelError::not_found("row was not found"))
            }
            DbError::Sqlx(sqlx::Error::Database(err))
                if err.code().is_some_and(|code| code == "23505") =>
            {
                tracing::error!(error = %err, "ontology unique-constraint violation");
                Self::from_kernel(KernelError::conflict("resource already exists"))
            }
            // 23503, foreign-key violation: the request named a row that does not
            // exist. Measured: attaching an object policy as a validly-signed
            // principal with no `users` row hit `created_by`'s
            // `(created_by, org_id) -> users(id, org_id)` FK and returned 500 —
            // a client-caused refusal reported as a server fault, which buries a
            // real authz condition (a token for a since-removed user) in the
            // noise operators are trained to page on.
            //
            // The message is deliberately generic and the constraint name stays
            // in the log: naming it would disclose the schema.
            DbError::Sqlx(sqlx::Error::Database(err))
                if err.code().is_some_and(|code| code == "23503") =>
            {
                tracing::error!(error = %err, "ontology foreign-key violation");
                Self::from_kernel(KernelError::validation(
                    "the request references a row that does not exist",
                ))
            }
            DbError::Sqlx(err) => {
                tracing::error!(error = %err, "database error");
                Self::internal("internal server error")
            }
            DbError::Serialize(err) => {
                tracing::error!(error = %err, "serialization error");
                Self::internal("internal server error")
            }
            DbError::CodeIssuance(err) => {
                tracing::error!(error = %err, "object-code issuance error");
                Self::internal("internal server error")
            }
        }
    }
}

fn rest_error_from_request_context(
    err: console_platform_request_context::RequestContextError,
) -> RestError {
    use console_platform_request_context::RequestContextError as E;
    match err {
        E::VerifierUnavailable => {
            RestError::unavailable("JWT verification is not configured for ontology API")
        }
        E::WrongTokenTier => RestError::from_kernel(KernelError::forbidden(
            "token tier is not valid for this route",
        )),
        E::AccessScope(error) => RestError::from_kernel(error),
        E::BranchScope(message) | E::EffectivePolicy(message) => RestError::internal(message),
        E::MissingOrg => RestError::internal("no tenant context is bound to the current request"),
        E::MissingBearer => RestError::unauthorized("missing or malformed bearer token"),
        E::InvalidToken => RestError::unauthorized("invalid bearer token"),
        E::InvalidClaim(message) => {
            RestError::unauthorized(format!("token claim is invalid: {message}"))
        }
    }
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: ErrorPayload,
}

#[derive(Debug, Serialize)]
struct ErrorPayload {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_key_write_revision: Option<i64>,
}

impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        let current_revision = self.current.as_ref().map(|current| current.revision);
        let mut response = (
            self.status,
            Json(ErrorBody {
                error: ErrorPayload {
                    code: self.code,
                    message: self.message,
                    current_key_write_revision: current_revision,
                },
            }),
        )
            .into_response();
        if let Some(current) = self.current {
            if let Ok(etag) = axum::http::HeaderValue::from_str(&current.etag) {
                response
                    .headers_mut()
                    .insert(axum::http::header::ETAG, etag);
            }
            response.headers_mut().insert(
                axum::http::header::CACHE_CONTROL,
                axum::http::HeaderValue::from_static("no-store"),
            );
        }
        response
    }
}

const fn status_for_error_kind(kind: ErrorKind) -> StatusCode {
    match kind {
        ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
        ErrorKind::NotFound => StatusCode::NOT_FOUND,
        ErrorKind::Forbidden => StatusCode::FORBIDDEN,
        ErrorKind::Conflict | ErrorKind::InvalidTransition => StatusCode::CONFLICT,
        ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

const fn code_for_error_kind(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::Validation => "validation",
        ErrorKind::NotFound => "not_found",
        ErrorKind::Forbidden => "forbidden",
        ErrorKind::Conflict => "conflict",
        ErrorKind::InvalidTransition => "invalid_transition",
        ErrorKind::Internal => "internal",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::header::IF_MATCH;

    #[test]
    fn divergent_child_identity_conflict_maps_to_http_409() {
        let error = RestError::from_ontology(PgOntologyError::Domain(KernelError::conflict(
            "child identity already names a different definition",
        )));
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code, "conflict");
    }

    #[test]
    fn missing_ontology_command_capability_maps_to_stable_503() {
        let error = RestError::from_ontology(PgOntologyError::CommandUnavailable);
        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.code, "ontology_command_unavailable");
        assert_eq!(
            error.message,
            "ontology command database is not configured or unavailable"
        );
        assert!(error.current.is_none());
    }

    #[test]
    fn object_type_if_match_requires_one_strong_key_validator() {
        let mut headers = HeaderMap::new();
        let missing = required_object_type_write_precondition(&headers).unwrap_err();
        assert_eq!(missing.status, StatusCode::PRECONDITION_REQUIRED);
        assert_eq!(missing.code, "ontology_write_precondition_required");

        for malformed in [
            "W/\"ont-object-type-key:00000000000000000000000000000001:r7\"",
            "*",
            "\"ont-object-type-key:00000000000000000000000000000001:r7\", \"other\"",
            "\"not-an-ontology-key-validator\"",
        ] {
            headers.insert(IF_MATCH, malformed.parse().unwrap());
            let error = required_object_type_write_precondition(&headers).unwrap_err();
            assert_eq!(error.status, StatusCode::BAD_REQUEST, "{malformed}");
            assert_eq!(error.code, "invalid_ontology_write_precondition");
        }

        headers.insert(
            IF_MATCH,
            "\"ont-object-type-key:00000000000000000000000000000001:r7\""
                .parse()
                .unwrap(),
        );
        headers.append(
            IF_MATCH,
            "\"ont-object-type-key:00000000000000000000000000000001:r8\""
                .parse()
                .unwrap(),
        );
        let duplicate = required_object_type_write_precondition(&headers).unwrap_err();
        assert_eq!(duplicate.status, StatusCode::BAD_REQUEST);
        headers.remove(IF_MATCH);
        headers.insert(
            IF_MATCH,
            "\"ont-object-type-key:00000000000000000000000000000001:r7\""
                .parse()
                .unwrap(),
        );
        let parsed = required_object_type_write_precondition(&headers).unwrap();
        assert_eq!(parsed.revision, 7);
        assert_eq!(
            parsed.validator_id,
            uuid::Uuid::from_u128(1),
            "the opaque strong validator is parsed exactly once at the REST boundary"
        );
    }

    #[test]
    fn stale_key_precondition_maps_to_412_with_current_etag_and_no_store() {
        let current = console_ontology_adapter_postgres::ObjectTypeWriteVersion {
            etag: "\"ont-object-type-key:00000000000000000000000000000001:r8\"".to_owned(),
            revision: 8,
        };
        let response = RestError::from_ontology(PgOntologyError::PreconditionFailed {
            current: current.clone(),
        })
        .into_response();
        assert_eq!(response.status(), StatusCode::PRECONDITION_FAILED);
        assert_eq!(
            response.headers().get("etag").unwrap(),
            current.etag.as_str()
        );
        assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
    }

    #[test]
    fn command_digest_canonicalizer_sorts_nested_payload_keys() {
        let left = serde_json::json!({"z": {"b": 2, "a": 1}, "a": [ {"d": 4, "c": 3} ]});
        let right = serde_json::json!({"a": [ {"c": 3, "d": 4} ], "z": {"a": 1, "b": 2}});
        assert_eq!(canonical_json(&left), canonical_json(&right));
    }

    #[test]
    fn command_digest_ignores_current_instance_attributes() {
        let command = ActionCommand {
            object_type_id: ObjectTypeId::from_uuid(Uuid::new_v4()),
            instance_id: Some(InstanceId::from_uuid(Uuid::new_v4())),
            title: None,
            params: serde_json::json!({"priority": "hi"}),
            reason: Some("operator request".to_owned()),
            valid_from: None,
            checklist_all_acknowledged: Some(true),
            four_eyes_request_ref: None,
            command_id: Some(Uuid::new_v4()),
            expected_revision: Some(7),
        };

        let before = action_command_digest(
            "set_priority",
            &command,
            &serde_json::json!({"priority": "lo", "unrelated": "before"}),
        )
        .unwrap();
        let after = action_command_digest(
            "set_priority",
            &command,
            &serde_json::json!({"priority": "lo", "unrelated": "after"}),
        )
        .unwrap();

        assert_eq!(before, after);
    }
}
