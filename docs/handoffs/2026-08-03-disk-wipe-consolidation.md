# Disk-wipe consolidation handoff — 2026-08-03

This is the durable restart record for a machine with none of the old worktrees,
branches, caches, ignored files, or chat context. Read it only from the latest
`origin/main`; local refs named below are evidence identities, not continuation
dependencies.

## Fresh-session entrypoint

Restore GitHub authentication and the repository's signed-commit configuration
from approved external custody, then start from a new clone with no local branch
other than `main`:

```sh
gh auth status
gh repo clone jason931225/console console
cd console
git switch main
git pull --ff-only
gh pr list --state open
```

Then read, in order:

1. `AGENTS.md`
2. `HANDOFF.md`
3. this file
4. `docs/PIVOT-2026-07-28.md`
5. `docs/program/README.md`
6. `.omx/plans/reasoning-lens-contract-execution-handoff.json`

At candidate-writing time, PR #552 was merged and release `v0.3.1` pointed to
`435e251edfab12750850d5b1d411528b10a3ed8a`; PR #562 was still the sole open PR.
That is a historical observation, not a completion claim. Do not wipe until a
later closeout on `main` records #562's exact candidate/authority/merge identities,
green run URLs, branch-protection readback, and any generated release PR. In a
future session, inspect those exact identities; a newly opened unrelated PR or a
newer CI run does not retroactively make this consolidation incomplete.

## Canonical branch and scope

- `main` is the only integration target. No `dev` or `develop` branch existed
  locally or remotely during the audit.
- The remote-ref audit began with 252 branch heads. It removed 250 exact,
  individually enumerated heads: 167 were heads of merged PRs, 76 were
  unassociated pre-pivot leftovers, six belonged to closed-unmerged PRs whose
  only useful final net was already preserved here, and one was the rejected
  post-pivot Cosskorea lane. During review, only `main` and PR #562's
  `docs/session-handoff-2026-08-02` head remain. GitHub's
  `deleteBranchOnMerge` setting is enabled; after #562 and any release PR merge,
  verify that `main` is the sole branch rather than recreating deleted refs. The
  exact point-in-time deletion inventory is
  [`2026-08-03-remote-branch-deletion-manifest.tsv`](2026-08-03-remote-branch-deletion-manifest.tsv).
- The product boundary remains Ontology/Foundry/Policy → Company/OrgUnit/Employee
  → HR/Payroll. ERP, field operations, dispatch, communications, compliance as a
  product, ingest/evidence, office editing, AI judgment, and frontend work remain
  outside the active pivot unless a later owner decision changes it.
- Cargo is the chosen build system. Buck2 is still present because its remaining
  test/build reachability must be replaced with measured Cargo parity before a
  dedicated removal train deletes it.
- Local branch names, worktree status, OMX/OMC runtime state, and old handoffs do
  not establish program completion or authority.

## CI and merge boundary

- Release `v0.3.1` and its exact `main` commit passed the complete CI workflow,
  including the serialized PostgreSQL reachability lane, before the
  consolidation candidate was finalized.
- PR #562 must publish the truthful `API contract — text-only contract checks`
  context. Before merge, branch protection must replace the obsolete
  `API contract — app-served OpenAPI` requirement with that exact context and
  add the already-running `Domain crates — unit tests` and
  `dev-up.mjs smoke — compose deps + migrate + /readyz` contexts. Preserve strict
  up-to-date checks, the existing GitHub Actions app binding, every other
  required context, and read the rule back after the update.
- Every final candidate is reviewed at its exact SHA by two independent
  adversarial reviewers. PR #562 additionally requires a formal approving
  GitHub review from someone other than its author, with no unresolved review
  findings and all required checks green, before squash merge.
- Interim signed tip `900c1749a94f945deaa85cc5097a51287620dd95` was
  pushed to PR #562 as a remote disaster-recovery checkpoint and then made draft
  after hosted verification exposed defects. It is superseded by the later exact
  C/T pair recorded in the final authority ledger and must never be merged on the
  strength of its partial checks.
- Signed repair checkpoint `baadf03cf4692754fd0b964834e324d14e48f20e`
  was also pushed while the PR remained draft. It adds the reviewed Buck test-face
  reconciliation and a provenance-safe deploy-test harness. A clean fast verifier
  passed every non-authority stage at that checkpoint; its two exact-M admissions
  correctly rejected the head because a content checkpoint is not the required
  ledger-only direct-child authority tip. It is recoverable evidence, not merge
  authority; only the replacement C/T pair may proceed.
- Two signed archive tags make provenance commits outside the post-pivot main
  ancestry reproducible from a fresh clone:
  `archive/pre-pivot-implementation-freeze-2026-07-24` resolves to
  `78cb5197927a031ead30c6dc0426c23455d3cb16`, and
  `archive/pivot-authority-base-2026-07-28` resolves to
  `d138ed28b65fa6dbec01bd8022be5a4e1db57687`. The truth-ledger validator
  binds the advertised refs to their exact commits; a bare SHA is no longer
  accepted as durable custody.

## Non-authoritative external opinion

During consolidation the user relayed an external static audit as an opinion,
not repository authority. It praised the domain model and supply-chain controls
while criticizing unfinished pivot convergence, CI brittleness, repository
size, and operational-readiness claims. The auditor did not run the complete
PostgreSQL suite or deploy the system, and individual observations may be
incomplete, stale, or wrong. Treat every score, claim, and recommendation only
as a hypothesis. The audit authorizes no deletion, restructuring, product
scope, release, deployment, or production claim; only findings reproduced
against current authoritative sources may enter implementation or program
state.

## What was preserved

The following useful final nets were prepared in the signed consolidation
candidate intended for PR #562. They become durable only when the PR head is
pushed and read back at the exact candidate/authority tip, then merged. Source
identities let future archaeology distinguish reviewed work from coincidental
similarity; no source branch is a continuation dependency.

| Area | Preserved outcome | Source identity |
| --- | --- | --- |
| Earlier PR #562 | Full 2026-08-02 handoff, its correction ledger, a main-gate simulator, and MJS test-reachability helper | old head `20cef095ae9bea4d920e5210effc4910ff635370`, joined by signed merge `9ce8e2a151742d3e7bdaed70000ca56d6172173d` |
| Post-pivot truth | Root guidance and current program documents reconciled to the pivot; migration parser handles qualified, multi-action `ALTER TABLE` | `f276d323b179473badf593bf858abb5dd5b94885`, `bd31825f46bcd4e00118e2b2f45938480b37bc2e` |
| Reasoning contract | Frozen 16-lens vocabulary, root manifests, evidence schema, templates, validator, and tests | `ed8424f5153b760162545e0ea669a4be5950280a`, `963302685bae2c28d7c6107dc2bb0b4f902392cd` |
| Test-graph decision | Proposed One Graph ADR records the Cargo-native direction without prematurely deleting Buck2 | `fcca3fab3fcf1a784e1794c6edf2c61bdfc6abb9` |
| Ignored planning packet | The exact approved Ultragoal/ralplan context, plan, and architect/critic handoff were deliberately force-added | `dff758724f7b428584a602cee7b2429dfbd7c5c1` |
| Domain attempt | Only the six-finding `BLOCKED` disposition was kept; no domain/DNS/credential implementation was admitted | `bdd24a16a7373522245c7ffcffb85fdedc0ec752` |
| Branch authorization | Eighteen fabricated-branch helpers were replaced with capability authorization; the final correction also removed the three path-wide gate exemptions and repaired concrete tenant/branch boundaries in HR exit reporting, registry site creation/master import, and reporting rollups. The changed pure tests and PostgreSQL regressions are CI-reachable. | initial implementation `8d7871a96f0fdcfd387d1e05260237d4eeec9b2b`, gate `9d4a136903c4d5d7978a046d0db9d2293a944ce5`; final signed C named by its direct-child authority ledger |
| Personal-data classification | Schema-derived closed-vocabulary column classification, exact-name baseline, database assertion, CI reachability, and payroll classifications. The final correction preserves the official instrument's one-/two-year unit, keeps schema introspection owner-only, and removes the out-of-pivot compliance product route. | `fccdf5288f916c5180045ef19d4daaa395998fbf` through `851b999f49222a4d04282088f508f552469d756d`; final signed C named by its direct-child authority ledger |
| Gate integrity | Request-body and undeclared-import false-green repairs, plus CI preflight enforcement of `openapi_drift` | `1ec3e69d7ec3b8348561d2d699326f0949258521` |
| Documentation gates | Stale citations were reconciled and local-link checking learned to ignore inline-code examples while still checking adjacent real links | `d90f127654e0b4b0fe423304bbf5086e3cc24228` |
| CI/tooling ratchets | Exact executed-test named sets, Cargo/feature reachability, credential argv hardening, local-CI parity, and removal of dead post-pivot tooling. The complete ten-job surface now locks 95 run steps, 29 action steps, job/workflow envelopes, and unfiltered required-context triggers. The final repair admits registry/reporting inline tests to the generated Buck face, updates both app inline-test cardinality locks, and runs fresh command doubles through load-bearing Bash wrappers so macOS provenance checks cannot turn an expected deploy failure into a harness timeout. | reduced from `09f147a7`, `26491630`, and `eb60e2e4`; final execution lock `3d5f0b0649b21c8e647b2fa31ec40bd2aeeb8fec`; repair checkpoints `aba19c8db6fa66ee4a6e642f72471e00dc65483f` and `baadf03cf4692754fd0b964834e324d14e48f20e` |
| Security proofs | Five required security contexts have exact parsed job/proof contracts; Trivy installs checksum-pinned before checkout, Cargo audit/deny use isolated direct binaries, and exception-policy regressions execute. Hosted execution caught the direct `cargo-audit` invocation missing its required `audit` subcommand; the final correction fixes and mutation-locks that exact command. | `d6cfedfd1c8230ca6e5ea43053d1ccc7dbcc2026`; final signed C named by its direct-child authority ledger |
| Program boundary | The generic instance-backed `company_conformance` fixture remains useful engine regression evidence but is explicitly not the Company/HR projected product target. Replacement conformance and projected Company/Person/Employment/PayRun work remain HOLD until owning-port and single-writer contracts exist. | final signed C named by its direct-child authority ledger |
| External PR authority | Unsigned fork and Dependabot heads fail the same protected-main C/T authentication instead of reporting a successful skip. | `e448f48ea840af2258d5bb374a9185e93b9d838e` |
| Release | Release-please 0.3.1 manifest/changelog plus an independently reviewed authority train | PR #552, C `5e297ca0ab2134e793bb40d5999908606ef1e050`, T `bab0ff594b1b66c85aaaa8c92ffcbedc88c0c2c2` |

## What was deliberately discarded

Discarded means “do not reconstruct it from reflogs or backups after the wipe.”

| Candidate | Disposition |
| --- | --- |
| Audit-boundary lane (`1f426033`) | Rejected in review. It changed the public policy-audit snapshot from `{user: UserSummary}` to an unversioned flat object and replaced the actual `team` ABAC value with `team_recorded`, preventing reconstruction of team-driven authorization. The remaining kernel API was opt-in, bypassable, and unused, so it was not kept as speculative infrastructure. |
| Ontology field-policy lane (`20ce7536`, integrated/reviewed as `090b927a314699a80d11ac655bfab4bdc19a71bf`) | Rejected by two independent high-risk reviews and signed-reverted in `3a3619a5a8c8c3871f5bbf3d7446ec3fb02e1033`. The granted command-role SQL entrypoint could bypass four-eyes and spoof/null the actor; migration 0212 activated previously untrusted attachments as `read_field`; and rollback to pre-enforcement application code would expose protected fields with no detach/repair or compatibility floor. A future implementation must atomically consume the exact grant in the definer, quarantine or reject historical rows, and design forward repair plus rollback-safe deployment. |
| Cosskorea domain code (`f3a0d9d8`; 13 paths in the final reviewed package, of which eight code/deploy paths remain dirty in the original root checkout) | Rejected after five correction rounds. Six sustained defects include session-takeover risk, unbound WebAuthn evidence, unsafe consent provenance, unusable ordinary-user recovery, missing served-certificate proof, and broken rollback cleanup. The authoritative disposition is [`docs/program/ledger/2026-08-03-cosskorea-domain-swap-blocked.md`](../program/ledger/2026-08-03-cosskorea-domain-swap-blocked.md). It explicitly revokes the superseded 2026-08-02 handoff's “ready to execute” instructions; the blocker ledger is the only durable artifact. |
| Generic work graph/handover slice (`7390720`) | Outside the hard post-pivot boundary and overlapping current authz/ontology objects; retaining it would create an unowned second design. |
| Workflow notifications, workflow approval, the broad reporting feature lane, broad audit, and other dirty feature lanes | Outside the active pivot and not necessary for a stable restart. This does not discard the narrow reporting tenant-scope repair preserved above. |
| KubeSpan worker ADR/work | Live topology was not authoritatively established and the work was not needed for this consolidation. The irreplaceable OCI node must not be used as an experiment. |
| Full Buck2 deletion | Deferred, not forgotten. Deleting it before Cargo reaches every current test would create invisible tests; ADR-0039 preserves the measured replacement direction. |
| Stash `546f0` | Obsolete employee-import fragments and removed React work; current main contains the fuller backend implementation and the frontend was intentionally deleted by the pivot. |
| Old authority/merge repair branches and historical worktrees | Superseded by reviewed PR contents or by main; branch topology itself carries no product value after squash merge. |

## Ultragoal and planning continuity

Most ignored `.omx` state was runtime churn: approximately 3.6 GB and 138,000
files of sessions, temporary worktrees, caches, logs, and superseded goals. `.omc`
contained no durable unique plan. Exactly three immutable planning inputs were
retained byte-for-byte, together with one tracked execution status record:

| Artifact | SHA-256 |
| --- | --- |
| `.omx/context/reasoning-lens-contract-20260803T101035Z.md` | `dea80c0a1fa5cc47c7ba12e4ee1c62480cd675e7b26bf33434ddf1fc94be61e4` |
| `.omx/plans/reasoning-lens-contract.md` | `76dc05561d7d6c07ee26afb68ea60841321eab7516f6d0546ba96d41825aad5c` |
| `.omx/plans/reasoning-lens-contract-handoff.json` | `db3ca7563223e271c6cf481a5766cfe6b96d2c73dbcf8dbaa5fa12092c010fc2` |
| `.omx/plans/reasoning-lens-contract-execution-handoff.json` | `0604281adacaca79263e891945e40866f4d053300203b8d131a91292801ea630` at the replacement-candidate sealing stage |

The original JSON correctly says execution had not started at the instant the
architect/critic plan was frozen. Do not edit that historical claim. The sibling
`reasoning-lens-contract-execution-handoff.json` is the machine-readable receipt
for subsequent implementation and verification. Its state and checksum change
until the consolidation closeout is committed; the first three hashes above do
not. A fresh session should continue from current program state and the latest
tracked receipt; it should not rerun the old Ultragoal as if implementation were
pending.

## Ignored files and secrets

Git cannot safely preserve live secrets. Before the disk is erased, copy the
values of `DISCORD_BOT_TOKEN` and `DISCORD_WEBHOOK_URL` from the ignored root
`.env` into an approved external secret manager, then rotate them if feasible.
Channel identifiers and the `CLAWHIP_*`/`GAJAE_*` entries are workstation-local
configuration; preserve them externally only if those tools are still needed.
Never commit `.env` or paste its values into an issue, PR, handoff, or log.

The repository is not sufficient to reconstruct workstation identity or
infrastructure access. Before wiping, escrow or deliberately reissue the private
material behind the configured SSH commit-signing key (`~/.ssh/id_ed25519`), OCI
SSH/API access (`~/.ssh/mnt_oci`, `~/.oci/config`, and
`~/.oci/mnt_api_key.pem`), GitHub CLI/keyring authentication, and any needed
`~/.kube/config` or `~/.talos/config`. Store them only in an approved encrypted
secret manager or backup. The kubeconfig observed during this consolidation
points at the shared laptop cluster, not proven OCI production; preserving it
does not change that authority boundary. After restore, verify `gh auth status`
and a throwaway signed commit's displayed signer before relying on either.

The ignored `ops/.dev-secrets/jwt-private.pem` and `jwt-public.pem` are local
development keys generated by the dev bootstrap and should be regenerated, not
backed up. Also discard `node_modules`, Rust/Buck build outputs, `.tmp`,
`.local-dev`, Python caches, Tofu provider locks/state generated in scratch
areas, and the remaining OMX/OMC runtime directories. The durable root
`.gitignore` now ignores newly generated `.omx/` runtime content; the four
already tracked planning/status files remain tracked. Also discard
`.superpowers` progress and temporary review packets under `/tmp`: they contain
interim Coss approvals superseded by the final `BLOCKED` record and are a
specific resurrection hazard.

The repository is self-contained after the merge except for intentionally
external secrets and infrastructure credentials. No unmerged local code or
planning context is a prerequisite for the next session.

## Safety holds that survive the wipe

- Never destroy, terminate, resize, or reprovision the grandfathered OCI Ampere
  A1 instance (4 OCPU / 24 GB). Re-creation permanently loses capacity.
- The laptop's `kubectl` context is not proof of the OCI production cluster and
  is shared with another repository. Confirm context and authority before any
  cluster observation; mutation still requires explicit authorization.
- Korea's six compliance controls remain `HOLD` until qualified Korean
  legal/compliance authority validates them. GitHub material is not a legal
  source, and `LAW_OC`/raw API responses must never be committed.
- No live DNS, TLS, production, credential-reset, WebAuthn, release exposure,
  payment, or compliance-claim operation is authorized by this handoff.

## Next product work

Continue from the sequence in `docs/program/README.md`: prove remaining Cargo/CI
equivalence and advance the bounded ontology/company/HR/payroll program. Recheck
the pivot before accepting any resurrected branch. For every proposed recovery,
ask whether main already contains the outcome, whether it is inside the current
scope, whether its source of truth is singular, and whether its exact tests are
reachable from CI. Do not use the existing `company_conformance` fixture to
dispatch projected Company/HR work; its current HOLD is recorded in
`docs/program/CATALOG.md`. Default to leaving rejected branches dead.
