# Authority tip — fail-closed Sol/Codex harness defects on the scout candidate

**Date:** 2026-08-09
**Kind:** authority tip (T) for candidate `df5ccb0ce9215d51bc7b0cf5f67f238809e650eb`
**Scope:** `.claude/workflows/{scout,lane-fanout,backlog-audit,stale-take-audit}.js`, `.claude/workflows/lane-fanout.test.mjs`, `scripts/check-platform-contract-drift.mjs`.
**Not product authority.** Clears no HOLD. Touches no backend crate, no migration, no OpenAPI document.

## Summary

Sol critic BLOCK findings (and matching Codex review threads) re-verified on tip `7e891c306`, then fixed on candidate `df5ccb0ce`:

1. **scout.js — unverified edges dropped.** A dead edge-verification batch no longer keeps the stored edge in `corrected`. No verdict → no edge (fail closed).
2. **lane-fanout.js — hollow `commandsRun` refused.** Every `commandsRun` entry must be a non-empty string; `commandsRun: [""]` and blank-among-real both refuse convergence. Claimed-command coverage (every claimed command re-run) remains enforced.
3. **check-platform-contract-drift.mjs — mask string literals before method scan.** Prose like `"documentation says get() here"` cannot invent a false GET. Generic nonlocal `PATH`/`ROUTE` names refuse repo-wide fallback. OpenAPI path keys may contain `:` (e.g. `/api/jobs:run`).
4. **scout.js — incomplete fanout handoff.** Replaced advertised `fanoutArgs` with `fanoutPlan: { status: 'incomplete', … }`; scout does not invent tip/wt/brief/accept.
5. **scout.js — path canonicalization.** `./backend/crates/foo/` and `backend/crates/foo/` collide before partition; `..` rejected.

Same-class Codex fail-closed items also closed: crate census completeness vs on-disk `Cargo.toml` tree in `backlog-audit.js`; stale-take confirmer must attest `missingFromHead` before publishing STALE.

## Verification

- `node .claude/workflows/lane-fanout.test.mjs` — 193 PASS, ALL PASS (includes regression probes for each fail-open above).
- `node scripts/check-platform-contract-drift.mjs` — PASS, 582 backend `/api/` operations across 54 route sources.
- `git diff --check origin/main...HEAD` — clean.

## HOLDs remaining

Unchanged. No production promotion, no frontend, no payment execution, no invented compliance scope.

<!-- REASONING-LENS-EVIDENCE:START -->
```json
{
  "lens_contract": "v1",
  "lens_contract_digest": "ac1e7d6b8150808ef73e5e3cd1a1e54d2f37eb43e84aaa1370dbbaaff3c44373",
  "task_class": "implementation",
  "risk_class": "high",
  "risk_domains": [
    "contracts",
    "release"
  ],
  "selected_lenses": [
    "Cartesian doubt",
    "Essentialism / YAGNI",
    "Red Team",
    "Operability / Day-2",
    "Blast-radius / cell-based",
    "Zero-trust / defense-in-depth"
  ],
  "task_fit": {
    "Cartesian doubt": "Re-verified each Sol BLOCK against tip 7e891c306 before coding; only defects that still reproduced were fixed.",
    "Essentialism / YAGNI": "Returned an explicitly incomplete fanoutPlan instead of inventing tip/wt/brief/accept a scout must not decide.",
    "Red Team": "Blank commandsRun, unverified edges, and string-literal HTTP verbs were treated as adversarial false-greens.",
    "Operability / Day-2": "Regression probes live in the offline preflight so the next tip cannot re-open these fail-opens silently.",
    "Blast-radius / cell-based": "Owned-root canonicalization keeps equivalent path spellings from landing in two concurrent lanes.",
    "Zero-trust / defense-in-depth": "No verdict is treated as a stored-edge yes; no blank command is treated as a run; no prose get() is treated as a route."
  },
  "mandatory_lens_exceptions": {},
  "findings": [
    "Unverified scout edges were still planned from when verification returned null.",
    "commandsRun:[\"\"] could look like an answered verifier after blank filtering.",
    "String literals inside method expressions could invent HTTP verbs.",
    "Scout advertised a handoff lane-fanout would abort on.",
    "./ vs bare owned roots did not collide before partition."
  ],
  "decisions_changed_or_rejected": [
    "Rejected inventing tip/wt/brief/accept in scout; returned an explicitly incomplete plan type instead.",
    "Rejected silently filtering blank commandsRun entries; any blank fails closed."
  ],
  "lens_set_changes": []
}
```
<!-- REASONING-LENS-EVIDENCE:END -->
