#!/usr/bin/env node
// Which .test.mjs suites actually execute in CI?
//
// A plain grep for the filename in ci.yml is wrong: workflows invoke `npm run
// test:adrs`, and package.json expands that to the file. So resolve the npm
// indirection to a fixed point, then ask which suites are reachable from a
// workflow `run:` line. Reports the reasoning so the answer can be checked
// rather than believed.

import { execFileSync } from 'node:child_process';

const REPO = '/Users/jasonlee/Developer/console';
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const files = git('ls-tree', '-r', '--name-only', 'origin/main').split('\n').filter(Boolean);
const suites = files.filter((f) => f.endsWith('.test.mjs'));
const workflows = files.filter((f) => f.startsWith('.github/workflows/'));
const pkg = JSON.parse(git('show', 'origin/main:package.json'));
const scripts = pkg.scripts ?? {};

// Every shell line a workflow actually runs.
let runText = '';
for (const w of workflows) runText += git('show', `origin/main:${w}`);

// Expand `npm run X` / `npm X` to X's body, repeatedly, until nothing new appears.
const invoked = new Set();
for (const name of Object.keys(scripts)) {
  const re = new RegExp(`npm\\s+(?:run\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w:-])`);
  if (re.test(runText)) invoked.add(name);
}
for (let changed = true; changed;) {
  changed = false;
  for (const name of [...invoked]) {
    for (const other of Object.keys(scripts)) {
      if (invoked.has(other)) continue;
      const re = new RegExp(`npm\\s+(?:run\\s+)?${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w:-])`);
      if (re.test(scripts[name])) { invoked.add(other); changed = true; }
    }
  }
}

const expanded = runText + [...invoked].map((n) => scripts[n]).join('\n');

const wired = [], nowhere = [];
for (const s of suites) {
  const direct = expanded.includes(s);
  const byBase = expanded.includes(s.split('/').pop());
  (direct || byBase ? wired : nowhere).push({ s, how: direct ? 'path' : byBase ? 'basename' : '' });
}

console.log(`.test.mjs suites on origin/main: ${suites.length}`);
console.log(`npm scripts reachable from a workflow: ${invoked.size}\n`);
console.log(`EXECUTES IN CI (${wired.length}):`);
for (const { s, how } of wired.sort((a, b) => a.s.localeCompare(b.s))) console.log(`  ${s}  [${how}]`);
console.log(`\nEXECUTES NOWHERE (${nowhere.length}):`);
for (const { s } of nowhere.sort((a, b) => a.s.localeCompare(b.s))) {
  // Is it at least runnable by hand via some npm script?
  const owner = Object.entries(scripts).find(([, v]) => v.includes(s) || v.includes(s.split('/').pop()));
  console.log(`  ${s}${owner ? `   (npm run ${owner[0]} — defined but never invoked by CI)` : '   (no npm script at all)'}`);
}
