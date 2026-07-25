#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const STATES = new Set(['DECLARED', 'PLANNED', 'IMPLEMENTED', 'VERIFIED', 'EXPOSED', 'HOLD']);
const VERDICTS = new Set(['MEET', 'EXCEED', 'HOLD']);
const EDGE_TYPES = new Set(['requires', 'blocks', 'integrates_with', 'validates']);
const RESOURCE_KEYS = ['writer', 'postgres', 'browser', 'ios', 'graph', 'cas'];

function fail(message) { throw new Error(message); }
function array(value) { return Array.isArray(value) ? value : []; }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`); return value; }
function nonempty(value, label) { if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`); return value; }
function sha(value, label) { if (!SHA.test(value ?? '')) fail(`${label} must be a full lowercase Git SHA`); return value; }
function uniqueStrings(values, label) { const seen = new Set(); for (const value of values) { nonempty(value, label); if (seen.has(value)) fail(`duplicate ${label}: ${value}`); seen.add(value); } return seen; }

export function validateConsoleTruthLedger(registry, jurisdiction, { resolveSha = () => true } = {}) {
  object(registry, 'registry'); object(jurisdiction, 'jurisdiction register');
  if (registry.schema_version !== 'console-capability-registry-v2') fail('unsupported console capability registry schema');
  if (jurisdiction.schema_version !== 'console-jurisdiction-register-v2') fail('unsupported console jurisdiction register schema');
  const candidate = object(registry.candidate, 'candidate');
  sha(candidate.sha, 'candidate sha');
  if (!resolveSha(candidate.sha)) fail('candidate SHA is unresolvable');
  for (const key of ['authority_base_sha', 'historical_implementation_freeze_sha']) {
    sha(registry.provenance?.[key], key);
    if (!resolveSha(registry.provenance[key])) fail(`${key} SHA is unresolvable`);
  }
  if (registry.provenance.authority_base_sha === candidate.sha) fail('authority base SHA must remain distinct from exact candidate');
  if (registry.provenance.historical_implementation_freeze_sha === candidate.sha) fail('historical implementation freeze must remain distinct from exact candidate');
  if (registry.design_reference?.sha256?.length !== 64) fail('missing Claude Design digest');
  if (typeof registry.build_reference?.buck2_release_pin !== 'string' || typeof registry.build_reference?.buck2_embedded_binary_version !== 'string') fail('missing separate Buck2 release pin and embedded binary version');
  const omni = object(registry.shared_omni_platform_gate, 'shared omni-platform gate');
  for (const area of ['identity_scope', 'object_action_workflow', 'search', 'audit_lineage', 'interoperability']) nonempty(omni.required_outcomes?.[area], `shared omni-platform gate ${area}`);
  if (!Array.isArray(registry.capabilities) || registry.capabilities.length === 0) fail('registry capabilities must be a non-empty array');
  const ids = new Set();
  const privateRoots = [];
  const sharedRoots = new Set(array(registry.shared_collision_roots?.paths));
  for (const cap of registry.capabilities) {
    object(cap, 'capability'); nonempty(cap.id, 'capability id');
    if (ids.has(cap.id)) fail(`duplicate capability id: ${cap.id}`); ids.add(cap.id);
    const truth = object(cap.truth, `${cap.id} truth`);
    for (const key of ['declared', 'implementation', 'verification', 'exposure']) {
      if (!STATES.has(truth[key])) fail(`${cap.id} invalid truth state ${key}`);
    }
    if (truth.exposure === 'EXPOSED' && truth.verification !== 'VERIFIED') fail(`${cap.id} exposed claim requires verified evidence`);
    const evidence = object(cap.candidate_evidence, `${cap.id} candidate evidence`);
    if (evidence.candidate_sha !== candidate.sha) fail(`${cap.id} candidate-bound evidence does not bind exact candidate`);
    if (!STATES.has(evidence.status)) fail(`${cap.id} candidate evidence status is invalid`);
    nonempty(evidence.reason, `${cap.id} candidate evidence reason`);
    object(evidence.contract, `${cap.id} candidate evidence contract`);
    for (const key of ['source_sha', 'backend_binary_digest_or_build_sha', 'database', 'api', 'browser', 'trace_logs']) nonempty(evidence.contract[key], `${cap.id} candidate evidence contract ${key}`);
    const benchmark = object(cap.benchmark, `${cap.id} per-module benchmark`);
    for (const key of ['category', 'non_goals', 'evidence_binding']) nonempty(benchmark[key], `${cap.id} benchmark ${key}`);
    const sources = array(benchmark.comparator_sources);
    if (!sources.length) fail(`${cap.id} per-module benchmark has no comparator sources`);
    for (const source of sources) { object(source, `${cap.id} comparator source`); nonempty(source.source, `${cap.id} comparator source path`); nonempty(source.observation_as_of, `${cap.id} comparator observation date`); nonempty(source.observation, `${cap.id} comparator observation`); }
    if (array(benchmark.native_outcomes).length < 3 || array(benchmark.native_outcomes).length > 7) fail(`${cap.id} benchmark requires 3-7 measurable native outcomes`);
    if (array(benchmark.omni_outcomes).length < 1 || array(benchmark.omni_outcomes).length > 3) fail(`${cap.id} benchmark requires 1-3 additive omni outcomes`);
    for (const outcome of [...benchmark.native_outcomes, ...benchmark.omni_outcomes]) nonempty(outcome, `${cap.id} benchmark outcome`);
    if (!VERDICTS.has(benchmark.verdict)) fail(`${cap.id} benchmark verdict is invalid`);
    nonempty(benchmark.independent_outcome_review?.status, `${cap.id} independent outcome review status`);
    if (benchmark.verdict !== 'HOLD' && evidence.status !== 'VERIFIED') fail(`${cap.id} non-HOLD benchmark requires verified candidate evidence`);
    const delivery = object(cap.delivery_unit, `${cap.id} delivery unit`);
    nonempty(delivery.id, `${cap.id} delivery unit id`);
    if (delivery.rust_required === true && array(delivery.buck2_targets).length === 0) fail(`${cap.id} Rust-required delivery unit has empty Buck targets`);
    const dependencies = array(cap.dependency_edges);
    for (const edge of dependencies) {
      object(edge, `${cap.id} dependency edge`); nonempty(edge.target, `${cap.id} dependency target`);
      if (edge.target === cap.id || !EDGE_TYPES.has(edge.type)) fail(`${cap.id} has dangling/invalid dependency`);
    }
    const route = object(cap.route_presentation, `${cap.id} route/presentation state`);
    for (const key of ['mounted', 'exposed', 'nav']) if (typeof route[key] !== 'boolean') fail(`${cap.id} route/presentation ${key} must be boolean`);
    nonempty(route.source, `${cap.id} route/presentation source`);
    if (route.exposed && !route.mounted) fail(`${cap.id} exposed route must be mounted`);
    if (truth.exposure === 'EXPOSED' && !route.exposed) fail(`${cap.id} exposed truth contradicts route presentation`);
    if (route.exposed && truth.exposure !== 'EXPOSED') fail(`${cap.id} route exposure contradicts truth state`);
    const ownership = object(cap.ownership, `${cap.id} ownership`);
    for (const key of ['frontend_roots', 'backend_roots', 'api_schema_roots']) for (const root of array(ownership[key])) nonempty(root, `${cap.id} ownership root`);
    for (const root of array(ownership.private_roots)) { nonempty(root, `${cap.id} private ownership root`); if (sharedRoots.has(root)) fail(`${cap.id} private root is declared shared`); privateRoots.push([cap.id, root]); }
    for (const root of array(ownership.serial_roots)) nonempty(root, `${cap.id} serial ownership root`);
    object(cap.resource_requirements, `${cap.id} resources`);
    for (const key of RESOURCE_KEYS) if (!Number.isInteger(cap.resource_requirements[key]) || cap.resource_requirements[key] < 0) fail(`${cap.id} invalid resource ${key}`);
    if (!array(cap.jurisdiction_bindings).length) fail(`${cap.id} missing jurisdiction bindings`);
  }
  for (const cap of registry.capabilities) for (const edge of array(cap.dependency_edges)) if (!ids.has(edge.target)) fail(`${cap.id} has dangling dependency target ${edge.target}`);
  for (let i = 0; i < privateRoots.length; i++) for (let j = i + 1; j < privateRoots.length; j++) {
    const [aId, a] = privateRoots[i], [bId, b] = privateRoots[j];
    if (aId !== bId && (a === b || a.startsWith(`${b.replace(/\/\*\*$/, '')}/`) || b.startsWith(`${a.replace(/\/\*\*$/, '')}/`))) fail(`overlapping private roots: ${aId}:${a} and ${bId}:${b}`);
  }
  const controls = new Map(array(jurisdiction.controls).map((control) => [control.id, control]));
  if (!controls.size) fail('jurisdiction register has no controls');
  for (const control of controls.values()) {
    if (control.release_disposition !== 'HOLD') fail(`jurisdiction control ${control.id} must remain HOLD without qualified authority`);
    nonempty(control.freshness?.status, `${control.id} freshness status`);
    nonempty(control.unhold_authority, `${control.id} explicit unhold authority`);
    if (!array(control.capability_traceability).length) fail(`${control.id} missing capability traceability`);
  }
  for (const cap of registry.capabilities) for (const binding of cap.jurisdiction_bindings) {
    if (!controls.has(binding.control_id)) fail(`${cap.id} has missing jurisdiction control ${binding.control_id}`);
    if (binding.candidate_sha !== candidate.sha) fail(`${cap.id} jurisdiction binding is not candidate-bound`);
  }
  return { capability_count: registry.capabilities.length, candidate_sha: candidate.sha, verdict: 'STRUCTURALLY_VALID_HOLD_PRESERVED' };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const registry = JSON.parse(readFileSync(path.join(root, 'docs/program/console-capability-registry.json')));
  const jurisdiction = JSON.parse(readFileSync(path.join(root, 'docs/program/console-jurisdiction-register.json')));
  const resolveSha = (value) => { try { execFileSync('git', ['cat-file', '-e', `${value}^{commit}`], { cwd: root, stdio: 'ignore' }); return true; } catch { return false; } };
  console.log(JSON.stringify(validateConsoleTruthLedger(registry, jurisdiction, { resolveSha }), null, 2));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
