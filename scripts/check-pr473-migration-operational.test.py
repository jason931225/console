#!/usr/bin/env python3

from __future__ import annotations

import copy
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("check-pr473-migration-operational.py")
SPEC = importlib.util.spec_from_file_location("pr473_gate", SCRIPT)
assert SPEC and SPEC.loader
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


def valid_manifest() -> dict:
    return json.loads(
        (SCRIPT.parents[1] / gate.MANIFEST_PATH).read_text(encoding="utf-8")
    )


class ManifestTests(unittest.TestCase):
    def test_accepts_canonical_manifest(self) -> None:
        gate.validate_manifest(valid_manifest())

    def test_rejects_wrong_typed_release_authority(self) -> None:
        for key, value in (
            ("release_phase", "contract"),
            ("deployment_authorized", True),
            ("command_only_claim_authorized", True),
        ):
            with self.subTest(key=key):
                manifest = valid_manifest()
                manifest[key] = value
                with self.assertRaises(gate.GateError):
                    gate.validate_manifest(manifest)

    def test_rejects_duplicate_or_missing_guarded_tests(self) -> None:
        duplicate = valid_manifest()
        duplicate["guarded_tests"][-1] = copy.deepcopy(duplicate["guarded_tests"][0])
        with self.assertRaises(gate.GateError):
            gate.validate_manifest(duplicate)

        missing = valid_manifest()
        missing["guarded_tests"].pop()
        with self.assertRaises(gate.GateError):
            gate.validate_manifest(missing)

    def test_rejects_an_unapproved_but_unique_test_tuple(self) -> None:
        manifest = valid_manifest()
        manifest["guarded_tests"][0]["name"] = "invented_unique_test"
        with self.assertRaises(gate.GateError):
            gate.validate_manifest(manifest)

    def test_rejects_noncanonical_json(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "gate.json"
            path.write_text(json.dumps(valid_manifest()), encoding="utf-8")
            with self.assertRaises(gate.GateError):
                gate.load_manifest(path)


class CommandLineTests(unittest.TestCase):
    def test_backend_directory_resolves_to_repository_root(self) -> None:
        backend = SCRIPT.parents[1] / "backend"
        self.assertEqual(gate.resolve_repo_root(None, backend), SCRIPT.parents[1])


class ExecutionTests(unittest.TestCase):
    @staticmethod
    def successful_output(target: str) -> str:
        names = gate.guarded_tests_by_target(valid_manifest()).get(target, ())
        return "\n".join(f"test {name} ... ok" for name in names) + "\n"

    def test_requires_the_buck_owned_disposable_postgres_harness(self) -> None:
        completed = [
            subprocess.CompletedProcess(
                ["tools/buck/test_needs_postgres.sh"],
                0,
                self.successful_output(target),
                "",
            )
            for target in gate.OPERATIONAL_SQLX_TARGETS
        ]

        with patch.object(gate, "run", side_effect=completed) as run_mock:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(gate.execute(SCRIPT.parents[1]), 0)

        self.assertEqual(run_mock.call_count, len(gate.OPERATIONAL_SQLX_TARGETS))
        for target, call in zip(gate.OPERATIONAL_SQLX_TARGETS, run_mock.call_args_list):
            command = call.args[0]
            self.assertEqual(
                command,
                [
                    str(SCRIPT.parents[1] / gate.BUCK_POSTGRES_HARNESS),
                    target,
                    "--test-executor-stdout=-",
                ],
            )
            self.assertNotIn("cargo", command)
            self.assertNotIn("DATABASE_URL", call.kwargs["env"])

    def test_rejects_reusable_ci_database_urls_before_harness_invocation(self) -> None:
        completed = [
            subprocess.CompletedProcess(["buck"], 0, self.successful_output(target), "")
            for target in gate.OPERATIONAL_SQLX_TARGETS
        ]
        inherited = {
            "DATABASE_URL": "postgres://superuser@ci/reusable",
            "MNT_APALIS_OWNER_DATABASE_URL": "postgres://owner@ci/reusable",
            "MNT_APALIS_RUNTIME_DATABASE_URL": "postgres://runtime@ci/reusable",
            "MNT_APALIS_ADMIN_DATABASE_URL": "postgres://admin@ci/reusable",
        }
        with patch.dict(os.environ, inherited, clear=False):
            with patch.object(gate, "run", side_effect=completed) as run_mock:
                with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                    self.assertEqual(gate.execute(SCRIPT.parents[1]), 0)
        environment = run_mock.call_args.kwargs["env"]
        for key in inherited:
            self.assertNotIn(key, environment)

    def test_fails_when_buck_harness_fails(self) -> None:
        completed = subprocess.CompletedProcess(["buck"], 19, "", "")
        with patch.object(gate, "run", return_value=completed):
            with self.assertRaisesRegex(gate.GateError, "Buck2 disposable PostgreSQL"):
                gate.execute(SCRIPT.parents[1])

    def test_fails_closed_when_a_declared_test_did_not_report_one_success(self) -> None:
        incomplete = subprocess.CompletedProcess(
            ["buck"],
            0,
            "test migration_0165_upgrades_legacy_sibling_versions_without_tenant_leakage ... ok\n",
            "",
        )
        with patch.object(gate, "run", return_value=incomplete):
            with self.assertRaisesRegex(gate.GateError, "exactly one successful Rust test result"):
                gate.execute(SCRIPT.parents[1])

    def test_fails_closed_when_a_declared_test_reports_twice(self) -> None:
        target = "//tools/buck:pr473-ontology-key-revision-postgres"
        output = self.successful_output(target)
        duplicate = subprocess.CompletedProcess(["buck"], 0, output + output, "")
        with patch.object(gate, "run", return_value=duplicate):
            with self.assertRaisesRegex(gate.GateError, "exactly one successful Rust test result"):
                gate.execute(SCRIPT.parents[1])


if __name__ == "__main__":
    unittest.main()
