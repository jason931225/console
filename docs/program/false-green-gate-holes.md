# False-green gate holes — four confirmed, one shape

Recorded 2026-07-25 during the wave-4 hotfix pass. Every item below was a
**confident green over a broken reality**, and not one was caught by a gate —
each was found by a person or agent reading code and checking a claim.

They share a single shape: *the check verifies a proxy for the contract instead
of the contract*. Listing them together because the remedy is a class of gate,
not four patches.

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

## The meta-finding

`openapi_drift`, the api-drift checks, `tsc`, `vitest`, `eslint` and
`check-ui-strings` were all green across the entire window in which all four
defects existed. Gate coverage is not the same as correctness coverage, and this
program has been reading the former as the latter.

Until H-1…H-4 have checks, "green" here means *green on what we thought to look
at* — and any claim of readiness should say so explicitly rather than cite a
gate list.
