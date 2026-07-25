import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTHORITY_PATHS, POLICY_PATH, TRUSTED_ALLOWED_SIGNER, TRUSTED_FINGERPRINT, TRUSTED_PRINCIPAL, validatePinnedPolicy, verifyBootstrapGraph } from './verify-console-pr-authority-bootstrap.mjs';

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
test('hostile HOME/program cannot replace the explicit verifier configuration seam', () => {
  const { data, calls } = fixture({ verifyCommit: (sha, authority) => { calls.push({ sha, authority, command: ['gpg.format=ssh', 'gpg.ssh.program=ssh-keygen', 'gpg.ssh.allowedSignersFile=<0600-temp>'] }); return { ok: true, principal: TRUSTED_PRINCIPAL, fingerprint: TRUSTED_FINGERPRINT }; } });
  verifyBootstrapGraph(data, { headSha: T, mergeSha: M });
  assert.ok(calls.every(({ command }) => command.includes('gpg.format=ssh') && command.includes('gpg.ssh.program=ssh-keygen') && command.includes('gpg.ssh.allowedSignersFile=<0600-temp>')));
});
