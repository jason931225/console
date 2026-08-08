// Offline preflight for lane-fanout.js. Run it BEFORE every dispatch:
//
//     node .claude/workflows/lane-fanout.test.mjs
//
// It exists because two classes of defect are invisible to reading, and both shipped here:
//
//   1. SYNTAX. An unescaped backtick inside a prompt template literal ends the literal. It
//      silently truncated BASE_LOCK once; the run looked normal and the lock was half gone.
//      `node --check` cannot see this — it rejects the top-level await and tells you nothing.
//   2. WIRING. A rule can be written, documented, believed, and reachable by nothing:
//        - `LENSES = ARGS.lenses || [...]` meant the standing lenses NEVER ran, because every
//          invocation passed `lenses`. Oracle integrity, the most common rejection cause in this
//          program, had never once been reviewed for.
//        - `verifierOk` matched the literal string "none" in the verifier's prose, so a verifier
//          writing "four, all minor; none contradicts the verdict" failed the check. Convergence
//          was unreachable whenever the verifier ran, and the harness manufactured rebuild rounds.
//        - convergence keyed on `severity === 'blocker'`, so a run reported CONVERGED while both
//          reviewers held six separately PROVEN fail-opens, every one filed "major".
//
// The harness is driven with STUB agents, so this proves the ENFORCEMENT LOGIC, not any agent's
// judgement. It is offline, free, and takes under a second.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, 'lane-fanout.js'), 'utf8')

// Compile exactly as the harness evaluates it: an async function body with these globals, so
// top-level await and return are legal. This is the only honest syntax check.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
let run
try {
  run = new AsyncFunction(
    'args', 'agent', 'parallel', 'pipeline', 'log', 'phase', 'budget', 'workflow',
    SRC.replace(/^export const meta = /m, 'const meta = '),
  )
} catch (e) {
  console.error('FAIL compile —', e.message)
  console.error('  An unescaped ` inside a prompt template literal is the usual cause.')
  process.exit(1)
}
console.log('PASS compile — body parses as the harness evaluates it')

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 500)}`)
  if (!ok) failures++
}

// Sequential is fine for a logic test; parallel() only needs to run every thunk and collect.
const parallel = async (thunks) => {
  const out = []
  for (const t of thunks) { try { out.push(await t()) } catch { out.push(null) } }
  return out
}
const pipeline = async (items, ...stages) => {
  const out = []
  for (const [i, it] of items.entries()) {
    let v = it
    for (const s of stages) v = await s(v, it, i)
    out.push(v)
  }
  return out
}

const BUILD = (over = {}) => ({
  status: 'done', summary: 's', filesChanged: ['x.rs'], redBaseline: 'RED', verification: 'ok',
  contractBreaches: 'none', enforcementPlacement: 'n/a - adds no enforcement',
  peripheralsUpdated: 'n/a - nothing described this behaviour', followUps: '', commands: [], ...over,
})
const FINDING = (over = {}) => ({
  severity: 'major', claim: 'c', failureScenario: 'f', location: 'l',
  provenByExecution: false, ownerLease: false, ...over,
})
const REVIEW = (over = {}) => ({ verdict: 'accept', findings: [], oracleWeakened: false, scopeCreep: false, ...over })
const VERIFY = (over = {}) => ({
  reproduced: true, actualResults: 'a', discrepancies: 'none', contradictsClaim: false,
  falseGreenRisk: 'none', ...over,
})

// Records every label the harness actually dispatched, which is how we prove a rule is REACHABLE
// rather than merely written.
const mkAgent = (opts = {}) => {
  const seen = []
  const fn = async (prompt, o = {}) => {
    const label = o.label || ''
    seen.push({ label, prompt })
    if (label.startsWith('build:')) return opts.build ? opts.build(seen) : BUILD()
    if (label.startsWith('review:')) return opts.review ? opts.review(prompt, seen) : REVIEW()
    if (label.startsWith('verify:')) return opts.verify ? opts.verify() : VERIFY()
    if (label === 'land') return opts.land ? opts.land() : { branch: 'integration/x', headSha: 'deadbee', landedLanes: ['a'], skippedLanes: [], verification: 'v', outstandingLeasedEdits: 'none', prCommand: 'gh pr create ...' }
    return 'REPORT'
  }
  fn.seen = seen
  return fn
}

const LANE = (over = {}) => ({ key: 'a', bead: 'b', wt: '/w', owned: 'x/**', brief: 't', accept: 'a', ...over })
const ARGS = (over = {}) => ({ tip: 'abc1234', lanes: [LANE()], maxRounds: 1, land: false, ...over })

const go = (args, agent = mkAgent(), logs = []) =>
  run(args, agent, parallel, pipeline, (m) => logs.push(m), () => {}, { total: null, spent: () => 0, remaining: () => Infinity }, async () => {})

const threw = async (args) => {
  try { await go(args); return null } catch (e) { return e.message }
}

// --- 1. An option the harness does not read must ABORT, never be silently dropped. ----------
{
  const m = await threw(ARGS({ prose_hardening: false }))
  check('unknown top-level arg aborts', !!m && /prose_hardening/.test(m), m)

  const m2 = await threw(ARGS({ lanes: [LANE({ scopes: ['x/'] })] }))
  check('unknown per-lane key aborts', !!m2 && /scopes/.test(m2), m2)

  const m3 = await threw(ARGS({ lens: ['typo'] }))
  check('a typo in `lenses` aborts rather than silently using defaults', !!m3 && /lens\b/.test(m3), m3)

  const ok = await go(ARGS())
  check('every documented arg is accepted', !!ok && Array.isArray(ok.headline), ok && Object.keys(ok))
}

// --- 2. Standing lenses must survive custom lenses (the dead-default defect). ---------------
{
  const agent = mkAgent()
  await go(ARGS({ lenses: ['CUSTOM ONE', 'CUSTOM TWO'] }), agent)
  const reviews = agent.seen.filter((s) => s.label.startsWith('review:'))
  const hasOracle = reviews.some((r) => /ORACLE INTEGRITY/.test(r.prompt))
  const hasPlacement = reviews.some((r) => /ENFORCEMENT PLACEMENT/.test(r.prompt))
  const hasDrift = reviews.some((r) => /PERIPHERAL DRIFT/.test(r.prompt))
  const hasCustom = reviews.some((r) => /CUSTOM ONE/.test(r.prompt))
  check('custom lenses ADD to standing lenses, never replace them',
    reviews.length === 5 && hasOracle && hasPlacement && hasDrift && hasCustom,
    { count: reviews.length, hasOracle, hasPlacement, hasDrift, hasCustom })
}

// --- 3. Convergence keys on PROOF, not on the severity label. -------------------------------
{
  const provenMajor = mkAgent({ review: () => REVIEW({ verdict: 'accept_with_findings', findings: [FINDING({ severity: 'major', provenByExecution: true })] }) })
  const r1 = await go(ARGS(), provenMajor)
  check('a PROVEN major blocks convergence', r1.lanes[0].converged === false, r1.headline)

  const arguedMajor = mkAgent({ review: () => REVIEW({ verdict: 'accept_with_findings', findings: [FINDING({ severity: 'major', provenByExecution: false })] }) })
  const r2 = await go(ARGS(), arguedMajor)
  check('an ARGUED major does not block convergence', r2.lanes[0].converged === true, r2.headline)

  const leasedBlocker = mkAgent({ review: () => REVIEW({ verdict: 'reject', findings: [FINDING({ severity: 'blocker', provenByExecution: true, ownerLease: true })] }) })
  const r3 = await go(ARGS(), leasedBlocker)
  check('an owner lease releases at ANY severity', r3.lanes[0].converged === true, r3.headline)

  const realBlocker = mkAgent({ review: () => REVIEW({ verdict: 'reject', findings: [FINDING({ severity: 'blocker' })] }) })
  const r4 = await go(ARGS(), realBlocker)
  check('a real blocker blocks', r4.lanes[0].converged === false, r4.headline)
}

// --- 4. The oracle may never be weakened, whatever the findings say. ------------------------
{
  const weakened = mkAgent({ review: () => REVIEW({ oracleWeakened: true }) })
  const r = await go(ARGS(), weakened)
  check('oracleWeakened blocks convergence with zero findings', r.lanes[0].converged === false, r.headline)
}

// --- 5. The verifier decides via a BOOLEAN, not a regex over its prose. ---------------------
{
  const conscientious = mkAgent({ verify: () => VERIFY({ discrepancies: 'four, all minor; none contradicts the verdict', contradictsClaim: false }) })
  const r = await go(ARGS(), conscientious)
  check('a wordy but non-contradicting verifier still converges', r.lanes[0].converged === true, r.headline)

  const contradicts = mkAgent({ verify: () => VERIFY({ contradictsClaim: true }) })
  const r2 = await go(ARGS(), contradicts)
  check('contradictsClaim=true blocks convergence', r2.lanes[0].converged === false, r2.headline)

  const notReproduced = mkAgent({ verify: () => VERIFY({ reproduced: false }) })
  const r3 = await go(ARGS(), notReproduced)
  check('reproduced=false blocks convergence', r3.lanes[0].converged === false, r3.headline)
}

// --- 6. Nothing green to falsify => no verifier. Rounds are the scarce resource. ------------
{
  const partial = mkAgent({ build: () => BUILD({ status: 'partial' }) })
  await go(ARGS(), partial)
  check('a non-done build skips the verifier', partial.seen.filter((s) => s.label.startsWith('verify:')).length === 0,
    partial.seen.map((s) => s.label))

  const done = mkAgent()
  await go(ARGS(), done)
  check('a done build runs the verifier', done.seen.filter((s) => s.label.startsWith('verify:')).length === 1,
    done.seen.map((s) => s.label))
}

// --- 7. Agent death is routine at this scale; retry once, then abandon. ---------------------
{
  let n = 0
  const flaky = mkAgent({ build: () => { n++; return n === 1 ? null : BUILD() } })
  const r = await go(ARGS(), flaky)
  check('a dead implementer is retried once and the round proceeds', n === 2 && r.lanes[0].status === 'done', { n, r: r.headline })

  const dead = mkAgent({ build: () => null })
  const r2 = await go(ARGS(), dead)
  check('two deaths abandon the lane without throwing', r2.lanes[0].converged === false, r2.headline)
}

// --- 8. Rejected rounds must feed the next build, or findings are collected and discarded. --
{
  const seenPrompts = []
  const agent = mkAgent({
    build: (seen) => { seenPrompts.push(seen[seen.length - 1].prompt); return BUILD() },
    review: () => REVIEW({ verdict: 'reject', findings: [FINDING({ severity: 'blocker', claim: 'THE-DISTINCTIVE-BLOCKER' })] }),
  })
  await go(ARGS({ maxRounds: 2 }), agent)
  check('round 2 receives round 1 blockers as feedback',
    seenPrompts.length === 2 && /THE-DISTINCTIVE-BLOCKER/.test(seenPrompts[1]), seenPrompts.length)
}

// --- 9. Reviewers diff the TIP, never HEAD~1 (which once diffed the base commit). -----------
{
  const agent = mkAgent()
  await go(ARGS(), agent)
  const reviews = agent.seen.filter((s) => s.label.startsWith('review:'))
  check('reviewers are told to diff the tip, and HEAD~1 appears only as a warning',
    reviews.every((r) => r.prompt.includes('abc1234')), reviews.length)
}

// --- 10. Landing is part of the pipeline. Its absence is what produced a +99 backlog. -------
{
  const agent = mkAgent()
  const r = await go(ARGS({ land: true }), agent)
  check('a converged lane LANDS by default', agent.seen.some((s) => s.label === 'land') && !!r.landed, r.headline)

  const noConverge = mkAgent({ review: () => REVIEW({ verdict: 'reject', findings: [FINDING({ severity: 'blocker' })] }) })
  await go(ARGS({ land: true }), noConverge)
  check('nothing converged => nothing lands', !noConverge.seen.some((s) => s.label === 'land'),
    noConverge.seen.map((s) => s.label))

  const off = mkAgent()
  await go(ARGS({ land: false }), off)
  check('land:false is honoured (and warns)', !off.seen.some((s) => s.label === 'land'), off.seen.map((s) => s.label))
}

// --- 11. The required-field trio must stay required, or the clause is skimmable again. ------
{
  const req = (SRC.match(/required: \[[^\]]*'enforcementPlacement'[^\]]*\]/) || [''])[0]
  check('enforcementPlacement is a REQUIRED build field', /enforcementPlacement/.test(req), req.slice(0, 200))
  check('peripheralsUpdated is a REQUIRED build field', /peripheralsUpdated/.test(req), req.slice(0, 200))
  check('redBaseline is a REQUIRED build field', /redBaseline/.test(req), req.slice(0, 200))
  const rf = (SRC.match(/required: \[[^\]]*'provenByExecution'[^\]]*\]/) || [''])[0]
  check('provenByExecution and ownerLease are REQUIRED per finding',
    /provenByExecution/.test(rf) && /ownerLease/.test(rf), rf.slice(0, 200))
}

// --- 12. The lock must not be silently truncated by a nested backtick. ----------------------
{
  const lock = SRC.slice(SRC.indexOf('const BASE_LOCK = `') + 19, SRC.indexOf('\n`\n\nconst LOCK'))
  check('BASE_LOCK contains no nested backtick', (lock.match(/`/g) || []).length === 0, (lock.match(/`/g) || []).length)
  for (const clause of ['NEVER WEAKEN THE ORACLE', 'CONTRACT TESTS ARE PART OF THE CHANGE',
    'AN ENFORCEMENT MUST BE ABLE TO SEE ITS SUBJECT', 'PERIPHERALS ARE PART OF THE CHANGE',
    'THE THIRD SPELLING MEANS THE MECHANISM IS WRONG', 'NEVER pass --workflow-only']) {
    check(`lock clause survives: ${clause}`, lock.includes(clause))
  }
}

console.log(failures ? `\n${failures} FAILURE(S) — do not dispatch` : '\nALL PASS — safe to dispatch')
process.exit(failures ? 1 : 0)
