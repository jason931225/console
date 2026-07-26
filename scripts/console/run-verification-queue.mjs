#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FULL_SHA = /^[0-9a-f]{40}$/;
const BUCK_LABEL = /^(?:[A-Za-z0-9_.-]+)?\/\/[A-Za-z0-9_./-]+:[A-Za-z0-9_.-]+$/;
const POSTGRES_WRAPPER = /^\/\/tools\/buck:[A-Za-z0-9_.-]+$/;
const EXECUTION = 'canonical_shared_daemon_combined_targets';
const SCHEMA = 'console-fanout-epoch-v2';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => [key, stable(child)]));
  return value;
}
function hashBytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function hashJson(value) { return hashBytes(JSON.stringify(stable(value))); }
function fail(message) { throw new Error(`verification queue HOLD: ${message}`); }
function requireDirectory(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) fail('receipt/report path escapes configured local receipt root');
  return resolvedCandidate;
}
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

/** Validate only the already-admitted scheduler contract; this does not re-plan work. */
export function validateVerificationPlan(plan) {
  if (!isPlainObject(plan) || plan.schema_version !== SCHEMA || !Array.isArray(plan.verification_queue)) fail('unsupported or malformed fanout plan');
  // Held cohorts remain planner evidence, not executable input. They must not
  // turn an otherwise safe scheduled cohort into a run, or into a silent pass.
  const scheduled = plan.verification_queue.filter((entry) => entry?.scheduled === true);
  const seen = new Set();
  for (const entry of scheduled) {
    if (!isPlainObject(entry) || entry.execution !== EXECUTION) fail('scheduled entry lacks canonical shared-daemon execution');
    if (!FULL_SHA.test(entry.verification_sha ?? '') || entry.cache_affinity !== entry.verification_sha) fail('scheduled entry lacks matching full verification SHA/cache affinity');
    if (seen.has(entry.verification_sha)) fail('duplicate exact-SHA verification cohort');
    seen.add(entry.verification_sha);
    if (!Array.isArray(entry.buck2_targets) || entry.buck2_targets.length === 0) fail('scheduled entry has no Buck targets');
    const targetSet = new Set();
    for (const target of entry.buck2_targets) {
      if (typeof target !== 'string' || target.startsWith('root//') || !BUCK_LABEL.test(target) || targetSet.has(target)) fail('scheduled entry has malformed, root-qualified, or duplicate Buck target');
      targetSet.add(target);
    }
    if (!Array.isArray(entry.leaf_commands) || entry.leaf_commands.length !== 0) fail('scheduled entry has executable leaf commands outside this Buck-only executor');
  }
  return scheduled.map((entry) => ({ ...entry, buck2_targets: [...entry.buck2_targets].sort((a, b) => a.localeCompare(b, 'en')) }));
}

export function parseWorktreePorcelain(output) {
  const records = [];
  let current = null;
  for (const line of String(output).split(/\r?\n/)) {
    if (line === '') { if (current?.path) records.push(current); current = null; continue; }
    const separator = line.indexOf(' ');
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1);
    if (key === 'worktree') { if (current?.path) records.push(current); current = { path: value }; }
    else if (current && key === 'HEAD') current.head = value;
    else if (current && key === 'branch') current.branch = value;
  }
  if (current?.path) records.push(current);
  return records;
}

/** Returns only clean worktrees already at the immutable SHA, lexically ordered. */
export function selectCanonicalWorktree(worktrees, sha, isClean) {
  const candidates = worktrees.filter((entry) => entry?.head === sha && isClean(entry)).sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (!candidates.length) fail('no clean exact-HEAD worktree exists for verification SHA');
  return { selected: candidates[0], candidates };
}

export function buildVerificationCommands(entry, worktree, reportDirectory, partition) {
  const normalTargets = partition.normal;
  const postgresTargets = partition.postgres;
  const reports = [];
  if (normalTargets.length) {
    const reportPath = requireDirectory(reportDirectory, path.join(reportDirectory, 'normal.build-report.json'));
    reports.push({ kind: 'normal', targets: normalTargets, reportPath, argv: [path.join(worktree, 'tools/buck2'), '--build-report', reportPath, 'test', '-j', '6', ...normalTargets] });
  }
  if (postgresTargets.length) {
    const reportPath = requireDirectory(reportDirectory, path.join(reportDirectory, 'postgres.build-report.json'));
    // The wrapper already exports RUST_TEST_THREADS=1.  Deliberately do not add
    // Buck --num-threads=1: that would serialize analysis/compilation as well.
    reports.push({ kind: 'postgres', targets: postgresTargets, reportPath, argv: [path.join(worktree, 'tools/buck/test_needs_postgres.sh'), '--build-report', reportPath, ...postgresTargets] });
  }
  return reports;
}

function defaultInspectWorktree(worktree) {
  const head = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' });
  return { head, clean: dirty === '' };
}
function defaultListWorktrees(repo) {
  const porcelain = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  return parseWorktreePorcelain(porcelain);
}
function defaultRun(command, worktree) {
  const [file, ...args] = command.argv;
  const { BUCK_ISOLATION_DIR: _ignored, ...environment } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: worktree, stdio: 'inherit', env: environment });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
}
function defaultToolDigest(worktree) { return hashBytes(readFileSync(path.join(worktree, 'tools/buck2'))); }
function defaultPlatformFacts() { return { platform: process.platform, arch: process.arch, release: os.release() }; }
function defaultMonotonicNow() { return Number(process.hrtime.bigint()); }
function defaultQueryMetadata(targets, worktree) {
  const query = `set(${targets.join(' ')})`;
  const output = execFileSync(path.join(worktree, 'tools/buck2'), ['uquery', '--json', '--output-attribute', '^labels$', query], { cwd: worktree, encoding: 'utf8' });
  return JSON.parse(output);
}
function normalizedQueryLabel(label) { return label.startsWith('root//') ? label.slice(4) : label; }
export function partitionTargetsByMetadata(targets, metadata) {
  if (!isPlainObject(metadata)) fail('Buck target metadata is unavailable or malformed');
  const expected = new Set(targets);
  const observed = new Map();
  for (const [rawLabel, attributes] of Object.entries(metadata)) {
    const label = normalizedQueryLabel(rawLabel);
    if (!expected.has(label) || observed.has(label) || !Array.isArray(attributes?.labels) || attributes.labels.some((item) => typeof item !== 'string')) fail('Buck target metadata does not exactly describe admitted targets');
    observed.set(label, attributes.labels);
  }
  if (observed.size !== expected.size) fail('Buck target metadata omitted an admitted target');
  const normal = [], postgres = [];
  for (const target of targets) {
    const labels = observed.get(target);
    if (labels.includes('needs-postgres')) {
      if (!POSTGRES_WRAPPER.test(target)) fail('needs-postgres target is not a credential-safe PostgreSQL wrapper');
      postgres.push(target);
    } else normal.push(target);
  }
  return { normal, postgres };
}

/** The supplied JSON is a cacheable transport artifact, never executable authority. */
export function verifyPlanAgainstAuthority(suppliedPlan, authority, runPlanner) {
  for (const [name, sha] of Object.entries(authority)) if (!FULL_SHA.test(sha ?? '')) fail(`${name} must be a full immutable SHA`);
  const recomputed = runPlanner(authority);
  if (!isPlainObject(recomputed) || hashJson(recomputed) !== hashJson(suppliedPlan)) fail('supplied fanout plan differs from the exact recomputed authority plan');
  return recomputed;
}

function resolveWorktree(sha, options) {
  const listed = options.listWorktrees();
  if (listed?.path) return { selected: listed, candidates: [listed] };
  const inspect = options.inspectWorktree;
  return selectCanonicalWorktree(listed, sha, (candidate) => {
    try { const state = inspect(candidate.path); return state.clean === true && state.head === sha; } catch { return false; }
  });
}
function recheckWorktree(worktree, sha, inspect) {
  const state = inspect(worktree);
  if (state.head !== sha || state.clean !== true) fail('selected worktree changed, is dirty, or no longer matches verification SHA');
}
function readBuildReport(reportPath, receiptRoot) {
  requireDirectory(receiptRoot, reportPath);
  if (!existsSync(reportPath)) fail('Buck call produced no build report');
  const bytes = readFileSync(reportPath);
  if (bytes.length === 0) fail('Buck call produced an empty build report');
  return hashBytes(bytes);
}

/** Execute admitted cohorts within the planner's declared bounded cold-Rust capacity. */
export async function executeVerificationQueue(plan, supplied = {}) {
  if (process.env.BUCK_ISOLATION_DIR || process.env.MNT_BUCK_NEEDS_POSTGRES_ISOLATION_DIR) fail('inherited Buck isolation is forbidden for compatible exact-SHA cohorts');
  const entries = validateVerificationPlan(plan);
  const options = {
    receiptRoot: supplied.receiptRoot ?? path.join(process.cwd(), '.tmp/console-verification'),
    listWorktrees: supplied.listWorktrees ?? (() => defaultListWorktrees(process.cwd())),
    inspectWorktree: supplied.inspectWorktree ?? defaultInspectWorktree,
    run: supplied.run ?? defaultRun,
    toolDigest: supplied.toolDigest ?? defaultToolDigest,
    platformFacts: supplied.platformFacts ?? defaultPlatformFacts,
    monotonicNow: supplied.monotonicNow ?? defaultMonotonicNow,
    queryMetadata: supplied.queryMetadata ?? defaultQueryMetadata,
  };
  const receiptRoot = path.resolve(options.receiptRoot);
  const declaredCapacity = plan.policy?.cold_rust_compile_lanes;
  const maxCohorts = supplied.maxCohorts ?? declaredCapacity ?? 1;
  if (!Number.isInteger(maxCohorts) || maxCohorts < 1 || (declaredCapacity !== undefined && (!Number.isInteger(declaredCapacity) || maxCohorts > declaredCapacity))) fail('max cohorts exceeds declared cold-Rust capacity');
  const runEntry = async (entry) => {
    const selection = resolveWorktree(entry.verification_sha, options);
    const worktree = selection.selected.path;
    recheckWorktree(worktree, entry.verification_sha, options.inspectWorktree);
    const partition = partitionTargetsByMetadata(entry.buck2_targets, options.queryMetadata(entry.buck2_targets, worktree));
    const identity = hashJson({ verification_sha: entry.verification_sha, targets: entry.buck2_targets, buck2_sha256: options.toolDigest(worktree), execution_platform: options.platformFacts() });
    const finalDirectory = requireDirectory(receiptRoot, path.join(receiptRoot, entry.verification_sha, identity));
    if (existsSync(finalDirectory)) fail('local receipt already exists for exact verification identity');
    const staging = requireDirectory(receiptRoot, path.join(receiptRoot, `.staging-${process.pid}-${identity}`));
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      const commands = buildVerificationCommands(entry, worktree, staging, partition);
      const calls = [];
      for (const command of commands) {
        recheckWorktree(worktree, entry.verification_sha, options.inspectWorktree);
        const started = options.monotonicNow();
        const execution = await options.run(command, worktree);
        const ended = options.monotonicNow();
        if (execution.status !== 0 || execution.signal) fail(`${command.kind} Buck call failed`);
        calls.push({ kind: command.kind, targets: command.targets, argv: command.argv, started_monotonic_ns: started, ended_monotonic_ns: ended, exit_status: execution.status, build_report_sha256: readBuildReport(command.reportPath, receiptRoot) });
      }
      const receipt = stable({ schema_version: 'console-verification-receipt-v1', status: 'passed', verification_sha: entry.verification_sha, cache_affinity: entry.cache_affinity, execution: entry.execution, verification_identity_sha256: identity, selected_worktree: worktree, candidate_worktrees: selection.candidates.map((candidate) => candidate.path), target_partition: partition, buck2_sha256: options.toolDigest(worktree), execution_platform: options.platformFacts(), isolation_absent: true, calls });
      writeFileSync(path.join(staging, 'receipt.json'), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
      mkdirSync(path.dirname(finalDirectory), { recursive: true, mode: 0o700 });
      renameSync(staging, finalDirectory);
      return { verification_sha: entry.verification_sha, receipt_path: path.join(finalDirectory, 'receipt.json') };
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  };
  const pending = [...entries]; const results = []; let activeCohorts = 0; let peakCohorts = 0;
  const workers = Array.from({ length: Math.min(maxCohorts, pending.length) }, async () => {
    while (pending.length) {
      const entry = pending.shift(); activeCohorts += 1; peakCohorts = Math.max(peakCohorts, activeCohorts);
      try { results.push(await runEntry(entry)); } finally { activeCohorts -= 1; }
    }
  });
  await Promise.all(workers);
  const ordered = results.sort((left, right) => left.verification_sha.localeCompare(right.verification_sha, 'en'));
  Object.defineProperty(ordered, 'peak_cohorts', { value: peakCohorts, enumerable: false });
  Object.defineProperty(ordered, 'max_cohorts', { value: maxCohorts, enumerable: false });
  return ordered;
}

function parseArgs(argv) {
  const result = { planPath: null, receiptRoot: null, candidate: null, authorityTip: null, syntheticMerge: null, admission: null, maxCohorts: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    const value = argv[index + 1];
    if (!value) fail(`missing value for ${flag}`);
    if (flag === '--plan') result.planPath = value;
    else if (flag === '--receipt-root') result.receiptRoot = value;
    else if (flag === '--candidate') result.candidate = value;
    else if (flag === '--authority-tip') result.authorityTip = value;
    else if (flag === '--synthetic-merge') result.syntheticMerge = value;
    else if (flag === '--admission') result.admission = value;
    else if (flag === '--max-cohorts') result.maxCohorts = Number(value);
    else fail(`unknown argument ${flag}`);
    index += 1;
  }
  if (result.help) return result;
  result.admission ??= result.candidate;
  if (!result.planPath || !result.candidate || !result.authorityTip || !result.syntheticMerge) fail('--plan, --candidate, --authority-tip, and --synthetic-merge are required');
  return result;
}
function recomputePlan(authority) {
  const planner = path.join(path.dirname(new URL(import.meta.url).pathname), 'plan-fanout.mjs');
  const args = [planner, '--candidate', authority.candidate, '--authority-tip', authority.authorityTip, '--synthetic-merge', authority.syntheticMerge, '--admission', authority.admission];
  const result = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8' });
  if (result.error || result.status !== 0) fail(`canonical plan recomputation failed: ${result.stderr || result.error?.message || 'unknown error'}`);
  try { return JSON.parse(result.stdout); } catch { fail('canonical plan recomputation returned malformed JSON'); }
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write('usage: node scripts/console/run-verification-queue.mjs --plan <fanout-plan.json> --candidate <sha> --authority-tip <sha> --synthetic-merge <sha> [--admission <sha>] [--receipt-root <ignored-local-dir>] [--max-cohorts <1..declared>]\n'); return; }
  const plan = JSON.parse(readFileSync(args.planPath, 'utf8'));
  const authority = { candidate: args.candidate, authorityTip: args.authorityTip, syntheticMerge: args.syntheticMerge, admission: args.admission };
  const canonicalPlan = verifyPlanAgainstAuthority(plan, authority, recomputePlan);
  const receipts = await executeVerificationQueue(canonicalPlan, { receiptRoot: args.receiptRoot, maxCohorts: args.maxCohorts ?? undefined });
  process.stdout.write(`${JSON.stringify({ status: 'passed', max_cohorts: receipts.max_cohorts, peak_cohorts: receipts.peak_cohorts, receipts })}\n`);
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
