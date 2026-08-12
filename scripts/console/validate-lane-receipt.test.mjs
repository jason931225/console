import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('./validate-lane-receipt.mjs', import.meta.url));
const SHA = 'b2acd80c4d7f340199b9147f6df9318d74af5f8d';
const BASE = '4417bb377a1b2c3d4e5f60718293a4b5c6d7e8f9';

function validLane(overrides = {}) {
  return {
    kind: 'lane',
    lane: 'v-lane-validator',
    headSha: SHA,
    baseSha: BASE,
    worktree: '/Users/jasonlee/Developer/console/.worktrees/v-lane-validator',
    commandsRun: ['node --test scripts/console/validate-lane-receipt.test.mjs'],
    enforcementPlacement:
      'Runs as node scripts/console/validate-lane-receipt.mjs per argv path; finest data-source distinction is one receipt file; examined-zero FAILS with exit 1.',
    peripheralsUpdated: 'scripts/console/lane-receipt.schema.json',
    classification: { personalData: false, holdAdjacent: false, notes: '' },
    preMortem: 'A silent pass on an empty argv list would mint a false green.',
    blastRadius: 'Tracked receipts and the console validator CLI only.',
    detection: 'node --test scripts/console/validate-lane-receipt.test.mjs',
    rollback: 'Revert the three scripts/console/lane-receipt files.',
    stopConditions: 'Stop if validation would require editing package.json or workflows.',
    reviewIdentities: ['v-lane-validator'],
    remainingHolds: [],
    result: 'green',
    followUps: [],
    ...overrides,
  };
}

function validCritic(overrides = {}) {
  return {
    kind: 'critic',
    verdict: 'APPROVE',
    findings: [],
    ...overrides,
  };
}

function writeReceipt(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lane-receipt-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('valid lane receipt passes', () => {
  withTemp((dir) => {
    const result = run([writeReceipt(dir, 'lane.json', validLane())]);
    assert.equal(result.status, 0, result.stderr);
  });
});

test('valid critic receipt passes', () => {
  withTemp((dir) => {
    const result = run([writeReceipt(dir, 'critic.json', validCritic())]);
    assert.equal(result.status, 0, result.stderr);
  });
});

test('missing enforcementPlacement FAILS', () => {
  withTemp((dir) => {
    const receipt = validLane();
    delete receipt.enforcementPlacement;
    const path = writeReceipt(dir, 'missing-enforcement.json', receipt);
    const result = run([path]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /enforcementPlacement missing required field/);
  });
});

test('empty-string command in commandsRun FAILS', () => {
  withTemp((dir) => {
    const path = writeReceipt(dir, 'empty-command.json', validLane({ commandsRun: ['node --test', ''] }));
    const result = run([path]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /commandsRun\[1] must be a non-empty string/);
  });
});

test('bad headSha FAILS', () => {
  withTemp((dir) => {
    const path = writeReceipt(dir, 'bad-sha.json', validLane({ headSha: 'not-a-sha' }));
    const result = run([path]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /headSha must be 40-hex/);
  });
});

test('critic finding missing provenByExecution FAILS', () => {
  withTemp((dir) => {
    const path = writeReceipt(dir, 'missing-proven.json', validCritic({
      findings: [{
        severity: 'minor',
        claim: 'x',
        failureScenario: 'y',
        location: 'z',
        ownerLease: false,
      }],
    }));
    const result = run([path]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /findings\[0]\.provenByExecution missing required field/);
  });
});

test('verdict BLOCK with empty findings FAILS', () => {
  withTemp((dir) => {
    const path = writeReceipt(dir, 'block-empty.json', validCritic({ verdict: 'BLOCK', findings: [] }));
    const result = run([path]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /findings empty findings array is valid only with verdict APPROVE/);
  });
});

test('zero-input invocation FAILS', () => {
  const result = run([]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /examined zero receipts/);
});
