# Authority tip — Wave-2 admit (dgo.1 / ae5 / i91)

**Date:** 2026-08-11
**Kind:** authority tip ledger bound on candidate C (product tip below); jurisdiction tip T is register-only (#618 grammar)
**Candidate (authority train):** `e288d290d87effecdc52f9ac1ad50dc49b4b1114` (immutable absolute SHA of the product tip that C parents; rekeyed at C commit time)
**Scope:** three critic-APPROVED leaves after #621 (v0.3.4) on main `e288d290d87effecdc52f9ac1ad50dc49b4b1114` ancestry base `e7f207eab0186b024eaaa3d56de1f9caffc59eda`. we1 HOLD optional (critic stalled).
**Not product authority.** Clears no HOLD beyond beads closed on merge. Makes no production tamper-evident claim for ae5 custody daemon (console-9gk).

## Summary

- **dgo.1:** distinct-natural-person four-eyes bar for Company/HR/Payroll (governance).
- **ae5:** ExternalSealSigner production wiring + custody transport (audit-chain / app). Custody daemon E2E remains HOLD.
- **i91:** own-property lookups for prototype-chain false-resolve across scripts/check-*.mjs (+ shared `scripts/own-property.mjs`). Residual census → console-g14a.

## Remaining HOLDs / follow-ups (not closed by this tip)

- console-we1 — leave §60⑤ consult; critic receipt missing (ef1e3fb8 stalled); re-dispatch before admit
- console-9gk — custody daemon E2E / do not overclaim gh#271 closed-as-tamper-evident
- console-g14a — i91.1 residual census
- console-9sxn — we1 OpenAPI lease
- console-uhlv — Actions secret RELEASE_PLEASE_TOKEN (ops; never commit value)
- console-umgn — converge heal-mode tip e13c00b58 still needs critic+admit (post-#621)

## Critic receipt binds (lane worktree APPROVE tips)

| leaf | product tip | critic |
|------|-------------|--------|
| dgo.1 | 1c0cec8b73fea98cba8de626c0a727a572045a22 | dgo.1-critic APPROVE |
| ae5 | e7e943565284c68a81c95ad1ebedf73a87e238d5 | ae5-critic APPROVE |
| i91 | 5a3f6742c30bb117296aace8291bbabfa4a129af | i91-critic APPROVE |

<!-- REASONING-LENS-EVIDENCE:START -->
```json
{
  "lens_contract": "v1",
  "task_class": "implementation",
  "risk_class": "high",
  "risk_domains": ["authz", "hr_payroll", "release"],
  "selected_lenses": [
    "Cartesian doubt",
    "Essentialism / YAGNI",
    "Chesterton's Fence",
    "Red Team",
    "Operability / Day-2",
    "Blast-radius / cell-based",
    "Zero-trust / defense-in-depth"
  ],
  "task_fit": {
    "Cartesian doubt": "Verified origin/main e7f207eab (#621) before cherry-pick; we1 critic transcript stalled at 2 lines — HOLD optional rather than invent APPROVE.",
    "Essentialism / YAGNI": "Admit only path-disjoint APPROVED trio; leave we1 out until critic receipt exists.",
    "Chesterton's Fence": "Keep #618 C=ledger+seed/index, T=jurisdiction-only grammar.",
    "Red Team": "Path overlap check dgo.1/ae5/i91 = NONE before serial cherry-pick.",
    "Operability / Day-2": "Ops bead console-uhlv for RELEASE_PLEASE_TOKEN; umgn residual annotated not re-landed as 621.",
    "Blast-radius / cell-based": "Single admission WT under hub .worktrees/; no sibling checkout writes.",
    "Zero-trust / defense-in-depth": "SSH-signed C and T; critic APPROVE receipts required for each admitted leaf."
  },
  "mandatory_lens_exceptions": {},
  "findings": [
    "we1 HOLD optional — no we1-critic.json.",
    "ae5 custody daemon E2E remains HOLD (console-9gk).",
    "Actions RELEASE_PLEASE_TOKEN tracked as console-uhlv — never commit secret."
  ],
  "challenges": [
    "Challenge: admitting without we1 might strand leave consult — accepted; brief gate allows HOLD-only-optional leaves."
  ]
}
```
<!-- REASONING-LENS-EVIDENCE:END -->
