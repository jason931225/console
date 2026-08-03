# Agentic engineering playbook

This playbook is subordinate to the pivot, accepted ADRs, roadmap, and development pipeline. It describes repeatable delivery, not product authority.

## Prepare before parallelism
1. Establish a known reference implementation (Company and OrgUnit).
2. Freeze an independently owned behavioral target (`company_conformance`).
3. Publish the mechanical expansion guide (`CATALOG.md`).
4. Run a small JobPosition/projection pilot and prove zero overlapping writes.
5. Preserve and independently verify the test baseline before widening.

## Lane contract
Every admitted lane has parser-visible registry metadata and an additive `docs/program/ledger/<lane-id>.md` receipt: outcome/non-goals, exact base SHA, owner and writable roots, forbidden shared roots, source-of-truth writer, leases, pre-mortem, rollback/stop conditions, immutable test invocation, reviewers, evidence, head SHA, result, HOLDs, and post-merge readback.

Use three writer worktrees, one integration worktree, and one reserve/fix worktree. High-risk authz, migration, contract, HR, release, and compliance-sensitive changes require one implementer, two independent adversarial reviewers, and a distinct integrator. Increase concurrency only after two collision-free epochs; reduce it after collisions, stale-base rebuilds, saturation, or review backlog.

## Evidence and enforcement
Preflight rejects dirty integration roots, stale bases, overlapping ownership, unowned migrations, generated-face writes, and weakened tests. Receipts retain command, revision, lockfile, runtime, counts, failures, and artifact hashes. Dry-run checks prove non-mutation. Jurisdiction records retain source locator, retrieval/effective dates, snapshot hash, applicability, reviewer, evidence links, due date, and claim type; CI never synthesizes a compliance conclusion.

## Review lenses
Review object-first, deep-not-wide, fail-closed authorization, mock-independent behavior, human dignity, and closed-loop rollback. Promote a lesson into `AGENTS.md` only after one severe incident or repeated recurrence; otherwise keep it in retrospectives and this playbook.
