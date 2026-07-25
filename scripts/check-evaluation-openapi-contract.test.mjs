import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const openapi = readFileSync("backend/openapi/openapi.yaml", "utf8");
const typescript = readFileSync("clients/ts/src/schema.d.ts", "utf8");
const rest = readFileSync("backend/crates/evaluation/rest/src/lib.rs", "utf8");

const routes = [
  "/api/v1/evaluation/cycles",
  "/api/v1/evaluation/cycles/{cycle_id}",
  "/api/v1/evaluation/cycles/{cycle_id}/preflight",
  "/api/v1/evaluation/cycles/{cycle_id}/open",
  "/api/v1/evaluation/cycles/{cycle_id}/start-calibration",
  "/api/v1/evaluation/cycles/{cycle_id}/finalize",
  "/api/v1/evaluation/cycles/{cycle_id}/archive",
  "/api/v1/evaluation/subjects",
  "/api/v1/evaluation/subjects/{subject_id}",
  "/api/v1/evaluation/subjects/{subject_id}/goals",
  "/api/v1/evaluation/subjects/{subject_id}/reviews/{kind}",
  "/api/v1/evaluation/subjects/{subject_id}/reviews/{kind}/submit",
  "/api/v1/evaluation/subjects/{subject_id}/calibrate",
  "/api/v1/evaluation/my-tasks",
  "/api/v1/evaluation/employees/{employee_id}/reviews",
];

test("evaluation REST routes are fully represented by OpenAPI and the generated TypeScript client", () => {
  for (const route of routes) {
    assert.match(rest, new RegExp(`"${route.replace(/[{}]/g, "\\$&")}"`));
    assert.match(openapi, new RegExp(`^  ${route.replace(/[{}]/g, "\\$&")}:$`, "m"));
    assert.match(typescript, new RegExp(`"${route.replace(/[{}]/g, "\\$&")}":`));
  }

  for (const schema of [
    "EvaluationCycleDetail",
    "EvaluationSubjectDetail",
    "EvaluationPreflightReport",
    "EvaluationTaskPage",
    "EvaluationLedgerPage",
    "CreateEvaluationCycleRequest",
    "SaveEvaluationReviewRequest",
  ]) {
    assert.match(openapi, new RegExp(`^    ${schema}:$`, "m"));
    assert.match(typescript, new RegExp(`${schema}:`));
  }
});

test("evaluation contract preserves backend-only semantics rather than local transport assumptions", () => {
  assert.match(openapi, /EvaluationTaskItem:[\s\S]*?review_status:/);
  assert.match(openapi, /EvaluationPreflightItem:[\s\S]*?subject_id:/);
  assert.match(openapi, /EvaluationEvidenceLinkInput:[\s\S]*?required: \[object_kind, object_ref, label\]/);
  const inputStart = openapi.indexOf("    EvaluationEvidenceLinkInput:\n");
  const inputEnd = openapi.indexOf("    SaveEvaluationReviewRequest:\n", inputStart);
  assert.ok(inputStart >= 0 && inputEnd > inputStart, "input schema bounds exist");
  assert.doesNotMatch(openapi.slice(inputStart, inputEnd), /sort_order:/);
});
