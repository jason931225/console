//! Append-only erasure ledger: a durable record of what personal data was
//! DELETED FROM THE LIVE CLUSTER, at what scope, when, by whom, and under what
//! authority.
//!
//! Deliberate wording, and it is a constraint rather than a style note: a row
//! recorded here was deleted from the live cluster and remains reconstructable
//! from the WAL archive, whose ObjectStore declares no retention policy. Nothing
//! in this crate — doc comment, variant name, error string or test name — may
//! call that destruction without naming the archive (ADR-0037 constraint 3;
//! that record adopts no option and this crate adopts none on its behalf).
//!
//! # What this does NOT solve
//!
//! 1. **Nothing outside PostgreSQL holds a witness yet, so the mechanism is
//!    INERT.** A point-in-time restore rolls the ledger back together with every
//!    in-cluster copy of its high-water mark, and [`classify`] then returns
//!    [`RestoreVerdict::Consistent`] against whatever witness it is handed.
//!    Detection is structurally impossible in that state, not merely unfired.
//!    This crate ships the three pieces — produce a witness ([`head`]), compare
//!    one ([`classify`]), replay after one ([`entries_since`]) — and no holder
//!    and no re-applier.
//! 2. **It detects; it never prevents.** No in-database construct survives a
//!    point-in-time restore of its own cluster.
//! 3. **No signature.** A caller holding `INSERT` can record false facts at
//!    append time. The chain is tamper-evident against a rollback and against
//!    nothing else. Do not call it tamper-proof.
//! 4. **It records only.** It does not erase, authorise or re-apply. No
//!    retention period, no automatic deletion, no data-subject-request workflow.
//!
//! Every Korea control remains HOLD. This crate asserts no Korean legal
//! conclusion; `authority` is free text precisely so that enumerating legal
//! bases does not smuggle one in.

use console_kernel_core::OrgId;
use console_platform_db::DbError;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

/// The fact set a single erasure entry records. Every field is required: an
/// entry that cannot say WHAT was erased is not evidence.
#[derive(Debug, Clone)]
pub struct ErasureFacts {
    /// What kind of subject the erasure was about (`"user"`, `"applicant"`, …).
    pub subject_kind: String,
    /// The subject's identifier. A `Uuid` rather than a string so a low-entropy
    /// natural key cannot be digested here; the stored reference is a digest.
    pub subject_id: Uuid,
    /// The relation rows were deleted from.
    pub erased_relation: String,
    /// The predicate that selected them, precise enough that a later reader can
    /// tell WHAT was erased rather than merely that something was.
    pub erased_selector: String,
    /// How many rows the selector matched.
    pub erased_row_count: i64,
    /// When the erasure took effect.
    pub effective_at: OffsetDateTime,
    /// Who performed it.
    pub actor: String,
    /// The authority it was performed under. Free text by design.
    pub authority: String,
}

/// A high-water mark: the position and content hash of one org's ledger head at
/// the moment it was observed. The thing an external holder would record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LedgerWitness {
    pub org_id: Uuid,
    pub seq: i64,
    pub entry_hash: [u8; 32],
}

/// One recorded entry, as the re-applier reads it back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerEntry {
    pub org_id: Uuid,
    pub seq: i64,
    pub subject_kind: String,
    pub subject_digest: [u8; 32],
    pub erased_relation: String,
    pub erased_selector: String,
    pub erased_row_count: i64,
    pub effective_at: OffsetDateTime,
    pub actor: String,
    pub authority: String,
    pub prev_entry_hash: [u8; 32],
    pub entry_hash: [u8; 32],
}

/// What comparing a held witness against the live ledger says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreVerdict {
    /// The witness is still on the live chain. Normal operation.
    Consistent { head_seq: i64 },
    /// The head is behind the witness: the ledger lost entries it had recorded.
    RolledBack { head_seq: i64, witness_seq: i64 },
    /// The witness's sequence exists but holds different content: the ledger was
    /// rolled back and then written forward again. A sequence-only comparison
    /// reads this as healthy, which is the failure this variant exists to name.
    Forked { witness_seq: i64 },
}

#[derive(Debug, thiserror::Error)]
pub enum ErasureLedgerError {
    #[error("erasure ledger database error: {0}")]
    Db(#[from] DbError),
    #[error("erasure ledger append lost the race for the next sequence")]
    Contention,
}

/// Append one entry to `org`'s ledger, returning the witness it produced.
pub async fn append(
    pool: &PgPool,
    org: OrgId,
    facts: &ErasureFacts,
) -> Result<LedgerWitness, ErasureLedgerError> {
    let _ = (pool, org, facts);
    unimplemented!("erasure ledger append: migration 0207 and this body are the next phase")
}

/// The current head of `org`'s ledger, or `None` if it has never been written.
pub async fn head(pool: &PgPool, org: OrgId) -> Result<Option<LedgerWitness>, ErasureLedgerError> {
    let _ = (pool, org);
    unimplemented!("erasure ledger head: migration 0207 and this body are the next phase")
}

/// Every entry after `after_seq`, in sequence order. The read path a re-applier
/// replays once a restore has been detected.
pub async fn entries_since(
    pool: &PgPool,
    org: OrgId,
    after_seq: i64,
) -> Result<Vec<LedgerEntry>, ErasureLedgerError> {
    let _ = (pool, org, after_seq);
    unimplemented!("erasure ledger entries_since: migration 0207 and this body are the next phase")
}

/// Compare a held witness against the live ledger.
pub async fn classify(
    pool: &PgPool,
    org: OrgId,
    witness: &LedgerWitness,
) -> Result<RestoreVerdict, ErasureLedgerError> {
    let _ = (pool, org, witness);
    unimplemented!("erasure ledger classify: migration 0207 and this body are the next phase")
}
