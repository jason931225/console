//! The branch a RESOURCE lives in — a type boundary, not a scan.
//!
//! `console-gate-fabricated-branch` is a text scan and says so in its own module
//! doc: three blind spots are known and none of them is fixable by another
//! pattern, because "a fabrication moved one function away scans clean" is a
//! property of reading text rather than a bug. The gate's own doc names the
//! control that closes all three — this module.
//!
//! [`ResourceBranch`] wraps a [`BranchId`] in a field that is private to THIS
//! module. Not `pub(crate)`: private. So no expression anywhere — not in a
//! caller, not in this crate, not one function away, not behind an import alias
//! — can put a `BranchId` the caller invented into one. `BranchId::new()`,
//! `branches.iter().next()`, `.nth(0)`, `branches.first().copied()` and every
//! shape nobody has written yet all fail the same way: there is no constructor
//! that takes a `BranchId`, so there is nothing to call. The compiler rejects
//! them; nothing has to recognise them first.
//!
//! # "Came from Postgres" is not the claim
//!
//! A newtype whose entrance is any row read proves only that a uuid made a round
//! trip through the database. That is strictly weaker than "this is the
//! resource's branch", and the gap swallows both shapes the gate exists to stop:
//! an echo query (`SELECT $1::uuid` with a minted id bound) fabricates outright,
//! and a free-form `from_row(row, column)` accepts `branch_id` read off the
//! PRINCIPAL's own membership row — the original tautology, re-spelled as a read.
//!
//! So the only entrance is [`ResourceBranch::lookup`], and the caller does not
//! choose its SQL. It supplies a [`BranchScopedResource`] — a closed enum — and a
//! row id; the table name and the branch column come from this module. There is
//! no variant for `user_branches` or any other principal-side table and a caller
//! cannot add one, so the tautology has no spelling here rather than being
//! discouraged.
//!
//! The proof is executable and lives on [`ResourceBranch`] itself as
//! `compile_fail` doctests.
//!
//! # Why the failing examples are PAIRED with compiling ones
//!
//! A bare `compile_fail` passes when its example fails to compile for ANY
//! reason — a typo, a renamed type, a missing import — so on its own it is green
//! for the wrong reason and proves nothing. The `E0xxx` annotations below do NOT
//! close that: **stable rustdoc does not check the error code.** Verified by
//! mutation rather than assumed: changing `E0423` to `E0308` left the doctest
//! passing, so the code is documentation of intent, not an assertion.
//!
//! What closes it is a control example that DOES compile using the same imports
//! and the same paths, so the fabrication is the only candidate left for what is
//! failing. There are five failing examples and three controls, and they are not
//! all equally tight: two failures are a one-token delta from their control (an
//! argument type; a turbofish). The other three share imports, type name and
//! call syntax with a control but differ by more than the fabrication alone.
//!
//! For all five, the annotated `E0xxx` is the diagnostic that was actually
//! observed — each snippet was compiled against the built rlib and the code
//! copied off the output, not guessed from the shape of the example.

use console_kernel_core::{BranchId, KernelError};
use sqlx::{Executor, Postgres};

/// The branch-scoped resource kinds authorization can read a branch for.
///
/// The table and its branch column are named HERE, never by the caller. That is
/// the whole difference between "a uuid that came back from Postgres" and "the
/// branch of THIS resource": a caller can pick which resource and which row, but
/// not which table, so it cannot point the read at `user_branches` or any other
/// principal-side table and get a `ResourceBranch` back.
///
/// `every_resource_kind_names_a_table_and_branch_column_that_exist` runs every
/// variant against the live schema, so a typo is a test failure rather than a
/// runtime denial nobody can explain.
///
/// Add a variant when a call site moves to [`crate::authorize_scoped`]. A
/// resource whose branch column is nullable does not belong here: those rows are
/// branch-LESS and belong on the `None` arm. If one is added anyway, a `NULL`
/// fails to decode as a uuid and [`ResourceBranch::lookup`] returns `Internal` —
/// closed, not defaulted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BranchScopedResource {
    WorkOrder,
    P1Dispatch,
    InventoryItem,
    RegistryCustomer,
    RegistrySite,
    RegistryEquipment,
}

impl BranchScopedResource {
    pub const ALL: [Self; 6] = [
        Self::WorkOrder,
        Self::P1Dispatch,
        Self::InventoryItem,
        Self::RegistryCustomer,
        Self::RegistrySite,
        Self::RegistryEquipment,
    ];

    /// The whole statement, as one `'static` literal per variant. Not a table
    /// name interpolated into a template: there is no string built at runtime,
    /// so no caller-supplied text can reach the SQL even in principle, and
    /// `sqlx`'s injection lint is satisfied without an `AssertSqlSafe` bypass.
    const fn select_branch_sql(self) -> &'static str {
        match self {
            Self::WorkOrder => "SELECT branch_id FROM work_orders WHERE id = $1",
            Self::P1Dispatch => "SELECT branch_id FROM p1_dispatches WHERE id = $1",
            Self::InventoryItem => "SELECT branch_id FROM inventory_items WHERE id = $1",
            Self::RegistryCustomer => "SELECT branch_id FROM registry_customers WHERE id = $1",
            Self::RegistrySite => "SELECT branch_id FROM registry_sites WHERE id = $1",
            Self::RegistryEquipment => "SELECT branch_id FROM registry_equipment WHERE id = $1",
        }
    }
}

/// The branch a resource row lives in, read from that row by this crate.
///
/// [`crate::authorize_scoped`] takes `Option<ResourceBranch>`: `Some(b)` is
/// branch authorization against a branch the RESOURCE has, `None` is branch-less
/// capability authorization for a resource that has no branch at all.
///
/// # A fabricated branch does not compile
///
/// THE CONTROL. Everything the failing examples below rely on — both imports,
/// the type name, the `::from` path, the `.get()` accessor — resolves and
/// compiles here. `From<T> for T` is reflexive, so `ResourceBranch::from` is a
/// real, callable path:
///
/// ```
/// use console_kernel_core::BranchId;
/// use console_platform_authz::ResourceBranch;
///
/// fn one_function_away(branch: ResourceBranch) -> BranchId {
///     ResourceBranch::from(branch).get()
/// }
/// ```
///
/// Now replace the argument type with `BranchId` and change nothing else. There
/// is no `From<BranchId>`, so moving the expression one function away — the
/// blind spot no text scan can close — does not help:
///
/// ```compile_fail,E0308
/// use console_kernel_core::BranchId;
/// use console_platform_authz::ResourceBranch;
///
/// fn one_function_away(branch: BranchId) -> BranchId {
///     ResourceBranch::from(branch).get()
/// }
/// ```
///
/// Nor does the tuple-struct constructor, which the module-private field keeps
/// out of scope everywhere else:
///
/// ```compile_fail,E0423
/// use console_kernel_core::BranchId;
/// use console_platform_authz::ResourceBranch;
///
/// let fabricated = ResourceBranch(BranchId::new());
/// ```
///
/// Nor an inherent constructor, because there is none that takes a `BranchId`:
///
/// ```compile_fail,E0599
/// use console_kernel_core::BranchId;
/// use console_platform_authz::ResourceBranch;
///
/// let fabricated = ResourceBranch::new(BranchId::new());
/// ```
///
/// # Nor a row read whose shape the CALLER chose
///
/// An echo query fabricates outright by binding a minted id and reading it
/// straight back: `query_scalar("SELECT $1::uuid").bind(BranchId::new().into_uuid())`.
/// That needs a [`Decode`](sqlx::Decode) impl, so this type has none:
///
/// ```compile_fail,E0277
/// fn decodes_from_any_sql_scalar<
///     T: for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>,
/// >() {
/// }
///
/// decodes_from_any_sql_scalar::<console_platform_authz::ResourceBranch>();
/// ```
///
/// THE CONTROL for that one, and a minimal delta: same bound, same turbofish
/// syntax, only the type differs — and `uuid::Uuid` does decode.
///
/// ```
/// fn decodes_from_any_sql_scalar<
///     T: for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>,
/// >() {
/// }
///
/// decodes_from_any_sql_scalar::<uuid::Uuid>();
/// ```
///
/// And a free-form `from_row(row, column)` would accept ANY row with ANY column
/// name — including `branch_id` off the principal's own membership row, where
/// `branch_scope.allows(b)` is true by construction and the branch dimension
/// disappears silently. There is no such entrance:
///
/// ```compile_fail,E0599
/// let caller_chose_the_column = console_platform_authz::ResourceBranch::from_row;
/// ```
///
/// THE CONTROL: the entrance that does exist, referenced exactly the same way.
/// It takes a resource KIND, not a table name or a column name.
///
/// ```
/// let authz_chose_the_table = console_platform_authz::ResourceBranch::lookup::<&sqlx::PgPool>;
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ResourceBranch(BranchId);

impl ResourceBranch {
    /// Read one resource row's branch. The ONLY entrance.
    ///
    /// `resource` picks the table and its branch column from
    /// [`BranchScopedResource`]; `id` picks the row. No part of the SQL comes
    /// from the caller, so there is no argument that could aim this at a
    /// principal-side table.
    ///
    /// # Errors
    ///
    /// [`console_kernel_core::ErrorKind::NotFound`] when no such row exists —
    /// never a defaulted or absent branch, because "the resource is missing" and
    /// "the resource is branch-less" authorize differently and must not collapse
    /// into one another. [`console_kernel_core::ErrorKind::Internal`] on any
    /// other database failure.
    pub async fn lookup<'e, E>(
        executor: E,
        resource: BranchScopedResource,
        id: uuid::Uuid,
    ) -> Result<Self, KernelError>
    where
        E: Executor<'e, Database = Postgres>,
    {
        let branch: Option<uuid::Uuid> = sqlx::query_scalar(resource.select_branch_sql())
            .bind(id)
            .fetch_optional(executor)
            .await
            .map_err(|err| {
                KernelError::internal(format!("cannot read {resource:?} branch: {err}"))
            })?;

        branch
            .map(|id| Self(BranchId::from_uuid(id)))
            .ok_or_else(|| {
                KernelError::not_found(format!("no {resource:?} row {id} to authorize against"))
            })
    }

    /// The branch this resource lives in.
    #[must_use]
    pub const fn get(self) -> BranchId {
        self.0
    }

    /// Unit-test constructor. `#[cfg(test)]` and `pub(crate)`, so it exists only
    /// in this crate's own test build and is not part of the published surface —
    /// a downstream crate cannot reach it even in ITS tests.
    #[cfg(test)]
    pub(crate) const fn for_test(branch: BranchId) -> Self {
        Self(branch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use console_kernel_core::BranchId;

    #[test]
    fn a_resource_branch_carries_the_branch_it_was_read_from() {
        let branch = BranchId::new();

        assert_eq!(ResourceBranch::for_test(branch).get(), branch);
    }

    /// No variant may read from a principal-side table. A `ResourceBranch` read
    /// off `user_branches` would make `branch_scope.allows(b)` true by
    /// construction — the exact tautology this type replaces, re-spelled as a
    /// row read. The closed enum is the control; this is the tripwire on the
    /// one way the enum could be extended into the hole again.
    #[test]
    fn no_resource_kind_reads_from_a_principal_side_table() {
        for resource in BranchScopedResource::ALL {
            let sql = resource.select_branch_sql();

            for principal_table in [
                "user_branches",
                "users",
                "branches",
                "user_role_assignments",
            ] {
                assert!(
                    !sql.contains(&format!("FROM {principal_table} ")),
                    "{resource:?} reads the principal's own table `{principal_table}`: {sql}"
                );
            }
        }
    }
}
