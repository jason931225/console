//! Support-ticket application layer: commands, query DTOs, read models, audit
//! event builders, and the notification port.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, EvidenceObjectId, KernelError, OrgId,
    SupportTicketCommentId, SupportTicketId, Timestamp, TraceContext, UserId, WorkOrderId,
};
use mnt_support_domain::{
    CaseEvent, CaseHistoryEntry, CaseScope, DispatchHandoffStatus, SupportCase, TicketCategory,
    TicketOrigin, TicketPriority, TicketStatus,
};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Open a ticket as an authenticated staff member. The ticket inherits the
/// requester's branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateInternalTicketCommand {
    pub actor: UserId,
    pub branch_id: BranchId,
    pub category: TicketCategory,
    pub priority: TicketPriority,
    pub title: String,
    pub body: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Open a ticket from the unauthenticated customer intake channel. There is no
/// actor and no branch; the customer supplies a name and contact (PII).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateCustomerIntakeCommand {
    pub category: TicketCategory,
    pub priority: TicketPriority,
    pub title: String,
    pub body: String,
    pub requester_name: String,
    /// Customer contact PII (phone/email). Never logged; never audited.
    pub requester_contact: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Assign (or reassign) a ticket to a staff member and triage a branch-less
/// customer ticket into a branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssignTicketCommand {
    pub actor: UserId,
    pub ticket_id: SupportTicketId,
    pub assignee_user_id: UserId,
    /// Branch to triage a branch-less customer ticket into. Required when the
    /// ticket has no branch yet; ignored once a ticket already carries a branch.
    pub branch_id: Option<BranchId>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Drive the status FSM.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransitionTicketCommand {
    pub actor: UserId,
    pub ticket_id: SupportTicketId,
    pub to_status: TicketStatus,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Append a comment. `is_internal_note` marks a staff-only note that the
/// customer-visible read path never returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddCommentCommand {
    pub actor: UserId,
    pub ticket_id: SupportTicketId,
    pub body: String,
    pub is_internal_note: bool,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

// ---------------------------------------------------------------------------
// Internal case lifecycle commands and transactional ports
// ---------------------------------------------------------------------------

/// Server-derived identity and tenant/branch scope for internal case writes.
/// The REST ticket contract deliberately does not expose this type yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupportCaseActorContext {
    pub org_id: OrgId,
    pub user_id: UserId,
    pub branch_scope: BranchScope,
}

/// Common mutation metadata. The adapter binds `actor` to the authenticated
/// principal, checks the tenant before this layer runs, and persists one
/// receipt per idempotency key inside the same transaction as the case change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SupportCaseCommandMetadata {
    pub actor: UserId,
    pub expected_version: u64,
    pub idempotency_key: String,
    pub fingerprint: String,
    pub trace: TraceContext,
}

impl SupportCaseCommandMetadata {
    pub fn validate(
        &self,
        context: &SupportCaseActorContext,
        branch_id: BranchId,
    ) -> Result<(), KernelError> {
        if self.actor != context.user_id {
            return Err(KernelError::forbidden(
                "support case command actor must match authenticated principal",
            ));
        }
        if !context.branch_scope.allows(branch_id) {
            return Err(KernelError::forbidden(
                "support case branch is outside authenticated scope",
            ));
        }
        if !(16..=200).contains(&self.idempotency_key.trim().len()) {
            return Err(KernelError::validation(
                "support case idempotency key must be 16..=200 characters",
            ));
        }
        if self.fingerprint.trim().is_empty() || self.fingerprint.len() > 128 {
            return Err(KernelError::validation(
                "support case fingerprint is required and bounded",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestDispatchHandoffCommand {
    pub case_id: SupportTicketId,
    pub work_order_id: WorkOrderId,
    pub metadata: SupportCaseCommandMetadata,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolveDispatchHandoffCommand {
    pub case_id: SupportTicketId,
    pub status: DispatchHandoffStatus,
    pub metadata: SupportCaseCommandMetadata,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BindCaseEvidenceCommand {
    pub case_id: SupportTicketId,
    pub evidence_object_id: EvidenceObjectId,
    pub metadata: SupportCaseCommandMetadata,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupportCaseIdempotency {
    Execute,
    Replay,
}

pub fn support_case_idempotency(
    existing_fingerprint: Option<&str>,
    metadata: &SupportCaseCommandMetadata,
) -> Result<SupportCaseIdempotency, KernelError> {
    match existing_fingerprint {
        None => Ok(SupportCaseIdempotency::Execute),
        Some(existing) if existing == metadata.fingerprint => Ok(SupportCaseIdempotency::Replay),
        Some(_) => Err(KernelError::conflict(
            "support case idempotency key reused with a different payload",
        )),
    }
}

/// Durable outbox payload. `dedupe_key` is derived from immutable case version
/// and event name, never from an invented messenger, mail, or report URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SupportCaseOutboxIntent {
    pub case_id: SupportTicketId,
    pub version: u64,
    pub dedupe_key: String,
    pub event: CaseEvent,
    #[serde(with = "time::serde::rfc3339")]
    pub occurred_at: Timestamp,
}

impl SupportCaseOutboxIntent {
    #[must_use]
    pub fn from_history(case_id: SupportTicketId, entry: &CaseHistoryEntry) -> Self {
        Self {
            case_id,
            version: entry.version,
            dedupe_key: format!(
                "support-case:{case_id}:{}:{}",
                entry.version,
                entry.event.name()
            ),
            event: entry.event.clone(),
            occurred_at: entry.occurred_at,
        }
    }
}

/// The external bounded contexts answer only existence and same-tenant/branch
/// visibility. They do not mutate Work Order or Evidence state from Support.
pub trait SupportCaseLinkVerifier {
    fn verify_work_order(
        &mut self,
        scope: CaseScope,
        work_order_id: WorkOrderId,
    ) -> Result<(), KernelError>;
    fn verify_evidence_object(
        &mut self,
        scope: CaseScope,
        evidence_object_id: EvidenceObjectId,
    ) -> Result<(), KernelError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupportCaseCommit {
    pub case: SupportCase,
    pub history: CaseHistoryEntry,
    pub outbox: SupportCaseOutboxIntent,
    pub action: &'static str,
    pub idempotency_key: String,
    pub fingerprint: String,
    pub result: SupportCaseMutationResult,
}

/// Exact response stored with an idempotency key. Replays never synthesize a
/// version from a newer caller payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupportCaseIdempotencyReceipt {
    pub fingerprint: String,
    pub result: SupportCaseMutationResult,
}

/// Adapter transaction contract. `commit` must atomically write the case
/// projection, append-only history, outbox intent, and idempotency receipt.
pub trait SupportCaseUnitOfWork: SupportCaseLinkVerifier {
    fn idempotency_receipt(
        &mut self,
        scope: CaseScope,
        case_id: SupportTicketId,
        actor: UserId,
        action: &str,
        key: &str,
    ) -> Result<Option<SupportCaseIdempotencyReceipt>, KernelError>;
    fn load_case_for_update(
        &mut self,
        case_id: SupportTicketId,
    ) -> Result<SupportCase, KernelError>;
    fn commit(&mut self, commit: SupportCaseCommit) -> Result<(), KernelError>;
}

pub trait SupportCaseRepository {
    type Transaction: SupportCaseUnitOfWork;
    fn transaction<T>(
        &mut self,
        operation: impl FnOnce(&mut Self::Transaction) -> Result<T, KernelError>,
    ) -> Result<T, KernelError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SupportCaseMutationResult {
    pub case_id: SupportTicketId,
    pub version: u64,
    pub replayed: bool,
}

pub fn request_dispatch_handoff<R: SupportCaseRepository>(
    repository: &mut R,
    context: &SupportCaseActorContext,
    command: RequestDispatchHandoffCommand,
) -> Result<SupportCaseMutationResult, KernelError> {
    repository.transaction(|tx| {
        const ACTION: &str = "support.case.dispatch_handoff.request";
        let mut case = tx.load_case_for_update(command.case_id)?;
        validate_case_context(context, &command.metadata, &case)?;
        if let Some(result) =
            replayed_case_result(tx, &case, context.user_id, ACTION, &command.metadata)?
        {
            return Ok(result);
        }
        tx.verify_work_order(case.scope(), command.work_order_id)?;
        let changed = case.request_dispatch_handoff(
            command.metadata.expected_version,
            command.metadata.actor,
            command.work_order_id,
            command.occurred_at,
        )?;
        if !changed {
            return Ok(SupportCaseMutationResult {
                case_id: case.id(),
                version: case.version(),
                replayed: true,
            });
        }
        commit_case_change(tx, case, ACTION, command.metadata)
    })
}

pub fn bind_case_evidence<R: SupportCaseRepository>(
    repository: &mut R,
    context: &SupportCaseActorContext,
    command: BindCaseEvidenceCommand,
) -> Result<SupportCaseMutationResult, KernelError> {
    repository.transaction(|tx| {
        const ACTION: &str = "support.case.evidence.bind";
        let mut case = tx.load_case_for_update(command.case_id)?;
        validate_case_context(context, &command.metadata, &case)?;
        if let Some(result) =
            replayed_case_result(tx, &case, context.user_id, ACTION, &command.metadata)?
        {
            return Ok(result);
        }
        tx.verify_evidence_object(case.scope(), command.evidence_object_id)?;
        let changed = case.bind_evidence(
            command.metadata.expected_version,
            command.metadata.actor,
            command.evidence_object_id,
            command.occurred_at,
        )?;
        if !changed {
            return Ok(SupportCaseMutationResult {
                case_id: case.id(),
                version: case.version(),
                replayed: true,
            });
        }
        commit_case_change(tx, case, ACTION, command.metadata)
    })
}

pub fn resolve_dispatch_handoff<R: SupportCaseRepository>(
    repository: &mut R,
    context: &SupportCaseActorContext,
    command: ResolveDispatchHandoffCommand,
) -> Result<SupportCaseMutationResult, KernelError> {
    repository.transaction(|tx| {
        const ACTION: &str = "support.case.dispatch_handoff.resolve";
        let mut case = tx.load_case_for_update(command.case_id)?;
        validate_case_context(context, &command.metadata, &case)?;
        if let Some(result) =
            replayed_case_result(tx, &case, context.user_id, ACTION, &command.metadata)?
        {
            return Ok(result);
        }
        case.resolve_dispatch_handoff(
            command.metadata.expected_version,
            command.metadata.actor,
            command.status,
            command.occurred_at,
        )?;
        commit_case_change(tx, case, ACTION, command.metadata)
    })
}

fn validate_case_context(
    context: &SupportCaseActorContext,
    metadata: &SupportCaseCommandMetadata,
    case: &SupportCase,
) -> Result<(), KernelError> {
    if context.org_id != case.scope().org_id {
        return Err(KernelError::forbidden(
            "support case tenant does not match authenticated principal",
        ));
    }
    metadata.validate(context, case.scope().branch_id)
}

fn replayed_case_result<T: SupportCaseUnitOfWork>(
    tx: &mut T,
    case: &SupportCase,
    actor: UserId,
    action: &str,
    metadata: &SupportCaseCommandMetadata,
) -> Result<Option<SupportCaseMutationResult>, KernelError> {
    let Some(receipt) = tx.idempotency_receipt(
        case.scope(),
        case.id(),
        actor,
        action,
        &metadata.idempotency_key,
    )?
    else {
        return Ok(None);
    };
    support_case_idempotency(Some(&receipt.fingerprint), metadata)?;
    Ok(Some(SupportCaseMutationResult {
        replayed: true,
        ..receipt.result
    }))
}

fn commit_case_change<T: SupportCaseUnitOfWork>(
    tx: &mut T,
    case: SupportCase,
    action: &'static str,
    metadata: SupportCaseCommandMetadata,
) -> Result<SupportCaseMutationResult, KernelError> {
    let history = case.history().last().cloned().ok_or_else(|| {
        KernelError::validation("support case mutation must append durable history")
    })?;
    let outbox = SupportCaseOutboxIntent::from_history(case.id(), &history);
    let result = SupportCaseMutationResult {
        case_id: case.id(),
        version: case.version(),
        replayed: false,
    };
    tx.commit(SupportCaseCommit {
        case,
        history,
        outbox,
        action,
        idempotency_key: metadata.idempotency_key,
        fingerprint: metadata.fingerprint,
        result: result.clone(),
    })?;
    Ok(result)
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/// Branch-scoped list with optional filters. SUPER_ADMIN/EXECUTIVE resolve to
/// `BranchScope::All` for cross-branch rollups (like reporting).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListTicketsQuery {
    pub branch_scope: BranchScope,
    pub status: Option<TicketStatus>,
    pub priority: Option<TicketPriority>,
    pub category: Option<TicketCategory>,
    pub origin: Option<TicketOrigin>,
    pub assignee_user_id: Option<UserId>,
    /// Include branch-less (untriaged customer) tickets in the result. Only
    /// honoured for `BranchScope::All` principals; branch-scoped staff never see
    /// untriaged cross-org intake.
    pub include_untriaged: bool,
    /// Page size. `None` falls back to the adapter default; the adapter always
    /// clamps to `1..=100` so an unbounded fetch is impossible even when the
    /// client sends no limit.
    pub limit: Option<i64>,
    /// Keyset cursor: return only tickets ordered strictly after this id on the
    /// `(created_at DESC, id)` ordering. `None` starts from the first page.
    /// Mirrors the messenger keyset-pagination pattern.
    pub cursor: Option<SupportTicketId>,
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketSummary {
    pub id: SupportTicketId,
    pub branch_id: Option<BranchId>,
    pub origin: TicketOrigin,
    pub category: TicketCategory,
    pub priority: TicketPriority,
    pub status: TicketStatus,
    pub title: String,
    pub requester_user_id: Option<UserId>,
    pub requester_name: Option<String>,
    pub assignee_user_id: Option<UserId>,
    /// Assignee display name, resolved via a same-org LEFT JOIN on `users`.
    /// `None` for an unassigned ticket or a deleted assignee; the web renders
    /// it through `safeLabel` so a missing name never leaks the UUID.
    pub assignee_name: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub due_at: Option<Timestamp>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: Timestamp,
    #[serde(with = "time::serde::rfc3339::option")]
    pub resolved_at: Option<Timestamp>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub closed_at: Option<Timestamp>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommentView {
    pub id: SupportTicketCommentId,
    pub ticket_id: SupportTicketId,
    pub author_user_id: Option<UserId>,
    /// Author display name, resolved via a same-org LEFT JOIN on `users`. `None`
    /// for a system/customer comment with no author or a deleted author; the web
    /// renders it through `safeLabel` so a missing name never leaks the UUID.
    pub author_name: Option<String>,
    pub body: String,
    pub is_internal_note: bool,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketDetail {
    pub ticket: TicketSummary,
    pub comments: Vec<CommentView>,
}

/// One keyset page of tickets plus the unpaged `total` matching the same
/// filters, so the console can show an honest count while still paging via the
/// cursor. `next_cursor` is the id to pass as `cursor` for the next page, or
/// `None` when this is the last page. Mirrors `MessagePage`, with `total` added.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketPage {
    pub items: Vec<TicketSummary>,
    pub next_cursor: Option<SupportTicketId>,
    pub total: i64,
}

/// Audience filter for [`TicketDetail`] reads. The customer-visible path drops
/// internal staff notes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CommentAudience {
    /// Staff: all comments, including internal notes.
    Internal,
    /// Customer-visible: internal notes are excluded.
    CustomerVisible,
}

impl CommentAudience {
    /// Whether a comment with the given `is_internal_note` flag is visible to
    /// this audience.
    #[must_use]
    pub const fn shows_internal_notes(self) -> bool {
        matches!(self, Self::Internal)
    }
}

// ---------------------------------------------------------------------------
// Notification port
// ---------------------------------------------------------------------------

/// Why a notification is being raised.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TicketNotificationKind {
    /// A ticket was (re)assigned — notify the new assignee.
    Assigned,
    /// The status changed — notify the requester (if internal) and the assignee.
    StatusChanged,
    /// A new customer-visible comment landed — notify requester and assignee.
    Commented,
}

impl TicketNotificationKind {
    #[must_use]
    pub const fn title(self) -> &'static str {
        match self {
            Self::Assigned => "Support ticket assigned",
            Self::StatusChanged => "Support ticket updated",
            Self::Commented => "New support ticket reply",
        }
    }

    #[must_use]
    pub const fn data_kind(self) -> &'static str {
        match self {
            Self::Assigned => "support_ticket_assigned",
            Self::StatusChanged => "support_ticket_status",
            Self::Commented => "support_ticket_comment",
        }
    }
}

/// A single notification to deliver. Recipients are staff users (push tokens
/// resolved by the adapter); external customers are notified through other
/// channels out of scope here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketNotification {
    pub ticket_id: SupportTicketId,
    pub recipient: UserId,
    pub kind: TicketNotificationKind,
    pub body: String,
}

impl TicketNotification {
    #[must_use]
    pub fn new(
        ticket_id: SupportTicketId,
        recipient: UserId,
        kind: TicketNotificationKind,
        body: impl Into<String>,
    ) -> Self {
        Self {
            ticket_id,
            recipient,
            kind,
            body: body.into(),
        }
    }
}

// ---------------------------------------------------------------------------
// Audit builder
// ---------------------------------------------------------------------------

/// Build a support audit event. `branch_id` is optional because customer-intake
/// tickets are branch-less until triaged (`with_branch` is only attached when a
/// branch is known). The PII contact is never placed in snapshots by callers.
pub fn support_audit_event(
    action: &str,
    actor: Option<UserId>,
    branch_id: Option<BranchId>,
    target_type: &str,
    target_id: impl ToString,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    let mut event = AuditEvent::new(
        actor,
        AuditAction::new(action)?,
        target_type,
        target_id.to_string(),
        trace,
        occurred_at,
    );
    if let Some(branch_id) = branch_id {
        event = event.with_branch(branch_id);
    }
    Ok(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mnt_support_domain::SlaPolicy;
    use time::macros::datetime;

    struct RecordingTransaction {
        case: SupportCase,
        receipt: Option<SupportCaseIdempotencyReceipt>,
        calls: Vec<&'static str>,
        receipt_inputs: Vec<(CaseScope, SupportTicketId, UserId, String, String)>,
        commits: Vec<SupportCaseCommit>,
    }

    impl SupportCaseLinkVerifier for RecordingTransaction {
        fn verify_work_order(
            &mut self,
            _scope: CaseScope,
            _work_order_id: WorkOrderId,
        ) -> Result<(), KernelError> {
            self.calls.push("verify_work_order");
            Ok(())
        }

        fn verify_evidence_object(
            &mut self,
            _scope: CaseScope,
            _evidence_object_id: EvidenceObjectId,
        ) -> Result<(), KernelError> {
            self.calls.push("verify_evidence_object");
            Ok(())
        }
    }

    impl SupportCaseUnitOfWork for RecordingTransaction {
        fn idempotency_receipt(
            &mut self,
            scope: CaseScope,
            case_id: SupportTicketId,
            actor: UserId,
            action: &str,
            key: &str,
        ) -> Result<Option<SupportCaseIdempotencyReceipt>, KernelError> {
            self.calls.push("receipt");
            self.receipt_inputs
                .push((scope, case_id, actor, action.to_owned(), key.to_owned()));
            Ok(self.receipt.clone())
        }

        fn load_case_for_update(
            &mut self,
            case_id: SupportTicketId,
        ) -> Result<SupportCase, KernelError> {
            self.calls.push("load");
            if case_id != self.case.id() {
                return Err(KernelError::not_found("support case was not found"));
            }
            Ok(self.case.clone())
        }

        fn commit(&mut self, commit: SupportCaseCommit) -> Result<(), KernelError> {
            self.calls.push("commit");
            self.case = commit.case.clone();
            self.commits.push(commit);
            Ok(())
        }
    }

    struct RecordingRepository {
        tx: RecordingTransaction,
    }

    impl SupportCaseRepository for RecordingRepository {
        type Transaction = RecordingTransaction;

        fn transaction<T>(
            &mut self,
            operation: impl FnOnce(&mut Self::Transaction) -> Result<T, KernelError>,
        ) -> Result<T, KernelError> {
            operation(&mut self.tx)
        }
    }

    fn fixture() -> (
        RecordingRepository,
        SupportCaseActorContext,
        SupportCaseCommandMetadata,
        Timestamp,
    ) {
        let now = datetime!(2026-07-24 09:00 UTC);
        let org_id = OrgId::new();
        let branch_id = BranchId::new();
        let actor = UserId::new();
        let case = SupportCase::open(
            SupportTicketId::new(),
            CaseScope::new(org_id, branch_id),
            TicketPriority::High,
            now,
            SlaPolicy::default(),
        )
        .unwrap();
        let context = SupportCaseActorContext {
            org_id,
            user_id: actor,
            branch_scope: BranchScope::single(branch_id),
        };
        let metadata = SupportCaseCommandMetadata {
            actor,
            expected_version: 0,
            idempotency_key: "support-case-idempotency-0001".to_owned(),
            fingerprint: "support-case-fingerprint-0001".to_owned(),
            trace: TraceContext::generate(),
        };
        (
            RecordingRepository {
                tx: RecordingTransaction {
                    case,
                    receipt: None,
                    calls: Vec::new(),
                    receipt_inputs: Vec::new(),
                    commits: Vec::new(),
                },
            },
            context,
            metadata,
            now,
        )
    }

    #[test]
    fn customer_visible_audience_hides_internal_notes() {
        assert!(!CommentAudience::CustomerVisible.shows_internal_notes());
        assert!(CommentAudience::Internal.shows_internal_notes());
    }

    #[test]
    fn audit_event_without_branch_is_org_global() {
        let event = support_audit_event(
            "support.ticket.create_customer",
            None,
            None,
            "support_ticket",
            SupportTicketId::new(),
            TraceContext::generate(),
            Timestamp::now_utc(),
        )
        .unwrap();
        assert!(event.branch_id.is_none());
        assert!(event.actor.is_none());
    }

    #[test]
    fn audit_event_with_branch_carries_scope() {
        let branch = BranchId::new();
        let event = support_audit_event(
            "support.ticket.create_internal",
            Some(UserId::new()),
            Some(branch),
            "support_ticket",
            SupportTicketId::new(),
            TraceContext::generate(),
            Timestamp::now_utc(),
        )
        .unwrap();
        assert_eq!(event.branch_id, Some(branch));
    }

    #[test]
    fn case_command_metadata_binds_actor_scope_and_idempotency() {
        let actor = UserId::new();
        let branch = BranchId::new();
        let context = SupportCaseActorContext {
            org_id: mnt_kernel_core::OrgId::new(),
            user_id: actor,
            branch_scope: BranchScope::single(branch),
        };
        let metadata = SupportCaseCommandMetadata {
            actor,
            expected_version: 3,
            idempotency_key: "support-case-handoff-0001".to_owned(),
            fingerprint: "sha256:request-body".to_owned(),
            trace: TraceContext::generate(),
        };
        assert!(metadata.validate(&context, branch).is_ok());
        assert_eq!(
            support_case_idempotency(None, &metadata).unwrap(),
            SupportCaseIdempotency::Execute
        );
        assert_eq!(
            support_case_idempotency(Some("sha256:request-body"), &metadata).unwrap(),
            SupportCaseIdempotency::Replay
        );
        assert!(support_case_idempotency(Some("other"), &metadata).is_err());
        assert!(metadata.validate(&context, BranchId::new()).is_err());
        let wrong_actor = SupportCaseCommandMetadata {
            actor: UserId::new(),
            ..metadata.clone()
        };
        assert!(wrong_actor.validate(&context, branch).is_err());
    }

    #[test]
    fn case_outbox_intent_is_deterministic_and_contains_no_delivery_url() {
        let case_id = SupportTicketId::new();
        let history = CaseHistoryEntry {
            version: 4,
            event: CaseEvent::EvidenceBound {
                evidence_object_id: EvidenceObjectId::new(),
            },
            actor: UserId::new(),
            occurred_at: Timestamp::now_utc(),
        };
        let intent = SupportCaseOutboxIntent::from_history(case_id, &history);
        assert_eq!(intent.case_id, case_id);
        assert_eq!(intent.version, 4);
        assert_eq!(
            intent.dedupe_key,
            format!("support-case:{case_id}:4:support.case.evidence_bound")
        );
    }

    #[test]
    fn replay_lookup_follows_case_authorization_and_is_bound_to_canonical_scope_actor_and_case() {
        let (mut repository, context, metadata, now) = fixture();
        let case_id = repository.tx.case.id();
        repository.tx.receipt = Some(SupportCaseIdempotencyReceipt {
            fingerprint: metadata.fingerprint.clone(),
            result: SupportCaseMutationResult {
                case_id,
                version: 7,
                replayed: false,
            },
        });
        let result = request_dispatch_handoff(
            &mut repository,
            &context,
            RequestDispatchHandoffCommand {
                case_id,
                work_order_id: WorkOrderId::new(),
                metadata: metadata.clone(),
                occurred_at: now,
            },
        )
        .unwrap();
        assert!(result.replayed);
        assert_eq!(repository.tx.calls, ["load", "receipt"]);
        assert_eq!(
            repository.tx.receipt_inputs[0].0,
            repository.tx.case.scope()
        );
        assert_eq!(repository.tx.receipt_inputs[0].1, case_id);
        assert_eq!(repository.tx.receipt_inputs[0].2, context.user_id);
    }

    #[test]
    fn wrong_actor_cannot_replay_before_authorization() {
        let (mut repository, context, mut metadata, now) = fixture();
        metadata.actor = UserId::new();
        let case_id = repository.tx.case.id();
        let result = request_dispatch_handoff(
            &mut repository,
            &context,
            RequestDispatchHandoffCommand {
                case_id,
                work_order_id: WorkOrderId::new(),
                metadata,
                occurred_at: now,
            },
        );
        assert!(result.is_err());
        assert_eq!(repository.tx.calls, ["load"]);
    }

    #[test]
    fn wrong_case_cannot_replay_before_authorization() {
        let (mut repository, context, metadata, now) = fixture();
        let result = request_dispatch_handoff(
            &mut repository,
            &context,
            RequestDispatchHandoffCommand {
                case_id: SupportTicketId::new(),
                work_order_id: WorkOrderId::new(),
                metadata,
                occurred_at: now,
            },
        );
        assert!(result.is_err());
        assert_eq!(repository.tx.calls, ["load"]);
    }

    #[test]
    fn wrong_branch_cannot_replay_before_authorization() {
        let (mut repository, mut context, metadata, now) = fixture();
        context.branch_scope = BranchScope::single(BranchId::new());
        let case_id = repository.tx.case.id();
        let result = request_dispatch_handoff(
            &mut repository,
            &context,
            RequestDispatchHandoffCommand {
                case_id,
                work_order_id: WorkOrderId::new(),
                metadata,
                occurred_at: now,
            },
        );
        assert!(result.is_err());
        assert_eq!(repository.tx.calls, ["load"]);
    }

    #[test]
    fn dispatch_handoff_commits_matching_case_history_outbox_and_receipt() {
        let (mut repository, context, metadata, now) = fixture();
        let case_id = repository.tx.case.id();
        let work_order_id = WorkOrderId::new();
        request_dispatch_handoff(
            &mut repository,
            &context,
            RequestDispatchHandoffCommand {
                case_id,
                work_order_id,
                metadata: metadata.clone(),
                occurred_at: now,
            },
        )
        .unwrap();
        let commit = &repository.tx.commits[0];
        assert_eq!(
            repository.tx.calls,
            ["load", "receipt", "verify_work_order", "commit"]
        );
        assert_eq!(commit.case.id(), commit.outbox.case_id);
        assert_eq!(commit.outbox.event, commit.history.event);
        assert_eq!(commit.outbox.version, commit.history.version);
        assert_eq!(commit.idempotency_key, metadata.idempotency_key);
        assert_eq!(commit.result.case_id, case_id);
    }

    #[test]
    fn evidence_binding_commits_matching_case_history_outbox_and_receipt() {
        let (mut repository, context, metadata, now) = fixture();
        let case_id = repository.tx.case.id();
        let evidence_object_id = EvidenceObjectId::new();
        bind_case_evidence(
            &mut repository,
            &context,
            BindCaseEvidenceCommand {
                case_id,
                evidence_object_id,
                metadata: metadata.clone(),
                occurred_at: now,
            },
        )
        .unwrap();
        let commit = &repository.tx.commits[0];
        assert_eq!(
            repository.tx.calls,
            ["load", "receipt", "verify_evidence_object", "commit"]
        );
        assert_eq!(commit.case.id(), commit.outbox.case_id);
        assert_eq!(commit.outbox.event, commit.history.event);
        assert_eq!(commit.idempotency_key, metadata.idempotency_key);
        assert!(
            matches!(commit.history.event, CaseEvent::EvidenceBound { evidence_object_id: id } if id == evidence_object_id)
        );
    }

    #[test]
    fn handoff_resolution_commits_matching_case_history_outbox_and_receipt() {
        let (mut repository, context, mut metadata, now) = fixture();
        let work_order_id = WorkOrderId::new();
        repository
            .tx
            .case
            .request_dispatch_handoff(0, context.user_id, work_order_id, now)
            .unwrap();
        metadata.expected_version = repository.tx.case.version();
        let case_id = repository.tx.case.id();
        resolve_dispatch_handoff(
            &mut repository,
            &context,
            ResolveDispatchHandoffCommand {
                case_id,
                status: DispatchHandoffStatus::Accepted,
                metadata: metadata.clone(),
                occurred_at: now,
            },
        )
        .unwrap();
        let commit = &repository.tx.commits[0];
        assert_eq!(repository.tx.calls, ["load", "receipt", "commit"]);
        assert_eq!(commit.case.id(), commit.outbox.case_id);
        assert_eq!(commit.outbox.event, commit.history.event);
        assert_eq!(commit.idempotency_key, metadata.idempotency_key);
        assert!(
            matches!(commit.history.event, CaseEvent::DispatchHandoffResolved { work_order_id: id, status: DispatchHandoffStatus::Accepted } if id == work_order_id)
        );
    }
}
