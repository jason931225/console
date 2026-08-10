# Authority tip — fail-closed Sol/Codex harness defects on the scout candidate

**Date:** 2026-08-09
**Kind:** authority tip (T) for the cargoTomlPaths / owned-root canonicalize candidate
**Candidate (authority train):** sole parent of this tip (`git rev-parse HEAD^`)
**Workflow fix commit:** `1e8209bba27531f8c3b587e6df1f41803e3b5d70`
**Scope:** `.claude/workflows/{scout,lane-fanout,backlog-audit}.js`, `.claude/workflows/lane-fanout.test.mjs`, `docs/documentation-manifest.seed.json`, `docs/documentation-index.json`.
**Not product authority.** Clears no HOLD. Touches no backend crate, no migration, no OpenAPI document.

## Summary

Codex P1/P2 fail-closed findings on tip `d9baa2879`, fixed on the workflow commit above (authority-train candidate C is this tip's sole parent):

1. **backlog-audit.js — no Node fs census.** Collect requires `cargoTomlPaths` from `find backend/crates -name Cargo.toml`; the script derives on-disk names and still aborts via `cratesOmittedFromCensus`. Empty or omitted paths fail closed.
2. **lane-fanout.js — canonicalize owned roots.** Strip `./`, collapse `.`, reject `..` before `pathOverlap`, so `./backend/crates/foo` and `backend/crates/foo` collide at dispatch.
3. **scout.js — absolute paths outside REPO.** Require an exact repo-root path boundary; sibling worktree prefixes no longer become fake owned roots.
4. **scout.js — downstream depth.** Depth walks reverse edges (what a ready bead unlocks), not prerequisites.
5. **scout.js — rejected count before dedupe.** Failed normalisations are counted before `Set`, so multi-file beads under one directory are not mis-deferred.
6. **Documentation manifest.** Seed/index register the fail-closed ledger path with the tip blob (product paths on C); tip bytes land on T.

## Verification

- `node .claude/workflows/lane-fanout.test.mjs` — 206 PASS, ALL PASS.
- `node scripts/check-platform-contract-drift.mjs` — PASS, 582 backend `/api/` operations across 54 route sources.
- `node scripts/console/generate-documentation-manifest.mjs --check` — OK (418 markdown files).
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
    "Cartesian doubt": "Reproduced Codex P1s on tip d9baa2879: node:fs import in backlog-audit and ./ vs bare owned-root disjointness in lane-fanout.",
    "Essentialism / YAGNI": "Replaced the fs walk with Collect.cargoTomlPaths rather than widening sandbox privileges.",
    "Red Team": "Treated empty cargoTomlPaths, sibling-worktree absolute prefixes, and ./ ownership spellings as adversarial false-greens.",
    "Operability / Day-2": "Regression probes cover cargoTomlPaths omission, ./ overlap, absolute-outside-REPO, downstream depth, and rejected-before-dedupe.",
    "Blast-radius / cell-based": "Canonical owned-root compare keeps equivalent path spellings from dispatching two writers against one root.",
    "Zero-trust / defense-in-depth": "Census completeness is cross-checked against an agent-supplied find oracle the sandbox cannot forge via Node fs."
  },
  "mandatory_lens_exceptions": {},
  "findings": [
    "backlog-audit imported node:fs after Collect, which sandboxes reject.",
    "lane-fanout pathOverlap treated ./backend/crates/foo and backend/crates/foo as disjoint.",
    "scout normaliseRoot accepted absolute paths outside REPO via prefix match.",
    "scout depthOf walked prerequisites, so every ready bead scored depth 0.",
    "scout counted rejected paths after Set dedupe, deferring multi-file beads."
  ],
  "decisions_changed_or_rejected": [
    "Rejected restoring Node filesystem access in workflow scripts; Collect must return cargoTomlPaths.",
    "Rejected leaving P2 absolute-path and rejected-before-dedupe defects open once they were clearly broken and cheap."
  ],
  "lens_set_changes": []
}
```
<!-- REASONING-LENS-EVIDENCE:END -->
