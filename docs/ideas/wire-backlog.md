# WIRE backlog — dead code that must not be deleted

Opened 2026-08-01 by the remediation of the whole-repo simplification audit.

The audit's triage split its findings into DELETE / WIRE / KEEP. WIRE means: the code has zero
callers **and** must survive, because it is either an unexposed surface for a capability the
registry still declares, or a designed check that was never called. An unrun check is not dead
weight; it is a check whose call site has not been written yet.

The DELETE default that `docs/evidence/console/wave4/inputs/DECISIONS.md:38-40` (D-5) establishes
does **not** apply to an item in this file. D-5 is a tie-breaker for code with no recorded intent.
An item here has recorded intent: a live capability-registry declaration. Removing one of these
requires retiring the declaration first, in the same change, with evidence — not a default.

This file records only the two items the FIX_FIRST review restored. It is not the full WIRE set
from the triage.

---

## W-1 · `SupportCase` aggregate and its five guards — `CAP-FIELD-CONSOLE`

**Code**
`backend/crates/support/domain/src/lib.rs:380-838,1048-1253`
`backend/crates/support/application/src/lib.rs:132-605,977-1145,1185-1588`

**Why it is WIRE.** `docs/program/console-capability-registry.json` declares `CAP-FIELD-CONSOLE`
("Customer-site intake to field visit, check-in, work log, acceptance") with
`state.backend = "integrated_dark_on_pr488"` and `state.production_exposure = "dark"`. Dark is the
declared condition, not an accident: the frontend surface was deleted by the 2026-07-28 clean-slate
pivot (`state.frontend`), so the backend is waiting on a consumer that a pivot removed. That is an
unexposed surface for a declared capability, which is the textbook WIRE case.

Zero callers is therefore expected and proves nothing. `grep -rn 'SupportCase\|CaseScope\|CaseEvent'
--include='*.rs' backend/` returns hits in exactly these two files.

**The five zero-caller guards.** Each is a designed check with no call site. Restoring the stack
restores the guards; wiring them is the open work.

| # | Guard | What it enforces | What wiring it requires |
| --- | --- | --- | --- |
| G-1 | `SupportCaseCommandMetadata::validate_preflight` (`application:151`) | Command actor equals the authenticated principal; idempotency key is 16..=200 chars; fingerprint is non-empty and ≤128 chars. Runs **before** a transaction opens, so a malformed actor never costs a connection. | A REST handler in `support/rest` that builds `SupportCaseActorContext` from the request context and calls one of the three application entry points. No new port. |
| G-2 | `SupportCaseCommandMetadata::validate` (`application:170`) | G-1 plus `context.branch_scope.allows(branch_id)` — the branch-scope half of the ADR-0028 org+branch authority pair. | Same handler as G-1; reached via `validate_case_context`. Needs `BranchScope` populated from the request context, which `platform/request-context` already supplies to other verticals. |
| G-3 | `support_case_idempotency` (`application:215`) | Same key + same fingerprint ⇒ `Replay`; same key + different fingerprint ⇒ `409 conflict`. This is the only thing stopping a retried mobile POST with an edited body from applying twice. | A `SupportCaseUnitOfWork` implementation in `support/adapter-postgres` whose `idempotency_receipt` reads a real receipt row, plus the receipt table itself — no `case_history`, `dispatch_handoff`, or `case_evidence` table exists in `backend/crates/platform/db/migrations/`. Migration is the long pole. |
| G-4 | `validate_case_context` (`application:490`) | Tenant match: `context.org_id != case.scope().org_id` ⇒ forbidden. Defence in depth behind RLS — it fires on a case loaded inside an armed transaction whose org still disagrees. | Same adapter as G-3. `SupportCaseRepository::transaction` already takes `org_id` as explicit authority for arming `app.current_org`; the implementation must actually arm it. |
| G-5 | `SupportCase::require_mutable` (`domain:816`) | Optimistic concurrency (`version != expected_version` ⇒ conflict) and terminal-state immutability (a closed case cannot be changed). | Nothing beyond G-3's CAS-capable `commit`. The check is pure domain; it runs the moment a mutation path exists. |

Adjacent and equally uncalled, listed so it is not lost: `SupportCase::rehydrate` (`domain:537`)
validates that a persisted history is contiguous, that its replay reproduces the stored status
projection, and that handoff/evidence events are coherent. It is the read-side integrity check for
G-3's storage and is exercised today only by four unit tests.

**Executed tests riding on this.** 15 in `console-support-domain`, 15 in `console-support-application`.
Six domain tests and twelve application tests are specific to `SupportCase`; they run in CI today and
were lost by the over-deletion this entry documents. The executed-tests ratchet counts `rust_test`
binary identities and now pins a per-binary static test-case baseline. The older binary-only form
stayed green through this loss; the case ratchet was added specifically so the same deletion now
fails even while both crate roots remain reachable.

**Decision owner.** Deleting W-1 requires first moving `CAP-FIELD-CONSOLE.state.backend` off
`integrated_dark_on_pr488`, which is a program decision, not a refactor.

---

## W-2 · `P1DispatchTargetSummary` — `CAP-DISPATCH-CONSOLE`

**Code** `backend/crates/dispatch/application/src/lib.rs:122-128`

```rust
pub struct P1DispatchTargetSummary {
    pub dispatch_id: P1DispatchId,
    pub user_id: UserId,
    pub role: String,
    pub push_token_count: i64,
}
```

**Why it is WIRE.** `CAP-DISPATCH-CONSOLE` is declared with `state.backend =
"spine_landed_spec_consumed"` and `state.production_exposure = "dark"` — dark backend, deleted
frontend, same shape as W-1. This is the push-fanout target read-model for the notification
vertical, which is under active development.

**Correcting the deletion rationale.** The DELETE commit said it was "superseded by the
`count_dispatch_targets` aggregate the live read models actually use". That is not a supersession:
`count_dispatch_targets` (`backend/crates/dispatch/adapter-postgres/src/lib.rs:1466`) returns a
scalar `i64` used once, at `:113`, as a pre-flight "is anyone reachable" count before a dispatch is
created. `P1DispatchTargetSummary` is the per-target row — who was targeted, in what role, with how
many live push tokens. An aggregate cannot supersede the breakdown it aggregates.

**What wiring it requires.** A query in `dispatch/adapter-postgres` that projects the rows
`count_dispatch_targets` currently only counts — the `eligible_users` CTE at `:1488` plus the
`push_token IS NOT NULL AND btrim(push_token) <> ''` predicate already at `:885-886` — and a
`GET` fan-out surface on the dispatch REST crate to return them. No migration: `push_token` already
lives in `0010_create_mobile_sync_devices.sql` / `0011_create_p1_dispatch.sql`.
