// H-1 gate: prove the request bodies that can be resolved mechanically, and name every body or
// enum direction that cannot. The register is an exact snapshot, not a suppression list: live
// mismatches are always findings, while every undecidable entry must match its source-derived
// operation, binding metadata, and reason byte-for-byte.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import { hasOwnKey, own } from "./own-property.mjs";

const ANCHORS = [
  "POST /api/v1/equipment-3r/rental-cases/{case_id}/handover",
  "POST /api/v1/inventory/items/{item_id}/consumptions",
  "POST /api/v1/inventory/items/{item_id}/receipts",
];

const ENUM_ANCHORS = [
  "POST /api/v1/benefit-catalog/items#category",
  "PATCH /api/v1/benefit-catalog/items/{benefit_id}#category",
  "POST /api/v1/evaluation/cycles#kind",
  "PUT /api/v1/evaluation/subjects/{subject_id}/reviews/{kind}#grade",
  "POST /api/v1/evaluation/subjects/{subject_id}/calibrate#final_grade",
  "POST /api/v1/inventory/cycle-counts/{count_id}/lines#reason",
  "POST /api/v1/inventory/cycle-counts/{count_id}/decision#decision",
];

const RESOLVED_FLOOR = 45;
const CENSUS_FLOOR = 291;
const ENUM_RESOLVED_FLOOR = 7;
const BODY_UNDECIDABLE_MAX = 238;
const ENUM_UNDECIDABLE_MAX = 15;
const REGISTER_VERSION = 1;
const REGISTER_PATH = "scripts/request-body-contract-undecidable.json";
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

const BODY_REASONS = new Set([
  "non_json_request_body",
  "route_parser_unresolved",
  "no_direct_json_binding",
  "openapi_schema_ref_chain_unsupported",
  "openapi_schema_composition_unsupported",
  "rust_struct_not_strict",
  "no_openapi_request_body",
]);
const ENUM_REASONS = new Set([
  "string_backed_spec_enum",
  "tagged_or_data_enum",
  "rust_enum_unsupported",
  "rust_enum_ambiguous",
  "rust_enum_unresolved",
  "openapi_enum_schema_unsupported",
]);

// These expressions intentionally cover the concrete first-party route and handler forms. Any
// new syntax falls into the exact undecidable register instead of being guessed.
const CONST_PATH = /pub const ([A-Z0-9_]+): &str =\s*"([^"]+)"/g;
const ROUTE = /\.route\(\s*([A-Z0-9_]+)\s*,([\s\S]*?)\)\s*,?\s*\)/g;
const METHOD = /\b(get|post|put|patch|delete)\(\s*([a-z0-9_]+)/g;
const HANDLER = /async fn ([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*->/g;
const JSON_BODY = /Json\(\s*\w+\s*\)\s*:\s*Json<\s*((?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Za-z_][A-Za-z0-9_]*)\s*>/;
const ITEM = /((?:#\[[^\]]*\]\s*)*)(?:pub(?:\([^)]*\))?\s+)?(struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*<[^>{;]*>)?\s*\{/g;
const RENAME_ALL = /rename_all\s*=\s*"([A-Za-z_-]+)"/;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function renameField(name, style) {
  const pascal = () => name.split("_").filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1)).join("");
  switch (style) {
    case "camelCase":
      return pascal().replace(/^./, (first) => first.toLowerCase());
    case "PascalCase":
      return pascal();
    case "kebab-case":
      return name.replaceAll("_", "-");
    case "SCREAMING-KEBAB-CASE":
      return name.replaceAll("_", "-").toUpperCase();
    case "UPPERCASE":
    case "SCREAMING_SNAKE_CASE":
      return name.toUpperCase();
    default:
      return name;
  }
}

// Mirrors serde_derive_internals::case::RenameRule::apply_to_variant. Variant names begin in
// PascalCase, so these rules are deliberately not implemented through renameField.
export function renameVariant(name, style) {
  const snake = () => [...name].map((character, index) => {
    const separator = index > 0 && character >= "A" && character <= "Z" ? "_" : "";
    return `${separator}${character.toLowerCase()}`;
  }).join("");
  switch (style) {
    case "lowercase":
      return name.toLowerCase();
    case "UPPERCASE":
      return name.toUpperCase();
    case "camelCase":
      return name.replace(/^./, (first) => first.toLowerCase());
    case "snake_case":
      return snake();
    case "SCREAMING_SNAKE_CASE":
      return snake().toUpperCase();
    case "kebab-case":
      return snake().replaceAll("_", "-");
    case "SCREAMING-KEBAB-CASE":
      return snake().replaceAll("_", "-").toUpperCase();
    default:
      return name;
  }
}

function rustFiles(directory, collected = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
  } catch {
    return collected;
  }
  for (const entry of entries) {
    if (entry.name === "target" || entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) rustFiles(path, collected);
    else if (entry.name.endsWith(".rs")) collected.push(path);
  }
  return collected;
}

function parseStructFields(body) {
  const fields = [];
  let pendingRename = null;
  let pendingDefault = false;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#[")) {
      pendingRename = line.match(/\brename\s*=\s*"([^"]+)"/)?.[1] ?? pendingRename;
      if (/\bdefault\b/.test(line)) pendingDefault = true;
      continue;
    }
    if (line.startsWith("//") || line === "") continue;
    const field = line.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:r#)?([a-z0-9_]+)\s*:\s*(.+?),?$/);
    if (field) {
      fields.push({ name: field[1], type: field[2], rename: pendingRename, hasDefault: pendingDefault });
    }
    pendingRename = null;
    pendingDefault = false;
  }
  return fields;
}

// This deliberately small lexical scanner is shared by item-body discovery and enum-variant
// splitting. Rust comments are whitespace, block comments nest, literals are indivisible, and
// (), [], and {} must balance. Keeping those rules in one place prevents either caller from
// interpreting braces or commas that the other caller correctly knows are literal bytes.
function codePointBefore(source, index) {
  if (index <= 0) return null;
  let start = index - 1;
  const trailing = source.charCodeAt(start);
  if (trailing >= 0xDC00 && trailing <= 0xDFFF && start > 0) {
    const leading = source.charCodeAt(start - 1);
    if (leading >= 0xD800 && leading <= 0xDBFF) start -= 1;
  }
  return source.slice(start, index);
}

function rawStringOpening(source, index) {
  let cursor;
  if (source[index] === "r") cursor = index + 1;
  else if ((source[index] === "b" || source[index] === "c") && source[index + 1] === "r") {
    cursor = index + 2;
  } else return null;
  if (/^[_\p{ID_Continue}]$/u.test(codePointBefore(source, index) ?? "")) return null;
  const hashStart = cursor;
  while (source[cursor] === "#") cursor += 1;
  if (source[cursor] !== '"') return null;
  const hashes = source.slice(hashStart, cursor);
  return hashes.length <= 255
    ? { valid: true, opening: source.slice(index, cursor + 1), closing: `"${hashes}` }
    : { valid: false };
}

function cookedStringClosing(source, opening) {
  let escaped = false;
  for (let index = opening + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') return index;
  }
  return -1;
}

function characterLiteralClosing(source, opening) {
  let index = opening + 1;
  if (index >= source.length || source[index] === "\n" || source[index] === "\r") return -1;
  if (source[index] === "\\") {
    index += 1;
    if (source[index] === "u" && source[index + 1] === "{") {
      const closingBrace = source.indexOf("}", index + 2);
      if (closingBrace < 0 || /[\r\n]/.test(source.slice(index, closingBrace))) return -1;
      const digits = source.slice(index + 2, closingBrace);
      if (!/^[0-9A-Fa-f_]+$/.test(digits) || !/[0-9A-Fa-f]/.test(digits)) return -1;
      const scalar = Number.parseInt(digits.replaceAll("_", ""), 16);
      if (scalar > 0x10FFFF || (scalar >= 0xD800 && scalar <= 0xDFFF)) return -1;
      index = closingBrace + 1;
    } else if (source[index] === "x") {
      if (!/^[0-9A-Fa-f]{2}$/.test(source.slice(index + 1, index + 3))) return -1;
      index += 3;
    } else {
      if (!/[0nrt\\'\"]/.test(source[index] ?? "")) return -1;
      index += 1;
    }
  } else {
    const point = source.codePointAt(index);
    if (point === undefined) return -1;
    index += point > 0xFFFF ? 2 : 1;
  }
  return source[index] === "'" ? index : -1;
}

function rustIdentifierStartsAt(source, index) {
  const point = source.codePointAt(index);
  return point !== undefined && /^[_\p{ID_Start}]$/u.test(String.fromCodePoint(point));
}

function commentWhitespace(comment) {
  return comment.replace(/[^\r\n]/g, " ");
}

function scanRustSyntax(source, {
  start = 0,
  rootDelimiter = null,
  splitTopLevel = false,
  projectCode = false,
} = {}) {
  const closes = { "(": ")", "[": "]", "{": "}" };
  const opens = new Set(Object.keys(closes));
  const closing = new Set(Object.values(closes));
  const delimiters = [];
  const segments = [];
  let segment = "";
  let projection = "";
  const append = (text) => {
    if (splitTopLevel) segment += text;
  };
  const project = (text) => {
    if (projectCode) projection += text;
  };
  const invalid = (error) => ({ valid: false, closing: -1, segments: [], projection: null, error });

  if (rootDelimiter !== null && source[start] !== rootDelimiter) {
    return invalid(`expected root delimiter ${rootDelimiter}`);
  }

  for (let index = start; index < source.length;) {
    const character = source[index];
    const next = source[index + 1];

    if (character === "/" && next === "/") {
      const newline = source.indexOf("\n", index + 2);
      const end = newline < 0 ? source.length : newline + 1;
      const whitespace = commentWhitespace(source.slice(index, end));
      append(whitespace);
      project(whitespace);
      index = end;
      continue;
    }
    if (character === "/" && next === "*") {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === "/" && source[cursor + 1] === "*") {
          depth += 1;
          cursor += 2;
        } else if (source[cursor] === "*" && source[cursor + 1] === "/") {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (depth > 0) return invalid("unterminated block comment");
      const whitespace = commentWhitespace(source.slice(index, cursor));
      append(whitespace);
      project(whitespace);
      index = cursor;
      continue;
    }

    const raw = rawStringOpening(source, index);
    if (raw) {
      if (!raw.valid) return invalid("raw string delimiter exceeds Rust's 255-hash limit");
      const rawEnd = source.indexOf(raw.closing, index + raw.opening.length);
      if (rawEnd < 0) return invalid("unterminated raw string literal");
      const end = rawEnd + raw.closing.length;
      const literal = source.slice(index, end);
      append(literal);
      project(commentWhitespace(literal));
      index = end;
      continue;
    }

    if (character === '"') {
      const stringEnd = cookedStringClosing(source, index);
      if (stringEnd < 0) return invalid("unterminated cooked string literal");
      const literal = source.slice(index, stringEnd + 1);
      append(literal);
      project(commentWhitespace(literal));
      index = stringEnd + 1;
      continue;
    }

    if (character === "'") {
      const literalEnd = characterLiteralClosing(source, index);
      if (literalEnd >= 0) {
        const literal = source.slice(index, literalEnd + 1);
        append(literal);
        project(commentWhitespace(literal));
        index = literalEnd + 1;
        continue;
      }
      if (!rustIdentifierStartsAt(source, index + 1)) {
        return invalid("unsupported or unterminated character literal");
      }
    }

    if (opens.has(character)) {
      delimiters.push(character);
    } else if (closing.has(character)) {
      const opening = delimiters.at(-1);
      if (!opening || closes[opening] !== character) {
        return invalid(`unbalanced closing delimiter ${character}`);
      }
      delimiters.pop();
      if (rootDelimiter !== null && delimiters.length === 0) {
        return { valid: true, closing: index, segments: [], projection: null, error: null };
      }
    } else if (character === "," && splitTopLevel && delimiters.length === 0) {
      segments.push(segment.trim());
      segment = "";
      project(character);
      index += 1;
      continue;
    }
    append(character);
    project(character);
    index += 1;
  }

  if (rootDelimiter !== null) return invalid(`unterminated root delimiter ${rootDelimiter}`);
  if (delimiters.length > 0) return invalid(`unterminated delimiter ${delimiters.at(-1)}`);
  const tail = segment.trim();
  if (tail) segments.push(tail);
  return { valid: true, closing: -1, segments, projection, error: null };
}

function topLevelSegments(body) {
  return scanRustSyntax(body, { splitTopLevel: true });
}

function serdeAttributes(attributes) {
  return [...attributes.matchAll(/#\[serde\(([^\]]*)\)\]/g)].map((match) => match[1]).join(",");
}

function parseEnum(attributes, body) {
  const serde = serdeAttributes(attributes);
  const derivesDeserialize = [...attributes.matchAll(/#\[derive\(([^\]]*)\)\]/g)]
    .some((match) => /(?:^|[,:\s])(?:serde::)?Deserialize(?:$|[,:\s])/.test(match[1]));
  const parsed = topLevelSegments(body);
  const variants = [];
  let hasVariantAttribute = false;
  let hasData = false;
  let hasUnsupportedSyntax = !parsed.valid;
  for (const segment of parsed.segments) {
    const cleaned = segment.trim();
    if (!cleaned) continue;
    if (cleaned.startsWith("#")) {
      hasVariantAttribute = true;
      continue;
    }
    const variant = cleaned.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (!variant) {
      hasUnsupportedSyntax = true;
      continue;
    }
    variants.push(variant[1]);
    const suffix = cleaned.slice(variant[0].length).trim();
    if (suffix.startsWith("(") || suffix.startsWith("{")) hasData = true;
    else if (suffix && !suffix.startsWith("=")) hasUnsupportedSyntax = true;
  }
  let reason = null;
  if (hasData || /(?:^|,)\s*(?:tag|content|untagged)\b/.test(serde)) {
    reason = "tagged_or_data_enum";
  } else if (
    !derivesDeserialize
    || hasVariantAttribute
    || hasUnsupportedSyntax
    || /(?:^|,)\s*(?:remote|from|try_from)\b/.test(serde)
    || variants.length === 0
  ) {
    reason = "rust_enum_unsupported";
  }
  return {
    renameAll: serde.match(RENAME_ALL)?.[1] ?? null,
    variants,
    reason,
  };
}

function parseItems(source, file) {
  const structs = [];
  const enums = [];
  const projected = scanRustSyntax(source, { projectCode: true });
  if (!projected.valid) {
    throw new Error(`cannot scan Rust source ${file}: ${projected.error}`);
  }
  ITEM.lastIndex = 0;
  let match;
  while ((match = ITEM.exec(projected.projection)) !== null) {
    const opening = ITEM.lastIndex - 1;
    const scan = scanRustSyntax(source, { start: opening, rootDelimiter: "{" });
    if (!scan.valid) {
      throw new Error(`cannot scan Rust item body ${file}::${match[3]}: ${scan.error}`);
    }
    const closing = scan.closing;
    const attributes = source.slice(match.index, match.index + match[1].length);
    const body = source.slice(opening + 1, closing);
    if (match[2] === "struct") {
      const serde = serdeAttributes(attributes);
      structs.push({
        file,
        name: match[3],
        denyUnknown: /\bdeny_unknown_fields\b/.test(serde),
        renameAll: serde.match(RENAME_ALL)?.[1] ?? null,
        fields: parseStructFields(body),
      });
    } else {
      enums.push({ file, name: match[3], ...parseEnum(attributes, body) });
    }
    ITEM.lastIndex = closing + 1;
  }
  return { structs, enums };
}

function collectSources(repoRoot) {
  const consts = new Map();
  const structs = [];
  const enums = [];
  const handlers = new Map();
  const rawRoutes = [];

  for (const absolute of rustFiles(join(repoRoot, "backend"))) {
    const source = readFileSync(absolute, "utf8");
    const file = relative(repoRoot, absolute);
    for (const match of source.matchAll(CONST_PATH)) {
      const candidates = consts.get(match[1]) ?? [];
      candidates.push({ file, path: match[2] });
      consts.set(match[1], candidates);
    }
    const items = parseItems(source, file);
    structs.push(...items.structs);
    enums.push(...items.enums);
    for (const match of source.matchAll(HANDLER)) {
      handlers.set(`${file}::${match[1]}`, match[2].match(JSON_BODY)?.[1] ?? null);
    }
    for (const match of source.matchAll(ROUTE)) {
      for (const method of match[2].matchAll(METHOD)) {
        rawRoutes.push({ file, constName: match[1], method: method[1], handler: method[2] });
      }
    }
  }

  const routes = rawRoutes.map((route) => {
    const candidates = consts.get(route.constName) ?? [];
    const local = candidates.filter((candidate) => candidate.file === route.file);
    const path = local.length === 1 ? local[0].path : candidates.length === 1 ? candidates[0].path : null;
    return {
      ...route,
      path,
      bodyType: handlers.get(`${route.file}::${route.handler}`) ?? null,
    };
  });
  return { structs, enums, routes };
}

function canonicalPath(path) {
  if (typeof path !== "string") return null;
  const placeholder = /\{[^/{}}]+\}/g;
  if (/[{}]/.test(path.replace(placeholder, ""))) return null;
  return path.replace(placeholder, "{}");
}

function operationKey(method, path) {
  const canonical = canonicalPath(path);
  return canonical ? `${method.toLowerCase()} ${canonical}` : null;
}

function namedType(type) {
  let remaining = type.trim();
  const option = remaining.match(/^Option\s*<\s*([\s\S]+)\s*>$/);
  if (option) remaining = option[1].trim();
  if (!/^(?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Za-z_][A-Za-z0-9_]*$/.test(remaining)) return null;
  const pieces = remaining.split("::");
  return { qualified: remaining, name: pieces.at(-1) };
}

function resolveNamed(items, file, name) {
  const candidates = items.filter((candidate) => candidate.name === name);
  const local = candidates.filter((candidate) => candidate.file === file);
  if (local.length === 1) return { value: local[0], status: "resolved" };
  if (local.length > 1 || candidates.length > 1) return { value: null, status: "ambiguous" };
  if (candidates.length === 1) return { value: candidates[0], status: "resolved" };
  return { value: null, status: "missing" };
}

function schemaReference(document, reference) {
  if (typeof reference !== "string" || !reference.startsWith("#/components/schemas/")) return null;
  const name = reference.slice("#/components/schemas/".length);
  if (!name || name.includes("/")) return null;
  const schema = own(own(own(document, "components"), "schemas"), name);
  return schema && typeof schema === "object" ? schema : null;
}

function requestBodySchema(document, path, method) {
  const requestBody = own(own(own(document, "paths"), path), method)?.requestBody;
  if (!requestBody || typeof requestBody !== "object") return { reason: "non_json_request_body" };
  const media = own(own(requestBody, "content"), "application/json");
  if (!media || typeof media !== "object") return { reason: "non_json_request_body" };
  const raw = own(media, "schema");
  if (!raw || typeof raw !== "object") return { reason: "openapi_schema_composition_unsupported" };
  let schema = raw;
  const reference = own(schema, "$ref");
  if (typeof reference === "string") {
    schema = schemaReference(document, reference);
    if (!schema || typeof own(schema, "$ref") === "string") {
      return { reason: "openapi_schema_ref_chain_unsupported" };
    }
  }
  if (own(schema, "oneOf") || own(schema, "allOf") || own(schema, "anyOf")) {
    return { reason: "openapi_schema_composition_unsupported" };
  }
  return { schema };
}

export function jsonRequestSchema(document, path, method) {
  return requestBodySchema(document, path, method).schema ?? null;
}

function schemaEnum(document, original, seen = new Set()) {
  if (!original || typeof original !== "object") return { kind: "none" };
  const reference = own(original, "$ref");
  if (typeof reference === "string") {
    if (seen.has(reference)) return { kind: "unsupported" };
    const resolved = schemaReference(document, reference);
    if (!resolved) return { kind: "unsupported" };
    return schemaEnum(document, resolved, new Set([...seen, reference]));
  }
  const oneOf = own(original, "oneOf");
  if (Array.isArray(oneOf)) {
    const nonNull = oneOf.filter((member) => own(member, "type") !== "null");
    const nulls = oneOf.length - nonNull.length;
    if (nonNull.length === 1 && nulls >= 1) return schemaEnum(document, nonNull[0], seen);
    return { kind: "unsupported" };
  }
  if (own(original, "allOf") || own(original, "anyOf")) return { kind: "unsupported" };
  const values = own(original, "enum");
  if (Array.isArray(values)) {
    return values.every((value) => typeof value === "string")
      ? { kind: "enum", values: [...new Set(values)].sort() }
      : { kind: "unsupported" };
  }
  if (own(original, "type") === "string") return { kind: "string" };
  return { kind: "none" };
}

function bodyEntry(operation, route, reason) {
  return {
    operation,
    rust_file: route?.file ?? null,
    handler: route?.handler ?? null,
    body_type: route?.bodyType ?? null,
    reason,
  };
}

function enumEntry(operation, wireField, rustFile, bodyType, rustType, reason) {
  return {
    operation,
    wire_field: wireField,
    rust_file: rustFile,
    body_type: bodyType,
    rust_type: rustType,
    reason,
  };
}

function bodyId(entry) {
  return entry.operation;
}

function enumId(entry) {
  return `${entry.operation}#${entry.wire_field}`;
}

function sortRegister(register) {
  register.body.sort((left, right) => compareText(bodyId(left), bodyId(right)));
  register.enum.sort((left, right) => compareText(enumId(left), enumId(right)));
  return register;
}

function validateEntryShape(entry, keys, nullableKeys) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const actualKeys = Object.keys(entry).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify([...keys].sort())) return false;
  return keys.every((key) => {
    if (nullableKeys.has(key)) return entry[key] === null || typeof entry[key] === "string";
    return typeof entry[key] === "string" && entry[key].length > 0;
  });
}

function compareRegisterKind(kind, registered, observed, idFor) {
  const findings = [];
  const registeredById = new Map(registered.map((entry) => [idFor(entry), entry]));
  const observedById = new Map(observed.map((entry) => [idFor(entry), entry]));
  for (const [id, entry] of observedById) {
    const recorded = registeredById.get(id);
    if (!recorded) findings.push(`unregistered ${kind} undecidable: ${id}`);
    else if (JSON.stringify(recorded) !== JSON.stringify(entry)) {
      findings.push(`${kind} register metadata drift: ${id}`);
    }
  }
  for (const id of registeredById.keys()) {
    if (!observedById.has(id)) findings.push(`stale ${kind} register entry: ${id}`);
  }
  return findings;
}

function inspectRegister(repoRoot, observedRegister) {
  let registered;
  try {
    registered = JSON.parse(readFileSync(join(repoRoot, REGISTER_PATH), "utf8"));
  } catch (error) {
    return [error?.code === "ENOENT"
      ? `missing undecidable register: ${REGISTER_PATH}`
      : `malformed undecidable register: ${REGISTER_PATH}`];
  }
  if (
    !registered
    || typeof registered !== "object"
    || Array.isArray(registered)
    || JSON.stringify(Object.keys(registered).sort()) !== JSON.stringify(["body", "enum", "version"])
    || registered.version !== REGISTER_VERSION
    || !Array.isArray(registered.body)
    || !Array.isArray(registered.enum)
  ) {
    return [`malformed undecidable register: ${REGISTER_PATH}`];
  }

  const findings = [];
  const bodyKeys = ["operation", "rust_file", "handler", "body_type", "reason"];
  const enumKeys = ["operation", "wire_field", "rust_file", "body_type", "rust_type", "reason"];
  for (const entry of registered.body) {
    if (!validateEntryShape(entry, bodyKeys, new Set(["rust_file", "handler", "body_type"]))) {
      findings.push("malformed body register entry");
    } else if (!BODY_REASONS.has(entry.reason)) {
      findings.push(`unknown body undecidable reason: ${entry.reason}`);
    }
  }
  for (const entry of registered.enum) {
    if (!validateEntryShape(entry, enumKeys, new Set())) findings.push("malformed enum register entry");
    else if (!ENUM_REASONS.has(entry.reason)) findings.push(`unknown enum undecidable reason: ${entry.reason}`);
  }

  for (const [kind, entries, idFor] of [
    ["body", registered.body, bodyId],
    ["enum", registered.enum, enumId],
  ]) {
    const ids = entries.map(idFor);
    for (let index = 1; index < ids.length; index += 1) {
      if (ids[index] === ids[index - 1]) findings.push(`duplicate ${kind} register entry: ${ids[index]}`);
      else if (compareText(ids[index], ids[index - 1]) < 0) findings.push(`${kind} register is not sorted`);
    }
  }
  if (findings.length > 0) return [...new Set(findings)];
  return [
    ...compareRegisterKind("body", registered.body, observedRegister.body, bodyId),
    ...compareRegisterKind("enum", registered.enum, observedRegister.enum, enumId),
  ].sort();
}

function specOperations(document) {
  const operations = [];
  const paths = own(document, "paths");
  if (!paths || typeof paths !== "object") return operations;
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const method of HTTP_METHODS) {
      const operation = own(pathItem, method);
      if (!operation || typeof operation !== "object" || !hasOwnKey(operation, "requestBody")) continue;
      operations.push({ path, method, operation: `${method.toUpperCase()} ${path}` });
    }
  }
  return operations.sort((left, right) => compareText(left.operation, right.operation));
}

function compareBody({ operation, schema, struct, findings }) {
  const properties = own(schema, "properties");
  if (!properties || typeof properties !== "object") return false;
  const wireName = (field) => field.rename ?? renameField(field.name, struct.renameAll);
  const wireNames = new Set(struct.fields.map(wireName));
  const required = own(schema, "required");
  const specRequired = new Set(Array.isArray(required) ? required : []);

  for (const property of Object.keys(properties)) {
    if (!wireNames.has(property)) {
      findings.push({
        operation,
        message: `spec property "${property}" is not a field of ${struct.name} (deny_unknown_fields => 422)`,
      });
    }
  }
  for (const field of struct.fields) {
    if (/^Option\s*</.test(field.type) || field.hasDefault) continue;
    if (specRequired.has(wireName(field))) continue;
    if (wireName(field) !== field.name && hasOwnKey(properties, field.name)) continue;
    findings.push({
      operation,
      message: `${struct.name}.${field.name} is required by the handler but not in spec required[]`,
    });
  }
  return true;
}

function compareEnums({ document, operation, schema, struct, enums, findings, enumUndecidable }) {
  const properties = own(schema, "properties");
  if (!properties || typeof properties !== "object") return { candidates: 0, resolved: 0, ids: [] };
  let candidates = 0;
  let resolved = 0;
  const ids = [];
  for (const field of struct.fields) {
    const wireField = field.rename ?? renameField(field.name, struct.renameAll);
    const property = own(properties, wireField);
    if (!property || typeof property !== "object") continue;
    const spec = schemaEnum(document, property);
    const type = namedType(field.type);
    const rustName = type?.name ?? field.type.trim();
    let rust = { kind: "none" };
    if (type?.name === "String") rust = { kind: "string" };
    else if (type) {
      const resolution = resolveNamed(enums, struct.file, type.name);
      if (resolution.status === "ambiguous") rust = { kind: "ambiguous" };
      else if (resolution.status === "resolved") rust = { kind: "enum", value: resolution.value };
    }
    if (spec.kind !== "enum" && rust.kind !== "enum" && rust.kind !== "ambiguous") continue;
    candidates += 1;
    const id = `${operation}#${wireField}`;

    let reason = null;
    if (rust.kind === "string" && spec.kind === "enum") reason = "string_backed_spec_enum";
    else if (rust.kind === "ambiguous") reason = "rust_enum_ambiguous";
    else if (rust.kind === "none" && spec.kind === "enum") reason = "rust_enum_unresolved";
    else if (rust.kind === "enum" && rust.value.reason) reason = rust.value.reason;
    else if (rust.kind === "enum" && spec.kind === "unsupported") reason = "openapi_enum_schema_unsupported";
    else if (rust.kind === "enum" && spec.kind === "none") reason = "openapi_enum_schema_unsupported";

    if (reason) {
      enumUndecidable.push(enumEntry(
        operation,
        wireField,
        struct.file,
        struct.name,
        rustName,
        reason,
      ));
      continue;
    }
    if (rust.kind !== "enum") continue;
    resolved += 1;
    ids.push(id);
    const rustValues = rust.value.variants
      .map((variant) => renameVariant(variant, rust.value.renameAll))
      .sort(compareText);
    if (spec.kind === "string") {
      findings.push({
        operation,
        message: `spec property "${wireField}" does not constrain serde enum ${rust.value.name}`,
      });
      continue;
    }
    const specValues = spec.values;
    for (const value of specValues.filter((value) => !rustValues.includes(value))) {
      findings.push({ operation, message: `spec-only enum variant "${value}" for ${wireField}` });
    }
    for (const value of rustValues.filter((value) => !specValues.includes(value))) {
      findings.push({ operation, message: `Rust-only enum variant "${value}" for ${wireField}` });
    }
  }
  return { candidates, resolved, ids };
}

/**
 * Evaluate the source-first request-body and enum contract.
 *
 * @param {{ repoRoot: string }} options
 */
export function evaluateRequestBodyContract({ repoRoot }) {
  const document = yaml.load(readFileSync(join(repoRoot, "backend/openapi/openapi.yaml"), "utf8"));
  const { structs, enums, routes } = collectSources(repoRoot);
  const findings = [];
  const bodyUndecidable = [];
  const enumUndecidable = [];
  const resolvedOperations = new Set();
  const resolvedEnumIds = new Set();
  let enumCandidates = 0;
  let enumResolved = 0;

  const routeIndex = new Map();
  for (const route of routes) {
    if (!route.path) continue;
    const key = operationKey(route.method, route.path);
    if (!key) continue;
    const candidates = routeIndex.get(key) ?? [];
    if (!candidates.some((candidate) => candidate.file === route.file && candidate.handler === route.handler)) {
      candidates.push(route);
    }
    routeIndex.set(key, candidates);
  }

  const operations = specOperations(document);
  const specKeys = new Set();
  for (const candidate of operations) {
    const key = operationKey(candidate.method, candidate.path);
    if (!key || specKeys.has(key)) {
      findings.push({ operation: candidate.operation, message: "normalized OpenAPI operation collision" });
    } else specKeys.add(key);
  }

  for (const candidate of operations) {
    const key = operationKey(candidate.method, candidate.path);
    const matchingRoutes = key ? routeIndex.get(key) ?? [] : [];
    const route = matchingRoutes.length === 1 ? matchingRoutes[0] : null;
    const schemaResult = requestBodySchema(document, candidate.path, candidate.method);
    if (schemaResult.reason === "non_json_request_body") {
      bodyUndecidable.push(bodyEntry(candidate.operation, route, schemaResult.reason));
      continue;
    }
    if (!route) {
      bodyUndecidable.push(bodyEntry(candidate.operation, null, "route_parser_unresolved"));
      continue;
    }
    if (!route.bodyType) {
      bodyUndecidable.push(bodyEntry(candidate.operation, route, "no_direct_json_binding"));
      continue;
    }
    if (schemaResult.reason) {
      bodyUndecidable.push(bodyEntry(candidate.operation, route, schemaResult.reason));
      continue;
    }
    const bodyNamed = namedType(route.bodyType);
    const structResolution = bodyNamed
      ? resolveNamed(structs, route.file, bodyNamed.name)
      : { value: null, status: "missing" };
    const struct = structResolution.value;
    if (!struct || !struct.denyUnknown || !compareBody({
      operation: candidate.operation,
      schema: schemaResult.schema,
      struct,
      findings,
    })) {
      bodyUndecidable.push(bodyEntry(candidate.operation, route, "rust_struct_not_strict"));
      continue;
    }
    resolvedOperations.add(candidate.operation);
    const enumReport = compareEnums({
      document,
      operation: candidate.operation,
      schema: schemaResult.schema,
      struct,
      enums,
      findings,
      enumUndecidable,
    });
    enumCandidates += enumReport.candidates;
    enumResolved += enumReport.resolved;
    for (const id of enumReport.ids) resolvedEnumIds.add(id);
  }

  const routeOnly = new Map();
  for (const route of routes) {
    if (!route.path || !route.bodyType) continue;
    const key = operationKey(route.method, route.path);
    if (!key || specKeys.has(key)) continue;
    const operation = `${route.method.toUpperCase()} ${route.path}`;
    const existing = routeOnly.get(key);
    if (existing && (existing.file !== route.file || existing.handler !== route.handler)) {
      findings.push({ operation, message: "normalized Rust route operation collision" });
      continue;
    }
    routeOnly.set(key, route);
  }
  for (const route of routeOnly.values()) {
    bodyUndecidable.push(bodyEntry(
      `${route.method.toUpperCase()} ${route.path}`,
      route,
      "no_openapi_request_body",
    ));
  }

  const observedRegister = sortRegister({
    version: REGISTER_VERSION,
    body: bodyUndecidable,
    enum: enumUndecidable,
  });
  const registerFindings = inspectRegister(repoRoot, observedRegister);
  findings.sort((left, right) => {
    const operationOrder = compareText(left.operation, right.operation);
    return operationOrder || compareText(left.message, right.message);
  });

  return {
    population: operations.length + routeOnly.size,
    resolved: resolvedOperations.size,
    skipped: bodyUndecidable.length,
    findings,
    unresolvedAnchors: ANCHORS.filter((anchor) => !resolvedOperations.has(anchor)),
    enumCandidates,
    enumResolved,
    enumSkipped: enumUndecidable.length,
    unresolvedEnumAnchors: ENUM_ANCHORS.filter((anchor) => !resolvedEnumIds.has(anchor)),
    observedRegister,
    registerFindings,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const json = process.argv.includes("--json");
  const rootArgument = process.argv.slice(2).find((argument) => argument !== "--json");
  const repoRoot = rootArgument ?? fileURLToPath(new URL("..", import.meta.url));
  const report = evaluateRequestBodyContract({ repoRoot });
  if (json) console.log(JSON.stringify(report, null, 2));
  for (const finding of report.findings) console.error(`${finding.operation}: ${finding.message}`);
  for (const finding of report.registerFindings) console.error(finding);
  for (const anchor of report.unresolvedAnchors) {
    console.error(`anchor operation ${anchor} no longer resolves — the resolver has silently degraded`);
  }
  for (const anchor of report.unresolvedEnumAnchors) {
    console.error(`enum anchor ${anchor} no longer resolves — enum coverage has silently degraded`);
  }
  const belowFloor = report.resolved < RESOLVED_FLOOR;
  const belowCensus = report.population < CENSUS_FLOOR;
  const belowEnumFloor = report.enumResolved < ENUM_RESOLVED_FLOOR;
  const aboveBodyMaximum = report.skipped > BODY_UNDECIDABLE_MAX;
  const aboveEnumMaximum = report.enumSkipped > ENUM_UNDECIDABLE_MAX;
  if (belowFloor) {
    console.error(`resolved ${report.resolved} operations, below the floor of ${RESOLVED_FLOOR} — `
      + "the resolver compared less of the surface than it was built to compare");
  }
  if (belowCensus) {
    console.error(`request-body population ${report.population}, below the census floor of ${CENSUS_FLOOR}`);
  }
  if (belowEnumFloor) {
    console.error(`enum-resolved ${report.enumResolved}, below the floor of ${ENUM_RESOLVED_FLOOR}`);
  }
  if (aboveBodyMaximum) {
    console.error(`body-undecidable ${report.skipped}, above the maximum of ${BODY_UNDECIDABLE_MAX}`);
  }
  if (aboveEnumMaximum) {
    console.error(`enum-undecidable ${report.enumSkipped}, above the maximum of ${ENUM_UNDECIDABLE_MAX}`);
  }
  const failed = report.findings.length > 0
    || report.registerFindings.length > 0
    || report.unresolvedAnchors.length > 0
    || report.unresolvedEnumAnchors.length > 0
    || belowFloor
    || belowCensus
    || belowEnumFloor
    || aboveBodyMaximum
    || aboveEnumMaximum;
  if (failed) {
    console.error(`request body contract gate FAILED: ${report.findings.length} finding(s), `
      + `resolved ${report.resolved}, skipped ${report.skipped}, enum-resolved ${report.enumResolved}, `
      + `enum-skipped ${report.enumSkipped}`);
    process.exit(1);
  }
  if (!json) {
    console.log(`request body contract gate passed (resolved ${report.resolved}, skipped ${report.skipped})`);
    console.log(`request body census ${report.population}; enum candidates ${report.enumCandidates}, `
      + `resolved ${report.enumResolved}, skipped ${report.enumSkipped}`);
  }
}
