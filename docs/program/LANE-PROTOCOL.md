# Lane protocol

Status: active preparation and integration contract. Product scope comes from the pivot; detailed method comes from the agentic engineering playbook.

## Preparation gate

Fan-out is forbidden until all are true:

1. Company and OrgUnit are the hand-reviewed reference.
2. `company_conformance` is frozen and owned outside expansion lanes.
3. `CATALOG.md` is the mechanical guide.
4. A two-lane JobPosition/projection pilot proves zero overlapping writes.
5. The original test baseline and exact invocation have independent evidence.

Person, Employment, and PayRun are domain-owned projected writers, not generic instance fan-out.

## Worktree topology

Use three concurrent writer worktrees, one reserved integration worktree, and one reserve/fix worktree. Read-only reviewers inspect frozen diffs and exact SHAs. Increase writers by one only after two collision-free epochs. Reduce concurrency immediately after any collision, stale-base rebuild, resource saturation, or reviewer backlog.

## Required lane receipt

Every admitted lane adds `docs/program/ledger/<lane-id>.md` and parser-visible registry metadata with:

- outcome and non-goals;
- exact base SHA and reference contract;
- owner, allowed writable roots, and forbidden shared roots;
- source-of-truth writer;
- resource demands and disposable leases;
- pre-mortem, blast radius, detection, rollback, and stop conditions;
- immutable test baseline and exact invocation;
- review lenses and approvers;
- evidence artifacts, head SHA, result, remaining HOLDs, and post-merge readback.

## Ownership

No two writers edit the same path. Migrations, lockfiles, OpenAPI, CI, authority records, generated files, and integration manifests have one serialized owner. Migration numbers are assigned immediately before landing, never reserved on stale branches. Generated files are changed through their source generator.

High-risk authz, migration, contract, approval, HR, release, and compliance-sensitive changes require one implementer, two independent adversarial reviewers, and a distinct fixer/integrator.

## Stop conditions

Stop and return the lane to integration on an out-of-scope write, target-baseline change, hidden dependency, migration-number conflict, stale base, failing nondisclosure/rollback evidence, test weakening, or a need to change a serialized face. Runtime state and branch names do not establish completion.
