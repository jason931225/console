#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { staticFindings } from "./check-test-credentials.mjs";

function findingsForWorkflow(source) {
  const root = mkdtempSync(join(tmpdir(), "console-test-credentials-"));
  const workflows = join(root, ".github", "workflows");
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(workflows, "ci.yml"), source);
  try {
    return staticFindings(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const findingsFor = (run) => findingsForWorkflow(
  `jobs:\n  test:\n    steps:\n      - run: ${JSON.stringify(run)}\n`,
);

test("rejects optional whitespace around a literal libpq password assignment", () => {
  for (const spelling of [
    "password=hunter2",
    "password =hunter2",
    "password= hunter2",
    "password = hunter2",
    "POSTGRES_PASSWORD = hunter2",
  ]) {
    assert.equal(
      findingsFor(`cargo test -p console-app -- ${spelling}`).length,
      1,
      spelling,
    );
  }
});

test("allows a shell environment assignment sourced from a variable", () => {
  assert.deepEqual(
    findingsFor('PGPASSWORD="$TEST_PASSWORD" cargo test -p console-app --lib'),
    [],
  );
});

test("rejects a credential separated from its runner inside a folded YAML scalar", () => {
  const findings = findingsForWorkflow(`jobs:
  test:
    steps:
      - name: Folded runner
        run: >-
          cargo test -p console-app --
          postgres://console_app:hunter2@db/console
`);
  assert.equal(findings.length, 1);
});
