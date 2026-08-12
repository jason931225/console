#!/usr/bin/env node
/**
 * Tracked lane-receipt validator. Schema file is the field-list SSOT.
 *
 * Usage:
 *   node scripts/console/validate-lane-receipt.mjs <receipt.json...> [--schema lane|critic]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCHEMA_URL = new URL('./lane-receipt.schema.json', import.meta.url);
const SCHEMA = JSON.parse(readFileSync(SCHEMA_URL, 'utf8'));
const NA_ENFORCEMENT = 'n/a - adds no enforcement';
const KINDS = new Set(['lane', 'critic']);

function pointer(base, key) {
  if (base === '') return String(key);
  if (/^\d+$/.test(String(key))) return `${base}[${key}]`;
  return `${base}.${key}`;
}

function resolveRef(node, root) {
  if (!node || typeof node !== 'object' || Array.isArray(node) || !('$ref' in node)) return node;
  const ref = node.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    throw new Error(`unsupported $ref: ${ref}`);
  }
  let target = root;
  for (const part of ref.slice(2).split('/')) {
    if (target == null || typeof target !== 'object') {
      throw new Error(`unresolved $ref: ${ref}`);
    }
    target = target[part];
  }
  if (target == null || typeof target !== 'object') {
    throw new Error(`unresolved $ref: ${ref}`);
  }
  const { $ref: _ignored, ...rest } = node;
  return resolveRef({ ...target, ...rest }, root);
}

function jsType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(value, expected) {
  const actual = jsType(value);
  if (expected === 'integer') return actual === 'number' && Number.isInteger(value);
  return actual === expected;
}

function walk(value, node, field, defects, root) {
  const schema = resolveRef(node, root);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;

  if (Array.isArray(schema.oneOf)) {
    const branchFailures = [];
    for (const branch of schema.oneOf) {
      const inner = [];
      walk(value, branch, field, inner, root);
      if (inner.length === 0) return;
      branchFailures.push(inner);
    }
    for (const inner of branchFailures[0] ?? [{ field, reason: 'does not match any oneOf branch' }]) {
      defects.push(inner);
    }
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      defects.push({ field, reason: `must be ${types.join('|')}` });
      return;
    }
  }

  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    defects.push({ field, reason: `must be ${JSON.stringify(schema.const)}` });
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    defects.push({ field, reason: `must be one of ${schema.enum.join('|')}` });
  }

  if (typeof schema.minLength === 'number' && typeof value === 'string' && value.length < schema.minLength) {
    defects.push({
      field,
      reason: schema.minLength === 1 ? 'must be a non-empty string' : `must have minLength ${schema.minLength}`,
    });
  }

  if (typeof schema.pattern === 'string' && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    defects.push({
      field,
      reason: schema.pattern === '^[0-9a-fA-F]{40}$' ? 'must be 40-hex' : `must match ${schema.pattern}`,
    });
  }

  if (jsType(value) === 'object' && schema.properties) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) {
        defects.push({ field: pointer(field, key), reason: 'missing required field' });
      }
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(value, key)) continue;
      walk(value[key], child, pointer(field, key), defects, root);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      defects.push({ field, reason: `must have at least ${schema.minItems} item(s)` });
    }
    if (schema.items) {
      value.forEach((item, index) => {
        walk(item, schema.items, pointer(field, index), defects, root);
      });
    }
  }
}

function enforcementAnswersContract(text) {
  const lowered = text.toLowerCase();
  const where = lowered.includes('where') || /\bruns\b/.test(lowered);
  const finest = lowered.includes('finest') || lowered.includes('data-source') || lowered.includes('data source');
  const examinedZero = lowered.includes('examined-zero') || lowered.includes('examined zero');
  return where && finest && examinedZero;
}

function applyConditionalRules(receipt, kind, defects) {
  if (kind === 'lane' && typeof receipt.enforcementPlacement === 'string' && receipt.enforcementPlacement.length > 0) {
    if (receipt.enforcementPlacement !== NA_ENFORCEMENT && !enforcementAnswersContract(receipt.enforcementPlacement)) {
      defects.push({
        field: 'enforcementPlacement',
        reason: `must be exactly "${NA_ENFORCEMENT}" or answer where the gate runs, finest data-source distinction, and how examined-zero fails`,
      });
    }
  }
  if (
    kind === 'critic'
    && receipt.verdict === 'BLOCK'
    && Array.isArray(receipt.findings)
    && receipt.findings.length === 0
  ) {
    defects.push({ field: 'findings', reason: 'empty findings array is valid only with verdict APPROVE' });
  }
}

function selectShape(kind) {
  if (kind === 'lane') return SCHEMA.$defs.laneReceipt;
  if (kind === 'critic') return SCHEMA.$defs.criticReceipt;
  return null;
}

function detectKind(receipt, forced) {
  if (forced) return forced;
  if (receipt && typeof receipt === 'object' && !Array.isArray(receipt) && KINDS.has(receipt.kind)) {
    return receipt.kind;
  }
  return null;
}

export function validateReceipt(receipt, forcedKind = null) {
  const defects = [];
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return [{ field: '', reason: 'must be a JSON object' }];
  }
  const kind = detectKind(receipt, forcedKind);
  if (!kind) {
    defects.push({ field: 'kind', reason: 'must be lane|critic' });
    return defects;
  }
  if (forcedKind && Object.hasOwn(receipt, 'kind') && receipt.kind !== forcedKind) {
    defects.push({ field: 'kind', reason: `does not match --schema ${forcedKind}` });
  }
  const shape = selectShape(kind);
  if (!shape) {
    defects.push({ field: 'kind', reason: 'must be lane|critic' });
    return defects;
  }
  walk(receipt, shape, '', defects, SCHEMA);
  applyConditionalRules(receipt, kind, defects);
  return defects;
}

export function parseArgs(argv) {
  let schemaKind = null;
  const files = [];
  const defects = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--schema') {
      const value = argv[++i];
      if (!KINDS.has(value)) {
        defects.push({ path: '', field: '--schema', reason: 'must be lane|critic' });
      } else {
        schemaKind = value;
      }
    } else if (arg.startsWith('-')) {
      defects.push({ path: '', field: arg, reason: 'unknown option' });
    } else {
      files.push(arg);
    }
  }
  return { schemaKind, files, defects };
}

function formatDefect(path, field, reason) {
  const bits = [path, field, reason].filter((part) => part !== '' && part != null);
  return bits.join(' ');
}

export function main(argv = process.argv.slice(2)) {
  const { schemaKind, files, defects: argDefects } = parseArgs(argv);
  if (files.length === 0) {
    console.error('examined zero receipts');
    return 1;
  }
  const lines = argDefects.map((d) => formatDefect(d.path, d.field, d.reason));
  for (const file of files) {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      lines.push(formatDefect(file, '', `cannot read: ${error.message}`));
      continue;
    }
    let receipt;
    try {
      receipt = JSON.parse(raw);
    } catch (error) {
      lines.push(formatDefect(file, '', `invalid JSON: ${error.message}`));
      continue;
    }
    for (const defect of validateReceipt(receipt, schemaKind)) {
      lines.push(formatDefect(file, defect.field, defect.reason));
    }
  }
  if (lines.length) {
    for (const line of lines) console.error(line);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main());
}
