//! Evaluation commands and transactional application ports.
//!
//! Adapters derive actor/tenant from the authenticated, RLS-armed request. No
//! command accepts `org_id`; persistence is reached only through one atomic
//! unit of work that owns aggregate, audit, RV, and receipt commit.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_evaluation_domain::{
    EvaluationCycle, EvaluationCycleId, EvaluationCycleState, EvaluationEvidenceLink,
    EvaluationSubject, EvaluationSubjectId, ReviewKind, RubricLevel, SubjectVisibility,
};
use mnt_kernel_core::{KernelError, OrgId, Timestamp, TraceContext, UserId};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvaluationActorContext {
    /// Server-derived tenant context, never caller input.
    pub org_id: OrgId,
    pub user_id: UserId,
    pub may_manage: bool,
    pub may_submit: bool,
    pub may_calibrate: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandMetadata {
    pub actor: UserId,
    pub trace: TraceContext,
    /// Aggregate OCC token: cycle for cycle actions, selected subject for calibration,
    /// selected review for draft edit/submit.
    pub expected_version: u64,
    pub idempotency_key: String,
    pub fingerprint: String,
}
impl CommandMetadata {
    pub fn validate(&self, context: &EvaluationActorContext) -> Result<(), KernelError> {
        if self.actor != context.user_id {
            return Err(KernelError::forbidden(
                "command actor must match authenticated principal",
            ));
        }
        if !(16..=200).contains(&self.idempotency_key.trim().len()) {
            return Err(KernelError::validation(
                "idempotency key must be 16..=200 characters",
            ));
        }
        if self.fingerprint.trim().is_empty() || self.fingerprint.len() > 128 {
            return Err(KernelError::validation(
                "command fingerprint is required and bounded",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenCycleCommand {
    pub cycle_id: EvaluationCycleId,
    pub metadata: CommandMetadata,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartCalibrationCommand {
    pub cycle_id: EvaluationCycleId,
    pub metadata: CommandMetadata,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalizeCycleCommand {
    pub cycle_id: EvaluationCycleId,
    pub metadata: CommandMetadata,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalibrateSubjectCommand {
    pub cycle_id: EvaluationCycleId,
    pub subject_id: EvaluationSubjectId,
    pub grade: RubricLevel,
    pub rationale: String,
    pub metadata: CommandMetadata,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditReviewDraftCommand {
    pub cycle_id: EvaluationCycleId,
    pub subject_id: EvaluationSubjectId,
    pub kind: ReviewKind,
    pub grade: RubricLevel,
    pub rationale: String,
    /// Adapter supplies only server-resolved tenant-visible links.
    pub evidence_links: Vec<EvaluationEvidenceLink>,
    pub metadata: CommandMetadata,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmitReviewCommand {
    pub cycle_id: EvaluationCycleId,
    pub subject_id: EvaluationSubjectId,
    pub kind: ReviewKind,
    pub metadata: CommandMetadata,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionReceipt {
    pub tenant: OrgId,
    pub action: String,
    pub idempotency_key: String,
    pub fingerprint: String,
    pub response: Value,
    pub occurred_at: Timestamp,
}
#[derive(Debug, Clone, PartialEq)]
pub enum IdempotencyDecision {
    Execute,
    Replay(Value),
}
pub fn decide_idempotency(
    existing: Option<&ActionReceipt>,
    tenant: OrgId,
    action: &str,
    metadata: &CommandMetadata,
) -> Result<IdempotencyDecision, KernelError> {
    let Some(existing) = existing else {
        return Ok(IdempotencyDecision::Execute);
    };
    if existing.tenant != tenant
        || existing.action != action
        || existing.idempotency_key != metadata.idempotency_key
    {
        return Err(KernelError::conflict("idempotency receipt key collision"));
    }
    if existing.fingerprint != metadata.fingerprint {
        return Err(KernelError::conflict(
            "idempotency key reused with a different payload",
        ));
    }
    Ok(IdempotencyDecision::Replay(existing.response.clone()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvaluationAuditIntent {
    pub action: &'static str,
    pub actor: UserId,
    pub trace: TraceContext,
    pub target_id: String,
}
#[derive(Debug, Clone, PartialEq)]
pub struct EvaluationCommit {
    pub cycle: EvaluationCycle,
    pub subjects: Vec<EvaluationSubject>,
    pub audit: EvaluationAuditIntent,
    pub receipt: ActionReceipt,
}

/// A transaction owns all persistence side effects. `commit` is one operation:
/// adapters must atomically persist aggregate, RV allocation, audit, and receipt or roll back all of them.
pub trait EvaluationUnitOfWork {
    fn receipt(&mut self, action: &str, key: &str) -> Result<Option<ActionReceipt>, KernelError>;
    fn load_cycle_for_update(
        &mut self,
        cycle_id: EvaluationCycleId,
    ) -> Result<(EvaluationCycle, Vec<EvaluationSubject>), KernelError>;
    fn reserve_rv_codes(&mut self, count: usize) -> Result<Vec<String>, KernelError>;
    fn commit(&mut self, commit: EvaluationCommit) -> Result<(), KernelError>;
}
/// Implementations must begin/commit/rollback the closure as one physical transaction.
pub trait EvaluationRepository {
    type Transaction: EvaluationUnitOfWork;
    fn transaction<T>(
        &mut self,
        operation: impl FnOnce(&mut Self::Transaction) -> Result<T, KernelError>,
    ) -> Result<T, KernelError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CycleActionResult {
    pub cycle_id: EvaluationCycleId,
    pub state: EvaluationCycleState,
    pub version: u64,
    pub changed_subject_ids: Vec<EvaluationSubjectId>,
}

pub fn open_cycle<R: EvaluationRepository>(
    repository: &mut R,
    context: &EvaluationActorContext,
    command: OpenCycleCommand,
    at: Timestamp,
) -> Result<CycleActionResult, KernelError> {
    require_manage(context, &command.metadata)?;
    execute_cycle_action(
        repository,
        context,
        "evaluation.cycle.open",
        command.cycle_id,
        &command.metadata,
        at,
        |cycle, subjects| {
            cycle.open(command.metadata.expected_version, subjects, at)?;
            Ok(Vec::new())
        },
    )
}
pub fn start_calibration<R: EvaluationRepository>(
    repository: &mut R,
    context: &EvaluationActorContext,
    command: StartCalibrationCommand,
    at: Timestamp,
) -> Result<CycleActionResult, KernelError> {
    require_manage(context, &command.metadata)?;
    execute_cycle_action(
        repository,
        context,
        "evaluation.cycle.start_calibration",
        command.cycle_id,
        &command.metadata,
        at,
        |cycle, subjects| {
            cycle.start_calibration(command.metadata.expected_version, subjects, at)?;
            Ok(Vec::new())
        },
    )
}
pub fn edit_review_draft<R: EvaluationRepository>(
    repository: &mut R,
    context: &EvaluationActorContext,
    command: EditReviewDraftCommand,
    at: Timestamp,
) -> Result<CycleActionResult, KernelError> {
    require_submitter(context, &command.metadata)?;
    execute_cycle_action(
        repository,
        context,
        "evaluation.review.edit_draft",
        command.cycle_id,
        &command.metadata,
        at,
        |cycle, subjects| {
            if cycle.state != EvaluationCycleState::Open {
                return Err(KernelError::conflict(
                    "review drafts are only mutable while cycle is open",
                ));
            }
            let subject = selected_subject(subjects, command.subject_id)?;
            require_selected_evaluator(context.user_id, subject, command.kind)?;
            subject.edit_review(
                command.kind,
                command.metadata.expected_version,
                command.grade,
                command.rationale.clone(),
                command.evidence_links.clone(),
            )?;
            Ok(vec![subject.id()])
        },
    )
}
pub fn submit_review<R: EvaluationRepository>(
    repository: &mut R,
    context: &EvaluationActorContext,
    command: SubmitReviewCommand,
    at: Timestamp,
) -> Result<CycleActionResult, KernelError> {
    require_submitter(context, &command.metadata)?;
    execute_cycle_action(
        repository,
        context,
        "evaluation.review.submit",
        command.cycle_id,
        &command.metadata,
        at,
        |cycle, subjects| {
            if cycle.state != EvaluationCycleState::Open {
                return Err(KernelError::conflict(
                    "review drafts are only mutable while cycle is open",
                ));
            }
            let subject = selected_subject(subjects, command.subject_id)?;
            require_selected_evaluator(context.user_id, subject, command.kind)?;
            subject.submit_review(command.kind, command.metadata.expected_version, at)?;
            Ok(vec![subject.id()])
        },
    )
}
pub fn calibrate_subject<R: EvaluationRepository>(
    repository: &mut R,
    context: &EvaluationActorContext,
    command: CalibrateSubjectCommand,
    at: Timestamp,
) -> Result<CycleActionResult, KernelError> {
    command.metadata.validate(context)?;
    if !context.may_calibrate {
        return Err(KernelError::forbidden(
            "evaluation calibration permission required",
        ));
    }
    execute_cycle_action(
        repository,
        context,
        "evaluation.subject.calibrate",
        command.cycle_id,
        &command.metadata,
        at,
        |cycle, subjects| {
            if cycle.state != EvaluationCycleState::Calibration {
                return Err(KernelError::conflict(
                    "calibration is only available during calibration",
                ));
            }
            let subject = selected_subject(subjects, command.subject_id)?;
            // Calibration OCC is deliberately the subject aggregate, not the cycle.
            subject.calibrate(
                command.metadata.expected_version,
                context.user_id,
                command.grade,
                command.rationale.clone(),
                at,
            )?;
            Ok(vec![subject.id()])
        },
    )
}
pub fn finalize_cycle<R: EvaluationRepository>(
    repository: &mut R,
    context: &EvaluationActorContext,
    command: FinalizeCycleCommand,
    at: Timestamp,
) -> Result<CycleActionResult, KernelError> {
    require_manage(context, &command.metadata)?;
    let action = "evaluation.cycle.finalize";
    repository.transaction(|transaction| {
        if let IdempotencyDecision::Replay(value) =
            receipt_decision(transaction, context, action, &command.metadata)?
        {
            return decode_result(value);
        }
        let (mut cycle, mut subjects) = transaction.load_cycle_for_update(command.cycle_id)?;
        cycle.finalize(
            command.metadata.expected_version,
            &subjects,
            context.user_id,
            at,
        )?;
        let codes = transaction.reserve_rv_codes(subjects.len())?;
        if codes.len() != subjects.len() {
            return Err(KernelError::internal(
                "RV allocator returned an incomplete reservation",
            ));
        }
        for (subject, code) in subjects.iter_mut().zip(codes) {
            subject.finalize(code, at)?;
        }
        let changed_subject_ids = subjects.iter().map(EvaluationSubject::id).collect();
        commit_result(
            transaction,
            context,
            action,
            &command.metadata,
            at,
            cycle,
            subjects,
            changed_subject_ids,
            context.user_id,
        )
    })
}

fn execute_cycle_action<R: EvaluationRepository>(
    repository: &mut R,
    context: &EvaluationActorContext,
    action: &'static str,
    cycle_id: EvaluationCycleId,
    metadata: &CommandMetadata,
    at: Timestamp,
    mutate: impl FnOnce(
        &mut EvaluationCycle,
        &mut [EvaluationSubject],
    ) -> Result<Vec<EvaluationSubjectId>, KernelError>,
) -> Result<CycleActionResult, KernelError> {
    repository.transaction(|transaction| {
        if let IdempotencyDecision::Replay(value) =
            receipt_decision(transaction, context, action, metadata)?
        {
            return decode_result(value);
        }
        let (mut cycle, mut subjects) = transaction.load_cycle_for_update(cycle_id)?;
        let changed = mutate(&mut cycle, &mut subjects)?;
        commit_result(
            transaction,
            context,
            action,
            metadata,
            at,
            cycle,
            subjects,
            changed,
            context.user_id,
        )
    })
}
fn receipt_decision<T: EvaluationUnitOfWork>(
    transaction: &mut T,
    context: &EvaluationActorContext,
    action: &str,
    metadata: &CommandMetadata,
) -> Result<IdempotencyDecision, KernelError> {
    let existing = transaction.receipt(action, &metadata.idempotency_key)?;
    decide_idempotency(existing.as_ref(), context.org_id, action, metadata)
}
fn commit_result<T: EvaluationUnitOfWork>(
    transaction: &mut T,
    context: &EvaluationActorContext,
    action: &'static str,
    metadata: &CommandMetadata,
    at: Timestamp,
    cycle: EvaluationCycle,
    subjects: Vec<EvaluationSubject>,
    changed_subject_ids: Vec<EvaluationSubjectId>,
    actor: UserId,
) -> Result<CycleActionResult, KernelError> {
    let result = CycleActionResult {
        cycle_id: cycle.id,
        state: cycle.state,
        version: cycle.version,
        changed_subject_ids,
    };
    let response = serde_json::to_value(&result).map_err(|error| {
        KernelError::internal(format!("cannot serialize cycle result: {error}"))
    })?;
    transaction.commit(EvaluationCommit {
        audit: EvaluationAuditIntent {
            action,
            actor,
            trace: metadata.trace.clone(),
            target_id: cycle.id.to_string(),
        },
        receipt: ActionReceipt {
            tenant: context.org_id,
            action: action.to_owned(),
            idempotency_key: metadata.idempotency_key.clone(),
            fingerprint: metadata.fingerprint.clone(),
            response,
            occurred_at: at,
        },
        cycle,
        subjects,
    })?;
    Ok(result)
}
fn decode_result(value: Value) -> Result<CycleActionResult, KernelError> {
    serde_json::from_value(value).map_err(|error| {
        KernelError::internal(format!("stored evaluation receipt is invalid: {error}"))
    })
}
fn selected_subject(
    subjects: &mut [EvaluationSubject],
    id: EvaluationSubjectId,
) -> Result<&mut EvaluationSubject, KernelError> {
    subjects
        .iter_mut()
        .find(|subject| subject.id() == id)
        .ok_or_else(|| KernelError::not_found("evaluation subject not found"))
}
fn require_selected_evaluator(
    actor: UserId,
    subject: &EvaluationSubject,
    kind: ReviewKind,
) -> Result<(), KernelError> {
    if subject.review_evaluator(kind) == actor {
        Ok(())
    } else {
        Err(KernelError::forbidden(
            "review action requires the selected review evaluator",
        ))
    }
}
fn require_manage(
    context: &EvaluationActorContext,
    metadata: &CommandMetadata,
) -> Result<(), KernelError> {
    metadata.validate(context)?;
    if context.may_manage {
        Ok(())
    } else {
        Err(KernelError::forbidden(
            "evaluation management permission required",
        ))
    }
}
fn require_submitter(
    context: &EvaluationActorContext,
    metadata: &CommandMetadata,
) -> Result<(), KernelError> {
    metadata.validate(context)?;
    if context.may_submit {
        Ok(())
    } else {
        Err(KernelError::forbidden(
            "evaluation submission permission required",
        ))
    }
}

/// Query adapters must use this gate before building a response; unrelated actors get no projection.
pub fn may_read_subject(
    context: &EvaluationActorContext,
    subject: &EvaluationSubject,
    cycle_state: EvaluationCycleState,
) -> SubjectVisibility {
    subject.visibility(context.user_id, context.may_calibrate, cycle_state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mnt_evaluation_domain::{
        EmployeeId, EvaluationGoal, EvaluationRubricId, GoalMetricKind, SubjectSnapshot,
    };
    use std::collections::BTreeMap;
    use time::macros::date;
    use uuid::Uuid;
    #[derive(Debug, Clone, Copy)]
    enum Failure {
        None,
        Audit,
        Receipt,
        Rv,
    }
    #[derive(Clone)]
    struct State {
        cycle: EvaluationCycle,
        subjects: Vec<EvaluationSubject>,
        receipts: BTreeMap<(String, String), ActionReceipt>,
        audits: usize,
        next_rv: u32,
    }
    struct MemoryRepository {
        state: State,
        failure: Failure,
    }
    struct MemoryTransaction {
        state: State,
        failure: Failure,
    }
    impl EvaluationRepository for MemoryRepository {
        type Transaction = MemoryTransaction;
        fn transaction<T>(
            &mut self,
            operation: impl FnOnce(&mut Self::Transaction) -> Result<T, KernelError>,
        ) -> Result<T, KernelError> {
            let mut transaction = MemoryTransaction {
                state: self.state.clone(),
                failure: self.failure,
            };
            let output = operation(&mut transaction)?;
            self.state = transaction.state;
            Ok(output)
        }
    }
    impl EvaluationUnitOfWork for MemoryTransaction {
        fn receipt(
            &mut self,
            action: &str,
            key: &str,
        ) -> Result<Option<ActionReceipt>, KernelError> {
            Ok(self
                .state
                .receipts
                .get(&(action.to_owned(), key.to_owned()))
                .cloned())
        }
        fn load_cycle_for_update(
            &mut self,
            id: EvaluationCycleId,
        ) -> Result<(EvaluationCycle, Vec<EvaluationSubject>), KernelError> {
            if id == self.state.cycle.id {
                Ok((self.state.cycle.clone(), self.state.subjects.clone()))
            } else {
                Err(KernelError::not_found("cycle"))
            }
        }
        fn reserve_rv_codes(&mut self, count: usize) -> Result<Vec<String>, KernelError> {
            if matches!(self.failure, Failure::Rv) {
                return Err(KernelError::internal("RV failure"));
            }
            let start = self.state.next_rv;
            self.state.next_rv += count as u32;
            Ok((start..start + count as u32)
                .map(|value| format!("RV-{value:04}"))
                .collect())
        }
        fn commit(&mut self, commit: EvaluationCommit) -> Result<(), KernelError> {
            if matches!(self.failure, Failure::Audit) {
                return Err(KernelError::internal("audit failure"));
            }
            if matches!(self.failure, Failure::Receipt) {
                return Err(KernelError::internal("receipt failure"));
            }
            self.state.cycle = commit.cycle;
            self.state.subjects = commit.subjects;
            self.state.audits += 1;
            self.state.receipts.insert(
                (
                    commit.receipt.action.clone(),
                    commit.receipt.idempotency_key.clone(),
                ),
                commit.receipt,
            );
            Ok(())
        }
    }
    fn context() -> EvaluationActorContext {
        EvaluationActorContext {
            org_id: OrgId::knl(),
            user_id: UserId::new(),
            may_manage: true,
            may_submit: true,
            may_calibrate: true,
        }
    }
    fn metadata(actor: UserId, expected_version: u64, fingerprint: &str) -> CommandMetadata {
        CommandMetadata {
            actor,
            trace: TraceContext::generate(),
            expected_version,
            idempotency_key: "evaluation-command-0001".to_owned(),
            fingerprint: fingerprint.to_owned(),
        }
    }
    fn subject(self_user: UserId) -> EvaluationSubject {
        let mut subject = EvaluationSubject::new(
            SubjectSnapshot {
                employee_id: EmployeeId::new(),
                manager_user_id: UserId::new(),
                home_branch_id: Uuid::new_v4(),
                org_unit_id: None,
                position_id: None,
                team_id: None,
            },
            self_user,
        )
        .unwrap();
        subject
            .replace_goals(
                0,
                vec![EvaluationGoal::new(GoalMetricKind::Kpi, "outcome", 100, 0).unwrap()],
            )
            .unwrap();
        subject
    }
    fn repository(
        state: EvaluationCycleState,
        failure: Failure,
        actor: UserId,
    ) -> MemoryRepository {
        let mut subject = subject(actor);
        let mut cycle = EvaluationCycle::draft(
            "cycle",
            date!(2026 - 01 - 01),
            date!(2026 - 12 - 31),
            EvaluationRubricId::new(),
        )
        .unwrap();
        if state != EvaluationCycleState::Draft {
            cycle
                .open(0, std::slice::from_mut(&mut subject), Timestamp::now_utc())
                .unwrap();
        }
        MemoryRepository {
            state: State {
                cycle,
                subjects: vec![subject],
                receipts: BTreeMap::new(),
                audits: 0,
                next_rv: 2500,
            },
            failure,
        }
    }
    #[test]
    fn exact_replay_and_changed_fingerprint_conflict() {
        let context = context();
        let now = Timestamp::now_utc();
        let mut repository =
            repository(EvaluationCycleState::Draft, Failure::None, context.user_id);
        let command = OpenCycleCommand {
            cycle_id: repository.state.cycle.id,
            metadata: metadata(context.user_id, 0, "same"),
        };
        let first = open_cycle(&mut repository, &context, command.clone(), now).unwrap();
        let replay = open_cycle(&mut repository, &context, command, now).unwrap();
        assert_eq!(first, replay);
        assert_eq!(repository.state.audits, 1);
        let changed = OpenCycleCommand {
            cycle_id: repository.state.cycle.id,
            metadata: metadata(context.user_id, 0, "changed"),
        };
        assert!(open_cycle(&mut repository, &context, changed, now).is_err());
    }
    #[test]
    fn commit_failure_rolls_back_cycle_audit_and_receipt() {
        let context = context();
        let now = Timestamp::now_utc();
        for failure in [Failure::Audit, Failure::Receipt] {
            let mut repository = repository(EvaluationCycleState::Draft, failure, context.user_id);
            let id = repository.state.cycle.id;
            let result = open_cycle(
                &mut repository,
                &context,
                OpenCycleCommand {
                    cycle_id: id,
                    metadata: metadata(context.user_id, 0, "same"),
                },
                now,
            );
            assert!(result.is_err());
            assert_eq!(repository.state.cycle.state, EvaluationCycleState::Draft);
            assert_eq!(repository.state.audits, 0);
            assert!(repository.state.receipts.is_empty());
        }
    }
    #[test]
    fn calibration_is_subject_occ_and_actor_bound() {
        let mut context = context();
        context.user_id = UserId::new();
        let now = Timestamp::now_utc();
        let mut repository = repository(EvaluationCycleState::Open, Failure::None, UserId::new());
        let (subject_id, stale, manager) = {
            let subject = &mut repository.state.subjects[0];
            subject
                .edit_review(ReviewKind::SelfReview, 0, RubricLevel::A, "self", vec![])
                .unwrap();
            subject
                .submit_review(ReviewKind::SelfReview, 1, now)
                .unwrap();
            let manager = subject.review_evaluator(ReviewKind::Manager);
            subject
                .edit_review(ReviewKind::Manager, 0, RubricLevel::A, "manager", vec![])
                .unwrap();
            subject.submit_review(ReviewKind::Manager, 1, now).unwrap();
            (subject.id(), subject.version() - 1, manager)
        };
        repository
            .state
            .cycle
            .start_calibration(1, &repository.state.subjects, now)
            .unwrap();
        let command = CalibrateSubjectCommand {
            cycle_id: repository.state.cycle.id,
            subject_id,
            grade: RubricLevel::A,
            rationale: "calibration".to_owned(),
            metadata: metadata(context.user_id, stale, "calibrate-000001"),
        };
        assert!(calibrate_subject(&mut repository, &context, command, now).is_err());
        let current = repository.state.subjects[0].version();
        let command = CalibrateSubjectCommand {
            cycle_id: repository.state.cycle.id,
            subject_id,
            grade: RubricLevel::A,
            rationale: "calibration".to_owned(),
            metadata: metadata(context.user_id, current, "calibrate-000002"),
        };
        calibrate_subject(&mut repository, &context, command, now).unwrap();
        assert_eq!(repository.state.subjects[0].version(), current + 1);
        // A second writer using the same pre-commit subject version loses OCC,
        // even though it uses a distinct idempotency key.
        let concurrent_loser = CalibrateSubjectCommand {
            cycle_id: repository.state.cycle.id,
            subject_id,
            grade: RubricLevel::A,
            rationale: "late calibration".to_owned(),
            metadata: metadata(context.user_id, current, "calibrate-000003"),
        };
        assert!(calibrate_subject(&mut repository, &context, concurrent_loser, now).is_err());
        assert_ne!(manager, context.user_id);
    }
    #[test]
    fn review_commands_require_the_selected_evaluator_and_submission_permission() {
        let context = context();
        let now = Timestamp::now_utc();
        let mut repository = repository(EvaluationCycleState::Open, Failure::None, UserId::new());
        let subject_id = repository.state.subjects[0].id();
        let denied = EditReviewDraftCommand {
            cycle_id: repository.state.cycle.id,
            subject_id,
            kind: ReviewKind::SelfReview,
            grade: RubricLevel::A,
            rationale: "evidence".to_owned(),
            evidence_links: vec![],
            metadata: metadata(context.user_id, 0, "edit-review-00001"),
        };
        assert!(edit_review_draft(&mut repository, &context, denied, now).is_err());
        let self_user = repository.state.subjects[0].review_evaluator(ReviewKind::SelfReview);
        let allowed_context = EvaluationActorContext {
            user_id: self_user,
            ..context
        };
        let edit = EditReviewDraftCommand {
            cycle_id: repository.state.cycle.id,
            subject_id,
            kind: ReviewKind::SelfReview,
            grade: RubricLevel::A,
            rationale: "evidence".to_owned(),
            evidence_links: vec![],
            metadata: metadata(self_user, 0, "edit-review-00002"),
        };
        edit_review_draft(&mut repository, &allowed_context, edit, now).unwrap();
        let submit = SubmitReviewCommand {
            cycle_id: repository.state.cycle.id,
            subject_id,
            kind: ReviewKind::SelfReview,
            metadata: metadata(self_user, 1, "submit-review-001"),
        };
        submit_review(&mut repository, &allowed_context, submit, now).unwrap();
        let retry_edit = EditReviewDraftCommand {
            cycle_id: repository.state.cycle.id,
            subject_id,
            kind: ReviewKind::SelfReview,
            grade: RubricLevel::S,
            rationale: "rewrite".to_owned(),
            evidence_links: vec![],
            metadata: metadata(self_user, 2, "edit-review-00003"),
        };
        assert!(edit_review_draft(&mut repository, &allowed_context, retry_edit, now).is_err());
        let no_submit = EvaluationActorContext {
            may_submit: false,
            ..allowed_context
        };
        let command = SubmitReviewCommand {
            cycle_id: repository.state.cycle.id,
            subject_id,
            kind: ReviewKind::SelfReview,
            metadata: metadata(self_user, 2, "submit-review-002"),
        };
        assert!(submit_review(&mut repository, &no_submit, command, now).is_err());
    }
    #[test]
    fn rv_reservation_failure_rolls_back_the_finalization_unit_of_work() {
        let mut context = context();
        context.user_id = UserId::new();
        let now = Timestamp::now_utc();
        let mut repository = repository(EvaluationCycleState::Open, Failure::Rv, UserId::new());
        {
            let subject = &mut repository.state.subjects[0];
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
        }
        repository
            .state
            .cycle
            .start_calibration(1, &repository.state.subjects, now)
            .unwrap();
        let subject = &mut repository.state.subjects[0];
        subject
            .calibrate(
                subject.version(),
                context.user_id,
                RubricLevel::A,
                "cross-check",
                now,
            )
            .unwrap();
        let cycle_version = repository.state.cycle.version;
        let before_rv = repository.state.next_rv;
        let command = FinalizeCycleCommand {
            cycle_id: repository.state.cycle.id,
            metadata: metadata(context.user_id, cycle_version, "finalize-rv-0001"),
        };
        assert!(finalize_cycle(&mut repository, &context, command, now).is_err());
        assert_eq!(
            repository.state.cycle.state,
            EvaluationCycleState::Calibration
        );
        assert_eq!(repository.state.next_rv, before_rv);
        assert_eq!(repository.state.audits, 0);
        assert!(repository.state.receipts.is_empty());
    }
}
