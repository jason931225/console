import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extractConsoleRouteFactsFromTexts } from './route-inventory.mjs';

test('route inventory mechanically separates nav, mounted registry bodies, and exposure', () => {
  const root = new URL('../../', import.meta.url);
  const nav = readFileSync(new URL('web/src/console/shell/nav.ts', root));
  const registry = readFileSync(new URL('web/src/console/screens/registry.ts', root));
  const result = extractConsoleRouteFactsFromTexts(nav.toString(), registry.toString());
  assert.equal(result.mounted.length, 27);
  assert.deepEqual(result.exposed, ['sales']);
  assert.equal(result.facts.sales.source_mounted, true);
  assert.equal(result.facts.sales.production_exposed, true);
  assert.equal(result.facts.payroll.nav_declared, true);
  assert.equal(result.facts.payroll.source_mounted, false);
});
