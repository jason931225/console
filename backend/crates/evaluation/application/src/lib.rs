//! Evaluation application commands, receipts, and inward-facing ports.
//!
//! Concrete REST and Postgres adapters remain outside this crate. The adapter
//! derives `EvaluationActorContext` from the authenticated session and RLS-armed
//! tenant; commands never carry a caller-supplied organization id.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_evaluation_domain::{
    EvaluationCycle, EvaluationCycleId, EvaluationCycleState, EvaluationSubject,
    EvaluationSubjectId, RubricLevel, SubjectVisibility,
};
use mnt_kernel_core::{KernelError, OrgId, Timestamp, TraceContext, UserId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Authenticated, server-derived evaluation authority. `org_id` is never decoded from a command body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvaluationActorContext {
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
        if self.idempotency_key.trim().len() < 16 || self.idempotency_key.len() > 200 {
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
pub struct CalibrateSubjectCommand {
    pub cycle_id: EvaluationCycleId,
    pub subject_id: EvaluationSubjectId,
    pub grade: RubricLevel,
    pub rationale: String,
    pub metadata: CommandMetadata,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalizeCycleCommand {
    pub cycle_id: EvaluationCycleId,
    pub metadata: CommandMetadata,
}

/// Stored exact response for a tenant/action/key/fingerprint. Persistence must enforce the same tuple.
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

/// Pure receipt semantics used by the durable adapter inside its transaction.
pub fn decide_idempotency(
    existing: Option<&ActionReceipt>,
    org_id: OrgId,
    action: &str,
    metadata: &CommandMetadata,
) -> Result<IdempotencyDecision, KernelError> {
    let Some(existing) = existing else {
        return Ok(IdempotencyDecision::Execute);
    };
    if existing.tenant != org_id
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

/// Persistence port. Implementations must lock the cycle, subjects, and receipts in one transaction.
pub trait EvaluationRepository {
    /// Loads the authoritative tenant-scoped aggregate under a write lock.
    fn load_cycle_for_update(
        &mut self,
        cycle_id: EvaluationCycleId,
    ) -> Result<(EvaluationCycle, Vec<EvaluationSubject>), KernelError>;
    /// Persists one atomic aggregate state plus audit records and RV reservations.
    fn save_cycle_transition(
        &mut self,
        cycle: &EvaluationCycle,
        subjects: &[EvaluationSubject],
        audit: EvaluationAuditIntent,
    ) -> Result<(), KernelError>;
    /// Looks up a receipt under a tenant/action/key unique lock.
    fn receipt(
        &mut self,
        action: &str,
        idempotency_key: &str,
    ) -> Result<Option<ActionReceipt>, KernelError>;
    /// Saves the exact response in the same transaction as the aggregate mutation.
    fn save_receipt(&mut self, receipt: ActionReceipt) -> Result<(), KernelError>;
    /// Allocates unique RV codes only after all finalization validation passes.
    fn reserve_rv_codes(&mut self, count: usize) -> Result<Vec<String>, KernelError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvaluationAuditIntent {
    pub action: &'static str,
    pub actor: UserId,
    pub trace: TraceContext,
    pub target_id: String,
}

/// Output that an adapter serializes as the future REST response and stores verbatim for replay.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    occurred_at: Timestamp,
) -> Result<CycleActionResult, KernelError> {
    require_manage(context, &command.metadata)?;
    execute_cycle_action(
        repository,
        context,
        "evaluation.cycle.open",
        command.cycle_id,
        &command.metadata,
        occurred_at,
        |cycle, subjects| {
            cycle.open(command.metadata.expected_version, subjects, occurred_at)?;
            Ok(Vec::new())
        },
    )
}
pub fn start_calibration<R: EvaluationRepository>(
    repository: &mut R,
    context: &EvaluationActorContext,
    command: StartCalibrationCommand,
    occurred_at: Timestamp,
) -> Result<CycleActionResult, KernelError> {
    require_manage(context, &command.metadata)?;
    execute_cycle_action(
        repository,
        context,
        "evaluation.cycle.start_calibration",
        command.cycle_id,
        &command.metadata,
        occurred_at,
        |cycle, subjects| {
            cycle.start_calibration(command.metadata.expected_version, subjects, occurred_at)?;
            Ok(Vec::new())
        },
    )
}
pub fn calibrate_subject<R: EvaluationRepository>(
    repository: &mut R,
    context: &EvaluationActorContext,
    command: CalibrateSubjectCommand,
    occurred_at: Timestamp,
) -> Result<CycleActionResult, KernelError> {
    if !context.may_calibrate {
        return Err(KernelError::forbidden(
            "evaluation calibration permission required",
        ));
    }
    command.metadata.validate(context)?;
    execute_cycle_action(
        repository,
        context,
        "evaluation.subject.calibrate",
        command.cycle_id,
        &command.metadata,
        occurred_at,
        |cycle, subjects| {
            if cycle.state != EvaluationCycleState::Calibration {
                return Err(KernelError::conflict(
                    "calibration is only available during calibration",
                ));
            }
            let Some(subject) = subjects
                .iter_mut()
                .find(|subject| subject.id == command.subject_id)
            else {
                return Err(KernelError::not_found("evaluation subject not found"));
            };
            subject.calibrate(
                context.user_id,
                command.grade,
                command.rationale.clone(),
                occurred_at,
            )?;
            Ok(vec![subject.id])
        },
    )
}
pub fn finalize_cycle<R: EvaluationRepository>(
    repository: &mut R,
    context: &EvaluationActorContext,
    command: FinalizeCycleCommand,
    occurred_at: Timestamp,
) -> Result<CycleActionResult, KernelError> {
    require_manage(context, &command.metadata)?;
    command.metadata.validate(context)?;
    let action = "evaluation.cycle.finalize";
    match decide_idempotency(
        repository
            .receipt(action, &command.metadata.idempotency_key)?
            .as_ref(),
        context.org_id,
        action,
        &command.metadata,
    )? {
        IdempotencyDecision::Replay(value) => {
            return serde_json::from_value(value).map_err(|error| {
                KernelError::internal(format!("stored evaluation receipt is invalid: {error}"))
            })
        }
        IdempotencyDecision::Execute => {}
    }
    let (mut cycle, mut subjects) = repository.load_cycle_for_update(command.cycle_id)?;
    // Validate every subject and reserve all codes before mutating any subject: an error cannot partially issue codes.
    cycle.finalize(
        command.metadata.expected_version,
        &subjects,
        context.user_id,
        occurred_at,
    )?;
    let codes = repository.reserve_rv_codes(subjects.len())?;
    if codes.len() != subjects.len() {
        return Err(KernelError::internal(
            "RV allocator returned an incomplete reservation",
        ));
    }
    for (subject, code) in subjects.iter_mut().zip(codes) {
        subject.finalize(code, occurred_at)?;
    }
    let result = CycleActionResult {
        cycle_id: cycle.id,
        state: cycle.state,
        version: cycle.version,
        changed_subject_ids: subjects.iter().map(|subject| subject.id).collect(),
    };
    repository.save_cycle_transition(
        &cycle,
        &subjects,
        EvaluationAuditIntent {
            action,
            actor: context.user_id,
            trace: command.metadata.trace.clone(),
            target_id: cycle.id.to_string(),
        },
    )?;
    repository.save_receipt(ActionReceipt {
        tenant: context.org_id,
        action: action.to_owned(),
        idempotency_key: command.metadata.idempotency_key,
        fingerprint: command.metadata.fingerprint,
        response: serde_json::to_value(&result).map_err(|error| {
            KernelError::internal(format!("cannot serialize cycle result: {error}"))
        })?,
        occurred_at,
    })?;
    Ok(result)
}

fn execute_cycle_action<R: EvaluationRepository>(
    repository: &mut R,
    context: &EvaluationActorContext,
    action: &'static str,
    cycle_id: EvaluationCycleId,
    metadata: &CommandMetadata,
    occurred_at: Timestamp,
    mutate: impl FnOnce(
        &mut EvaluationCycle,
        &mut [EvaluationSubject],
    ) -> Result<Vec<EvaluationSubjectId>, KernelError>,
) -> Result<CycleActionResult, KernelError> {
    match decide_idempotency(
        repository
            .receipt(action, &metadata.idempotency_key)?
            .as_ref(),
        context.org_id,
        action,
        metadata,
    )? {
        IdempotencyDecision::Replay(value) => {
            return serde_json::from_value(value).map_err(|error| {
                KernelError::internal(format!("stored evaluation receipt is invalid: {error}"))
            })
        }
        IdempotencyDecision::Execute => {}
    }
    let (mut cycle, mut subjects) = repository.load_cycle_for_update(cycle_id)?;
    let changed_subject_ids = mutate(&mut cycle, &mut subjects)?;
    let result = CycleActionResult {
        cycle_id: cycle.id,
        state: cycle.state,
        version: cycle.version,
        changed_subject_ids,
    };
    repository.save_cycle_transition(
        &cycle,
        &subjects,
        EvaluationAuditIntent {
            action,
            actor: context.user_id,
            trace: metadata.trace.clone(),
            target_id: cycle.id.to_string(),
        },
    )?;
    repository.save_receipt(ActionReceipt {
        tenant: context.org_id,
        action: action.to_owned(),
        idempotency_key: metadata.idempotency_key.clone(),
        fingerprint: metadata.fingerprint.clone(),
        response: serde_json::to_value(&result).map_err(|error| {
            KernelError::internal(format!("cannot serialize cycle result: {error}"))
        })?,
        occurred_at,
    })?;
    Ok(result)
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

/// Projection gate used by future query/REST adapters. It exposes no aggregate data to unrelated actors.
pub fn may_read_subject(
    context: &EvaluationActorContext,
    subject: &EvaluationSubject,
    cycle_state: EvaluationCycleState,
) -> SubjectVisibility {
    subject.visibility(context.user_id, context.may_calibrate, cycle_state)
}

/// In-memory receipt registry exists only to unit-test idempotency semantics; it is not a production repository.
#[derive(Default)]
pub struct ReceiptFixture {
    values: BTreeMap<(OrgId, String, String), ActionReceipt>,
}
impl ReceiptFixture {
    pub fn insert(&mut self, receipt: ActionReceipt) {
        self.values.insert(
            (
                receipt.tenant,
                receipt.action.clone(),
                receipt.idempotency_key.clone(),
            ),
            receipt,
        );
    }
    pub fn get(&self, tenant: OrgId, action: &str, key: &str) -> Option<&ActionReceipt> {
        self.values
            .get(&(tenant, action.to_owned(), key.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mnt_evaluation_domain::{
        EmployeeId, EvaluationGoal, EvaluationRubricId, GoalMetricKind, SubjectSnapshot,
    };
    use time::macros::date;
    use uuid::Uuid;
    fn context() -> EvaluationActorContext {
        EvaluationActorContext {
            org_id: OrgId::knl(),
            user_id: UserId::new(),
            may_manage: true,
            may_submit: true,
            may_calibrate: true,
        }
    }
    fn metadata(actor: UserId, fingerprint: &str) -> CommandMetadata {
        CommandMetadata {
            actor,
            trace: TraceContext::generate(),
            expected_version: 0,
            idempotency_key: "evaluation-command-0001".to_owned(),
            fingerprint: fingerprint.to_owned(),
        }
    }
    #[test]
    fn exact_idempotency_replays_but_changed_payload_conflicts() {
        let now = Timestamp::now_utc();
        let context = context();
        let metadata = metadata(context.user_id, "same");
        let receipt = ActionReceipt {
            tenant: context.org_id,
            action: "evaluation.cycle.open".to_owned(),
            idempotency_key: metadata.idempotency_key.clone(),
            fingerprint: metadata.fingerprint.clone(),
            response: serde_json::json!({"ok":true}),
            occurred_at: now,
        };
        assert_eq!(
            decide_idempotency(
                Some(&receipt),
                context.org_id,
                "evaluation.cycle.open",
                &metadata
            )
            .unwrap(),
            IdempotencyDecision::Replay(serde_json::json!({"ok":true}))
        );
        let changed = metadata(context.user_id, "changed");
        assert!(decide_idempotency(
            Some(&receipt),
            context.org_id,
            "evaluation.cycle.open",
            &changed
        )
        .is_err());
    }
    #[test]
    fn actor_and_role_are_server_bound() {
        let context = context();
        let mut metadata = metadata(UserId::new(), "same");
        assert!(require_manage(&context, &metadata).is_err());
        metadata.actor = context.user_id;
        let denied = EvaluationActorContext {
            may_manage: false,
            ..context
        };
        assert!(require_manage(&denied, &metadata).is_err());
    }
    #[test]
    fn unrelated_projection_is_opaque() {
        let self_user = UserId::new();
        let subject = EvaluationSubject::new(
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
        let unrelated = EvaluationActorContext {
            user_id: UserId::new(),
            ..context()
        };
        assert_eq!(
            may_read_subject(&unrelated, &subject, EvaluationCycleState::Open),
            SubjectVisibility::Unrelated
        );
        let _ = (
            EvaluationCycle::draft(
                "cycle",
                date!(2026 - 01 - 01),
                date!(2026 - 12 - 31),
                EvaluationRubricId::new(),
            )
            .unwrap(),
            EvaluationGoal::new(GoalMetricKind::Kpi, "metric", 100, 0).unwrap(),
        );
    }
}
