//! Reporting application layer.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::future::Future;

use mnt_kernel_core::{BranchScope, KernelError, Timestamp, TraceContext, UserId};
pub use mnt_reporting_domain::{
    AnalyticsDefinitionVersion, AnalyticsEvidence, AnalyticsFactQueryIdentity, AnalyticsMetric,
    AnalyticsPeriod, AnalyticsSourceDomain, DailyStatusReport, DailyStatusRow, DashboardAnalytics,
    DashboardAnalyticsScope, ExportSourceNote, KpiMetric, KpiReport, KpiRollup, KpiRollupScope,
    KpiScope, LaborCostAnalytics, LaborCostAnalyticsScope, MetricAvailability, MetricUnavailable,
    OpsEquipmentStatus, OpsFunnel, OpsMechanicLoad, OpsSummary, Period, PeriodicInspectionRow,
    RatioEvidence, SumEvidence, TrendSlot, UnavailableMetric, WorkDiaryActionEntry, WorkDiaryBody,
    WorkDiaryDraft, WorkDiaryStatus,
};
use time::Date;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KpiQuery {
    pub period: Period,
    pub scope: KpiScope,
    pub branch_scope: BranchScope,
}

/// Audited KPI workbook download request. Carries the same aggregation inputs as
/// `KpiQuery` plus the actor/trace/timestamp needed to record the download in
/// `excel_export_logs` + `audit_events`, exactly like the sibling
/// daily-status / work-diary exports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KpiExportQuery {
    pub actor: UserId,
    pub period: Period,
    pub scope: KpiScope,
    pub branch_scope: BranchScope,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, thiserror::Error)]
pub enum KpiQueryError {
    #[error(transparent)]
    Kernel(#[from] KernelError),

    #[error("database error: {0}")]
    Database(String),
}

pub trait KpiQueryPort {
    fn query_kpis(
        &self,
        query: KpiQuery,
    ) -> impl Future<Output = Result<KpiReport, KpiQueryError>> + Send + '_;
}

/// One immutable predicate identity is shared by a summary and every page of
/// its drill-down facts. Adapters must reject identities they did not produce;
/// this makes a fact page unable to silently diverge from its summary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnalyticsFactPageQuery {
    pub fact_query_identity: AnalyticsFactQueryIdentity,
    pub after: Option<AnalyticsFactCursor>,
    pub limit: u16,
}

impl AnalyticsFactPageQuery {
    pub fn new(
        fact_query_identity: AnalyticsFactQueryIdentity,
        after: Option<AnalyticsFactCursor>,
        limit: u16,
    ) -> Result<Self, KernelError> {
        if limit == 0 || limit > 100 {
            return Err(KernelError::validation(
                "analytics fact page limit must be between 1 and 100",
            ));
        }
        Ok(Self {
            fact_query_identity,
            after,
            limit,
        })
    }
}

/// Opaque, adapter-issued cursor. The application never accepts an offset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnalyticsFactCursor(String);

impl AnalyticsFactCursor {
    pub fn new(value: impl Into<String>) -> Result<Self, KernelError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(KernelError::validation(
                "analytics fact cursor cannot be empty",
            ));
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnalyticsFact {
    id: AnalyticsFactId,
    occurred_at: Timestamp,
    source_domain: AnalyticsSourceDomain,
    evidence_href: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AnalyticsFactId(String);

impl AnalyticsFactId {
    pub fn new(value: impl Into<String>) -> Result<Self, KernelError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(KernelError::validation("analytics fact id cannot be empty"));
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl AnalyticsFact {
    pub fn new(
        id: AnalyticsFactId,
        occurred_at: Timestamp,
        source_domain: AnalyticsSourceDomain,
        evidence_href: impl Into<String>,
    ) -> Result<Self, KernelError> {
        let evidence_href = evidence_href.into();
        if evidence_href.trim().is_empty() {
            return Err(KernelError::validation(
                "analytics fact evidence href cannot be empty",
            ));
        }
        Ok(Self {
            id,
            occurred_at,
            source_domain,
            evidence_href,
        })
    }

    #[must_use]
    pub fn id(&self) -> &AnalyticsFactId {
        &self.id
    }
    #[must_use]
    pub fn occurred_at(&self) -> Timestamp {
        self.occurred_at
    }
    #[must_use]
    pub fn source_domain(&self) -> AnalyticsSourceDomain {
        self.source_domain
    }
    #[must_use]
    pub fn evidence_href(&self) -> &str {
        &self.evidence_href
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnalyticsFactPage {
    pub fact_query_identity: AnalyticsFactQueryIdentity,
    pub facts: Vec<AnalyticsFact>,
    pub next_cursor: Option<AnalyticsFactCursor>,
}

#[derive(Debug, thiserror::Error)]
pub enum AnalyticsQueryError {
    #[error(transparent)]
    Kernel(#[from] KernelError),
    #[error("analytics read error: {0}")]
    Read(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardAnalyticsQuery {
    pub period: AnalyticsPeriod,
    pub requested_scope: DashboardAnalyticsScope,
    pub branch_scope: BranchScope,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaborCostAnalyticsQuery {
    pub period: AnalyticsPeriod,
    pub branch_scope: BranchScope,
}

impl LaborCostAnalyticsQuery {
    pub fn new(period: AnalyticsPeriod, branch_scope: BranchScope) -> Result<Self, KernelError> {
        AnalyticsPeriod::monthly(period.start(), period.end())?;
        Ok(Self {
            period,
            branch_scope,
        })
    }
}

pub trait DashboardAnalyticsPort {
    fn dashboard_analytics(
        &self,
        query: DashboardAnalyticsQuery,
    ) -> impl Future<Output = Result<DashboardAnalytics, AnalyticsQueryError>> + Send + '_;

    fn dashboard_facts(
        &self,
        query: AnalyticsFactPageQuery,
    ) -> impl Future<Output = Result<AnalyticsFactPage, AnalyticsQueryError>> + Send + '_;
}

/// Labor cost remains company-only: branch scoping authorizes the read but
/// cannot alter the returned business scope or invent a payroll amount.
pub trait LaborCostAnalyticsPort {
    fn labor_cost_analytics(
        &self,
        query: LaborCostAnalyticsQuery,
    ) -> impl Future<Output = Result<LaborCostAnalytics, AnalyticsQueryError>> + Send + '_;

    fn labor_cost_facts(
        &self,
        query: AnalyticsFactPageQuery,
    ) -> impl Future<Output = Result<AnalyticsFactPage, AnalyticsQueryError>> + Send + '_;
}

/// Per-tenant operational dashboard query.
///
/// `aging_hours` is the threshold past which an unresolved work order is counted
/// as aging; `at_risk_minutes` is the lead time before a P1 accept-window
/// deadline at which a dispatch is flagged at-risk; `top_mechanics` caps the
/// utilization list. All reads run org-scoped under RLS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpsSummaryQuery {
    pub aging_hours: u32,
    pub at_risk_minutes: u32,
    pub top_mechanics: u32,
}

pub trait OpsSummaryPort {
    fn ops_summary(
        &self,
        query: OpsSummaryQuery,
    ) -> impl Future<Output = Result<OpsSummary, KpiQueryError>> + Send + '_;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportingExportQuery {
    pub actor: UserId,
    pub date: Date,
    pub branch_scope: BranchScope,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkDiaryQuery {
    pub actor: UserId,
    pub date: Date,
    pub branch_scope: BranchScope,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkDiaryUpdateCommand {
    pub actor: UserId,
    pub date: Date,
    pub branch_scope: BranchScope,
    pub body: WorkDiaryBody,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkDiaryConfirmCommand {
    pub actor: UserId,
    pub date: Date,
    pub branch_scope: BranchScope,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportedWorkbook {
    pub file_name: String,
    pub content_type: &'static str,
    pub bytes: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum ReportingExportError {
    #[error(transparent)]
    Kernel(#[from] KernelError),

    #[error("database error: {0}")]
    Database(String),

    #[error("workbook error: {0}")]
    Workbook(String),
}

impl From<KpiQueryError> for ReportingExportError {
    fn from(error: KpiQueryError) -> Self {
        match error {
            KpiQueryError::Kernel(error) => Self::Kernel(error),
            KpiQueryError::Database(message) => Self::Database(message),
        }
    }
}

pub trait ReportingExportPort {
    fn export_daily_status(
        &self,
        query: ReportingExportQuery,
    ) -> impl Future<Output = Result<ExportedWorkbook, ReportingExportError>> + Send + '_;

    fn export_work_diary(
        &self,
        query: ReportingExportQuery,
    ) -> impl Future<Output = Result<ExportedWorkbook, ReportingExportError>> + Send + '_;

    /// Build the KPI report (identical aggregation to the JSON `query_kpis`
    /// path) as a downloadable Excel workbook. The download is audited exactly
    /// like the sibling daily-status / work-diary exports: one
    /// `excel_export_logs` row plus one `audit_events` row, recorded under RLS.
    fn export_kpi(
        &self,
        query: KpiExportQuery,
    ) -> impl Future<Output = Result<ExportedWorkbook, ReportingExportError>> + Send + '_;
}

pub trait WorkDiaryDraftPort {
    fn get_or_generate_work_diary(
        &self,
        query: WorkDiaryQuery,
    ) -> impl Future<Output = Result<WorkDiaryDraft, ReportingExportError>> + Send + '_;

    fn update_work_diary(
        &self,
        command: WorkDiaryUpdateCommand,
    ) -> impl Future<Output = Result<WorkDiaryDraft, ReportingExportError>> + Send + '_;

    fn confirm_work_diary(
        &self,
        command: WorkDiaryConfirmCommand,
    ) -> impl Future<Output = Result<WorkDiaryDraft, ReportingExportError>> + Send + '_;
}

#[cfg(test)]
mod analytics_contract_tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn fact_page_requires_a_bounded_cursor_contract() {
        let identity = AnalyticsFactQueryIdentity::new("dashboard-july-company").unwrap();
        assert!(AnalyticsFactPageQuery::new(identity.clone(), None, 0).is_err());
        assert!(AnalyticsFactPageQuery::new(identity.clone(), None, 101).is_err());
        let query = AnalyticsFactPageQuery::new(
            identity,
            Some(AnalyticsFactCursor::new("opaque-next-page").unwrap()),
            100,
        )
        .unwrap();
        assert_eq!(query.after.unwrap().as_str(), "opaque-next-page");
    }

    #[test]
    fn labor_cost_query_accepts_only_whole_utc_months() {
        let month = AnalyticsPeriod::monthly(
            datetime!(2026-07-01 00:00 UTC),
            datetime!(2026-08-01 00:00 UTC),
        )
        .unwrap();
        assert!(LaborCostAnalyticsQuery::new(month, BranchScope::All).is_ok());
        let partial = AnalyticsPeriod::new(
            datetime!(2026-07-02 00:00 UTC),
            datetime!(2026-08-01 00:00 UTC),
        )
        .unwrap();
        assert!(LaborCostAnalyticsQuery::new(partial, BranchScope::All).is_err());
    }
}
