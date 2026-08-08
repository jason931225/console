//! Effective-dated grants — ADR-0032 §1, §3 and §6.
//!
//! A 발령 (appointment) has a date; a grant row until now did not. The interval
//! goes on the grant and only on the grant, and it is **half-open**:
//! `[valid_from, valid_to)`. `valid_from` is inside, `valid_to` is outside. That
//! is not a stylistic choice — it is what makes "this 발령 ends the instant the
//! next one begins" expressible without the two claiming a shared instant, and
//! it matches the predicate `PgInstanceStore::get_as_of` already ships.
//!
//! §6 is the load-bearing clause here: crossing `valid_from` or `valid_to` is
//! **not a write**, so no `bump_subject_version_tx` fires and no monotone
//! freshness counter can notice it. An interval therefore must never be cited as
//! a reason to skip a per-request evaluation, and expiry is enforced by the read
//! predicate rather than by a status-flipping job. [`GrantValidity::contains`]
//! is consulted at the instant the decision is made
//! ([`crate::authorize_scoped`]) and the result is never carried across it.

use console_kernel_core::{KernelError, Timestamp};

/// A grant's half-open validity interval `[valid_from, valid_to)`.
///
/// `valid_to == None` is an open-ended grant. BOTH ends `None` is
/// [`GrantValidity::always`] — the pre-ADR-0032 shape, a grant whose row carries
/// no interval at all, which is how every grant resolved today looks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct GrantValidity {
    valid_from: Option<Timestamp>,
    valid_to: Option<Timestamp>,
}

impl GrantValidity {
    /// No interval recorded. Effective at every instant, which is exactly what
    /// every grant resolved from today's `user_role_assignments` means.
    #[must_use]
    pub const fn always() -> Self {
        Self {
            valid_from: None,
            valid_to: None,
        }
    }

    /// `[valid_from, valid_to)`. `None` upper bound means open-ended.
    ///
    /// # Errors
    ///
    /// Rejects `valid_to <= valid_from`. `[t, t)` contains no instant and an
    /// inverted pair contains none either, so both describe a grant that can
    /// never be effective — a data-entry error rather than a policy, and one a
    /// half-open reading would otherwise swallow silently.
    pub fn half_open(
        valid_from: Timestamp,
        valid_to: Option<Timestamp>,
    ) -> Result<Self, KernelError> {
        if valid_to.is_some_and(|end| end <= valid_from) {
            return Err(KernelError::validation(
                "grant validity must be a non-empty half-open interval [valid_from, valid_to)",
            ));
        }
        Ok(Self {
            valid_from: Some(valid_from),
            valid_to,
        })
    }

    /// Whether `at` falls inside `[valid_from, valid_to)`.
    #[must_use]
    pub fn contains(self, at: Timestamp) -> bool {
        self.valid_from.is_none_or(|from| from <= at) && self.valid_to.is_none_or(|to| at < to)
    }

    #[must_use]
    pub const fn valid_from(self) -> Option<Timestamp> {
        self.valid_from
    }

    #[must_use]
    pub const fn valid_to(self) -> Option<Timestamp> {
        self.valid_to
    }

    /// Two half-open intervals share at least one instant.
    ///
    /// `[a, b)` and `[b, c)` do NOT overlap; that is the property the whole
    /// half-open reading exists to provide.
    fn overlaps(self, other: Self) -> bool {
        starts_before_end(self.valid_from, other.valid_to)
            && starts_before_end(other.valid_from, self.valid_to)
    }
}

/// An absent bound is unbounded: `None` start is `-∞`, `None` end is `+∞`.
fn starts_before_end(from: Option<Timestamp>, to: Option<Timestamp>) -> bool {
    match (from, to) {
        (Some(from), Some(to)) => from < to,
        _ => true,
    }
}

/// ADR-0032 §1: `user_role_assignments`' `UNIQUE (org_id, user_id, role_id)`
/// becomes a per-`(org_id, user_id, role_id)` NON-OVERLAP constraint.
///
/// The grouping key is the ROLE. Two different roles covering the same instant
/// is the ordinary case — a user holds several — and rejecting that would be an
/// outage, not a guard. Two rows for the SAME role covering the same instant is
/// the ambiguity: at that instant, two records claim to say when this one
/// authority began.
///
/// The database constraint is the real enforcement and it is not written yet
/// (see this crate's lane notes). This is the same predicate at the trust
/// boundary, so the resolver refuses an ambiguous set rather than folding over
/// it, whichever of the two lands first.
///
/// # Errors
///
/// [`console_kernel_core::ErrorKind::Conflict`] naming the offending role when
/// two of its assignment intervals share any instant.
pub fn enforce_assignment_non_overlap(
    assignments: &[(uuid::Uuid, GrantValidity)],
) -> Result<(), KernelError> {
    // ponytail: O(n²) over one user's role assignments — a handful of rows.
    // Sort-by-(role, valid_from) and compare neighbours if that ever stops being
    // a handful.
    for (index, (role_id, validity)) in assignments.iter().enumerate() {
        for (other_role, other_validity) in assignments.iter().skip(index + 1) {
            if role_id == other_role && validity.overlaps(*other_validity) {
                return Err(KernelError::conflict(format!(
                    "role {role_id} has overlapping effective-dated assignments"
                )));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use console_kernel_core::{ErrorKind, Timestamp};

    fn ts(secs: i64) -> Timestamp {
        Timestamp::from_unix_timestamp(secs).unwrap()
    }

    fn role_a() -> uuid::Uuid {
        uuid::Uuid::from_u128(0xa)
    }

    fn role_b() -> uuid::Uuid {
        uuid::Uuid::from_u128(0xb)
    }

    /// THE interval-end test. A test that probes only the middle proves nothing:
    /// the whole risk of a half-open interval is which end is closed.
    #[test]
    fn valid_from_is_inside_the_interval_and_valid_to_is_outside() {
        let validity = GrantValidity::half_open(ts(100), Some(ts(200))).unwrap();

        assert!(!validity.contains(ts(99)), "one second before valid_from");
        assert!(validity.contains(ts(100)), "valid_from itself is INSIDE");
        assert!(validity.contains(ts(199)), "one second before valid_to");
        assert!(!validity.contains(ts(200)), "valid_to itself is OUTSIDE");
        assert!(!validity.contains(ts(201)), "one second after valid_to");
    }

    #[test]
    fn an_open_ended_interval_closes_only_its_lower_end() {
        let validity = GrantValidity::half_open(ts(100), None).unwrap();

        assert!(!validity.contains(ts(99)));
        assert!(validity.contains(ts(100)));
        assert!(validity.contains(ts(4_000_000_000)));
    }

    /// `[t, t)` contains no instant at all, and `[b, a)` with `a < b` is inverted.
    /// A grant that can never be effective is a data-entry error, not a policy.
    #[test]
    fn an_empty_or_inverted_interval_is_rejected() {
        let empty = GrantValidity::half_open(ts(200), Some(ts(200))).unwrap_err();
        assert_eq!(empty.kind, ErrorKind::Validation);

        let inverted = GrantValidity::half_open(ts(200), Some(ts(100))).unwrap_err();
        assert_eq!(inverted.kind, ErrorKind::Validation);
    }

    #[test]
    fn a_grant_with_no_recorded_interval_is_always_effective() {
        let always = GrantValidity::always();

        assert!(always.contains(ts(0)));
        assert!(always.contains(ts(4_000_000_000)));
    }

    /// The half-open payoff: a 발령 that ends the instant the next one begins is
    /// the NORMAL shape, and a closed-interval model would reject it.
    #[test]
    fn touching_half_open_intervals_for_one_role_do_not_overlap() {
        let rows = [
            (
                role_a(),
                GrantValidity::half_open(ts(100), Some(ts(200))).unwrap(),
            ),
            (
                role_a(),
                GrantValidity::half_open(ts(200), Some(ts(300))).unwrap(),
            ),
        ];

        assert!(enforce_assignment_non_overlap(&rows).is_ok());
    }

    /// One second of shared time is an overlap.
    #[test]
    fn intervals_sharing_a_single_instant_for_one_role_are_rejected() {
        let rows = [
            (
                role_a(),
                GrantValidity::half_open(ts(100), Some(ts(201))).unwrap(),
            ),
            (
                role_a(),
                GrantValidity::half_open(ts(200), Some(ts(300))).unwrap(),
            ),
        ];

        let err = enforce_assignment_non_overlap(&rows).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Conflict);
    }

    #[test]
    fn two_open_ended_intervals_for_one_role_are_rejected() {
        let rows = [
            (role_a(), GrantValidity::half_open(ts(100), None).unwrap()),
            (role_a(), GrantValidity::half_open(ts(900), None).unwrap()),
        ];

        assert!(enforce_assignment_non_overlap(&rows).is_err());
    }

    #[test]
    fn two_interval_less_rows_for_one_role_are_rejected() {
        let rows = [
            (role_a(), GrantValidity::always()),
            (role_a(), GrantValidity::always()),
        ];

        assert!(enforce_assignment_non_overlap(&rows).is_err());
    }

    /// The constraint is per `(org_id, user_id, role_id)`. Two DIFFERENT roles
    /// covering the same instant is the ordinary case — rejecting it would be an
    /// outage, not a guard.
    #[test]
    fn the_same_interval_on_two_roles_is_not_an_overlap() {
        let rows = [
            (
                role_a(),
                GrantValidity::half_open(ts(100), Some(ts(200))).unwrap(),
            ),
            (
                role_b(),
                GrantValidity::half_open(ts(100), Some(ts(200))).unwrap(),
            ),
        ];

        assert!(enforce_assignment_non_overlap(&rows).is_ok());
    }

    /// Order of presentation must not decide the verdict.
    #[test]
    fn overlap_detection_does_not_depend_on_input_order() {
        let early = (
            role_a(),
            GrantValidity::half_open(ts(100), Some(ts(300))).unwrap(),
        );
        let late = (
            role_a(),
            GrantValidity::half_open(ts(200), Some(ts(400))).unwrap(),
        );

        assert!(enforce_assignment_non_overlap(&[early, late]).is_err());
        assert!(enforce_assignment_non_overlap(&[late, early]).is_err());
    }

    #[test]
    fn an_empty_assignment_set_is_not_an_overlap() {
        assert!(enforce_assignment_non_overlap(&[]).is_ok());
    }
}
