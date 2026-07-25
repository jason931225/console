#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseImmutableJson } from './immutable-json.mjs';
import { extractConsoleRouteFacts } from './route-inventory.mjs';

const SHA = /^[0-9a-f]{40}$/;
const STATES = new Set(['DECLARED', 'PLANNED', 'IMPLEMENTED', 'VERIFIED', 'EXPOSED', 'HOLD']);
const VERDICTS = new Set(['MEET', 'EXCEED', 'HOLD']);
const EDGE_TYPES = new Set(['requires', 'blocks', 'integrates_with', 'validates']);
const validatedRegistries = new WeakSet();
const RESOURCE_KEYS = ['writer', 'postgres', 'browser', 'ios', 'graph', 'cas'];

function fail(message) { throw new Error(message); }
function array(value) { return Array.isArray(value) ? value : []; }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`); return value; }
function nonempty(value, label) { if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`); return value; }
function sha(value, label) { if (!SHA.test(value ?? '')) fail(`${label} must be a full lowercase Git SHA`); return value; }
function uniqueStrings(values, label) { const seen = new Set(); for (const value of values) { nonempty(value, label); if (seen.has(value)) fail(`duplicate ${label}: ${value}`); seen.add(value); } return seen; }

export function validateConsoleTruthLedger(registry, jurisdiction, { resolveSha = () => true, resolveBuckTarget = () => true, resolveSource = () => true, expectedCandidateSha, routeFacts } = {}) {
  object(registry, 'registry'); object(jurisdiction, 'jurisdiction register');
  if (registry.schema_version !== 'console-capability-registry-v2') fail('unsupported console capability registry schema');
  if (jurisdiction.schema_version !== 'console-jurisdiction-register-v2') fail('unsupported console jurisdiction register schema');
  const candidate = object(registry.candidate, 'candidate');
  sha(candidate.sha, 'candidate sha');
  if (!SHA.test(expectedCandidateSha ?? '') || candidate.sha !== expectedCandidateSha) fail('ledger candidate does not match externally supplied expected candidate SHA');
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
  const globalOutcomeAssertions = new Set();
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
    for (const source of sources) { object(source, `${cap.id} comparator source`); nonempty(source.source, `${cap.id} comparator source path`); nonempty(source.observation_as_of, `${cap.id} comparator observation date`); if (!/^\d{4}-\d{2}-\d{2}$/.test(source.observation_as_of) || Number.isNaN(Date.parse(`${source.observation_as_of}T00:00:00Z`))) fail(`${cap.id} comparator observation date must be ISO`); if (!resolveSource(source.source)) fail(`${cap.id} comparator source is not repository-resolvable`); nonempty(source.observation, `${cap.id} comparator observation`); }
    if (array(benchmark.native_outcomes).length < 3 || array(benchmark.native_outcomes).length > 7) fail(`${cap.id} benchmark requires 3-7 measurable native outcomes`);
    if (array(benchmark.omni_outcomes).length < 1 || array(benchmark.omni_outcomes).length > 3) fail(`${cap.id} benchmark requires 1-3 additive omni outcomes`);
    const outcomeIds = new Set(); const outcomeShapes = new Set();
    for (const outcome of [...benchmark.native_outcomes, ...benchmark.omni_outcomes]) { object(outcome, `${cap.id} benchmark outcome`); for (const key of ['id','persona_scenario','action_workflow','measurable_assertion','required_receipts','status']) nonempty(outcome[key], `${cap.id} benchmark outcome ${key}`); if (outcome.status !== 'HOLD') fail(`${cap.id} benchmark outcome must remain HOLD`); if (outcomeIds.has(outcome.id)) fail(`${cap.id} duplicate benchmark outcome id`); outcomeIds.add(outcome.id); const shape=outcome.measurable_assertion; if (outcomeShapes.has(shape) || globalOutcomeAssertions.has(shape)) fail(`${cap.id} duplicate benchmark outcome assertion`); outcomeShapes.add(shape); globalOutcomeAssertions.add(shape); }
    if (!['SOURCE_BOUNDED_STARTING_DOSSIER','HOLD_INSUFFICIENT_CATEGORY_DOSSIER'].includes(benchmark.dossier_status)) fail(`${cap.id} benchmark dossier status is invalid`);
    if (benchmark.dossier_status === 'HOLD_INSUFFICIENT_CATEGORY_DOSSIER') nonempty(benchmark.missing_dossier_reason, `${cap.id} missing dossier reason`);
    if (!VERDICTS.has(benchmark.verdict)) fail(`${cap.id} benchmark verdict is invalid`);
    nonempty(benchmark.independent_outcome_review?.status, `${cap.id} independent outcome review status`); if (benchmark.independent_outcome_review.status !== 'HOLD') { const review=benchmark.independent_outcome_review; if (review.candidate_sha !== candidate.sha || !nonempty(review.receipt_path, `${cap.id} review receipt path`) || !nonempty(review.reviewer_id, `${cap.id} independent reviewer`) || review.reviewer_id === cap.owner) fail(`${cap.id} non-HOLD outcome review is not independent candidate-bound receipt-backed evidence`); }
    if (benchmark.verdict !== 'HOLD' && evidence.status !== 'VERIFIED') fail(`${cap.id} non-HOLD benchmark requires verified candidate evidence`);
    const delivery = object(cap.delivery_unit, `${cap.id} delivery unit`);
    nonempty(delivery.id, `${cap.id} delivery unit id`);
    if (!['NOT_APPLICABLE','REQUIRED','REQUIRED_UNRESOLVED'].includes(delivery.rust_status)) fail(`${cap.id} delivery unit has invalid Rust status`);
    const buckTargets = array(delivery.buck2_targets);
    if (delivery.rust_status === 'REQUIRED' && !buckTargets.length) fail(`${cap.id} Rust-required delivery unit has empty Buck targets`);
    if (delivery.rust_status === 'REQUIRED_UNRESOLVED' && (truth.implementation !== 'HOLD' || evidence.status !== 'HOLD')) fail(`${cap.id} unresolved Rust delivery must remain HOLD`);
    for (const target of buckTargets) { if (typeof target !== 'string' || !/^\/\/[A-Za-z0-9_./-]+:[A-Za-z0-9_.-]+$/.test(target) || !resolveBuckTarget(target)) fail(`${cap.id} has invalid/nonexistent Buck target`); }
    const dependencies = array(cap.dependency_edges);
    for (const edge of dependencies) {
      object(edge, `${cap.id} dependency edge`); nonempty(edge.target, `${cap.id} dependency target`);
      if (edge.target === cap.id || !EDGE_TYPES.has(edge.type)) fail(`${cap.id} has dangling/invalid dependency`);
    }
    const route = object(cap.route_presentation, `${cap.id} route/presentation state`);
    if (!Array.isArray(route.route_keys)) fail(`${cap.id} route keys must be an array`);
    for (const key of ['source_mounted', 'production_exposed', 'registry_body_present', 'nav_declared']) if (typeof route[key] !== 'boolean') fail(`${cap.id} route/presentation ${key} must be boolean`);
    nonempty(route.evidence_receipt_status, `${cap.id} route evidence receipt status`); nonempty(route.source, `${cap.id} route/presentation source`);
    if (route.production_exposed && !route.source_mounted) fail(`${cap.id} exposed route must be mounted`);
    if (truth.exposure === 'EXPOSED' && !route.production_exposed) fail(`${cap.id} exposed truth contradicts route presentation`);
    if (route.production_exposed && truth.exposure !== 'EXPOSED') fail(`${cap.id} route exposure contradicts truth state`);
    if (routeFacts) for (const key of route.route_keys) { const fact=routeFacts.facts?.[key]; if (!fact || ['source_mounted','production_exposed','registry_body_present','nav_declared'].some((field)=>fact[field]!==route[field])) fail(`${cap.id} route source fact mismatch for ${key}`); }
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
  if (array(jurisdiction.target_jurisdiction_set).length !== 1 || jurisdiction.target_jurisdiction_set[0] !== 'KR' || !array(jurisdiction.jurisdictions).every((entry) => entry?.country_code === 'KR' && entry.id === 'JUR-KR-001')) fail('jurisdiction target must be exactly KR / JUR-KR-001');
  const controls = new Map(); for (const control of array(jurisdiction.controls)) { if (controls.has(control.id)) fail(`duplicate control id: ${control.id}`); controls.set(control.id, control); }
  if (!controls.size) fail('jurisdiction register has no controls');
  for (const control of controls.values()) {
    if (control.release_disposition !== 'HOLD') fail(`jurisdiction control ${control.id} must remain HOLD without qualified authority`);
    nonempty(control.freshness?.status, `${control.id} freshness status`);
    nonempty(control.unhold_authority, `${control.id} explicit unhold authority`);
    if (!array(control.capability_traceability).length) fail(`${control.id} missing capability traceability`); const traceTuples = new Set(); for (const trace of control.capability_traceability) { const tuple=`${trace.capability_id}|${trace.candidate_sha}`; if (traceTuples.has(tuple)) fail(`${control.id} duplicate trace tuple`); traceTuples.add(tuple); if (trace.candidate_sha !== candidate.sha) fail(`${control.id} trace is not candidate-bound`); } if (control.candidate_evidence?.candidate_sha !== candidate.sha) fail(`${control.id} control evidence is not candidate-bound`);
  }
  for (const cap of registry.capabilities) for (const binding of cap.jurisdiction_bindings) {
    if (binding.jurisdiction_id !== 'JUR-KR-001' || !controls.has(binding.control_id)) fail(`${cap.id} has missing jurisdiction control ${binding.control_id}`);
    if (binding.candidate_sha !== candidate.sha) fail(`${cap.id} jurisdiction binding is not candidate-bound`);
    if (!array(controls.get(binding.control_id).capability_traceability).some((trace) => trace.capability_id === cap.id && trace.candidate_sha === candidate.sha)) fail(`${cap.id} jurisdiction trace is not bidirectional`);
  }
  validatedRegistries.add(registry);
  return { capability_count: registry.capabilities.length, candidate_sha: candidate.sha, verdict: 'STRUCTURALLY_VALID_HOLD_PRESERVED' };
}
export function isValidatedConsoleTruthLedger(registry) { return validatedRegistries.has(registry); }

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const registry = parseImmutableJson(readFileSync(path.join(root, 'docs/program/console-capability-registry.json'), 'utf8'), 'console capability registry').value;
  const jurisdiction = parseImmutableJson(readFileSync(path.join(root, 'docs/program/console-jurisdiction-register.json'), 'utf8'), 'console jurisdiction register').value;
  const resolveSource = (value) => typeof value === 'string' && !value.includes('..') && existsSync(path.join(root, value));
  const resolveBuckTarget = (target) => { try { execFileSync(path.join(root, 'tools/buck2'), ['targets', target], { cwd: root, stdio: 'ignore' }); return true; } catch { return false; } };
  const resolveSha = (value) => { try { execFileSync('git', ['cat-file', '-e', `${value}^{commit}`], { cwd: root, stdio: 'ignore' }); return true; } catch { return false; } };
  const expectedCandidateSha = process.env.CONSOLE_EXPECTED_CANDIDATE_SHA ?? 'ebdf4c81d22502fac7a46192dd0b237fc0748241';
  console.log(JSON.stringify(validateConsoleTruthLedger(registry, jurisdiction, { resolveSha, resolveSource, resolveBuckTarget, expectedCandidateSha, routeFacts: extractConsoleRouteFacts(root) }), null, 2));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
