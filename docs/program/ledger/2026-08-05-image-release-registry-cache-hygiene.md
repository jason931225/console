# Ledger — image-release registry BuildKit cache + GHA hygiene (2026-08-05)

## Identity

- Slice: B2 registry cache + automated GHA cache hygiene
- Base: origin/main post-#574
- Files:
  - `.github/workflows/image-release.yml` — `cache-from`/`cache-to` `type=registry`
  - `.github/workflows/cache-hygiene.yml` — daily + manual prune
  - `tools/ci/gha-cache-hygiene.mjs` — delete policy

## Decision

1. **Stop writing Docker BuildKit cache into Actions GHA storage.** Use GHCR refs  
   `ghcr.io/<owner>/console-app:buildcache-<arch>` with `mode=max` (safe on registry).
2. **Automate hygiene:** daily job deletes residual `buildkit-` / `index-` GHA keys and  
   enforces an 8 GiB soft budget without touching `v0-rust-` / `node-cache-` keys.

## Non-goals

- No change to multi-arch digests, Trivy, cosign, or production promotion
- No GHCR blob GC API (registry lifecycle is separate)

<!-- REASONING-LENS-EVIDENCE:START -->
```json
{
  "lens_contract": "v1",
  "lens_contract_digest": "ac1e7d6b8150808ef73e5e3cd1a1e54d2f37eb43e84aaa1370dbbaaff3c44373",
  "task_class": "implementation",
  "risk_class": "high",
  "risk_domains": [
    "release",
    "other"
  ],
  "selected_lenses": [
    "Cartesian doubt",
    "Essentialism / YAGNI",
    "Chesterton's Fence",
    "Pragmatism",
    "Red Team",
    "Systems Thinking",
    "Operability / Day-2",
    "Blast-radius / cell-based",
    "FinOps / unit-cost",
    "Telemetry-first",
    "Zero-trust / defense-in-depth"
  ],
  "task_fit": {
    "Cartesian doubt": "Inventory showed buildkit/index GHA keys not cargo caused the 10GB breach; fix moves Docker cache off Actions storage.",
    "Essentialism / YAGNI": "Registry cache refs plus a small scheduled hygiene script; no registry GC service or extra infra.",
    "Chesterton's Fence": "Keeps per-arch cache isolation (buildcache-amd64/arm64) so multi-arch builds do not clobber each other.",
    "Pragmatism": "GHCR already authenticated for image push; same login pushes buildcache tags.",
    "Red Team": "Hygiene never deletes v0-rust- or node-cache- prefixes; dry_run available on workflow_dispatch.",
    "Systems Thinking": "Image-release no longer writes GHA blobs; hygiene removes residual type=gha leftovers and enforces an 8GiB soft cap.",
    "Operability / Day-2": "Daily schedule plus manual dispatch; step summary reports before/after usage.",
    "Blast-radius / cell-based": "Only image-release cache lines and a new optional hygiene workflow; CI required contexts unchanged.",
    "FinOps / unit-cost": "Actions cache is a hard shared 10GB pool; registry storage is the correct place for multi-GB layer graphs.",
    "Telemetry-first": "Hygiene logs usage and victim counts; fails if still over budget after cleanup.",
    "Zero-trust / defense-in-depth": "Trivy/cosign/provenance gates unchanged; cache policy is performance isolation not admission weakening."
  },
  "mandatory_lens_exceptions": {},
  "findings": [
    "type=gha mode=max per image times arch filled ~10.3GB of the shared Actions cache.",
    "Registry cache keeps mode=max without competing with rust-cache.",
    "Scheduled hygiene deletes buildkit-/index- prefixes and enforces 8GiB soft max."
  ],
  "decisions_changed_or_rejected": [
    "Rejected mode=min on GHA as the long-term fix; chose B2 registry cache.",
    "Rejected deleting rust-cache in hygiene; keep-list is explicit."
  ],
  "lens_set_changes": []
}
```
<!-- REASONING-LENS-EVIDENCE:END -->
