//! fabricated-branch gate.
//!
//! `console_platform_authz::authorize(principal, action, resource_branch)` checks
//! `principal.branch_scope.allows(resource_branch)` before it reads a matrix cell.
//! That check is only meaningful when `resource_branch` was read off the RESOURCE.
//! Derive it from the principal instead —
//!
//! ```ignore
//! match &principal.branch_scope {
//!     BranchScope::All => BranchId::new(),
//!     BranchScope::Branches(b) => b.iter().next().copied()...,
//! }
//! ```
//!
//! — and the check becomes a TAUTOLOGY on **both** arms: `All` allows any freshly
//! minted id, and `Branches(set).iter().next()` is by definition a member of
//! `set`. The `.iter().any(|b| authorize(.., *b).is_ok())` variant is the same
//! tautology, only wordier: the disjunction ranges over the principal's own
//! branches, so `allows` is true on every iteration. The branch dimension does not
//! fail loudly — it disappears silently.
//!
//! This pattern was copy-pasted into 18 production helpers across 18 crates, and
//! one of them documented it as correct and cited another as precedent. A doc
//! comment is what already failed; hence a gate.
//!
//! ## The fix is never "add a marker"
//!
//! * The resource HAS a branch → read it off the row and pass THAT to `authorize`.
//! * The resource has NO branch (no `branch_id` column; a list gate whose
//!   confinement is the caller's whole scope) → `authorize_capability`, which
//!   drops the branch dimension visibly.
//! * The action spans EVERY branch → `authorize_org_wide`.
//!
//! ## Exceptions
//!
//! Picking a representative branch is legitimate when it never reaches an
//! authorization decision — choosing a default branch for row *creation*, a
//! `len() == 1` store filter, stamping an actor branch on an audit row.
//!
//! Those shapes are recognized, not merely tolerated: a `Branches` arm whose
//! sibling is `BranchScope::All => None` yields `Option<BranchId>` and so cannot
//! hand `authorize` a branch for an `All` principal, which is the only thing the
//! fabrication existed to do. An arm that calls `authorize` itself is never
//! excused that way. Anything else needs an inline `// fabricated-branch: ok
//! <reason>` marker on the arm or the line above it, so each remaining exception
//! is a reviewed sentence rather than an accident.
//!
//! ## Scope
//!
//! Rules are substring matches over whitespace-stripped arm bodies, which assumes
//! `cargo fmt`-normalized source — `.github/workflows/ci.yml`'s `rustfmt check`
//! step is a hard prerequisite, not a nicety. Comment lines are ignored so this
//! module's own prose does not trip it.
//!
//! An arm body is therefore read to the END of the arm, including the lines
//! `cargo fmt` wraps a long method chain onto. Reading only the arm's first line
//! is the one failure this gate cannot afford: the fabrication would scan clean in
//! exactly the shape the formatter produces. See [`continues_on_next_line`].

use std::path::{Path, PathBuf};
use std::{collections::BTreeSet, fs};

/// Paths whose fabrications belong to a lane that owns them and are handed off
/// rather than fixed here. Each entry is a debt: delete it when that lane lands.
const HANDED_OFF: &[(&str, &str)] = &[
    (
        "crates/reporting/rest/src/lib.rs",
        "reporting lane: KpiScope::Branch already passes a real branch; the \
         Company/Region/Technician scopes want authorize_capability",
    ),
    (
        "crates/registry/rest/src/lib.rs",
        "registry lane: the fabricating helpers at :1929 and :1985 — \
         registry_equipment/customers/sites all carry a NOT NULL branch_id, so \
         thread the real scope, do not make it branch-less. \
         `principal_create_branch` (:713) is NOT covered by this entry and no \
         longer needs to be: it is an Option-yielding default-branch pick for row \
         creation, which the sibling-`None` rule reads as clean on its own.",
    ),
    (
        "app/src/hr.rs",
        "HR lane: authorize_hr_scoped's .iter().any(|b| authorize(..).is_ok()) is \
         the same tautology. `employees` DOES have a branch column — \
         `home_branch_id` (migration 0166, FK to branches(id, org_id)) — so \
         whether these sites are branch-less or want that column threaded is the \
         HR lane's call, not an assumption this entry may make for it",
    ),
];

/// Inline escape hatch for a representative branch that never feeds `authorize`.
const MARKER: &str = "fabricated-branch: ok";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViolationKind {
    /// `BranchScope::All =>` arm minting a `BranchId::new()`.
    FabricatedAllArm,
    /// `BranchScope::Branches(b) =>` arm picking `b`'s own first/any member.
    TautologicalBranchesArm,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub kind: ViolationKind,
    pub file: PathBuf,
    pub line: usize,
    pub detail: String,
}

impl std::fmt::Display for Violation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "[{:?}] {}:{}: {}",
            self.kind,
            self.file.display(),
            self.line,
            self.detail
        )
    }
}

#[derive(Debug, Default)]
pub struct GateResult {
    pub violations: Vec<Violation>,
    pub files_scanned: usize,
}

impl GateResult {
    #[must_use]
    pub fn passed(&self) -> bool {
        self.violations.is_empty()
    }
}

/// Scan the backend workspace. Errors when the scan root does not resolve or
/// contains no Rust at all — a gate that scanned nothing exits 0 otherwise, which
/// is indistinguishable from a gate that passed.
pub fn check_workspace(workspace_dir: &Path) -> Result<GateResult, String> {
    let result = check_source_tree(workspace_dir)?;
    if result.files_scanned == 0 {
        return Err(format!(
            "scanned 0 Rust files under {} — the scan root did not resolve",
            workspace_dir.display()
        ));
    }
    Ok(result)
}

/// Scan an arbitrary tree. Used by the mutation suite against a throwaway
/// workspace; `check_workspace` adds the scanned-nothing guard on top.
pub fn check_source_tree(root: &Path) -> Result<GateResult, String> {
    let mut result = GateResult::default();
    for file in collect_rust_files(root)? {
        let source = fs::read_to_string(&file)
            .map_err(|e| format!("cannot read {}: {e}", file.display()))?;
        result.files_scanned += 1;
        if is_handed_off(&file) {
            continue;
        }
        check_source_file(&file, &source, &mut result);
    }
    Ok(result)
}

fn is_handed_off(file: &Path) -> bool {
    let path = file.to_string_lossy().replace('\\', "/");
    HANDED_OFF.iter().any(|(suffix, _)| path.ends_with(suffix))
}

fn check_source_file(file: &Path, source: &str, result: &mut GateResult) {
    let lines: Vec<&str> = source.lines().collect();
    // The `.iter().any(|b| authorize(..))` shape is only a tautology when it
    // feeds an authorization decision; a bare membership loop is not this gate's
    // business.
    let touches_authz = source.contains("authorize");

    for (idx, line) in lines.iter().enumerate() {
        if is_comment(line) || marked(&lines, idx) {
            continue;
        }
        let body = arm_body(&lines, idx);

        if line.contains("BranchScope::All =>") && body.contains("BranchId::new()") {
            result.violations.push(Violation {
                kind: ViolationKind::FabricatedAllArm,
                file: file.to_path_buf(),
                line: idx + 1,
                detail: "BranchScope::All arm mints a BranchId that belongs to no \
                         branch; use authorize_capability or authorize_org_wide"
                    .to_owned(),
            });
        }

        if !touches_authz {
            continue;
        }
        if let Some(binding) = branches_arm_binding(line) {
            let picks_own_member = body.contains(&format!("{binding}.iter().next()"))
                || body.contains(&format!("{binding}.iter().any("));
            if picks_own_member && !yields_option(&lines, idx, &body) {
                result.violations.push(Violation {
                    kind: ViolationKind::TautologicalBranchesArm,
                    file: file.to_path_buf(),
                    line: idx + 1,
                    detail: format!(
                        "BranchScope::Branches({binding}) arm authorizes against a \
                         member of {binding} itself, so branch_scope.allows is \
                         always true; pass the resource's branch or use \
                         authorize_capability"
                    ),
                });
            }
        }
    }
}

/// How far from a `Branches` arm its sibling `All` arm can sit. Both arms of these
/// two-arm matches are adjacent, give or take a marker comment.
const SIBLING_ARM_WINDOW: usize = 4;

/// Whether this `Branches` arm belongs to a match that yields `Option<BranchId>`,
/// identified by a sibling `BranchScope::All => None` arm.
///
/// That match cannot be the fabrication this gate exists to stop. The fabrication's
/// whole job was to hand [`authorize`] a `BranchId` for an `All` principal, and an
/// `All` arm of `None` refuses to produce one — an `All` caller is then either
/// skipped or denied, never admitted on a minted id. What remains is precisely the
/// legitimate shape the module docs list: the ACTOR's branch stamped on an audit
/// row (`console_app::audit_event_branch`), or a default branch chosen for row
/// CREATION (`registry/rest::principal_create_branch`). Those sites previously had
/// to carry a marker or, worse, a file-wide `HANDED_OFF` exemption that also hid
/// the file's real fabrications.
///
/// An arm that calls `authorize` itself is never excused — that is the `.any()`
/// tautology, and it is a decision, not a value.
fn yields_option(lines: &[&str], idx: usize, body: &str) -> bool {
    if body.contains("authorize(") {
        return false;
    }
    let lo = idx.saturating_sub(SIBLING_ARM_WINDOW);
    let hi = (idx + SIBLING_ARM_WINDOW).min(lines.len().saturating_sub(1));
    (lo..=hi).any(|sibling| {
        !is_comment(lines[sibling])
            && lines[sibling].contains("BranchScope::All =>")
            && matches!(
                arm_body(lines, sibling).as_str(),
                "BranchScope::All=>None" | "BranchScope::All=>None,"
            )
    })
}

fn is_comment(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("//") || trimmed.starts_with("*") || trimmed.starts_with("/*")
}

/// A violation is excused by a `// fabricated-branch: ok <reason>` marker on the
/// arm itself or on the line directly above it.
fn marked(lines: &[&str], idx: usize) -> bool {
    lines[idx].contains(MARKER) || (idx > 0 && lines[idx - 1].contains(MARKER))
}

/// The match arm starting at `idx`, whitespace-stripped so rustfmt's line breaks
/// (`branches\n.iter()\n.any(..)`) read as one expression. Comment lines are
/// dropped. Scans forward until brace/paren depth returns to its starting level
/// AND the expression has actually ended, capped so a malformed file cannot walk
/// the whole source.
fn arm_body(lines: &[&str], idx: usize) -> String {
    let mut body = String::new();
    let mut depth = 0i32;
    for (offset, line) in lines.iter().enumerate().skip(idx).take(40) {
        if is_comment(line) {
            continue;
        }
        body.extend(line.chars().filter(|c| !c.is_whitespace()));
        for ch in line.chars() {
            match ch {
                '{' | '(' | '[' => depth += 1,
                '}' | ')' | ']' => depth -= 1,
                _ => {}
            }
        }
        if depth <= 0 && !continues_on_next_line(lines, offset) {
            break;
        }
    }
    body
}

/// Whether the arm's expression carries on past `idx`.
///
/// Depth alone is not the end of an arm. `cargo fmt` wraps a long method chain so
/// the first line closes at paren depth 0 while the expression continues:
///
/// ```ignore
/// BranchScope::Branches(b) => b
///     .iter()
///     .next()
/// ```
///
/// Stopping at depth 0 reads the arm as just `b`, and the fabrication scans clean
/// — in the exact shape the formatter produces, which is the shape the next one
/// will arrive in. A continuation line begins with `.` or `?`; a match arm pattern
/// never does, so resuming on one cannot swallow the following arm.
fn continues_on_next_line(lines: &[&str], idx: usize) -> bool {
    lines
        .iter()
        .skip(idx + 1)
        .take(5)
        .find(|line| !is_comment(line) && !line.trim().is_empty())
        .is_some_and(|line| {
            let next = line.trim_start();
            next.starts_with('.') || next.starts_with('?')
        })
}

/// `BranchScope::Branches(branches) =>` / `Branches(branches) if .. =>` → the
/// binding name. Returns `None` for wildcard or destructuring patterns, which
/// cannot name a member to pick.
fn branches_arm_binding(line: &str) -> Option<&str> {
    let rest = line.split_once("BranchScope::Branches(")?.1;
    let (binding, after) = rest.split_once(')')?;
    if !after.contains("=>") {
        return None;
    }
    let binding = binding.trim();
    let valid = !binding.is_empty()
        && binding
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !binding.starts_with(|c: char| c.is_ascii_digit());
    valid.then_some(binding)
}

fn collect_rust_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = BTreeSet::new();
    collect_rust_files_inner(root, &mut files)?;
    Ok(files.into_iter().collect())
}

fn collect_rust_files_inner(dir: &Path, files: &mut BTreeSet<PathBuf>) -> Result<(), String> {
    if should_skip_dir(dir) {
        return Ok(());
    }
    let entries =
        fs::read_dir(dir).map_err(|e| format!("cannot read directory {}: {e}", dir.display()))?;
    for entry in entries {
        let entry =
            entry.map_err(|e| format!("cannot read directory entry in {}: {e}", dir.display()))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("cannot read file type for {}: {e}", path.display()))?;
        if file_type.is_dir() {
            collect_rust_files_inner(&path, files)?;
        } else if file_type.is_file() && path.extension().is_some_and(|ext| ext == "rs") {
            files.insert(path);
        }
    }
    Ok(())
}

fn should_skip_dir(path: &Path) -> bool {
    let components: Vec<String> = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    components
        .iter()
        .any(|part| part == "target" || part == ".git")
        || components
            .windows(2)
            .any(|window| window[0] == "ci" && window[1] == "gates")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(source: &str) -> GateResult {
        let mut result = GateResult::default();
        check_source_file(Path::new("src/lib.rs"), source, &mut result);
        result
    }

    #[test]
    fn flags_the_all_arm_that_mints_a_branch() {
        let result = scan(
            r#"
fn representative_branch(principal: &Principal) -> Result<BranchId, E> {
    match &principal.branch_scope {
        BranchScope::All => Ok(BranchId::new()),
        BranchScope::Branches(branches) => branches.iter().next().copied().ok_or(E),
    }
}
fn call() { authorize(p, a, b) }
"#,
        );
        assert_eq!(result.violations.len(), 2, "{:#?}", result.violations);
        assert_eq!(result.violations[0].kind, ViolationKind::FabricatedAllArm);
        assert_eq!(
            result.violations[1].kind,
            ViolationKind::TautologicalBranchesArm
        );
    }

    /// The wordier form. `hr.rs` used it; a reviewer read it as stricter than
    /// `.next()` when it is exactly as vacuous.
    #[test]
    fn flags_the_any_over_own_branches_form() {
        let result = scan(
            r#"
fn authorize_scoped(principal: &Principal, feature: Feature) -> Result<(), E> {
    match &principal.branch_scope {
        BranchScope::Branches(branches) => {
            if branches
                .iter()
                .any(|branch| authorize(principal, action, *branch).is_ok())
            {
                Ok(())
            } else {
                Err(E)
            }
        }
        BranchScope::All => Ok(()),
    }
}
"#,
        );
        assert_eq!(result.violations.len(), 1, "{:#?}", result.violations);
        assert_eq!(
            result.violations[0].kind,
            ViolationKind::TautologicalBranchesArm
        );
    }

    /// THE BYPASS. `cargo fmt` wraps a long chain so the arm's first line closes
    /// at paren depth 0; a body read that stopped there saw only `branches` and
    /// scanned this clean, exit 0. This is `app/src/lib.rs::authorize_audit_read`
    /// verbatim as it stood before the migration — the formatter's own output, so
    /// the shape any future fabrication arrives in.
    #[test]
    fn flags_the_rustfmt_wrapped_branches_arm() {
        let result = scan(
            r#"
fn authorize_audit_read(principal: &Principal) -> Result<(), ApiError> {
    let resource_branch = match &principal.branch_scope {
        BranchScope::All => BranchId::new(),
        BranchScope::Branches(branches) => branches
            .iter()
            .next()
            .copied()
            .ok_or_else(|| ApiError::forbidden("principal has no branch scope"))?,
    };
    authorize(
        principal,
        Action::new(Feature::AuditLogRead),
        resource_branch,
    )
    .map_err(ApiError::from_kernel)
}
"#,
        );
        assert_eq!(result.violations.len(), 2, "{:#?}", result.violations);
        assert_eq!(result.violations[0].kind, ViolationKind::FabricatedAllArm);
        assert_eq!(
            result.violations[1].kind,
            ViolationKind::TautologicalBranchesArm
        );
    }

    /// The same wrap on the `.any()` form, with no `All` arm to fall back on.
    #[test]
    fn flags_the_rustfmt_wrapped_any_arm() {
        let result = scan(
            r#"
fn require(principal: &Principal, action: Action) -> Result<(), E> {
    match &principal.branch_scope {
        BranchScope::All => authorize_org_wide(principal, action),
        BranchScope::Branches(branches) => branches
            .iter()
            .any(|branch| authorize(principal, action, *branch).is_ok())
            .then_some(())
            .ok_or(E),
    }
}
"#,
        );
        assert_eq!(result.violations.len(), 1, "{:#?}", result.violations);
        assert_eq!(
            result.violations[0].kind,
            ViolationKind::TautologicalBranchesArm
        );
    }

    /// Reading to the end of an arm must not read INTO the next one: an honest
    /// `Branches` arm beside a minting `All` arm is one violation, not two.
    #[test]
    fn does_not_read_one_arm_into_the_next() {
        let result = scan(
            r#"
fn pick(principal: &Principal, id: Id) -> BranchId {
    match &principal.branch_scope {
        BranchScope::All => BranchId::new(),
        BranchScope::Branches(branches) => resource_branch_of(id),
    }
}
fn call() { authorize(p, a, b) }
"#,
        );
        assert_eq!(result.violations.len(), 1, "{:#?}", result.violations);
        assert_eq!(result.violations[0].kind, ViolationKind::FabricatedAllArm);
    }

    /// `All => None` makes the match yield `Option<BranchId>`, which cannot hand
    /// `authorize` a branch for an `All` principal — the actor-branch and
    /// default-branch-for-creation shapes the module docs bless. Previously this
    /// needed a marker, or a file-wide exemption that also hid real fabrications
    /// (`registry/rest/src/lib.rs:713`).
    #[test]
    fn accepts_an_option_yielding_pick_beside_an_all_none_arm() {
        let result = scan(
            r#"
fn principal_create_branch(principal: &Principal) -> Option<BranchId> {
    match &principal.branch_scope {
        BranchScope::All => None,
        BranchScope::Branches(branches) => branches.iter().next().copied(),
    }
}
fn create(p: &Principal) { authorize(p, a, row.branch_id) }
"#,
        );
        assert!(result.passed(), "{:#?}", result.violations);
    }

    /// The `Option` exemption is about a VALUE, not a decision: an arm that calls
    /// `authorize` itself is still the tautology, `All => None` or not.
    #[test]
    fn option_exemption_does_not_excuse_an_arm_that_authorizes() {
        let result = scan(
            r#"
fn require(principal: &Principal, action: Action) -> Option<()> {
    match &principal.branch_scope {
        BranchScope::All => None,
        BranchScope::Branches(branches) => branches
            .iter()
            .any(|branch| authorize(principal, action, *branch).is_ok())
            .then_some(()),
    }
}
"#,
        );
        assert_eq!(result.violations.len(), 1, "{:#?}", result.violations);
        assert_eq!(
            result.violations[0].kind,
            ViolationKind::TautologicalBranchesArm
        );
    }

    /// ...and it is keyed on `None` specifically. An `All` arm that DENIES still
    /// leaves the `Branches` arm free to feed `authorize` a member of its own set.
    #[test]
    fn option_exemption_does_not_extend_to_a_denying_all_arm() {
        let result = scan(
            r#"
fn representative(principal: &Principal) -> Result<BranchId, E> {
    match &principal.branch_scope {
        BranchScope::All => Err(E::forbidden()),
        BranchScope::Branches(branches) => branches.iter().next().copied().ok_or(E::forbidden()),
    }
}
fn call() { authorize(p, a, representative(p)?) }
"#,
        );
        assert_eq!(result.violations.len(), 1, "{:#?}", result.violations);
        assert_eq!(
            result.violations[0].kind,
            ViolationKind::TautologicalBranchesArm
        );
    }

    #[test]
    fn flags_the_multi_line_all_arm() {
        let result = scan(
            r#"
fn pick(principal: &Principal) -> BranchId {
    match &principal.branch_scope {
        BranchScope::All => {
            BranchId::new()
        }
        BranchScope::Branches(_) => authorize_somehow(),
    }
}
"#,
        );
        assert_eq!(result.violations.len(), 1, "{:#?}", result.violations);
        assert_eq!(result.violations[0].kind, ViolationKind::FabricatedAllArm);
    }

    #[test]
    fn accepts_a_marked_exception() {
        let result = scan(
            r#"
fn audit_event_branch(scope: &BranchScope) -> Option<BranchId> {
    match scope {
        BranchScope::All => None,
        // fabricated-branch: ok stamps the actor's branch on an audit row, never authorize
        BranchScope::Branches(branches) => branches.iter().next().copied(),
    }
}
fn other() { authorize(p, a, b) }
"#,
        );
        assert!(result.passed(), "{:#?}", result.violations);
    }

    /// The whole point of the primitive: the honest branch-less form is clean.
    #[test]
    fn accepts_authorize_capability() {
        let result = scan(
            r#"
fn require_feature(principal: &Principal, feature: Feature) -> Result<(), E> {
    authorize_capability(principal, Action::new(feature)).map_err(E::from_kernel)
}
"#,
        );
        assert!(result.passed(), "{:#?}", result.violations);
    }

    /// And so is threading a real resource branch.
    #[test]
    fn accepts_a_resource_branch_read_off_the_row() {
        let result = scan(
            r#"
async fn complete(state: &S, principal: &Principal, id: Id) -> Result<(), E> {
    let branch_id = state.store.schedule_branch_in_scope(id, &principal.branch_scope).await?;
    authorize(principal, Action::new(Feature::X), branch_id).map_err(E::from_kernel)
}
"#,
        );
        assert!(result.passed(), "{:#?}", result.violations);
    }

    /// This gate's own prose, and `authorize`'s doc comment, describe the shape
    /// they forbid. Documenting an anti-pattern must not trip it.
    #[test]
    fn ignores_the_pattern_inside_comments() {
        let result = scan(
            r#"
/// Never write `BranchScope::All => BranchId::new()`, and never write
/// `BranchScope::Branches(b) => b.iter().next()` — both are tautologies.
// BranchScope::All => Ok(BranchId::new()),
fn authorize_capability_doc() {}
"#,
        );
        assert!(result.passed(), "{:#?}", result.violations);
    }

    /// A membership loop that never reaches `authorize` is not this gate's
    /// business.
    #[test]
    fn ignores_branch_picking_in_a_file_with_no_authorization() {
        let result = scan(
            r#"
fn first_branch(scope: &BranchScope) -> Option<BranchId> {
    match scope {
        BranchScope::All => None,
        BranchScope::Branches(branches) => branches.iter().next().copied(),
    }
}
"#,
        );
        assert!(result.passed(), "{:#?}", result.violations);
    }

    // The scanned-nothing guard is proven in
    // `tests/gate_detects_violation.rs::gate_errors_when_it_walked_zero_rust_files`,
    // which needs a real temp tree; it is not duplicated here.
}
