# False-green gate holes — eight confirmed, one shape

Recorded 2026-07-25 during the wave-4 hotfix pass. Every item below was a
**confident green over a broken reality**, and not one was caught by a gate —
each was found by a person or agent reading code and checking a claim.

They share a single shape: *the check verifies a proxy for the contract instead
of the contract*. Listing them together because the remedy is a class of gate,
not eight patches.

## H-1 · The drift gate compares path inventories, not request bodies

`openapi_drift` asserts that every configured route appears in `openapi.yaml`.
It never compares an operation's `requestBody` against the `#[derive(Deserialize)]`
struct the handler binds. So a spec can publish a body shape the server rejects
and CI stays green.

**Proven twice.** (a) The equipment handover fragment, applied ahead of its crate
diff, would have 422'd every console handover with no gate objecting. (b)
`PayrollRunStatus` was missing seven statuses across two schemas — green under
every existing gate, caught by reading the migration's CHECK constraint.

**Proposed check.** Diff each operation's `requestBody` required-set and property
names against the handler's bound struct. `#[serde(deny_unknown_fields)]` makes
the request direction strictly decidable: an undocumented field is a guaranteed
422, not a maybe. Enum variants as step two — that is the shape the payroll bug
took.

## H-2 · Hand-written client types bypass the generated ones entirely

`web/src/console/equipment/**` declares its own local interfaces instead of
consuming `clients/ts`. `tsc -b`, `check:api-drift:portable` and
`check:api-drift:swift` therefore all pass while the console posts
`evidenceReference` at a server that now requires `evidenceObjectId`.

This is H-1 from the opposite direction: H-1 is spec-vs-handler, H-2 is
console-vs-spec. A hand-typed client diverges from a *correct* spec with every
gate green.

**Proposed check.** Fail when a console module declares a local interface whose
shape shadows a generated schema, or — cheaper and blunter — require that any
module calling `/api/**` imports its types from the generated client.

## H-3 · Unit tests hand-feed literals the real column never produces

The §61 notice printed `미사용 연차 유급휴가는 13.000000일입니다` to workers.
`employees.leave_remaining` is `NUMERIC(16,6)` (widened by 0166), but **every
unit test hand-fed `notice_body` a `"13.00"` literal**, so only the DB-backed
test ever saw the real column.

**Proposed check.** Not fully mechanisable, but the operational rule is: any
value that reaches a user-visible or legally-operative string must have at least
one assertion sourced from the real column, not a fixture literal. Enforce in
review; the DoD already requires a runtime-role test per module — this says what
that test must *cover*.

## H-4 · The test suite resolves a package the lockfile does not contain

`package-lock.json` pins `react-router@8.3.0` and has **no `react-router-dom`
entry at all**; nothing in the workspace declares it. Local `node_modules`
nonetheless carried `react-router@7.17.0` *and* `react-router-dom@7.17.0` — a
stale tree matching neither. Local `tsc` and `vitest` passed against a phantom
package; CI runs `npm ci` from the lockfile and would fail to resolve, with 9
suites failing to LOAD (0 assertion failures).

Every web "green" in this program to date — including the coordinator's own
2792/2792 — was measured against that phantom tree.

**Proposed check.** A CI step (or pre-push gate) that verifies the installed tree
matches the lockfile, and a lint that fails on importing a package absent from
the manifest. `npm ls <pkg>` exits non-zero for undeclared packages; that alone
would have caught it.

## H-5 · A migration red/green proof can be a stale binary

`sqlx::migrate!` embeds the migration set at **compile time**, and cargo does
not track `.sql` files as inputs. So the standard red-proof ritual — remove the
migration, watch the test go red, restore it, watch it go green — produces a
**valid red and a meaningless green**: the restoring run links the stale binary
that still has the migration embedded, and would have passed either way.

Found first-hand by the L-A1 stage-2 verifier, which hit it while proving its
own work and reported it rather than banking the green.

**Rule for every backend lane.** A cargo red/green over a migration must touch a
crate source file, or `cargo clean -p <crate>`, *between the halves*. Otherwise
the green proves nothing. Buck is unaffected — the migrations tree is a declared
input there, so it rebuilds correctly.

This one is worse than H-1…H-4 in a specific way: those hid defects in the
product. This hides defects in **the evidence** — it can make a lane's proof of
correctness fraudulent without the lane intending anything of the kind.

## H-6 · A gate whose own fixture made it unfalsifiable

The PR 473 migration operational gate requires exactly one libtest
selection/result/summary per guarded regression. Its summary pattern ended the
line at `filtered out;` — but libtest **always** closes with ` finished in
<n>s`. That pattern could not match any real run, on any stream, so the gate
could never pass. It also read `completed.stdout`, while Buck2's simple console
(every non-TTY, i.e. every CI run) replays a test's captured stdout on
**stderr** under a `[<ISO8601>] ` prefix per line, defeating its `^` anchors.

The gate's unit test did not catch any of it, because the fixture hand-wrote a
summary line libtest never emits — **H-3, inside a gate**. That is the sharpest
form of this failure: H-3 in a product surface produces one wrong number; H-3 in
a gate silently disarms every check that gate is supposed to enforce.

It stayed invisible because CI preflight had been red on this lineage, so the
backend job had never run. A gate that has never executed is not a gate, and its
presence in a job list is not evidence of anything.

**Rule.** A gate that parses tool output must have at least one fixture captured
from a real run of that tool, pasted verbatim, not reconstructed from memory of
the format. Reconstructed fixtures test the author's belief about the format,
which is exactly the thing in doubt.

## H-7 · A display concern wired into a fetch dependency

Not a gate hole — a defect *class* the gates cannot see, recorded here because
it was found the same way (reading code behind a "flaky test").

The evidence register decorated rows with display names at fetch time, making
`resolveNames` a dependency of `loadList` and therefore of the list effect. When
the user directory resolved, the effect re-fired and re-seeded rows from the
**list** endpoint — which carries no holds, custody or copies. An evidence
object opened before the directory landed was redrawn as unheld, its chain of
custody empty. A legally-operative falsehood, produced by a cache-warming
refetch.

CI called it a flaky test. It was the product losing a race.

**Rule.** Data that a surface presents as authoritative must never be
re-seedable from a lossier endpoint. Derive display concerns at render; keep
fetched wire truth in state untouched. When a test in an authoritative surface
"flakes," suspect the surface before the test.

## H-8 · A CI rewrite silently deleted the workspace test run

The largest hole, found while checking whether a *different* known-red test had
been caught. It had not — and the reason turned out to be a regression on this
very branch.

On `main`, `scripts/check-pr473-migration-operational.py` runs three things: the
exact Apalis database tests, **`cargo test --workspace`** (with `--skip` for the
guarded names so they are not run twice), and the 11 guarded regressions. Main's
green backend job reports **491 libtest result lines totalling 1,548 tests**, and
the gate prints `…3 exact Apalis database tests, workspace, plus 11 exact
guarded tests`.

Commit `77768668 fix(ci): run PR473 SQLx gate through Buck harness` — **empty
body, no stated rationale** — rewrote that gate to drive the new Buck2
disposable-PostgreSQL harness and, in the same 418-deletion diff, removed the
`--workspace` invocation. Nothing anywhere in CI replaced it. The backend job
went from executing ~1,548 tests to executing roughly fifteen.

The file's own docstring still reads *"Run the PR 473 migration regressions once
each, **without weakening workspace tests**."* The sentence survived the change
that falsified it.

After the removal, the complete set of Rust test executions across all six
workflows is:

| | |
|---|---|
| `//backend/crates/support/domain:mnt-support-domain-unit` | one crate's unit tests |
| `//backend/app:mnt-app-unit` | the app's `src` unit tests |
| `mnt-gate-tenant-isolation --test owner_only_acl_postgres18` | one file |
| `mnt-platform-auth-rest --features dev-auth` | one package |
| `mnt-platform-provisioning --test dev_principal_upsert_race` | one file |
| the PR 473 gate | 4 disposable-PostgreSQL targets + 11 named regressions |

There is **no workspace-wide `cargo test` anywhere in CI**. Against that, the
workspace holds **156 crates**, **148 integration-test files** across 62 crates,
**124** `#[cfg(test)]` modules, and **63** app story tests under
`backend/app/tests/`. Essentially none of it executes on any push or PR.

What CI does guarantee is that all of it *compiles*: `clippy --all-targets -D
warnings` builds every test target. Compiling is not running. A test can be
green in the author's terminal, compile forever after, and never assert again.

The sharpest illustration is in the preflight itself. `tools/buck/preflight.sh`
runs `buck2 uquery "kind('rust_test', '//backend/...')"` and prints
`buck-preflight: enumerated 318 Rust test target(s)`. It **counts** them. It
never runs one. A line that reads like coverage, in the job that gates the
pipeline, asserting only that 318 test targets can be named.

Two distinct failures compounded here, and they should not be conflated. The
defects this branch fixed — a self-approval hole at the lifecycle chokepoint, a
`SECURITY DEFINER` function shipped `EXECUTE TO PUBLIC`, a fabricated statutory
rule, a migration that dropped a column its handler still read — shipped because
**CI never ran at all** on this lineage (preflight was red, so every downstream
job reported `skipping`). The workspace deletion is the *second* failure: it
means that once preflight was repaired, the restored job would still not have
caught them.

**Rule.** A CI change that reduces what executes must say so in its commit
message and name the replacement. `77768668` said only "run PR473 SQLx gate
through Buck harness" — true, and silent about the 1,548 tests leaving with it.
Deletions of coverage are not implementation details of a refactor.

**Corollary.** The job name is a claim. "Backend — fmt / clippy / test / gates"
must either run the workspace suite or be renamed to what it does; a reviewer
reading the check list has no other signal.

## The meta-finding

`openapi_drift`, the api-drift checks, `tsc`, `vitest`, `eslint` and
`check-ui-strings` were all green across the entire window in which every one of
these defects existed. Gate coverage is not the same as correctness coverage,
and this program has been reading the former as the latter.

H-6 sharpens that into something worse than a blind spot. A gate can be *worse
than absent*: an absent gate is visibly absent, while a gate that cannot pass —
or that has simply never executed, because an earlier job failed and everything
downstream reported `skipping` — occupies its slot in the job list and reads as
coverage. Four of the five defects fixed on this branch were only reachable
after CI preflight went green for the first time on this lineage.

Until H-1…H-4 have checks, "green" here means *green on what we thought to look
at* — and any claim of readiness should say so explicitly rather than cite a
gate list. The stronger form of the same discipline: before citing a gate as
evidence, confirm it *ran*, and that it has ever been observed to fail.
