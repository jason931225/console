import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const CONSOLE_NAV_SOURCE = 'web/src/console/shell/nav.ts';
export const CONSOLE_REGISTRY_SOURCE = 'web/src/console/screens/registry.ts';

// The single legitimate "no facts" value. `route_source_present: false` is the
// only thing that lets a consumer distinguish "the console has no frontend, so
// it presents no routes" from "extraction produced nothing". Consumers must
// treat a missing/false flag as absent source and refuse to corroborate any
// route claim against it.
export const ABSENT_CONSOLE_ROUTE_FACTS = Object.freeze({ route_source_present: false, facts: Object.freeze({}) });

function literals(text, declaration) {
  const match = text.match(new RegExp(`(?:export\\s+)?const\\s+${declaration}[\\s\\S]*?=\\s*\\[([\\s\\S]*?)\\](?:\\s+as const)?`));
  if (!match) throw new Error(`missing ${declaration}`);
  return [...match[1].matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((entry) => entry[1]);
}
export function extractConsoleRouteFactsFromTexts(navText, registryText) {
  const mounted = literals(navText, 'MOUNTED_SCREEN_KEYS');
  const exposed = literals(navText, 'EXPOSED_SCREEN_KEYS');
  const nav = [...navText.matchAll(/screen:\s*"([A-Za-z][A-Za-z0-9]*)"/g)].map((entry) => entry[1]);
  const bodyBlock = registryText.match(/SCREEN_REGISTRY[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!bodyBlock) throw new Error('missing SCREEN_REGISTRY');
  const bodies = [...bodyBlock[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):/gm)].map((entry) => entry[1]);
  const all = new Set([...mounted, ...exposed, ...nav, ...bodies]);
  const facts = Object.fromEntries([...all].sort().map((key) => [key, { source_mounted: mounted.includes(key), production_exposed: exposed.includes(key), registry_body_present: bodies.includes(key), nav_declared: nav.includes(key) }]));
  return { route_source_present: true, facts, mounted, exposed, nav, bodies };
}

/**
 * Absence of BOTH route sources is the only tolerated failure: the 2026-07-28
 * clean-slate pivot deleted the frontend, and a console with no frontend
 * presents no routes. Every other failure — a renamed constant, a malformed
 * SCREEN_REGISTRY, an unreadable file, a half-landed frontend — propagates.
 * Swallowing those would report "no routes" for a console that has them.
 */
export function extractConsoleRouteFacts(repoRoot) {
  const navPath = path.join(repoRoot, CONSOLE_NAV_SOURCE);
  const registryPath = path.join(repoRoot, CONSOLE_REGISTRY_SOURCE);
  const navPresent = existsSync(navPath);
  const registryPresent = existsSync(registryPath);
  if (navPresent !== registryPresent) throw new Error(`console route source is partially present: ${navPresent ? CONSOLE_REGISTRY_SOURCE : CONSOLE_NAV_SOURCE} is missing`);
  if (!navPresent) return ABSENT_CONSOLE_ROUTE_FACTS;
  return extractConsoleRouteFactsFromTexts(readFileSync(navPath, 'utf8'), readFileSync(registryPath, 'utf8'));
}

// ---------------------------------------------------------------------------
// ADR-0041: the Rust/Leptos side of the inventory.
//
// The two tombstone paths above pin the deleted React stack. ADR-0041 allows
// `console-<domain>-ui` members and lockfile Leptos; a machine-readable route
// facts file is a frontend-lane follow-up. Until that lands, inventory may
// report zero Leptos packages and must not fail HEAD for that absence.
//
// What still fails: a non-ui workspace member declaring a Leptos-family
// dependency. Cargo metadata reports the TRUE package name, so
// `view = { package = "leptos" }` renames cannot hide it.
// Unreadable inventory (missing manifest/lockfile, cargo failure, zero
// members, zero locked packages) throws — the gate fails closed, never
// reports a clean state it did not observe.
//
// The import lives down here so the tombstone constants above keep their
// lines: ADR-0030 cites route-inventory.mjs:4-5 verbatim. ESM hoists it.
import { execFileSync } from 'node:child_process';

export const BACKEND_WORKSPACE_MANIFEST = 'backend/Cargo.toml';
export const BACKEND_WORKSPACE_LOCKFILE = 'backend/Cargo.lock';

// Matches the framework's package namespace (leptos, leptos_axum,
// leptos_meta, leptos-use, ...) on a separator boundary, so `leptose`-style
// strangers do not match. Lockfile leptos is allowed (ADR-0041); a non-ui
// member must still declare the true package name to be flagged.
export const LEPTOS_PACKAGE_FAMILY = /^leptos(?:[_-]|$)/;

// ADR-0030 §6: the chartered per-domain surface crate is console-<domain>-ui.
export const CONSOLE_UI_MEMBER_NAME = /(?:^|-)ui$/;

const ADR = 'ADR-0041 non-ui Leptos violation';

/**
 * Classifier over `cargo metadata` packages. Ui members may declare Leptos.
 * A non-ui member that declares a Leptos-family dependency is a violation.
 * Throws instead of returning clean when handed nothing or anything it cannot
 * read: a scan that examined zero members has observed nothing and must not pass.
 */
export function workspaceMemberViolations(packages, { repoRoot } = {}) {
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error('workspace scan examined zero workspace members; refusing to report a clean state it did not observe');
  }
  const violations = [];
  for (const pkg of packages) {
    if (typeof pkg?.name !== 'string' || pkg.name === '' || typeof pkg?.manifest_path !== 'string' || !Array.isArray(pkg?.dependencies)) {
      throw new Error('workspace scan met a member missing name/manifest_path/dependencies; refusing to classify what it cannot read');
    }
    const where = repoRoot ? path.relative(repoRoot, pkg.manifest_path) : pkg.manifest_path;
    const uiMember = CONSOLE_UI_MEMBER_NAME.test(pkg.name);
    for (const dep of pkg.dependencies) {
      if (typeof dep?.name !== 'string' || dep.name === '') {
        throw new Error(`workspace scan met an unreadable dependency of '${pkg.name}'; refusing to classify what it cannot read`);
      }
      if (!uiMember && LEPTOS_PACKAGE_FAMILY.test(dep.name)) {
        const alias = typeof dep.rename === 'string' && dep.rename ? ` (renamed locally to '${dep.rename}')` : '';
        violations.push(`${ADR}: workspace member '${pkg.name}' (${where}) declares Leptos-family dependency '${dep.name}'${alias}; Leptos is legal only on Layer::Ui members (package name ending in -ui)`);
      }
    }
  }
  return violations;
}

/**
 * Pure lockfile reader: every `[[package]]` block must yield a name, and a
 * lockfile with no blocks is unreadable, not clean.
 */
export function lockedPackageNames(lockfileText) {
  if (typeof lockfileText !== 'string' || !lockfileText.includes('[[package]]')) {
    throw new Error(`${BACKEND_WORKSPACE_LOCKFILE} holds no [[package]] blocks; the locked dependency graph is unreadable and unreadable must fail`);
  }
  return lockfileText.split('[[package]]').slice(1).map((block, index) => {
    const name = block.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (!name) throw new Error(`${BACKEND_WORKSPACE_LOCKFILE} [[package]] block ${index + 1} carries no name; refusing to scan a graph it cannot read`);
    return name[1];
  });
}

/**
 * The Rust-side inventory: enumerate workspace members through Cargo's own
 * authority (`cargo metadata --no-deps`, glob-aware, rename-transparent) and
 * the locked graph. Ui members and lockfile Leptos are allowed (ADR-0041).
 * A non-ui member declaring Leptos is a violation. Every unreadable input throws.
 */
export function extractConsoleWorkspaceFacts(repoRoot) {
  const manifestPath = path.join(repoRoot, BACKEND_WORKSPACE_MANIFEST);
  const lockfilePath = path.join(repoRoot, BACKEND_WORKSPACE_LOCKFILE);
  if (!existsSync(manifestPath)) throw new Error(`${BACKEND_WORKSPACE_MANIFEST} is missing under ${repoRoot}; the workspace inventory cannot see its subject and unreadable must fail`);
  if (!existsSync(lockfilePath)) throw new Error(`${BACKEND_WORKSPACE_LOCKFILE} is missing under ${repoRoot}; the workspace inventory cannot see the locked graph and unreadable must fail`);
  let stdout;
  try {
    stdout = execFileSync(
      'cargo',
      ['metadata', '--no-deps', '--format-version', '1', '--offline', '--manifest-path', manifestPath],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(`cargo metadata failed; the workspace inventory cannot enumerate workspace members and unreadable must fail: ${stderr || error.message}`);
  }
  let metadata;
  try {
    metadata = JSON.parse(stdout);
  } catch {
    throw new Error('cargo metadata emitted unparseable JSON; the workspace inventory cannot enumerate workspace members and unreadable must fail');
  }
  const packages = Array.isArray(metadata.packages) ? metadata.packages : [];
  const memberViolations = workspaceMemberViolations(packages, { repoRoot });
  const lockedNames = lockedPackageNames(readFileSync(lockfilePath, 'utf8'));
  const uiMemberCount = packages.filter((pkg) => typeof pkg?.name === 'string' && CONSOLE_UI_MEMBER_NAME.test(pkg.name)).length;
  const leptosLockedPackageCount = lockedNames.filter((name) => LEPTOS_PACKAGE_FAMILY.test(name)).length;
  return {
    workspace_scanned: true,
    member_count: packages.length,
    locked_package_count: lockedNames.length,
    ui_member_count: uiMemberCount,
    leptos_locked_package_count: leptosLockedPackageCount,
    violations: memberViolations,
  };
}
