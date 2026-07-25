import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { validateConsoleTruthLedger } from '/Users/jasonlee/Developer/maintenance-worktrees/w4-epoch-20260725/scripts/console/validate-console-truth-ledger.mjs';
import { extractConsoleRouteFactsFromTexts } from '/Users/jasonlee/Developer/maintenance-worktrees/w4-epoch-20260725/scripts/console/route-inventory.mjs';
const R = '/Users/jasonlee/Developer/maintenance-worktrees/w4-epoch-20260725';
const C = '88c57a1d519b43bc4c0e7b721c62bc248b938b38';
const show = (p) => execFileSync('git', ['-C', R, 'show', `${C}:${p}`], { encoding: 'utf8' });
const facts = extractConsoleRouteFactsFromTexts(show('web/src/console/shell/nav.ts'), show('web/src/console/screens/registry.ts'));
const reg = JSON.parse(readFileSync(`${R}/docs/program/console-capability-registry.json`, 'utf8'));
const jur = JSON.parse(readFileSync(`${R}/docs/program/console-jurisdiction-register.json`, 'utf8'));
const KEEP = new Set(['CAP-SALES-CRM', 'CAP-ONTOLOGY-ENGINE', 'CAP-CONSOLE-SHELL', 'CAP-SHARED-ONTOLOGY-WORKFLOW']);
reg.capabilities = reg.capabilities.filter((c) => KEEP.has(c.id));
// route inventory bijection: everything the subset does not own becomes unmodeled
const owned = new Set(reg.capabilities.flatMap((c) => c.route_presentation.route_keys));
reg.source_inventory.unmodeled_keys = Object.keys(facts.facts).filter((k) => !owned.has(k)).map((key) => ({ key, status: 'HOLD_UNMAPPED' }));
// jurisdiction bijection: keep only subset traces, add the two new ones (this IS the manifest)
for (const control of jur.controls) {
  control.capability_traceability = control.capability_traceability.filter((t) => KEEP.has(t.capability_id));
  for (const id of ['CAP-SALES-CRM', 'CAP-ONTOLOGY-ENGINE']) {
    control.capability_traceability.push({ capability_id: id, candidate_sha: reg.candidate.sha });
  }
}
try { console.log('PASS', JSON.stringify(validateConsoleTruthLedger(reg, jur, { resolveSha: () => true, resolveBuckTarget: () => true, resolveSource: () => true, facts, routeFacts: facts, repoRoot: R }))); }
catch (e) { console.log('FAIL:', e.message); }
