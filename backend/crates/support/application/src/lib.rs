//! Support-ticket application layer: commands, query DTOs, read models, audit
//! event builders, and the notification port.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, CustomerId, KernelError, SiteId,
    SupportTicketCommentId, SupportTicketId, Timestamp, TraceContext, UserId, WorkOrderId,
};
use mnt_support_domain::{
    AcceptanceChannel, AcceptanceKind, FieldSlaState, TicketCategory, TicketOrigin, TicketPriority,
    TicketStatus,
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

/// Bind a ticket to the field object chain: a customer site and/or the work
/// order dispatched for the visit. `Some(None)` clears a link (explicit JSON
/// `null`); `None` leaves it untouched. Linking a site to an untriaged CUSTOMER
/// ticket also sets `branch_id` from the site — that IS triage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkTicketCommand {
    pub actor: UserId,
    pub ticket_id: SupportTicketId,
    /// Principal's branch scope: the site lookup is confined to it so a
    /// branch-scoped manager can only link sites they can see (deny-by-omission).
    pub branch_scope: BranchScope,
    pub site_id: Option<Option<SiteId>>,
    pub work_order_id: Option<Option<WorkOrderId>>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Record the customer's acceptance verdict for a RESOLVED ticket — the audited
/// closure evidence of the field story. Drives the existing FSM edges
/// (accept ⇒ CLOSED, decline ⇒ reopen IN_PROGRESS + customer-visible comment).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordAcceptanceCommand {
    pub actor: UserId,
    pub ticket_id: SupportTicketId,
    pub kind: AcceptanceKind,
    pub channel: AcceptanceChannel,
    /// Customer-side acknowledger name — a business fact like `requester_name`;
    /// stored, never logged to traces or audit snapshots.
    pub accepted_by: String,
    pub note: Option<String>,
    /// `Idempotency-Key` header value (16..=200 chars, sibling-pilot semantics):
    /// a replay with the same key + fingerprint returns the stored acceptance;
    /// reuse with a different request is a conflict.
    pub idempotency_key: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
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
    /// Restrict to tickets linked to one customer site (field-console queue).
    pub site_id: Option<SiteId>,
}

/// Branch-scoped field-site overview query (list layer of `/console/field`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListFieldSitesQuery {
    pub branch_scope: BranchScope,
    /// Substring match on site name or customer name.
    pub q: Option<String>,
    pub customer_id: Option<CustomerId>,
    /// Filter on the derived per-site SLA state.
    pub sla: Option<FieldSlaState>,
    /// Page size; the adapter clamps to `1..=100`.
    pub limit: Option<i64>,
    /// Keyset cursor: the id of the last site from the previous page, on the
    /// `(site_name, site_id)` ascending ordering.
    pub cursor: Option<SiteId>,
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
    /// Field object chain (0194, all additive): the linked customer site, its
    /// customer (denormalized on link), and the dispatched work order.
    pub site_id: Option<SiteId>,
    pub site_name: Option<String>,
    pub customer_id: Option<CustomerId>,
    pub customer_name: Option<String>,
    pub work_order_id: Option<WorkOrderId>,
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

// ---------------------------------------------------------------------------
// Field read models (customer-site overview / detail — `/console/field`)
// ---------------------------------------------------------------------------

/// One row of the field-site overview: the site, its customer, and the
/// aggregated issue/visit/SLA state — every count derives from the same query
/// as the rows (stat bar honesty, §4-11).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldSiteRow {
    pub site_id: SiteId,
    pub site_name: String,
    pub branch_id: BranchId,
    pub customer_id: CustomerId,
    pub customer_name: String,
    pub address: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    /// Tickets in OPEN/IN_PROGRESS/ON_HOLD linked to the site.
    pub open_ticket_count: i64,
    /// Open tickets whose SLA `due_at` has already passed.
    pub breached_ticket_count: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    pub next_due_at: Option<Timestamp>,
    /// Work orders for the site in a non-terminal status.
    pub active_work_order_count: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_arrival_at: Option<Timestamp>,
    pub sla: FieldSlaState,
}

/// One keyset page of field sites plus the unpaged `total` for the same
/// filters. `next_cursor` is the id to pass as `cursor` for the next page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldSitePage {
    pub items: Vec<FieldSiteRow>,
    pub next_cursor: Option<SiteId>,
    pub total: i64,
}

/// Site master facts on the field detail panel (registry-owned data, read-only
/// projection here; edits go through the registry API).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldSiteSummary {
    pub id: SiteId,
    pub name: String,
    pub branch_id: BranchId,
    pub customer_id: CustomerId,
    pub customer_name: String,
    pub address: Option<String>,
    pub province: Option<String>,
    pub city: Option<String>,
    pub postal_code: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub geofence_radius_m: Option<f64>,
    pub contact_name: Option<String>,
    pub contact_phone: Option<String>,
}

/// Per-site SLA rollup: current open/breached state plus the 90-day resolution
/// record (resolved before vs after `due_at`; tickets without a due date are
/// excluded rather than guessed).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldSlaSummary {
    pub state: FieldSlaState,
    pub open: i64,
    pub breached: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    pub next_due_at: Option<Timestamp>,
    pub resolved_within_sla_90d: i64,
    pub resolved_breached_90d: i64,
}

/// Read-only reference to a work order dispatched to the site. Status/priority/
/// result are the workorder crate's 16-state vocabulary rendered as chips; all
/// mutations go through the workorder API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldWorkOrderRef {
    pub id: WorkOrderId,
    pub request_no: String,
    pub status: String,
    pub priority: String,
    #[serde(with = "time::serde::rfc3339::option")]
    pub target_due_at: Option<Timestamp>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub report_submitted_at: Option<Timestamp>,
    pub result_type: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
}

/// A durable check-in/out business fact (`site_attendance_events`, compliance-
/// owned; carries no coordinates and survives consent withdrawal).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldAttendanceEvent {
    pub user_id: UserId,
    /// Same-org display-name lookup; `None` for a deleted user.
    pub user_name: Option<String>,
    pub work_order_id: WorkOrderId,
    /// `ARRIVAL` or `DEPARTURE` (compliance vocabulary, read-only here).
    pub kind: String,
    #[serde(with = "time::serde::rfc3339")]
    pub occurred_at: Timestamp,
}

/// Recorded customer acceptance (append-only closure evidence).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketAcceptanceView {
    pub id: uuid::Uuid,
    pub ticket_id: SupportTicketId,
    pub kind: AcceptanceKind,
    pub channel: AcceptanceChannel,
    pub accepted_by: String,
    pub note: Option<String>,
    pub recorded_by_user_id: UserId,
    /// Same-org display-name lookup; `None` for a deleted recorder.
    pub recorded_by_name: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub occurred_at: Timestamp,
}

/// Object + history layers of the field detail panel: the site, its SLA rollup,
/// and the traversable downstream chain (tickets, work orders, attendance,
/// acceptances — each capped at 50, most relevant first).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldSiteDetail {
    pub site: FieldSiteSummary,
    pub sla: FieldSlaSummary,
    pub tickets: Vec<TicketSummary>,
    pub work_orders: Vec<FieldWorkOrderRef>,
    pub attendance: Vec<FieldAttendanceEvent>,
    pub acceptances: Vec<TicketAcceptanceView>,
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
}
