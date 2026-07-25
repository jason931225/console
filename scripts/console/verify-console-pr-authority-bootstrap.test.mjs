import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTHORITY_PATHS, POLICY_PATH, TRUSTED_ALLOWED_SIGNER, TRUSTED_FINGERPRINT, TRUSTED_PRINCIPAL, validatePinnedPolicy, verifyBootstrapGraph, verifyPinnedSshCommit } from './verify-console-pr-authority-bootstrap.mjs';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const C = 'c'.repeat(40), T = 't'.repeat(40).replace(/t/g, 'a'), M = 'b'.repeat(40), BASE = 'd'.repeat(40);
const policy = `${TRUSTED_ALLOWED_SIGNER}\n`;
const changes = AUTHORITY_PATHS.map((path) => ({ path, status: 'M', oldMode: '100644', newMode: '100644', oldType: 'blob', newType: 'blob' }));
function fixture(overrides = {}) {
  const calls = []; const registry = JSON.stringify({ candidate: { sha: C } });
  const data = {
    hasCommit: () => true,
    readFile: (sha, file) => file === POLICY_PATH ? policy : registry,
    treeEntry: () => ({ mode: '100644', type: 'blob' }),
    parents: (sha) => sha === T ? [C] : sha === M ? [BASE, T] : [],
    diff: () => changes,
    tree: (sha) => sha === M || sha === T ? 'tree-t' : 'tree-c',
    sameTreeDiff: () => true,
    verifyCommit: (sha, authority) => { calls.push({ sha, authority }); return { ok: true, principal: TRUSTED_PRINCIPAL, fingerprint: TRUSTED_FINGERPRINT }; },
    ...overrides,
  };
  return { data, calls };
}
function rejects(overrides, pattern) { const { data } = fixture(overrides); assert.throws(() => verifyBootstrapGraph(data, { headSha: T, mergeSha: M }), pattern); }

test('accepts signed C/T plus an unsigned synthetic merge M without executing marker', () => {
  const { data, calls } = fixture({ readFile: (sha, file) => {
    if (sha === M) throw new Error('synthetic merge executable/data was read');
    return file === POLICY_PATH ? policy : JSON.stringify({ candidate: { sha: C } });
  } });
  assert.deepEqual(verifyBootstrapGraph(data, { headSha: T, mergeSha: M }), { candidateSha: C, integrationTipSha: T, mergeSha: M });
  assert.deepEqual(calls.map(({ sha }) => sha), [C, T]);
  assert.ok(calls.every(({ authority }) => authority.policy === policy && authority.principal === TRUSTED_PRINCIPAL && authority.fingerprint === TRUSTED_FINGERPRINT));
});
test('rejects unsigned C and T', () => {
  rejects({ verifyCommit: () => ({ ok: false }) }, /C is not signed/);
  rejects({ verifyCommit: (sha) => sha === C ? { ok: true, principal: TRUSTED_PRINCIPAL, fingerprint: TRUSTED_FINGERPRINT } : { ok: false } }, /T is not signed/);
});
test('rejects wrong signing key or principal', () => {
  rejects({ verifyCommit: () => ({ ok: true, principal: TRUSTED_PRINCIPAL, fingerprint: 'SHA256:wrong' }) }, /C is not signed/);
  rejects({ verifyCommit: () => ({ ok: true, principal: 'attacker@example.invalid', fingerprint: TRUSTED_FINGERPRINT }) }, /C is not signed/);
});
test('rejects attacker self-authorized C policy and malformed policy', () => {
  rejects({ readFile: (sha, file) => file === POLICY_PATH ? 'attacker@example.invalid ssh-ed25519 AAAA\n' : JSON.stringify({ candidate: { sha: C } }) }, /pinned signer/);
  assert.throws(() => validatePinnedPolicy(policy.trim()), /pinned signer/);
});
test('rejects policy type/mode, policy change, and product change after C', () => {
  rejects({ treeEntry: () => ({ mode: '100755', type: 'blob' }) }, /mode-100644/);
  rejects({ diff: () => [...changes.slice(0, 2), { path: POLICY_PATH, status: 'M', oldMode: '100644', newMode: '100644', oldType: 'blob', newType: 'blob' }] }, /authority documents/);
  rejects({ diff: () => [...changes.slice(0, 2), { path: 'scripts/console/validate-console-truth-ledger.mjs', status: 'M', oldMode: '100644', newMode: '100644', oldType: 'blob', newType: 'blob' }] }, /authority documents/);
  rejects({ diff: () => [...changes.slice(0, 2), { path: 'web/src/console/marker.mjs', status: 'M', oldMode: '100644', newMode: '100644', oldType: 'blob', newType: 'blob' }] }, /authority documents/);
});
test('rejects indirect T and malformed M', () => {
  rejects({ parents: (sha) => sha === T ? [C, BASE] : [BASE, T] }, /direct single-parent/);
  rejects({ parents: (sha) => sha === T ? [C] : [BASE] }, /two-parent merge/);
  rejects({ tree: (sha) => sha === M ? 'tree-m' : 'tree-t' }, /tree\/diff/);
  rejects({ sameTreeDiff: () => false }, /tree\/diff/);
});
test('hostile global Git config cannot replace the pinned verifier or execute its marker', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'console-hostile-git-config-'));
  const marker = path.join(directory, 'marker');
  const attacker = path.join(directory, 'attacker-ssh-program');
  const globalConfig = path.join(directory, 'gitconfig');
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  try {
    writeFileSync(attacker, `#!/bin/sh\nprintf attacked > '${marker}'\nexit 1\n`, { mode: 0o700 });
    writeFileSync(globalConfig, `[gpg "ssh"]\n\tprogram = ${attacker}\n`);
    const result = verifyPinnedSshCommit(process.cwd(), sha, policy, {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'gpg.ssh.program',
      GIT_CONFIG_VALUE_0: attacker,
      HOME: directory,
      XDG_CONFIG_HOME: directory,
    });
    assert.equal(result.ok, true);
    assert.equal(result.principal, TRUSTED_PRINCIPAL);
    assert.equal(result.fingerprint, TRUSTED_FINGERPRINT);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
