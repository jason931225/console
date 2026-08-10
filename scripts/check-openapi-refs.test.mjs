import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  evaluateOpenapiRefs,
  MAPPING_FLOOR,
  REF_FLOOR,
} from "./check-openapi-refs.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("./check-openapi-refs.mjs", import.meta.url));
const fixtureRoots = [];

after(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

function fixture(specYaml) {
  const root = mkdtempSync(join(tmpdir(), "openapi-refs-"));
  fixtureRoots.push(root);
  const absolute = join(root, "backend/openapi/openapi.yaml");
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, specYaml);
  return root;
}

// Every hostile document below is one of the four positions the two text scans in
// backend/crates/contracts/src/lib.rs were PROVEN to fail open on (PR #620 review, recorded in
// that crate's module doc under "WHAT THIS SCANNER STILL MISSES"). Each fixture is legal YAML
// that a parser reads exactly one way; a line- or scalar-oriented scan reads it another.
function spec(body) {
  return `openapi: 3.1.0
info:
  title: Fixture
  version: 0.0.1
paths: {}
${body}`;
}

describe("openapi ref totality gate", () => {
  // Fail-open (1): a $ref written in YAML flow style, carrying the foreign-URL prefix this
  // check exists to close. The block-entry scan requires `$ref` to open its line and never
  // sees a flow mapping; the pointer scan reports the scalar it can delimit, not the ref.
  it("reports a flow-style foreign-URL $ref whole, prefix included", () => {
    const root = fixture(spec(`components:
  schemas:
    Uuid:
      type: string
    Wrapper:
      properties:
        id: { $ref: 'https://intruder.example/common.yaml#/components/schemas/Uuid' }
`));

    const { findings } = evaluateOpenapiRefs({ repoRoot: root });

    assert.equal(findings.length, 1, JSON.stringify(findings, null, 2));
    // Whole, not from the `#/` onwards: the prefix IS the defect, and resolving the tail
    // against the local schema set is exactly the fail-open being closed.
    assert.match(
      findings[0].message,
      /https:\/\/intruder\.example\/common\.yaml#\/components\/schemas\/Uuid/,
    );
  });

  // Fail-open (1b), the documented intersection gap of the two scans: flow style AND no
  // `#/components/` pointer anywhere in the value, so neither scan has anything to find.
  it("reports a flow-style $ref that carries no pointer to find", () => {
    const root = fixture(spec(`components:
  schemas:
    Todo:
      type: object
    List:
      allOf: [{ $ref: Todo.yaml }]
`));

    const { findings } = evaluateOpenapiRefs({ repoRoot: root });

    assert.equal(findings.length, 1, JSON.stringify(findings, null, 2));
    assert.match(findings[0].message, /Todo\.yaml/);
  });

  // Fail-open (2), the Todo-Summary prefix trap: a quoted pointer with an internal space.
  // A scan that ends a scalar at whitespace truncates this to `#/components/schemas/Todo`,
  // which resolves, and the defect composes clean.
  it("reports a quoted $ref with an internal space instead of truncating to a resolvable prefix", () => {
    const root = fixture(spec(`components:
  schemas:
    Todo:
      type: object
    Wrapper:
      properties:
        summary:
          $ref: "#/components/schemas/Todo Summary"
`));

    const { findings } = evaluateOpenapiRefs({ repoRoot: root });

    assert.equal(findings.length, 1, JSON.stringify(findings, null, 2));
    assert.match(findings[0].message, /Todo Summary/);
  });

  // Fail-open (4): a foreign prefix ending in `{`, which the backward scan treats as a scalar
  // delimiter even though it is legal inside a quoted YAML scalar. Delimiter-truncated, the
  // reported value loses the prefix that makes it foreign.
  it("reports a foreign prefix ending in flow delimiters legal inside a quoted scalar", () => {
    const root = fixture(spec(`components:
  schemas:
    Uuid:
      type: string
    Wrapper:
      properties:
        id:
          $ref: "common{.yaml#/components/schemas/Uuid"
`));

    const { findings } = evaluateOpenapiRefs({ repoRoot: root });

    assert.equal(findings.length, 1, JSON.stringify(findings, null, 2));
    assert.match(findings[0].message, /common\{\.yaml#\/components\/schemas\/Uuid/);
  });

  // Fail-open (3): an OpenAPI 3.1 discriminator.mapping value in the implicit schema-NAME
  // form carries no pointer for a text scan to find. The name is still a schema reference,
  // and a ghost name drops a union subtype from every generated client.
  it("resolves implicit discriminator.mapping schema names and reports the ghost", () => {
    const root = fixture(spec(`components:
  schemas:
    Todo:
      type: object
    Union:
      discriminator:
        propertyName: kind
        mapping:
          alive: Todo
          gone: Ghost
          pointed: '#/components/schemas/Todo'
`));

    const { findings } = evaluateOpenapiRefs({ repoRoot: root });

    assert.equal(findings.length, 1, JSON.stringify(findings, null, 2));
    assert.match(findings[0].message, /Ghost/);
    assert.match(findings[0].location, /mapping\/gone/);
  });

  // The parser is what makes the gate total: block, flow, single-quoted, double-quoted,
  // folded and anchored spellings of the same pointer are one value after load. A gate that
  // saw them differently would be the text scan again, wearing a parser's name.
  it("reads refs identically across block, flow, quoted, folded and anchored spellings", () => {
    const root = fixture(spec(`components:
  schemas:
    Todo:
      type: object
    A:
      properties:
        block:
          $ref: '#/components/schemas/Todo'
        flow: { $ref: "#/components/schemas/Todo" }
        folded:
          $ref: >-
            #/components/schemas/Todo
        anchored:
          $ref: &todo '#/components/schemas/Todo'
        aliased:
          $ref: *todo
`));

    const { refs, findings } = evaluateOpenapiRefs({ repoRoot: root });

    assert.deepEqual(findings, []);
    assert.equal(refs, 5, "every spelling must be seen, and seen as the same pointer");
  });

  it("reports a well-formed local schema ref whose target no fragment defines", () => {
    const root = fixture(spec(`components:
  schemas:
    Wrapper:
      properties:
        todo:
          $ref: '#/components/schemas/Missing'
`));

    const { findings } = evaluateOpenapiRefs({ repoRoot: root });

    assert.equal(findings.length, 1, JSON.stringify(findings, null, 2));
    assert.match(findings[0].message, /Missing/);
  });

  // The published document carries every component section, so unlike compose() — which can
  // resolve only schemas — this gate resolves responses, parameters, and the rest by the same
  // rule. A pointer into an absent section entry is the same defect as a dangling schema.
  it("resolves refs into non-schema component sections and reports their absence", () => {
    const root = fixture(spec(`components:
  schemas:
    Todo:
      type: object
  responses:
    NotFound:
      description: missing
paths:
  /todos:
    get:
      responses:
        '404':
          $ref: '#/components/responses/NotFound'
        '410':
          $ref: '#/components/responses/Gone'
`).replace("paths: {}\n", ""));

    const { findings } = evaluateOpenapiRefs({ repoRoot: root });

    assert.equal(findings.length, 1, JSON.stringify(findings, null, 2));
    assert.match(findings[0].message, /Gone/);
  });

  it("rejects a nested JSON pointer by the same exact-shape rule, without enumerating it", () => {
    const root = fixture(spec(`components:
  schemas:
    Todo:
      type: object
      properties:
        id:
          type: string
    Wrapper:
      properties:
        id:
          $ref: '#/components/schemas/Todo/properties/id'
`));

    const { findings } = evaluateOpenapiRefs({ repoRoot: root });

    assert.equal(findings.length, 1, JSON.stringify(findings, null, 2));
    assert.match(findings[0].message, /Todo\/properties\/id/);
  });

  // `$ref: #/components/schemas/Todo` unquoted is a YAML comment: the author wrote a pointer
  // and published null. The text scans SAW a ref here; the document does not contain one.
  // Reporting the null is the fail-closed direction for a key that promises a reference.
  it("reports a $ref whose pointer YAML comment rules made null", () => {
    const root = fixture(spec(`components:
  schemas:
    Todo:
      type: object
    Wrapper:
      properties:
        todo:
          $ref: #/components/schemas/Todo
`));

    const { findings } = evaluateOpenapiRefs({ repoRoot: root });

    assert.equal(findings.length, 1, JSON.stringify(findings, null, 2));
    assert.match(findings[0].message, /not a string/);
  });

  // A hostile document must not hang the gate: YAML aliases can make the object graph cyclic.
  it("terminates on a self-referential alias instead of walking forever", () => {
    const root = fixture(spec(`components:
  schemas:
    Loop: &loop
      allOf:
        - *loop
`));

    const { findings } = evaluateOpenapiRefs({ repoRoot: root });

    assert.deepEqual(findings, []);
  });

  // Examined-zero must FAIL: a walker that visits nothing reports nothing, and the floor is
  // what turns that silence into an exit code. Same shape as the request-body gate's floor.
  it("exits 1 naming the floor when the document contains almost no refs", () => {
    const root = fixture(spec(`components:
  schemas:
    Todo:
      type: object
    Wrapper:
      properties:
        todo:
          $ref: '#/components/schemas/Todo'
`));

    const result = spawnSync(process.execPath, [cli, root], { encoding: "utf8" });

    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /below the floor/);
  });

  it("exits 1 loudly when the document is not parseable YAML at all", () => {
    const root = fixture("openapi: 3.1.0\n  bad-indent: {\n");

    const result = spawnSync(process.execPath, [cli, root], { encoding: "utf8" });

    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /cannot be parsed/);
  });

  // Only the real repository can clear the floors, which is what makes them floors. This is
  // the exit-0 branch, observed rather than assumed.
  it("exits 0 against this repository, above both floors", () => {
    const { refs, mappingEntries, findings } = evaluateOpenapiRefs({ repoRoot });

    assert.deepEqual(findings, []);
    assert.ok(refs >= REF_FLOOR, `walker degraded: saw ${refs} refs, floor ${REF_FLOOR}`);
    assert.ok(
      mappingEntries >= MAPPING_FLOOR,
      `walker degraded: saw ${mappingEntries} mapping entries, floor ${MAPPING_FLOOR}`,
    );

    const result = spawnSync(process.execPath, [cli], { encoding: "utf8" });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /openapi ref gate passed/);
  });
});
