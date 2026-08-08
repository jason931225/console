export const meta = {
  name: 'lane-fanout',
  description: 'Reusable hardened lane fan-out: RED-baseline build, cross-lane defect ledger, adversarial diff-only review, independent re-verification, converge-or-escalate',
  whenToUse: 'Any multi-lane implementation phase with path-disjoint owned roots. Parameterise with args; do not fork this file per phase.',
  phases: [
    { title: 'Build', detail: 'one implementer per disjoint lane, failing test first' },
    { title: 'Review', detail: '2 diff-only adversarial reviewers + 1 independent re-runner per lane' },
  ],
}

// ---------------------------------------------------------------------------
// args = {
//   tip:        "<sha>"            // what each lane started from; ALL diffs are taken against this
//   lanes:      [{ key, bead, wt, owned, brief, accept, blockedTargets? }]
//   lockExtra?: "<string>"         // phase-specific additions to the lock contract
//   maxRounds?: 3
//   lenses?:    ["...", "..."]     // review lenses; defaults below
// }
//
// This file exists because the same harness was re-derived four times by hand, and every defect
// found in it (HEAD~1 diffing the base commit, reviewer findings discarded with no feedback edge,
// a stale owned-root after a mid-run scope ruling, "empty diff = auto reject") had to be fixed in
// each copy separately. Bun's rule applies to the pipeline as much as to the code it produces:
// fix the process that generates the work, not each instance of the work.
// ---------------------------------------------------------------------------

// args may arrive as a real object OR as a JSON-encoded string depending on how the caller passed
// it. A reusable harness should tolerate both rather than die on the caller's serialisation choice.
let ARGS = args
if (typeof ARGS === 'string') {
  try {
    ARGS = JSON.parse(ARGS)
  } catch (e) {
    throw new Error(`lane-fanout: args arrived as a string that is not valid JSON: ${e.message}`)
  }
}
ARGS = ARGS || {}

const TIP = ARGS.tip
const LANES = ARGS.lanes || []
const MAX_ROUNDS = ARGS.maxRounds || 3

if (!TIP) throw new Error('lane-fanout: args.tip is required (the SHA every lane diffs against)')
if (!Array.isArray(LANES) || !LANES.length) throw new Error('lane-fanout: args.lanes must be a non-empty array')
for (const l of LANES) {
  for (const f of ['key', 'wt', 'owned', 'brief', 'accept']) {
    if (!l || !l[f]) throw new Error(`lane-fanout: lane ${l && l.key ? l.key : '<unnamed>'} is missing required field "${f}"`)
  }
}

const BASE_LOCK = `
=== LOCK CONTRACT (binding; violation = rejected work) ===
GIT — these caused a real multi-agent collision in the Bun rewrite and again in this program:
  NO stash / stash pop / reset (any mode) / checkout <branch> / rebase / merge / clean
  NO push, NO force-push, NO git worktree add|remove, NO branch creation.
  PERMITTED: git status, git diff, git log, 'git add <explicit path>', 'git commit' of those paths.
  Commit ONLY inside your owned root. If the worktree already contains work, BUILD ON IT — you may
  not reset or revert it. Fix forward.
BUILD:
  Run from the WORKTREE ROOT. Never 'cd backend'. Never a bare 'cargo test' or --workspace.
  Scope every invocation: cargo test --locked --manifest-path backend/Cargo.toml -p <pkg> ...
  PostgreSQL-backed targets: tools/ci/cargo_needs_postgres.sh --only <name> --num-threads=1
  *** NEVER pass --workflow-only. Dark targets carry in_workflow_postgres_job=false, so it selects
      ZERO targets and exits 0. That is a FALSE GREEN, not a pass. Always --only. ***
  sqlx::query! is COMPILE-TIME checked against a live schema; SQLX_OFFLINE=true compiles with no
  database (offline cache committed at backend/.sqlx/). A hand-made createdb will NOT work — it
  lacks the role topology and fails at compile time with 'role "anonymous" does not exist'.
CHANGE DISCIPLINE:
  Minimal and mechanical. Do not refactor, tidy or rename anything near the fix. Improving while
  fixing is what previously broke a lane into 99 errors across 8 crates it never opened.
  If you need a paragraph-long comment to justify a workaround, the code is wrong — fix the code.
NEVER WEAKEN THE ORACLE:
  No deleted tests, no #[ignore], no relaxed or loosened assertions, and above all NEVER make a
  test pass by conforming it to the defect. Multiple lanes in this program were rejected for
  exactly that, and in each case the "green" test was hiding a live production outage.
AN ENFORCEMENT MUST BE ABLE TO SEE ITS SUBJECT:
  If your change adds or modifies a gate, check, census, guard or invariant, answer TWO questions
  in writing BEFORE you build it, and put the answers in enforcementPlacement:
    (1) WHERE does it run in the sequence, and does its subject EXIST yet at that point?
    (2) What is the FINEST distinction its data source can express?
  Both have already shipped as no-ops in this program. A canonical-writer census was placed in a
  reconcile script that runs BEFORE migrations, so it matched zero tables and its REVOKE loop
  iterated nothing in every automated path — and the lane recorded "succeeds on a bare cluster" as a
  feature, which is exactly how the no-op hid. Separately, a database-capability control was
  specified to enforce per-CRATE ownership, but every crate connects as the same role (console_rt),
  so the finest distinction available to it was per-ROLE and the crate boundary was never drawn.
  A check that never runs and a check that runs blind both exit 0. Neither shows up in a test count.
  THEREFORE: "examined zero subjects" MUST be a FAILURE, never a pass. And never claim a control
  covers a distinction its data source cannot express — say what it actually enforces, and name the
  residual gap in followUps.
TEST THE CONTROL BY EXECUTING IT, NOT BY READING IT:
  A contains()/substring assertion over a gate's own source text is not evidence the gate works. A
  reviewer inverted a census to 'IF leaked IS NOT NULL AND false THEN', killing it entirely, and all
  16 tests stayed green. Mutate the control itself and prove each mutation goes RED.
ROOT CAUSE, NOT SYMPTOM:
  Before editing, grep every caller of the function you are about to touch. One guard in the shared
  function beats a guard in each caller, and patching only the reported path leaves siblings broken.
CONTRACT TESTS ARE PART OF THE CHANGE:
  Before you edit behaviour, find every test that ENCODES the behaviour you are changing —
  including integration suites in other crates (backend/app/tests/** is the usual one). Changing a
  contract necessarily breaks the tests asserting the old contract; that is the change, not a
  regression. If such a test is OUTSIDE your owned root, STOP and report it in followUps with the
  exact file and assertions BEFORE you build. Do not silently break it, and do not abandon the
  work. This has been mis-scoped four times in this program: a lane authorised to fix a defect but
  forbidden the crate holding it, authorised to create a crate but forbidden the workspace
  manifest, and twice authorised to change a contract but forbidden the test that encodes it.
`

const LOCK = BASE_LOCK + (ARGS.lockExtra || '')

const BUILD_SCHEMA = {
  type: 'object',
  required: ['status', 'summary', 'filesChanged', 'redBaseline', 'verification', 'contractBreaches', 'enforcementPlacement'],
  properties: {
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    redBaseline: { type: 'string', description: 'the failing test written FIRST and its exact failure output, before implementation' },
    verification: { type: 'string', description: 'EXACT commands run and EXACT pass/fail counts; an independent agent will re-run these' },
    commands: { type: 'array', items: { type: 'string' }, description: 'the verbatim commands an independent verifier should re-run' },
    contractBreaches: { type: 'string' },
    // Required, with an explicit n/a escape, so that OMITTING the answer is impossible rather than
    // merely discouraged. A prose clause in the lock can be skimmed; a schema field cannot.
    enforcementPlacement: {
      type: 'string',
      description:
        'If this change adds or modifies any gate/check/census/guard: WHERE in the sequence it runs and whether its subject exists at that point, and the FINEST distinction its data source can express. State how "examined zero subjects" fails. If the change adds no enforcement, write exactly: n/a - adds no enforcement.',
    },
    followUps: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['reject', 'accept_with_findings', 'accept'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'claim', 'failureScenario', 'location'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          claim: { type: 'string' },
          failureScenario: { type: 'string' },
          location: { type: 'string' },
        },
      },
    },
    oracleWeakened: { type: 'boolean' },
    scopeCreep: { type: 'boolean' },
  },
}

// An independent re-runner. Lanes self-report their own green; nobody checked that in the first
// four runs, and the integration owner had to re-run everything by hand afterwards. This makes the
// check part of the pipeline.
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['reproduced', 'actualResults', 'discrepancies', 'contradictsClaim'],
  properties: {
    reproduced: { type: 'boolean', description: 'true only if YOU ran the commands and saw the claimed results' },
    actualResults: { type: 'string', description: 'the exact output you observed, not what was claimed' },
    discrepancies: { type: 'string', description: 'any difference between claimed and observed, or "none"' },
    // The VERIFIER decides whether its findings matter -- not a regex over its prose. A previous
    // version required discrepancies to be the literal string "none", so a conscientious verifier
    // writing "four, all minor; none contradicts the verdict" failed the check and the lane was
    // sent back for another build round. Convergence was effectively unreachable whenever the
    // verifier ran: every lane with one reported converged=false while every review-only lane
    // reported true. That defect manufactured rebuild rounds, which are the dominant cost here.
    contradictsClaim: { type: 'boolean', description: 'TRUE only if what you observed CONTRADICTS the claimed result - a count that differs, a command that failed, a false green. Cosmetic differences (line numbers, timings, wording) are FALSE.' },
    falseGreenRisk: { type: 'string', description: 'did any command select ZERO tests and still exit 0?' },
  },
}

// STANDING lenses run on EVERY lane, every round. They are not defaults.
//
// They used to be defaults -- `ARGS.lenses || [...]` -- and every single invocation of this harness
// passed `lenses`, so the fallback never once evaluated. Oracle integrity is the most common
// rejection cause in this program and it had never been reviewed for; it was only ever caught
// incidentally by a custom lens that happened to look. A default that is always overridden is not a
// default, it is dead code that reads as coverage.
const STANDING_LENSES = [
  'CORRECTNESS + ORACLE INTEGRITY — does the change address the root cause, and does the suite still prove as much as before? Hunt for tests conformed to defects and assertions that would pass even if the behaviour were broken. Pick the load-bearing assertion, break the code it guards, and say whether it actually goes RED.',
  'ENFORCEMENT PLACEMENT — for every gate/check/census/guard this change touches, ignore whether its LOGIC is right and ask only whether it can SEE its subject. (a) Where does it run in the sequence, and does its subject exist yet at that point? (b) What is the finest distinction its data source can express, and does the change claim a finer one? (c) Does "examined zero subjects" fail, or pass? (d) Is it tested by EXECUTING it, or by a contains() over its own source text — mutate the control and check the tests go RED. Both failure modes have shipped here: a census that ran before migrations existed, and a per-crate rule enforced by a data source that only distinguishes roles. Verify the answers in enforcementPlacement rather than trusting them.',
]

const LENSES = [
  ...STANDING_LENSES,
  ...(ARGS.lenses || [
    'BLAST RADIUS — does any public wire contract, stored format, or authorization outcome change shape? Who can now do what they could not before, or vice versa? Consider generated clients, rows already written under the old format, and callers in other crates.',
  ]),
]

// --- telemetry -------------------------------------------------------------
// Measured across six runs of this harness: ~130 agents, ~12M tokens, ~5.7h wall-clock, at a ratio
// of 3.67 checkers per build. Wall-clock divided by builds is 7-13 min per ROUND, and reviews run
// in parallel, so a round costs roughly one build plus one review wave.
//
// That makes ROUNDS the scarce resource, not tokens. And an audit of why rounds were spent found
// most early ones went to defects in the HARNESS and the BRIEF, not in the lane's code: reviewers
// diffing HEAD~1, findings discarded with no feedback edge, empty-diff auto-reject, reviewers not
// told which paths were owner-leased, a lane authorised to create a crate but forbidden the
// workspace manifest. Each of those cost a full build cycle per affected lane.
//
// The lever follows directly: another reviewer is cheap, another BUILD ROUND is expensive. So
// classify what each round was actually spent on, and let the numbers say whether the next
// improvement belongs in the brief or in the code.
const TELEMETRY = { rounds: [], startedAt: null }

function classifyRejection(blockers, weakened, verifierOk, status) {
  // Coarse, deliberately: the point is to see the SHAPE of wasted rounds, not to be precise.
  const text = blockers.map((b) => `${b.claim} ${b.location}`).join(' ').toLowerCase()
  if (!verifierOk) return 'unreproducible-claim'
  if (weakened) return 'oracle-weakened'
  if (/outside the authorised|in-scope path|scope list|not in scope/.test(text)) return 'scope-brief-defect'
  if (/executes nowhere|ratchet|baseline|ci\.yml|workflow step|lease/.test(text)) return 'owner-lease'
  if (status && status !== 'done') return 'incomplete'
  if (blockers.length) return 'code-defect'
  return 'unclassified'
}

// --- cross-lane defect ledger: Bun's "fix the generator" -------------------
const DEFECT_LEDGER = []

function recordDefects(laneKey, blockers, weakened) {
  for (const b of blockers) {
    const claim = (b.claim || '').trim()
    if (!claim) continue
    const key = claim.slice(0, 80).toLowerCase()
    if (DEFECT_LEDGER.some((d) => d.key === key)) continue
    DEFECT_LEDGER.push({ key, laneKey, claim, location: b.location || '' })
  }
  if (weakened && !DEFECT_LEDGER.some((d) => d.key === '__oracle__')) {
    DEFECT_LEDGER.push({
      key: '__oracle__',
      laneKey,
      claim: 'A reviewer judged that a change made the suite prove LESS than before (oracleWeakened=true).',
      location: '',
    })
  }
}

function ledgerBlock(selfKey) {
  const others = DEFECT_LEDGER.filter((d) => d.laneKey !== selfKey)
  if (!others.length) return ''
  return `
=== DEFECT CLASSES ALREADY CAUGHT IN OTHER LANES THIS RUN ===
Found by adversarial review of a DIFFERENT lane. They are CLASSES, not incidents — the same mistake
is available to you. Read them as things not to do.
${others.map((d, i) => `${i + 1}. (lane ${d.laneKey}) ${d.claim}${d.location ? `\n   seen at: ${d.location}` : ''}`).join('\n')}
`
}

function reviewPrompt(l, lens) {
  return `You are an ADVERSARIAL CODE REVIEWER. Your ONLY job is to find bugs and reasons this change
does not work. You are NOT told the author's reasoning and must not go looking for it.
Assume the code is WRONG until the diff proves otherwise.

  cd ${l.wt}
  git --no-pager diff ${TIP}
  git status --porcelain

*** Diff against ${TIP} exactly as above. Do NOT use 'git diff HEAD~1' — that shows an unrelated
    earlier commit's own contents rather than the change under review. If what you are reading has
    nothing to do with this lane's subject, you have the wrong diff; re-run the command above. ***

An EMPTY diff is NOT automatically a rejection. Some work is a proof that no change was needed.
Judge whether the reported evidence supports that claim; reject only if it does not.

YOUR REVIEW LENS: ${lens}

Every finding needs a CONCRETE failure scenario: specific inputs or state producing wrong
behaviour. A finding without one is a label, not a finding, and is worthless.

BLOCKER-level specifically:
 - any test made to pass by conforming it to a defect instead of fixing the defect
 - any deleted test, added #[ignore], or loosened assertion
 - an expectation matching observed output rather than the intended contract, especially anything
   environment-dependent (collation, locale, timezone, hash or iteration order)
 - a security or authorization decision that FAILS OPEN on error, absence, staleness or
   unavailability where the contract requires fail-closed
 - a claimed invariant with no test, or a test that would still pass if the invariant were broken
 - a backward-compatibility shim with no test proving it reads the legacy form
 - edits outside the IN-SCOPE PATHS below

*** NOT A BLOCKER — INTEGRATION-OWNER LEASES ***
Some files are deliberately withheld from every lane and are applied by the integration owner:
  docs/program/executed-tests-baseline.json, .github/workflows/**, tools/ci/postgres-cargo-map.json,
  backend/openapi/**, lockfiles, backend/crates/platform/db/migrations/**
A change that ADDS TESTS will therefore, by construction, leave the executed-tests ratchet red and
its new binaries unwired until the owner lands the companion edit. That is EXPECTED and is NOT a
defect in the lane's work. Report it as severity "major" with the exact companion edit required —
never as a blocker, and never as grounds to reject. Rejecting on it makes any test-adding lane
permanently unconvergeable, which would penalise exactly the changes that add the most coverage.
Do still reject if the lane EDITED one of those paths itself.

=== IN-SCOPE PATHS (authorised) ===
${l.owned}
This is SCOPE, not rationale. It says which files were legitimately in play and nothing about
whether the author got them right. Edits inside are not scope creep by location alone but can
still be wrong. Edits outside are a contract breach — report as blockers.

Set oracleWeakened=true if the suite now proves LESS than before. Default to rejecting when unsure.`
}

function verifyPrompt(l, fix) {
  const cmds = (fix.commands && fix.commands.length ? fix.commands : []).map((c) => `  ${c}`).join('\n')
  return `You are an INDEPENDENT VERIFIER. You do not review code and you do not read the author's
reasoning. Your single job is to RE-RUN what was claimed and report what ACTUALLY happens.

  cd ${l.wt}

CLAIMED VERIFICATION:
${fix.verification}

${cmds ? `COMMANDS TO RE-RUN VERBATIM:\n${cmds}` : 'The author listed no explicit commands. Derive them from the claimed verification above and say so.'}

RULES:
 - RUN the commands. Do not reason about whether they would pass. Reproduced=true only if you
   personally observed the result.
 - Report the EXACT output you saw, including counts, not the counts that were claimed.
 - *** FALSE-GREEN CHECK: if any command reports running ZERO tests and still exits 0, that is a
     false green — say so loudly in falseGreenRisk. In this repository --workflow-only selects zero
     dark targets and exits 0, which is exactly this trap. ***
 - If a command fails for an ENVIRONMENTAL reason (missing dependency, database not provisioned,
   Docker down), say so explicitly rather than reporting the change as broken.
 - Do NOT edit any file. You are read-and-run only.

Report any difference between what was claimed and what you observed, however small.`
}

function buildPrompt(l, fb) {
  // A rejection MUST arrive with something actionable. A previous run rejected a lane on verifier
  // disagreement alone, rendered an empty "BLOCKERS:" list, and the lane reported: "the rejection
  // came with no blocker text, so I re-derived the weakest point of my own diff". It recovered by
  // luck. When there are no blockers, state the actual cause and fall back to lower-severity
  // findings so the lane always has a concrete starting point.
  let reasonLines = []
  if (fb) {
    if (fb.weakened) reasonLines.push('A reviewer set oracleWeakened=true: the suite now proves LESS than before. Restoring the oracle is the highest priority.')
    if (fb.verifierSaid) reasonLines.push(`The INDEPENDENT VERIFIER re-ran your commands and disagreed with your claimed result: ${fb.verifierSaid}`)
    if (fb.notDone) reasonLines.push(`You reported status="${fb.notDone}" rather than "done". If that is genuinely blocked, say so precisely in followUps; if it is finishable, finish it.`)
    if (!fb.blockers.length && !reasonLines.length) reasonLines.push('No blocker was recorded, which means the rejection came from a failed convergence check rather than a named finding. Re-derive the weakest point of your own diff and address it.')
  }

  const blockerText = fb && fb.blockers.length
    ? `BLOCKERS (must all be resolved):\n${fb.blockers.map((b, i) => `${i + 1}. [${b.severity}] ${b.claim}\n   where: ${b.location}\n   fails when: ${b.failureScenario}`).join('\n')}`
    : (fb && fb.lesser && fb.lesser.length
      ? `NO BLOCKERS were raised. Lower-severity findings, treat as the actionable list:\n${fb.lesser.map((b, i) => `${i + 1}. [${b.severity}] ${b.claim}\n   where: ${b.location}\n   fails when: ${b.failureScenario}`).join('\n')}`
      : 'NO named findings were recorded this round.')

  const feedback = fb
    ? `
=== ROUND ${fb.round}: THIS LANE WAS REJECTED ===
Your earlier change is already in the worktree. Amend it; do not revert wholesale.

WHY IT WAS REJECTED:
${reasonLines.map((r) => ` - ${r}`).join('\n')}

${blockerText}

Fix the CAUSE, not the symptom named. If two findings share a root, fix the root once.
Reviewers see ONLY your diff, never your reasoning — if a finding looks like a misunderstanding,
that is itself a signal the change is not self-evident. Make the code clearer rather than arguing.
If a finding names a path you may not touch, say so in followUps rather than editing it.
`
    : ''

  return `You are the IMPLEMENTER for lane "${l.key}"${l.bead ? ` (beads issue ${l.bead})` : ''}.
${feedback}${ledgerBlock(l.key)}
WORKTREE (yours alone, based on ${TIP}):
  ${l.wt}
Work ONLY there. Do not touch any other worktree or the primary checkout.

YOUR OWNED ROOT (the only place you may write):
  ${l.owned}

${l.brief}

ACCEPTANCE: ${l.accept}

METHOD — RED BASELINE FIRST, not optional:
 1. WRITE THE FAILING TEST FIRST. Encode the required behaviour as a test and RUN it. Capture the
    exact failure output — that is your redBaseline. A lane that implements first and tests after
    cannot demonstrate its test would have caught anything.
 2. Implement the smallest change that makes it pass.
 3. Re-run and report EXACT counts. Populate 'commands' with the verbatim commands you ran — an
    independent verifier will re-run them and compare against what you claim.
 4. MUTATION-CHECK your own new assertions: break the thing you just fixed, confirm the suite goes
    RED, then restore and confirm GREEN. An assertion that still passes when the behaviour is
    broken proves nothing. Report this in verification.
 5. Commit only your owned paths. Do not push.

Cold builds take several minutes; that is expected, not a hang.
If you cannot finish, report "partial" or "blocked" with the exact failure. An honest blocked
result is far more useful than a weakened test.

${LOCK}`
}

async function runLane(l) {
  let fb = null
  let last = { lane: l, fix: null, reviews: [], verify: null, blockers: [], rounds: 0, converged: false }

  // A lane whose implementer already finished gets REVIEW ONLY. Re-running it would duplicate
  // committed work and risk a second writer in a worktree, and its diff still needs review.
  if (l.reviewOnly) {
    const checks = await parallel(LENSES.map((lens) => () =>
      agent(reviewPrompt(l, lens), { label: `review:${l.key}`, phase: 'Review', schema: REVIEW_SCHEMA })))
    const reviews = checks.filter(Boolean)
    const blockers = reviews.flatMap((v) => (v.findings || []).filter((f) => f.severity === 'blocker'))
    const weakened = reviews.some((v) => v.oracleWeakened)
    recordDefects(l.key, blockers, weakened)
    const converged = blockers.length === 0 && !weakened
    log(`${l.key}: review-only -> ${blockers.length} blocker(s)${weakened ? ', ORACLE WEAKENED' : ''}`)
    return { lane: l, fix: l.priorResult || null, reviews, verify: null, blockers, rounds: 0, converged }
  }

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const sfx = round > 1 ? `#${round}` : ''

    // Agent death is routine at this scale; retry once before giving up on the round.
    let fix = await agent(buildPrompt(l, fb), { label: `build:${l.key}${sfx}`, phase: 'Build', schema: BUILD_SCHEMA })
    if (!fix) {
      log(`${l.key}: implementer died in round ${round}, retrying once`)
      fix = await agent(buildPrompt(l, fb), { label: `build:${l.key}${sfx}r`, phase: 'Build', schema: BUILD_SCHEMA })
    }
    if (!fix) {
      log(`${l.key}: implementer died twice in round ${round} — abandoning lane`)
      last.rounds = round
      break
    }

    // Two adversarial readers plus, when there is something to falsify, one independent re-runner.
    //
    // The verifier exists to test a CLAIMED green by re-running the lane's own commands. A lane
    // reporting "partial" or "blocked" is claiming nothing, so there is nothing to falsify and the
    // round cannot converge regardless. Running it anyway re-executes full test suites for no
    // decision value: in one measured phase, two consecutive rounds converged zero lanes, so six
    // verifiers re-ran suites whose result could not have changed any outcome. Reviews still run
    // on every round -- a rejected round's findings are exactly what the next build needs.
    const claimsGreen = fix.status === 'done'
    const checks = await parallel([
      ...LENSES.map((lens) => () => agent(reviewPrompt(l, lens), { label: `review:${l.key}${sfx}`, phase: 'Review', schema: REVIEW_SCHEMA })),
      ...(claimsGreen ? [() => agent(verifyPrompt(l, fix), { label: `verify:${l.key}${sfx}`, phase: 'Review', schema: VERIFY_SCHEMA })] : []),
    ])
    const reviews = checks.slice(0, LENSES.length).filter(Boolean)
    const verify = claimsGreen ? (checks[LENSES.length] || null) : null
    if (!claimsGreen) log(`${l.key}: round ${round} reported "${fix.status}" — verifier skipped, nothing green to falsify`)

    const blockers = reviews.flatMap((v) => (v.findings || []).filter((f) => f.severity === 'blocker'))
    const weakened = reviews.some((v) => v.oracleWeakened)
    recordDefects(l.key, blockers, weakened)

    // A lane is not green because it says so. The verifier must have reproduced it.
    // The verifier judges whether its own findings contradict the claim; contradictsClaim is a
    // required field, so there is no prose to parse and nothing to fall back to.
    const verifierOk = !verify || (verify.reproduced === true && verify.contradictsClaim === false)
    const verifierSaid = verifierOk ? null : `reproduced=${verify && verify.reproduced}; contradictsClaim=${verify && verify.contradictsClaim}; discrepancies=${verify && verify.discrepancies}; falseGreenRisk=${verify && verify.falseGreenRisk}`

    last = { lane: l, fix, reviews, verify, blockers, rounds: round, converged: false }

    if (fix.status === 'done' && blockers.length === 0 && !weakened && verifierOk) {
      last.converged = true
      log(`${l.key}: CONVERGED round ${round} (independently re-verified)`)
      break
    }

    const cause = classifyRejection(blockers, weakened, verifierOk, fix.status)
    TELEMETRY.rounds.push({ lane: l.key, round, cause, blockers: blockers.length, weakened, verifierOk })
    log(`${l.key}: round ${round} -> status=${fix.status}, ${blockers.length} blocker(s)${weakened ? ', ORACLE WEAKENED' : ''}${verifierOk ? '' : ', VERIFIER DISAGREED'} [cause: ${cause}]`)
    if (round === MAX_ROUNDS) {
      log(`${l.key}: ESCALATION — hit MAX_ROUNDS=${MAX_ROUNDS} unconverged; ${blockers.length} blocker(s) survive`)
      break
    }
    // Carry lower-severity findings and the status so the next round always has something concrete
    // even when no blocker was raised.
    const lesser = reviews.flatMap((v) => (v.findings || []).filter((f) => f.severity !== 'blocker')).slice(0, 6)
    fb = {
      round: round + 1,
      blockers,
      lesser,
      weakened,
      verifierSaid,
      notDone: fix.status === 'done' ? null : fix.status,
    }
  }
  return last
}

phase('Build')

const results = await parallel(LANES.map((l) => () => runLane(l)))

const out = results.filter(Boolean).map((r) => ({
  lane: r.lane.key,
  bead: r.lane.bead || null,
  converged: r.converged,
  rounds: r.rounds,
  status: r.fix ? r.fix.status : 'agent_failed',
  summary: r.fix ? r.fix.summary : null,
  redBaseline: r.fix ? r.fix.redBaseline : null,
  filesChanged: r.fix ? r.fix.filesChanged : [],
  claimedVerification: r.fix ? r.fix.verification : null,
  independentlyReproduced: r.verify ? r.verify.reproduced : null,
  verifierObserved: r.verify ? r.verify.actualResults : null,
  verifierDiscrepancies: r.verify ? r.verify.discrepancies : null,
  falseGreenRisk: r.verify ? r.verify.falseGreenRisk : null,
  contractBreaches: r.fix ? r.fix.contractBreaches : null,
  followUps: r.fix ? r.fix.followUps : null,
  verdicts: (r.reviews || []).map((v) => v.verdict),
  oracleWeakened: (r.reviews || []).some((v) => v.oracleWeakened),
  remainingBlockers: r.blockers || [],
}))

const conv = out.filter((o) => o.converged).map((o) => o.lane)
const stuck = out.filter((o) => !o.converged).map((o) => `${o.lane}(${o.rounds}r,${o.remainingBlockers.length}b)`)
log(`CONVERGED: ${conv.join(', ') || 'none'} | UNCONVERGED: ${stuck.join(', ') || 'none'}`)
if (DEFECT_LEDGER.length) log(`defect classes seen this run: ${DEFECT_LEDGER.length}`)

// Where did the rounds go? Rounds are the scarce resource, so this is the number that should drive
// the next improvement. A run dominated by scope-brief-defect means fix the BRIEF; by code-defect
// means the lanes are genuinely hard; by owner-lease means the lease boundary is drawn wrong.
const byCause = {}
for (const r of TELEMETRY.rounds) byCause[r.cause] = (byCause[r.cause] || 0) + 1
const wasted = (byCause['scope-brief-defect'] || 0) + (byCause['owner-lease'] || 0)
const buildRounds = out.reduce((n, o) => n + (o.rounds || 0), 0)

// SERIAL DEPTH is what wall-clock actually tracks — measured across this harness's runs, per-step
// latency sits at 9-14 min and total time follows depth almost exactly while ignoring width:
// 12 agents at depth 6 took 74 min; 36 agents at depth 6 took 63 min. Three times the width, no
// slower. So adding reviewers is nearly free and adding a serial step is not.
// This harness is already flat WITHIN a round -- build, then one parallel block of reviewers plus
// the verifier -- so depth is 2 per round and nothing here can be unstacked further. All remaining
// depth is ROUNDS, which makes brief quality the only real lever on wall-clock.
const maxRounds = out.reduce((n, o) => Math.max(n, o.rounds || 0), 0)
const depth = maxRounds * 2
log(`telemetry: ${buildRounds} build round(s); serial depth ~${depth} (${maxRounds} round(s) x 2: build then one parallel check block)`)
log(`telemetry: rejection causes ${JSON.stringify(byCause)}`)
if (wasted) log(`telemetry: ${wasted}/${TELEMETRY.rounds.length} rejected round(s) were BRIEF or LEASE defects, not code — fix those in the brief, not the lane`)

// Headline FIRST and compact, because the result file gets truncated on long runs and the journal
// stores content-hash labels rather than the lane keys passed in — so a truncated tail leaves
// verdicts unattributable to lanes. One line per lane, before anything verbose.
const headline = out.map((o) =>
  `${o.lane}: ${o.converged ? 'CONVERGED' : 'UNCONVERGED'} r${o.rounds} ${o.status} blockers=${(o.remainingBlockers || []).length} weakened=${o.oracleWeakened} verified=${o.independentlyReproduced}`)
log(`HEADLINE | ${headline.join(' | ')}`)

return {
  headline,
  lanes: out,
  defectClasses: DEFECT_LEDGER.map((d) => ({ lane: d.laneKey, claim: d.claim })),
  telemetry: {
    buildRounds,
    serialDepth: depth,
    checkersPerBuild: buildRounds ? +(((LENSES.length + 1) * buildRounds) / buildRounds).toFixed(2) : 0,
    rejectionCauses: byCause,
    briefOrLeaseRounds: wasted,
    rounds: TELEMETRY.rounds,
  },
}
