# Wave-4 migration-slot ledger — APPEND-ONLY

**Owner:** the integrator. **Status:** live from 2026-07-25.
**Governs:** `backend/crates/platform/db/migrations/**` (a shared collision root).

This file is the only authority for which migration number a lane may use.
Entries are **appended, never edited or reordered**. A struck entry gets a new
appended row recording the strike; the original row stays.

---

## 1. The protocol

1. A lane that needs a migration **requests a slot** — lane id, subject, one
   line on what the migration does — and then waits.
2. The **integrator appends** a row here and assigns the number.
3. The lane names its file `manifests/migration/<NNNN>_<subject>.sql` inside its
   own worktree and hands it to the integrator as a manifest. Lanes do not write
   into `backend/crates/platform/db/migrations/` directly.
4. **A lane never picks its own number.** In particular a lane never runs `ls`
   on the migrations directory, because that directory shows only *this*
   worktree — see §2 for why that is not the same question.

Requesting is cheap. Colliding is not: two migrations with the same number are
not detected by `cargo`, `sqlx`, or any CI gate in this repo — they are detected
by a reviewer reading a merge diff, or not at all.

## 2. Why `ls` is the wrong instrument — the proven failure mode

Surveyed 2026-07-25 across every ref (`git ls-tree` on all
`refs/remotes/origin/*` and `refs/heads/*`, not `ls` on one worktree).

**`0197` is a live duplicate right now.** Two different subjects hold it:

| File | Where it lives |
|---|---|
| `0197_notice_audience_and_category.sql` | merged; on the spine and on this branch (`7dca8757`, 2026-07-24) |
| `0197_customer_site_registry_foundation.sql` | unmerged, on three live branches: `codex/customer-site-registry-foundation-20260724` (`54f9d658`), `codex/registry-current-base-review-fixes` (`5aef5164`), `review/registry-current-base-53bf6c0` (`5b139418`) |

Whichever lands second silently shadows or duplicates the first. Both authors
would have seen `0196` as the high-water when they ran `ls`.

**It is not an isolated slip.** Distinct subjects sharing one number, at ref
tips, today:

| Slot | Subject A | Subject B |
|---|---|---|
| 0092 | `add_payroll_access_features` | `create_absence_exit_workflow` |
| 0093 | `add_group_domain_role_scopes` | `settlement_certification` |
| 0117 | `comms_email_account_claim_token_fencing` | `search_trgm_indexes` |
| 0122 | `audit_events_action_created_at_idx` | `comms_account_by_address` / `create_leave_requests` (three-way) |
| 0124 | `audit_events_action_created_at_idx` | `workflow_trigger_binding_subject_kind` |
| 0125 | `comms_account_by_address` | `workflow_definition_pending_revision` |
| 0126 | `workflow_trigger_binding_subject_kind_idx` | `workflow_trigger_binding_subject_kind` |
| 0127 | `audit_events_action_created_at_idx` | `workflow_definition_pending_revision` |
| 0128 | `comms_account_by_address` | `workflow_trigger_binding_subject_kind_idx` |
| 0170 | `financial_purchase_request_queue_index` | `harden_object_policy_attachment_and_blockers` |
| 0181 | `financial_purchase_request_queue_index` | `leave_api_create_employee` |
| 0182 | `create_equipment_3r` | `financial_purchase_request_queue_index` |
| 0185 | `create_equipment_3r` | `financial_purchase_request_queue_index` |

Read the 0181/0182/0185 rows together: the same two migrations were renumbered
past each other three times by lanes each running `ls` on their own worktree.
That is the failure this ledger exists to end.

## 3. Seed state — surveyed 2026-07-25

Command of record:

```
for r in $(git for-each-ref --format='%(refname)' refs/remotes/origin refs/heads); do
  git ls-tree --name-only "$r" backend/crates/platform/db/migrations/
done | sed 's|.*/||' | grep -E '^0[0-9]{3}_' | sort -u
```

| Fact | Value |
|---|---|
| Highest slot on this branch (`claude/w4-epoch-20260725` @ `4cabe239`) | **0202** |
| Highest slot across **all** refs surveyed | **0202** — no ref carries anything above it |
| Refs at the 0202 high-water | `origin/codex/operational-object-runtime-progress`, `origin/codex/pr488-final-integration-v2-20260725` |
| `0202` subject | `0202_notification_policies_and_object_agg.sql` (`fe1e8b91`) |
| `0201` | **absent everywhere — RESERVED, unavailable.** Reserved gap for the evidence-retention subject. No lane may take it. |
| First free slot | **0203** |

## 4. Assignments

Appended by the integrator only. `assigned` means the number is spent — even if
the lane is later dropped, the number is not recycled.

| # | Slot | Assigned to | Subject | State | Appended |
|---|---|---|---|---|---|
| 1 | 0201 | — | evidence-retention (reserved gap) | **RESERVED — unavailable** | 2026-07-25 |
| 2 | 0203 | L-A1 | ontology catalog additive-upgrade path | assigned | 2026-07-25 |
| 3 | 0204 | L-X1 | deal aggregate — the CRM trunk | assigned | 2026-07-25 |
| 4 | 0205 | L-X2 | deal stage transitions + per-stage evidence enum | assigned | 2026-07-25 |
| 5 | 0206 | L-X3 | activity discipline + Closed-Lost reason enum + auto-Lost settings | assigned | 2026-07-25 |
| 6 | 0207 | L-X4 | deterministic round-robin owner assignment + bulk reassignment | assigned | 2026-07-25 |
| 7 | 0208 | L-X5 | Won → contract `C-` + large-deal threshold object | assigned | 2026-07-25 |
| 8 | 0209 | L-X7 | ontology projections (deal / listing / inquiry) | assigned | 2026-07-25 |
| 9 | 0210 | L-X8 | lead PII: consent, retention, masking, audited sensitive view | assigned | 2026-07-25 |
| 10 | 0211 | hf-leaveapi-revoke | REVOKE PUBLIC on leave_api.assert_employee_directory_manager (SECURITY DEFINER authz helper) + restore the six→seven deny-by-default tripwire | assigned | 2026-07-25 |

Next free slot after the seeded assignments: **0211**.

### Standing hazards for these nine

- The 0197 duplicate above is **still unmerged on three branches**. If any of
  them is admitted, its file must be renumbered to a slot requested here first.
- `codex/equipment-evidence-custody-20260724` tops out at 0184 and
  `codex/console-fanout-planner-hardening-20260724` at 0183; both are ~19 slots
  behind and will renumber on admission. Neither may self-assign.

## 5. Requesting a slot

Open a request to the integrator with exactly this shape:

```
slot request
  lane:    L-XN
  subject: <snake_case_subject>          # becomes the filename suffix
  does:    <one line>
  tables:  <new tables, or "none">       # every new table needs FORCE RLS
```

The integrator appends a row to §4 and replies with the number. There is no
self-service path.

> **Integrator deviation, recorded 2026-07-25.** Slot 0211 was assigned after the
> integrator first mis-allocated 0203 by surveying migration *files* across refs
> instead of reading §4 — the exact failure rule 1.4 forbids. The lane caught it
> and did not self-reassign. Its migration was also written directly into
> `backend/crates/platform/db/migrations/` rather than handed over as a §1.3
> manifest, because the integrator briefed it that way; accepted as-is this once
> since the integrator lands it immediately, and a manifest round-trip would add
> a copy step with drift risk and no safety gain. §1.3 still stands for lanes the
> integrator is not landing in the same pass.
