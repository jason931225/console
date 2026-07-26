#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildVerificationCommands,
  executeVerificationQueue,
  parseWorktreePorcelain,
  selectCanonicalWorktree,
  validateVerificationPlan,
  verifyPlanAgainstAuthority,
} from './run-verification-queue.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function queueEntry(overrides = {}) {
  return {
    scheduled: true,
    verification_sha: SHA,
    cache_affinity: SHA,
    execution: 'canonical_shared_daemon_combined_targets',
    buck2_targets: ['//backend/crates/example:unit', '//tools/buck:app-example-postgres'],
    leaf_commands: [],
    ...overrides,
  };
}

test('admission rejects malformed or non-executable verification cohorts', () => {
  assert.deepEqual(validateVerificationPlan({ schema_version: 'console-fanout-epoch-v2', verification_queue: [queueEntry()] }).map((entry) => entry.verification_sha), [SHA]);
  for (const invalid of [
    { schema_version: 'wrong', verification_queue: [queueEntry()] },
    { schema_version: 'console-fanout-epoch-v2', verification_queue: [queueEntry({ cache_affinity: OTHER_SHA })] },
    { schema_version: 'console-fanout-epoch-v2', verification_queue: [queueEntry({ buck2_targets: [] })] },
    { schema_version: 'console-fanout-epoch-v2', verification_queue: [queueEntry({ buck2_targets: ['/absolute:target'] })] },
    { schema_version: 'console-fanout-epoch-v2', verification_queue: [queueEntry({ buck2_targets: ['root//tools/buck:app-example-postgres'] })] },
    { schema_version: 'console-fanout-epoch-v2', verification_queue: [queueEntry({ leaf_commands: ['git diff --check'] })] },
    { schema_version: 'console-fanout-epoch-v2', verification_queue: [queueEntry(), queueEntry()] },
  ]) assert.throws(() => validateVerificationPlan(invalid));
  assert.deepEqual(validateVerificationPlan({ schema_version: 'console-fanout-epoch-v2', verification_queue: [queueEntry({ scheduled: false })] }), []);
});

test('clean matching worktree selection is canonical and rejects absent or dirty candidates', () => {
  const parsed = parseWorktreePorcelain([
    'worktree /z/repo', `HEAD ${SHA}`, 'branch refs/heads/z', '',
    'worktree /a/repo', `HEAD ${SHA}`, 'branch refs/heads/a', '',
    'worktree /dirty/repo', `HEAD ${SHA}`, 'branch refs/heads/dirty', '',
  ].join('\n'));
  const selected = selectCanonicalWorktree(parsed, SHA, (candidate) => candidate.path !== '/dirty/repo');
  assert.equal(selected.selected.path, '/a/repo');
  assert.deepEqual(selected.candidates.map((candidate) => candidate.path), ['/a/repo', '/z/repo']);
  assert.throws(() => selectCanonicalWorktree(parsed, OTHER_SHA, () => true), /no clean exact-HEAD/);
});

test('a supplied JSON plan is held unless it exactly matches explicit immutable authority recomputation', () => {
  const authority = { candidate: SHA, authorityTip: OTHER_SHA, syntheticMerge: 'c'.repeat(40), admission: 'd'.repeat(40) };
  const plan = { schema_version: 'console-fanout-epoch-v2', verification_queue: [queueEntry()] };
  assert.equal(verifyPlanAgainstAuthority(plan, authority, () => structuredClone(plan)).schema_version, plan.schema_version);
  assert.throws(() => verifyPlanAgainstAuthority(plan, authority, () => ({ ...plan, verification_queue: [] })), /differs/);
  assert.throws(() => verifyPlanAgainstAuthority(plan, { ...authority, candidate: 'bad' }, () => plan), /immutable SHA/);
});

test('command construction uses exact metadata rather than a path heuristic and never serializes Buck compilation', async () => {
  const { partitionTargetsByMetadata } = await import('./run-verification-queue.mjs');
  const partition = partitionTargetsByMetadata(queueEntry().buck2_targets, {
    'root//backend/crates/example:unit': { labels: ['test.unit'] },
    'root//tools/buck:app-example-postgres': { labels: ['needs-postgres', 'resource.postgres'] },
  });
  const commands = buildVerificationCommands(queueEntry(), '/repo', '/reports', partition);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].argv.slice(0, 5), ['/repo/tools/buck2', '--build-report', commands[0].reportPath, 'test', '-j']);
  assert.equal(commands[0].argv[5], '6');
  assert.deepEqual(commands[0].targets, ['//backend/crates/example:unit']);
  assert.deepEqual(commands[1].argv, ['/repo/tools/buck/test_needs_postgres.sh', '--build-report', commands[1].reportPath, '//tools/buck:app-example-postgres']);
  assert.ok(commands.flatMap((command) => command.argv).every((arg) => arg !== '--num-threads=1' && arg !== '--isolation-dir'));
  assert.throws(() => partitionTargetsByMetadata(['//backend/crates/example:integration'], { 'root//backend/crates/example:integration': { labels: ['needs-postgres'] } }), /credential-safe/);
});

test('execution writes a digest-bound receipt only after every combined call succeeds', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'queue-receipt-'));
  try {
    const reportRoot = path.join(root, 'reports');
    const plan = { schema_version: 'console-fanout-epoch-v2', verification_queue: [queueEntry()] };
    const selected = { path: '/canonical/repo', head: SHA };
    const calls = [];
    const result = await executeVerificationQueue(plan, {
      receiptRoot: reportRoot,
      listWorktrees: () => selected,
      inspectWorktree: () => ({ clean: true, head: SHA }),
      toolDigest: () => 'c'.repeat(64),
      platformFacts: () => ({ os: 'test', arch: 'test' }),
      queryMetadata: () => ({ 'root//backend/crates/example:unit': { labels: [] }, 'root//tools/buck:app-example-postgres': { labels: ['needs-postgres'] } }),
      run: (command) => {
        calls.push(command);
        writeFileSync(command.reportPath, `report-${calls.length}\n`);
        return { status: 0, signal: null };
      },
      monotonicNow: (() => { let tick = 0; return () => ++tick; })(),
    });
    assert.equal(calls.length, 2);
    assert.equal(result.length, 1);
    const receipt = JSON.parse(readFileSync(result[0].receipt_path, 'utf8'));
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.verification_sha, SHA);
    assert.equal(receipt.calls.length, 2);
    assert.equal(receipt.calls[0].build_report_sha256, createHash('sha256').update('report-1\n').digest('hex'));
    assert.equal(receipt.isolation_absent, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed calls leave no successful or partial receipt behind', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'queue-failure-'));
  try {
    const reportRoot = path.join(root, 'reports');
    await assert.rejects(() => executeVerificationQueue({ schema_version: 'console-fanout-epoch-v2', verification_queue: [queueEntry()] }, {
      receiptRoot: reportRoot,
      listWorktrees: () => ({ path: '/canonical/repo', head: SHA }),
      inspectWorktree: () => ({ clean: true, head: SHA }),
      toolDigest: () => 'c'.repeat(64),
      platformFacts: () => ({ os: 'test', arch: 'test' }),
      queryMetadata: () => ({ 'root//backend/crates/example:unit': { labels: [] }, 'root//tools/buck:app-example-postgres': { labels: ['needs-postgres'] } }),
      run: (command) => { writeFileSync(command.reportPath, 'failed\n'); return { status: 1, signal: null }; },
      monotonicNow: () => 1,
    }));
    assert.equal(requireNoReceipts(reportRoot), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scheduled exact-SHA cohorts run only up to declared cold-Rust capacity and expose peak telemetry', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'queue-capacity-'));
  try {
    const other = queueEntry({ verification_sha: OTHER_SHA, cache_affinity: OTHER_SHA });
    const worktrees = [{ path: '/repo-a', head: SHA }, { path: '/repo-b', head: OTHER_SHA }];
    let active = 0; let peak = 0;
    const receipts = await executeVerificationQueue({ schema_version: 'console-fanout-epoch-v2', policy: { cold_rust_compile_lanes: 2 }, verification_queue: [queueEntry(), other] }, {
      receiptRoot: path.join(root, 'reports'), maxCohorts: 2,
      listWorktrees: () => worktrees,
      inspectWorktree: (candidate) => ({ clean: true, head: worktrees.find((worktree) => worktree.path === candidate).head }),
      toolDigest: () => 'c'.repeat(64), platformFacts: () => ({ os: 'test' }), monotonicNow: () => 1,
      queryMetadata: () => ({ 'root//backend/crates/example:unit': { labels: [] }, 'root//tools/buck:app-example-postgres': { labels: ['needs-postgres'] } }),
      run: async (command) => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 5)); writeFileSync(command.reportPath, 'ok\n'); active -= 1; return { status: 0, signal: null }; },
    });
    assert.equal(receipts.length, 2);
    assert.equal(receipts.max_cohorts, 2);
    assert.equal(receipts.peak_cohorts, 2);
    assert.ok(peak <= 2);
    await assert.rejects(() => executeVerificationQueue({ schema_version: 'console-fanout-epoch-v2', policy: { cold_rust_compile_lanes: 1 }, verification_queue: [queueEntry()] }, { receiptRoot: path.join(root, 'reject'), maxCohorts: 2 }), /capacity/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function requireNoReceipts(root) {
  try { return !readFileSync(path.join(root, SHA, 'receipt.json'), 'utf8'); } catch (error) { return error.code === 'ENOENT'; }
}
