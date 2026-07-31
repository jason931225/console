import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateUndeclaredImports } from "./check-undeclared-imports.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("./check-undeclared-imports.mjs", import.meta.url));
const fixtureRoots = [];

after(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

// A fixture is a real git worktree: the gate discovers files through the index, so an
// unstaged fixture would silently scan nothing and every assertion below would read green.
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "undeclared-imports-"));
  fixtureRoots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  const init = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "-q", root], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const add = spawnSync("git", ["-C", root, "add", "--", ...Object.keys(files)], { encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  return root;
}

const emptyManifest = JSON.stringify({ name: "fixture", devDependencies: {} });

describe("undeclared import gate", () => {
  it("reports a bare specifier that the nearest package.json does not declare", () => {
    const root = fixture({
      "package.json": emptyManifest,
      "scripts/thing.mjs": 'import openapiTS from "openapi-typescript";\n\nexport default openapiTS;\n',
    });

    const { findings } = evaluateUndeclaredImports(root);

    assert.deepEqual(findings, [{ file: "scripts/thing.mjs", line: 1, specifier: "openapi-typescript" }]);
  });

  it("accepts the same import once the manifest declares it", () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "fixture", devDependencies: { "openapi-typescript": "7.10.0" } }),
      "scripts/thing.mjs": 'import openapiTS from "openapi-typescript";\n\nexport default openapiTS;\n',
    });

    const { findings } = evaluateUndeclaredImports(root);

    assert.deepEqual(findings, []);
  });

  it("resolves against the nearest package.json, not only the root one", () => {
    const root = fixture({
      "package.json": emptyManifest,
      "tools/npm/compat/package.json": JSON.stringify({
        name: "compat",
        dependencies: { "minimatch-modern": "npm:minimatch@10.2.5" },
      }),
      "tools/npm/compat/index.cjs": 'const minimatch = require("minimatch-modern");\n\nmodule.exports = minimatch;\n',
    });

    const { findings } = evaluateUndeclaredImports(root);

    assert.deepEqual(findings, []);
  });

  it("does not report node: builtins or relative specifiers", () => {
    const root = fixture({
      "package.json": emptyManifest,
      "scripts/thing.mjs": [
        'import { readFileSync } from "node:fs";',
        'import assert from "node:assert/strict";',
        'import helper from "./helper.mjs";',
        'import shared from "../lib/shared.js";',
        "",
        "export default { readFileSync, assert, helper, shared };",
        "",
      ].join("\n"),
      "scripts/helper.mjs": "export default 1;\n",
      "lib/shared.js": "export default 2;\n",
    });

    const { findings } = evaluateUndeclaredImports(root);

    assert.deepEqual(findings, []);
  });

  it("covers require() and dynamic import(), not just static import", () => {
    const root = fixture({
      "package.json": emptyManifest,
      "scripts/required.cjs": 'const a = require("phantom-required");\n\nmodule.exports = a;\n',
      "scripts/dynamic.mjs": 'export const load = () => import("phantom-dynamic");\n',
    });

    const { findings } = evaluateUndeclaredImports(root);

    assert.deepEqual(
      findings.map((finding) => finding.specifier).sort(),
      ["phantom-dynamic", "phantom-required"],
    );
  });

  it("reduces a subpath import to the package name before consulting the manifest", () => {
    const root = fixture({
      "package.json": JSON.stringify({
        name: "fixture",
        devDependencies: { "js-yaml": "4.3.0", "@scope/pkg": "1.0.0" },
      }),
      "scripts/thing.mjs": [
        'import load from "js-yaml/dist/js-yaml.mjs";',
        'import scoped from "@scope/pkg/sub/deep.js";',
        "",
        "export default { load, scoped };",
        "",
      ].join("\n"),
    });

    const { findings } = evaluateUndeclaredImports(root);

    assert.deepEqual(findings, []);
  });

  it("reports a scoped package that is absent from the manifest", () => {
    const root = fixture({
      "package.json": emptyManifest,
      "scripts/thing.mjs": 'import scoped from "@scope/absent/sub.js";\n',
    });

    const { findings } = evaluateUndeclaredImports(root);

    assert.deepEqual(findings.map((finding) => finding.specifier), ["@scope/absent"]);
  });

  it("does not mistake prose or SQL inside a string literal for an import specifier", () => {
    const root = fixture({
      "package.json": emptyManifest,
      "scripts/thing.mjs": [
        "export const sql = `",
        "  SELECT id from employees",
        "`;",
        'export const note = "import the roster from HR before payroll runs";',
        'export const sentinel = "RAW_GIT_SENTINEL_DO_NOT_LEAK";',
        "",
      ].join("\n"),
    });

    const { findings } = evaluateUndeclaredImports(root);

    assert.deepEqual(findings, []);
  });

  it("counts the files it scanned, so an empty scan cannot read as coverage", () => {
    const root = fixture({
      "package.json": emptyManifest,
      "scripts/a.mjs": "export default 1;\n",
      "scripts/b.cjs": "module.exports = 2;\n",
      "scripts/c.js": "export default 3;\n",
      "docs/notes.md": "not a script\n",
    });

    const { scanned } = evaluateUndeclaredImports(root);

    assert.equal(scanned, 3);
  });

  it("exits 1 and names the offending specifier when run as a CLI", () => {
    const root = fixture({
      "package.json": emptyManifest,
      "scripts/thing.mjs": 'import openapiTS from "openapi-typescript";\n',
    });

    const result = spawnSync(process.execPath, [cli, root], { encoding: "utf8" });

    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /openapi-typescript/);
  });

  // A bare exit 0 is not evidence: a gate that scanned nothing exits 0 too. The green path must
  // state what it looked at, so an empty scan cannot be read as coverage.
  it("exits 0 reporting the scanned file count when every specifier is declared", () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "fixture", devDependencies: { "js-yaml": "4.3.0" } }),
      "scripts/thing.mjs": 'import yaml from "js-yaml";\n\nexport default yaml;\n',
    });

    const result = spawnSync(process.execPath, [cli, root], { encoding: "utf8" });

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /passed \(1 file scanned\)/);
  });

  // The archived-evidence classification, tested from both sides. It is an exception, not an
  // omission, and the difference is that an exception is itself covered by a test whose red has
  // been observed. Added in the implementation phase after the gate found a SECOND live instance
  // of H-4 that the RED phase had not anticipated — see the header of check-undeclared-imports.mjs.
  it("classifies docs/evidence as archived rather than scanning it", () => {
    const { excluded, findings } = evaluateUndeclaredImports(repoRoot);

    assert.ok(
      excluded.includes("docs/evidence/console/wave4/L-F1/browser-window-host.mjs"),
      `the classification must name what it excludes, got ${JSON.stringify(excluded)}`,
    );
    assert.deepEqual(findings, []);
  });

  it("goes red on the archived artifact the moment the classification is removed", () => {
    const { findings } = evaluateUndeclaredImports(repoRoot, []);

    assert.deepEqual(findings, [
      { file: "docs/evidence/console/wave4/L-F1/browser-window-host.mjs", line: 30, specifier: "playwright" },
    ]);
  });

  // The gate's own subject. Red today: scripts/lib/kotlin-discriminator-unions.mjs:4 imports
  // openapi-typescript, which is in neither package.json nor package-lock.json, and its sibling
  // test dies with ERR_MODULE_NOT_FOUND — a LOAD failure with zero assertion failures, which is
  // exactly the H-4 signature.
  it("finds no undeclared import anywhere in this repository", () => {
    const { scanned, findings } = evaluateUndeclaredImports(repoRoot);

    assert.ok(scanned > 50, `expected the repo scan to cover the tracked script surface, scanned ${scanned}`);
    assert.deepEqual(findings, []);
  });
});
