//! Pure evaluation lifecycle and review invariants.
//!
//! This crate intentionally contains no transport, database, authorization
//! engine, or request-context dependency. Adapters rehydrate these values only
//! after arming tenant RLS and authorizing the authenticated principal.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::{KernelError, Timestamp, UserId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! evaluation_id {
    ($name:ident) => {
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(Uuid);
        impl $name {
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }
            #[must_use]
            pub const fn from_uuid(value: Uuid) -> Self {
                Self(value)
            }
            #[must_use]
            pub const fn as_uuid(&self) -> &Uuid {
                &self.0
            }
        }
        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }
    };
}
evaluation_id!(EvaluationCycleId);
evaluation_id!(EvaluationSubjectId);
evaluation_id!(EvaluationGoalId);
evaluation_id!(EvaluationReviewId);
evaluation_id!(EvaluationEvidenceLinkId);
evaluation_id!(EvaluationRubricId);
evaluation_id!(EmployeeId);
evaluation_id!(OrgUnitId);
evaluation_id!(PositionId);
evaluation_id!(TeamId);
evaluation_id!(GovernedObjectId);

/// Lifecycle state of an evaluation cycle. There is no backwards transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EvaluationCycleState {
    Draft,
    Open,
    Calibration,
    Finalized,
    Archived,
}

/// State of one review packet; submission is terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EvaluationReviewState {
    Draft,
    Submitted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewKind {
    SelfReview,
    Manager,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SubjectTaskState {
    NotStarted,
    SelfSubmitted,
    ManagerSubmitted,
    ReadyForCalibration,
    Calibrated,
    Finalized,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RubricLevel {
    S,
    A,
    B,
    C,
    D,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GoalMetricKind {
    Kpi,
    Attendance,
    Task,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GovernedObjectKind {
    Attendance,
    WorkOrder,
    Approval,
    Kpi,
}

/// Actor relationship is derived from the server-scoped subject projection, not request input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubjectVisibility {
    Unrelated,
    SelfParticipant,
    AssignedManager,
    Calibrator,
}

/// Stable employee and organization snapshot. It becomes immutable when a cycle opens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubjectSnapshot {
    pub employee_id: EmployeeId,
    pub manager_user_id: UserId,
    pub home_branch_id: Uuid,
    pub org_unit_id: Option<OrgUnitId>,
    pub position_id: Option<PositionId>,
    pub team_id: Option<TeamId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvaluationGoal {
    id: EvaluationGoalId,
    pub metric_kind: GoalMetricKind,
    pub target: String,
    pub weight_percent: u8,
    pub sort_order: u32,
}
impl EvaluationGoal {
    pub fn new(
        metric_kind: GoalMetricKind,
        target: impl Into<String>,
        weight_percent: u8,
        sort_order: u32,
    ) -> Result<Self, KernelError> {
        let target = required_text(target.into(), "goal target", 200)?;
        if weight_percent == 0 {
            return Err(KernelError::validation(
                "goal weight must be between 1 and 100",
            ));
        }
        Ok(Self {
            id: EvaluationGoalId::new(),
            metric_kind,
            target,
            weight_percent,
            sort_order,
        })
    }
}

/// Tenant-configurable presentation for the fixed grading codes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RubricDefinition {
    id: EvaluationRubricId,
    pub levels: Vec<RubricDefinitionLevel>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RubricDefinitionLevel {
    pub level: RubricLevel,
    pub label: String,
    pub description: String,
    pub behavior_anchors: Vec<String>,
    pub sort_order: u8,
}
impl RubricDefinition {
    pub fn new(levels: Vec<RubricDefinitionLevel>) -> Result<Self, KernelError> {
        if levels.len() != 5 {
            return Err(KernelError::validation(
                "rubric must define exactly S/A/B/C/D",
            ));
        }
        let expected = [
            RubricLevel::S,
            RubricLevel::A,
            RubricLevel::B,
            RubricLevel::C,
            RubricLevel::D,
        ];
        for (index, required) in expected.iter().enumerate() {
            let Some(level) = levels.iter().find(|level| level.level == *required) else {
                return Err(KernelError::validation(
                    "rubric must define each fixed grade exactly once",
                ));
            };
            if level.sort_order != index as u8
                || required_text(level.label.clone(), "rubric label", 80).is_err()
                || required_text(level.description.clone(), "rubric description", 500).is_err()
                || level.behavior_anchors.is_empty()
            {
                return Err(KernelError::validation(
                    "rubric labels, descriptions, anchors, and canonical order are required",
                ));
            }
        }
        Ok(Self {
            id: EvaluationRubricId::new(),
            levels,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvaluationEvidenceLink {
    id: EvaluationEvidenceLinkId,
    pub governed_object_kind: GovernedObjectKind,
    pub governed_object_id: GovernedObjectId,
    pub label: String,
    pub sort_order: u32,
}
impl EvaluationEvidenceLink {
    /// `governed_object_id` must have been resolved by the tenant-scoped adapter before construction.
    pub fn resolved(
        kind: GovernedObjectKind,
        governed_object_id: GovernedObjectId,
        label: impl Into<String>,
        sort_order: u32,
    ) -> Result<Self, KernelError> {
        Ok(Self {
            id: EvaluationEvidenceLinkId::new(),
            governed_object_kind: kind,
            governed_object_id,
            label: required_text(label.into(), "evidence label", 200)?,
            sort_order,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvaluationReview {
    id: EvaluationReviewId,
    kind: ReviewKind,
    evaluator_user_id: UserId,
    state: EvaluationReviewState,
    grade: Option<RubricLevel>,
    rationale: Option<String>,
    evidence_links: Vec<EvaluationEvidenceLink>,
    version: u64,
    submitted_at: Option<Timestamp>,
}
impl EvaluationReview {
    #[must_use]
    pub fn draft(kind: ReviewKind, evaluator_user_id: UserId) -> Self {
        Self {
            id: EvaluationReviewId::new(),
            kind,
            evaluator_user_id,
            state: EvaluationReviewState::Draft,
            grade: None,
            rationale: None,
            evidence_links: Vec::new(),
            version: 0,
            submitted_at: None,
        }
    }
    #[must_use]
    pub const fn evaluator_user_id(&self) -> UserId {
        self.evaluator_user_id
    }
    #[must_use]
    pub const fn state(&self) -> EvaluationReviewState {
        self.state
    }
    #[must_use]
    pub const fn version(&self) -> u64 {
        self.version
    }

    pub fn edit(
        &mut self,
        expected_version: u64,
        grade: RubricLevel,
        rationale: impl Into<String>,
        evidence_links: Vec<EvaluationEvidenceLink>,
    ) -> Result<(), KernelError> {
        self.require_version(expected_version)?;
        if self.state != EvaluationReviewState::Draft {
            return Err(KernelError::conflict("submitted review is immutable"));
        }
        self.grade = Some(grade);
        self.rationale = Some(required_text(rationale.into(), "review rationale", 2_000)?);
        self.evidence_links = evidence_links;
        self.version += 1;
        Ok(())
    }
    pub fn submit(&mut self, expected_version: u64, at: Timestamp) -> Result<(), KernelError> {
        self.require_version(expected_version)?;
        if self.state != EvaluationReviewState::Draft {
            return Err(KernelError::conflict("review already submitted"));
        }
        if self.grade.is_none() || self.rationale.as_deref().is_none_or(str::is_empty) {
            return Err(KernelError::validation(
                "submitted review requires grade and rationale",
            ));
        }
        self.state = EvaluationReviewState::Submitted;
        self.submitted_at = Some(at);
        self.version += 1;
        Ok(())
    }
    fn require_version(&self, expected: u64) -> Result<(), KernelError> {
        if self.version == expected {
            Ok(())
        } else {
            Err(KernelError::conflict("stale evaluation review version"))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvaluationSubject {
    id: EvaluationSubjectId,
    snapshot: SubjectSnapshot,
    goals: Vec<EvaluationGoal>,
    self_review: EvaluationReview,
    manager_review: EvaluationReview,
    task_state: SubjectTaskState,
    calibrated_grade: Option<RubricLevel>,
    calibration_rationale: Option<String>,
    calibrated_by: Option<UserId>,
    calibrated_at: Option<Timestamp>,
    final_grade: Option<RubricLevel>,
    rv_code: Option<String>,
    finalized_at: Option<Timestamp>,
    version: u64,
    frozen: bool,
}
impl EvaluationSubject {
    pub fn new(snapshot: SubjectSnapshot, self_user_id: UserId) -> Result<Self, KernelError> {
        if snapshot.manager_user_id == self_user_id {
            return Err(KernelError::validation(
                "subject and manager must be distinct",
            ));
        }
        Ok(Self {
            id: EvaluationSubjectId::new(),
            manager_review: EvaluationReview::draft(ReviewKind::Manager, snapshot.manager_user_id),
            self_review: EvaluationReview::draft(ReviewKind::SelfReview, self_user_id),
            snapshot,
            goals: Vec::new(),
            task_state: SubjectTaskState::NotStarted,
            calibrated_grade: None,
            calibration_rationale: None,
            calibrated_by: None,
            calibrated_at: None,
            final_grade: None,
            rv_code: None,
            finalized_at: None,
            version: 0,
            frozen: false,
        })
    }
    pub fn replace_goals(
        &mut self,
        expected_version: u64,
        goals: Vec<EvaluationGoal>,
    ) -> Result<(), KernelError> {
        self.require_unfrozen()?;
        self.require_version(expected_version)?;
        validate_goals(&goals)?;
        self.goals = goals;
        self.version += 1;
        Ok(())
    }
    pub fn freeze_for_open(&mut self) -> Result<(), KernelError> {
        validate_goals(&self.goals)?;
        self.frozen = true;
        Ok(())
    }
    #[must_use]
    pub const fn id(&self) -> EvaluationSubjectId {
        self.id
    }
    #[must_use]
    pub fn review_evaluator(&self, kind: ReviewKind) -> UserId {
        match kind {
            ReviewKind::SelfReview => self.self_review.evaluator_user_id(),
            ReviewKind::Manager => self.manager_review.evaluator_user_id(),
        }
    }
    #[must_use]
    pub fn review_version(&self, kind: ReviewKind) -> u64 {
        match kind {
            ReviewKind::SelfReview => self.self_review.version(),
            ReviewKind::Manager => self.manager_review.version(),
        }
    }
    #[must_use]
    pub const fn version(&self) -> u64 {
        self.version
    }
    #[must_use]
    pub const fn task_state(&self) -> SubjectTaskState {
        self.task_state
    }
    #[must_use]
    pub fn rv_code(&self) -> Option<&str> {
        self.rv_code.as_deref()
    }
    pub fn edit_review(
        &mut self,
        kind: ReviewKind,
        expected_review_version: u64,
        grade: RubricLevel,
        rationale: impl Into<String>,
        evidence_links: Vec<EvaluationEvidenceLink>,
    ) -> Result<(), KernelError> {
        match kind {
            ReviewKind::SelfReview => {
                self.self_review
                    .edit(expected_review_version, grade, rationale, evidence_links)?
            }
            ReviewKind::Manager => self.manager_review.edit(
                expected_review_version,
                grade,
                rationale,
                evidence_links,
            )?,
        }
        self.version += 1;
        Ok(())
    }
    pub fn submit_review(
        &mut self,
        kind: ReviewKind,
        expected_review_version: u64,
        at: Timestamp,
    ) -> Result<(), KernelError> {
        match kind {
            ReviewKind::SelfReview => self.self_review.submit(expected_review_version, at)?,
            ReviewKind::Manager => self.manager_review.submit(expected_review_version, at)?,
        }
        self.task_state = match (self.self_review.state(), self.manager_review.state()) {
            (EvaluationReviewState::Submitted, EvaluationReviewState::Submitted) => {
                SubjectTaskState::ReadyForCalibration
            }
            (EvaluationReviewState::Submitted, _) => SubjectTaskState::SelfSubmitted,
            (_, EvaluationReviewState::Submitted) => SubjectTaskState::ManagerSubmitted,
            _ => SubjectTaskState::NotStarted,
        };
        self.version += 1;
        Ok(())
    }
    pub fn calibrate(
        &mut self,
        expected_version: u64,
        actor: UserId,
        grade: RubricLevel,
        rationale: impl Into<String>,
        at: Timestamp,
    ) -> Result<(), KernelError> {
        self.require_version(expected_version)?;
        if self.task_state != SubjectTaskState::ReadyForCalibration {
            return Err(KernelError::conflict(
                "calibration requires both submitted reviews",
            ));
        }
        if actor == self.self_review.evaluator_user_id
            || actor == self.manager_review.evaluator_user_id
        {
            return Err(KernelError::conflict(
                "calibration requires four-eyes actor separation",
            ));
        }
        self.calibrated_grade = Some(grade);
        self.calibration_rationale = Some(required_text(
            rationale.into(),
            "calibration rationale",
            500,
        )?);
        self.calibrated_by = Some(actor);
        self.calibrated_at = Some(at);
        self.task_state = SubjectTaskState::Calibrated;
        self.version += 1;
        Ok(())
    }
    pub fn finalize(
        &mut self,
        rv_code: impl Into<String>,
        at: Timestamp,
    ) -> Result<(), KernelError> {
        if self.task_state != SubjectTaskState::Calibrated {
            return Err(KernelError::conflict(
                "finalization requires calibrated subject",
            ));
        }
        let rv_code = canonical_rv_code(rv_code.into())?;
        self.final_grade = self.calibrated_grade;
        self.rv_code = Some(rv_code);
        self.finalized_at = Some(at);
        self.task_state = SubjectTaskState::Finalized;
        self.version += 1;
        Ok(())
    }
    #[must_use]
    pub fn visibility(
        &self,
        actor: UserId,
        is_calibrator: bool,
        cycle_state: EvaluationCycleState,
    ) -> SubjectVisibility {
        if actor == self.self_review.evaluator_user_id {
            SubjectVisibility::SelfParticipant
        } else if actor == self.manager_review.evaluator_user_id {
            SubjectVisibility::AssignedManager
        } else if is_calibrator && cycle_state == EvaluationCycleState::Calibration {
            SubjectVisibility::Calibrator
        } else {
            SubjectVisibility::Unrelated
        }
    }
    #[must_use]
    pub fn can_read_self_content(&self, visibility: SubjectVisibility) -> bool {
        match visibility {
            SubjectVisibility::SelfParticipant | SubjectVisibility::Calibrator => true,
            SubjectVisibility::AssignedManager => {
                self.manager_review.state == EvaluationReviewState::Submitted
            }
            SubjectVisibility::Unrelated => false,
        }
    }
    fn require_unfrozen(&self) -> Result<(), KernelError> {
        if self.frozen {
            Err(KernelError::conflict(
                "subject snapshot and goals are frozen after cycle opening",
            ))
        } else {
            Ok(())
        }
    }
    fn require_version(&self, expected: u64) -> Result<(), KernelError> {
        if self.version == expected {
            Ok(())
        } else {
            Err(KernelError::conflict("stale evaluation subject version"))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvaluationCycle {
    id: EvaluationCycleId,
    name: String,
    state: EvaluationCycleState,
    effective_from: time::Date,
    effective_until: time::Date,
    rubric_id: EvaluationRubricId,
    version: u64,
    opened_at: Option<Timestamp>,
    calibration_started_at: Option<Timestamp>,
    finalized_at: Option<Timestamp>,
    finalized_by: Option<UserId>,
    archived_at: Option<Timestamp>,
}
impl EvaluationCycle {
    #[must_use]
    pub const fn id(&self) -> EvaluationCycleId {
        self.id
    }
    #[must_use]
    pub const fn state(&self) -> EvaluationCycleState {
        self.state
    }
    #[must_use]
    pub const fn version(&self) -> u64 {
        self.version
    }
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }
    #[must_use]
    pub const fn effective_from(&self) -> time::Date {
        self.effective_from
    }
    #[must_use]
    pub const fn effective_until(&self) -> time::Date {
        self.effective_until
    }
    #[must_use]
    pub const fn rubric_id(&self) -> EvaluationRubricId {
        self.rubric_id
    }
    #[must_use]
    pub const fn opened_at(&self) -> Option<Timestamp> {
        self.opened_at
    }
    #[must_use]
    pub const fn calibration_started_at(&self) -> Option<Timestamp> {
        self.calibration_started_at
    }
    #[must_use]
    pub const fn finalized_at(&self) -> Option<Timestamp> {
        self.finalized_at
    }
    #[must_use]
    pub const fn finalized_by(&self) -> Option<UserId> {
        self.finalized_by
    }
    #[must_use]
    pub const fn archived_at(&self) -> Option<Timestamp> {
        self.archived_at
    }

    pub fn draft(
        name: impl Into<String>,
        effective_from: time::Date,
        effective_until: time::Date,
        rubric_id: EvaluationRubricId,
    ) -> Result<Self, KernelError> {
        if effective_until < effective_from {
            return Err(KernelError::validation(
                "evaluation cycle effective end precedes effective start",
            ));
        }
        Ok(Self {
            id: EvaluationCycleId::new(),
            name: required_text(name.into(), "cycle name", 120)?,
            state: EvaluationCycleState::Draft,
            effective_from,
            effective_until,
            rubric_id,
            version: 0,
            opened_at: None,
            calibration_started_at: None,
            finalized_at: None,
            finalized_by: None,
            archived_at: None,
        })
    }
    pub fn open(
        &mut self,
        expected_version: u64,
        subjects: &mut [EvaluationSubject],
        at: Timestamp,
    ) -> Result<(), KernelError> {
        self.require_state(EvaluationCycleState::Draft)?;
        self.require_version(expected_version)?;
        if subjects.is_empty() {
            return Err(KernelError::validation(
                "opening requires at least one subject",
            ));
        }
        for subject in subjects {
            subject.freeze_for_open()?;
        }
        self.state = EvaluationCycleState::Open;
        self.opened_at = Some(at);
        self.version += 1;
        Ok(())
    }
    pub fn start_calibration(
        &mut self,
        expected_version: u64,
        subjects: &[EvaluationSubject],
        at: Timestamp,
    ) -> Result<(), KernelError> {
        self.require_state(EvaluationCycleState::Open)?;
        self.require_version(expected_version)?;
        if subjects
            .iter()
            .any(|subject| subject.task_state() != SubjectTaskState::ReadyForCalibration)
        {
            return Err(KernelError::conflict(
                "calibration requires both reviews submitted for every subject",
            ));
        }
        self.state = EvaluationCycleState::Calibration;
        self.calibration_started_at = Some(at);
        self.version += 1;
        Ok(())
    }
    pub fn finalize(
        &mut self,
        expected_version: u64,
        subjects: &[EvaluationSubject],
        finalizer: UserId,
        at: Timestamp,
    ) -> Result<(), KernelError> {
        self.require_state(EvaluationCycleState::Calibration)?;
        self.require_version(expected_version)?;
        if subjects.is_empty()
            || subjects
                .iter()
                .any(|subject| subject.task_state() != SubjectTaskState::Calibrated)
        {
            return Err(KernelError::conflict(
                "finalization requires every subject calibrated",
            ));
        }
        self.state = EvaluationCycleState::Finalized;
        self.finalized_by = Some(finalizer);
        self.finalized_at = Some(at);
        self.version += 1;
        Ok(())
    }
    pub fn archive(&mut self, expected_version: u64, at: Timestamp) -> Result<(), KernelError> {
        self.require_state(EvaluationCycleState::Finalized)?;
        self.require_version(expected_version)?;
        self.state = EvaluationCycleState::Archived;
        self.archived_at = Some(at);
        self.version += 1;
        Ok(())
    }
    fn require_state(&self, expected: EvaluationCycleState) -> Result<(), KernelError> {
        if self.state == expected {
            Ok(())
        } else {
            Err(KernelError::conflict("illegal evaluation cycle transition"))
        }
    }
    fn require_version(&self, expected: u64) -> Result<(), KernelError> {
        if self.version == expected {
            Ok(())
        } else {
            Err(KernelError::conflict("stale evaluation cycle version"))
        }
    }
}

fn validate_goals(goals: &[EvaluationGoal]) -> Result<(), KernelError> {
    if goals.is_empty() {
        return Err(KernelError::validation(
            "each subject requires at least one goal",
        ));
    }
    let total: u16 = goals
        .iter()
        .map(|goal| u16::from(goal.weight_percent))
        .sum();
    if total != 100 {
        return Err(KernelError::validation(
            "subject goal weights must total exactly 100",
        ));
    }
    let mut orders: Vec<_> = goals.iter().map(|goal| goal.sort_order).collect();
    orders.sort_unstable();
    orders.dedup();
    if orders.len() != goals.len() {
        return Err(KernelError::validation(
            "goal sort orders must be unique per subject",
        ));
    }
    Ok(())
}
fn required_text(value: String, field: &str, max: usize) -> Result<String, KernelError> {
    let value = value.trim().to_owned();
    if value.is_empty() || value.len() > max {
        Err(KernelError::validation(format!(
            "{field} must be nonempty and at most {max} characters"
        )))
    } else {
        Ok(value)
    }
}
fn canonical_rv_code(raw: String) -> Result<String, KernelError> {
    let value = raw.trim().to_ascii_uppercase();
    let valid = value
        .strip_prefix("RV-")
        .is_some_and(|suffix| suffix.len() >= 4 && suffix.chars().all(|ch| ch.is_ascii_digit()));
    if valid {
        Ok(value)
    } else {
        Err(KernelError::validation("RV code must match ^RV-[0-9]{4,}$"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;
    fn subject() -> EvaluationSubject {
        let employee = UserId::new();
        EvaluationSubject::new(
            SubjectSnapshot {
                employee_id: EmployeeId::new(),
                manager_user_id: UserId::new(),
                home_branch_id: Uuid::new_v4(),
                org_unit_id: None,
                position_id: None,
                team_id: None,
            },
            employee,
        )
        .unwrap()
    }
    fn goal(weight: u8, order: u32) -> EvaluationGoal {
        EvaluationGoal::new(GoalMetricKind::Kpi, "Revenue", weight, order).unwrap()
    }
    #[test]
    fn cycle_fsm_freezes_subjects_and_requires_exact_weight() {
        let now = Timestamp::now_utc();
        let mut subject = subject();
        assert!(subject.replace_goals(0, vec![goal(99, 0)]).is_err());
        subject
            .replace_goals(0, vec![goal(50, 0), goal(50, 1)])
            .unwrap();
        let mut cycle = EvaluationCycle::draft(
            "2026 H2",
            date!(2026 - 07 - 01),
            date!(2026 - 12 - 31),
            EvaluationRubricId::new(),
        )
        .unwrap();
        cycle
            .open(0, std::slice::from_mut(&mut subject), now)
            .unwrap();
        assert!(subject.replace_goals(1, vec![goal(100, 0)]).is_err());
        assert!(cycle.archive(1, now).is_err());
    }
    #[test]
    fn complete_cycle_requires_submitted_reviews_calibration_and_finalization() {
        let now = Timestamp::now_utc();
        let mut subject = subject();
        subject.replace_goals(0, vec![goal(100, 0)]).unwrap();
        let mut cycle = EvaluationCycle::draft(
            "2026 annual",
            date!(2026 - 01 - 01),
            date!(2026 - 12 - 31),
            EvaluationRubricId::new(),
        )
        .unwrap();
        cycle
            .open(0, std::slice::from_mut(&mut subject), now)
            .unwrap();
        assert!(
            cycle
                .start_calibration(1, std::slice::from_ref(&subject), now)
                .is_err()
        );
        subject
            .edit_review(
                ReviewKind::SelfReview,
                0,
                RubricLevel::A,
                "self evidence",
                vec![],
            )
            .unwrap();
        subject
            .submit_review(ReviewKind::SelfReview, 1, now)
            .unwrap();
        subject
            .edit_review(
                ReviewKind::Manager,
                0,
                RubricLevel::A,
                "manager evidence",
                vec![],
            )
            .unwrap();
        subject.submit_review(ReviewKind::Manager, 1, now).unwrap();
        cycle
            .start_calibration(1, std::slice::from_ref(&subject), now)
            .unwrap();
        subject
            .calibrate(
                subject.version(),
                UserId::new(),
                RubricLevel::A,
                "cross-functional calibration",
                now,
            )
            .unwrap();
        cycle
            .finalize(2, std::slice::from_ref(&subject), UserId::new(), now)
            .unwrap();
        subject.finalize("RV-2500", now).unwrap();
        cycle.archive(3, now).unwrap();
        assert_eq!(cycle.state(), EvaluationCycleState::Archived);
        assert_eq!(subject.rv_code(), Some("RV-2500"));
    }

    #[test]
    fn calibration_is_subject_occ_controlled() {
        let now = Timestamp::now_utc();
        let mut subject = subject();
        subject.replace_goals(0, vec![goal(100, 0)]).unwrap();
        subject
            .edit_review(ReviewKind::SelfReview, 0, RubricLevel::A, "self", vec![])
            .unwrap();
        subject
            .submit_review(ReviewKind::SelfReview, 1, now)
            .unwrap();
        subject
            .edit_review(ReviewKind::Manager, 0, RubricLevel::A, "manager", vec![])
            .unwrap();
        subject.submit_review(ReviewKind::Manager, 1, now).unwrap();
        let stale = subject.version() - 1;
        assert!(
            subject
                .calibrate(stale, UserId::new(), RubricLevel::A, "cross-check", now)
                .is_err()
        );
        subject
            .calibrate(
                subject.version(),
                UserId::new(),
                RubricLevel::A,
                "cross-check",
                now,
            )
            .unwrap();
        assert_eq!(subject.task_state(), SubjectTaskState::Calibrated);
    }

    #[test]
    fn reviews_are_occ_controlled_and_submitted_content_is_immutable() {
        let now = Timestamp::now_utc();
        let mut review = EvaluationReview::draft(ReviewKind::SelfReview, UserId::new());
        review
            .edit(0, RubricLevel::A, "delivered measurable result", vec![])
            .unwrap();
        assert!(review.submit(0, now).is_err());
        review.submit(1, now).unwrap();
        assert!(review.edit(2, RubricLevel::S, "rewrite", vec![]).is_err());
    }
    #[test]
    fn manager_cannot_read_self_before_manager_submission_and_calibration_requires_four_eyes() {
        let now = Timestamp::now_utc();
        let mut subject = subject();
        subject.replace_goals(0, vec![goal(100, 0)]).unwrap();
        subject
            .edit_review(
                ReviewKind::SelfReview,
                0,
                RubricLevel::A,
                "self result",
                vec![],
            )
            .unwrap();
        subject
            .submit_review(ReviewKind::SelfReview, 1, now)
            .unwrap();
        let manager = subject.review_evaluator(ReviewKind::Manager);
        assert!(!subject.can_read_self_content(subject.visibility(
            manager,
            false,
            EvaluationCycleState::Open
        )));
        subject
            .edit_review(
                ReviewKind::Manager,
                0,
                RubricLevel::A,
                "manager result",
                vec![],
            )
            .unwrap();
        subject.submit_review(ReviewKind::Manager, 1, now).unwrap();
        assert!(subject.can_read_self_content(subject.visibility(
            manager,
            false,
            EvaluationCycleState::Open
        )));
        assert!(
            subject
                .calibrate(
                    subject.version(),
                    manager,
                    RubricLevel::A,
                    "calibration",
                    now
                )
                .is_err()
        );
        subject
            .calibrate(
                subject.version(),
                UserId::new(),
                RubricLevel::A,
                "calibration",
                now,
            )
            .unwrap();
    }
}
