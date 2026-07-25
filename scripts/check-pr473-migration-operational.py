#!/usr/bin/env python3
"""Run the PR 473 migration regressions once each, without weakening workspace tests."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

ROLLBACK_FLOOR = "f6ff236b9770c79301a3d07da6afb56be1e27bbf"
MANIFEST_PATH = Path("docs/release/PR-473-EXPAND-CONTRACT.gate.json")
TOP_LEVEL_KEYS = (
    "schema_version",
    "pull_request",
    "rollback_floor",
    "release_phase",
    "deployment_authorized",
    "command_only_claim_authorized",
    "production_authority",
    "guarded_tests",
)
PRODUCTION_AUTHORITY = {
    "production_cardinality": False,
    "old_runtime_drain": False,
    "rollback_floor_raise": False,
}
TEST_KEYS = ("domain", "package", "target", "source", "name")
EXPECTED_TESTS = (
    ("ontology", "mnt-ontology-adapter-postgres", "key_revision_migration_upgrade", "backend/crates/ontology/adapter-postgres/tests/key_revision_migration_upgrade.rs", "migration_0165_upgrades_legacy_sibling_versions_without_tenant_leakage"),
    ("ontology", "mnt-ontology-adapter-postgres", "key_revision_migration_upgrade", "backend/crates/ontology/adapter-postgres/tests/key_revision_migration_upgrade.rs", "migration_0165_keeps_exact_old_binary_writes_audited_and_cas_consistent"),
    ("ontology", "mnt-ontology-adapter-postgres", "key_revision_migration_upgrade", "backend/crates/ontology/adapter-postgres/tests/key_revision_migration_upgrade.rs", "migration_0165_rehearses_populated_expand_with_bounded_lock_and_statement_timeouts"),
    ("leave", "mnt-leave-adapter-postgres", "leave_migration_expand_contract", "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs", "migration_0166_rehearses_populated_expand_with_bounded_lock_and_statement_timeouts"),
    ("leave", "mnt-leave-adapter-postgres", "leave_migration_expand_contract", "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs", "exact_charge_create_accepts_resolved_and_review_required_shapes"),
    ("leave", "mnt-leave-adapter-postgres", "leave_migration_expand_contract", "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs", "exact_charge_create_atomically_rejects_mismatched_reason_and_evidence_shapes"),
    ("leave", "mnt-leave-adapter-postgres", "leave_migration_expand_contract", "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs", "immediate_f6ff_employee_import_remains_usable_after_0166"),
    ("leave", "mnt-leave-adapter-postgres", "leave_migration_expand_contract", "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs", "staged_f6ff_employee_import_apply_remains_atomic_after_0166"),
    ("leave", "mnt-leave-adapter-postgres", "leave_migration_expand_contract", "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs", "staged_f6ff_apply_rejects_missing_duplicate_or_forged_current_tx_audit"),
    ("leave", "mnt-leave-adapter-postgres", "leave_migration_expand_contract", "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs", "legacy_leave_mutations_require_exactly_one_same_transaction_audit"),
    ("leave", "mnt-leave-adapter-postgres", "leave_migration_expand_contract", "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs", "staged_employee_import_rejects_payload_not_equal_to_immutable_ledger"),
)
BUCK_POSTGRES_HARNESS = Path("tools/buck/test_needs_postgres.sh")
# Generated target labels are the execution boundary for this operational gate.
# The disposable harness, not a job-level service database, supplies SQLx's
# bootstrap authority and per-invocation database lifecycle.
OPERATIONAL_SQLX_TARGETS = (
    "//tools/buck:pr473-ontology-key-revision-postgres",
    "//tools/buck:pr473-leave-expand-postgres",
    "//tools/buck:pr473-apalis-adapter-postgres",
    "//tools/buck:pr473-apalis-schema-postgres",
)
TARGET_BY_SOURCE_AND_BINARY = {
    (
        "backend/crates/ontology/adapter-postgres/tests/key_revision_migration_upgrade.rs",
        "key_revision_migration_upgrade",
    ): "//tools/buck:pr473-ontology-key-revision-postgres",
    (
        "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs",
        "leave_migration_expand_contract",
    ): "//tools/buck:pr473-leave-expand-postgres",
}
RUST_TARGET_BY_SOURCE_AND_BINARY = {
    (
        "backend/crates/ontology/adapter-postgres/tests/key_revision_migration_upgrade.rs",
        "key_revision_migration_upgrade",
    ): "//backend/crates/ontology/adapter-postgres:mnt-ontology-adapter-postgres-itest-key_revision_migration_upgrade",
    (
        "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs",
        "leave_migration_expand_contract",
    ): "//backend/crates/leave/adapter-postgres:mnt-leave-adapter-postgres-itest-leave_migration_expand_contract",
}


class GateError(ValueError):
    """A fail-closed gate contract violation."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as error:
        raise GateError(f"cannot read manifest {path}: {error}") from error
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as error:
        raise GateError(f"manifest is not valid JSON: {error}") from error
    if not isinstance(manifest, dict):
        raise GateError("manifest root must be an object")
    if raw != canonical_json(manifest):
        raise GateError("manifest must use canonical two-space JSON with one trailing newline")
    validate_manifest(manifest)
    return manifest


def validate_manifest(manifest: dict[str, Any]) -> None:
    if tuple(manifest) != TOP_LEVEL_KEYS:
        raise GateError(f"manifest keys must be exactly {TOP_LEVEL_KEYS}")
    expected_scalars = {
        "schema_version": 1,
        "pull_request": 473,
        "rollback_floor": ROLLBACK_FLOOR,
        "release_phase": "expand",
        "deployment_authorized": False,
        "command_only_claim_authorized": False,
        "production_authority": PRODUCTION_AUTHORITY,
    }
    for key, expected in expected_scalars.items():
        if manifest[key] != expected or type(manifest[key]) is not type(expected):
            raise GateError(f"manifest {key} must be exactly {expected!r}")

    tests = manifest["guarded_tests"]
    if not isinstance(tests, list) or len(tests) != 11:
        raise GateError("manifest guarded_tests must contain exactly 11 entries")
    tuples: list[tuple[str, str, str, str, str]] = []
    for index, test in enumerate(tests):
        if not isinstance(test, dict) or tuple(test) != TEST_KEYS:
            raise GateError(f"guarded_tests[{index}] keys must be exactly {TEST_KEYS}")
        if any(not isinstance(test[key], str) or not test[key] for key in TEST_KEYS):
            raise GateError(f"guarded_tests[{index}] values must be non-empty strings")
        tuples.append(tuple(test[key] for key in TEST_KEYS))
    if tuple(tuples) != EXPECTED_TESTS:
        raise GateError("manifest guarded_tests must equal the 11 exact expected tuples in canonical order")


def load_buck_rule(repo_root: Path, target: str) -> str:
    """Read the exact top-level Buck rule body for an absolute target label."""
    match = re.fullmatch(r"//(?P<package>[^:]+):(?P<name>[^:]+)", target)
    if match is None:
        raise GateError(f"invalid Buck target label {target!r}")
    path = repo_root / match.group("package") / "BUCK"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise GateError(f"cannot read Buck declaration {path}: {error}") from error
    name = re.escape(match.group("name"))
    rule = re.search(
        rf'^\s*(?:rust_test|sh_test)\(\n    name = "{name}",(?P<body>.*?)^\)\n',
        text,
        re.MULTILINE | re.DOTALL,
    )
    if rule is None:
        raise GateError(f"Buck target declaration is missing for {target}")
    return rule.group(0)


def guarded_test_specs(repo_root: Path, manifest: dict[str, Any]) -> tuple[tuple[str, str], ...]:
    """Bind every manifest tuple to its wrapper and generated Rust test declaration."""
    specs: list[tuple[str, str]] = []
    for test in manifest["guarded_tests"]:
        key = (test["source"], test["target"])
        wrapper_target = TARGET_BY_SOURCE_AND_BINARY.get(key)
        rust_target = RUST_TARGET_BY_SOURCE_AND_BINARY.get(key)
        if wrapper_target is None or rust_target is None:
            raise GateError("guarded test does not map to an approved Buck2 PostgreSQL target")
        rust_rule = load_buck_rule(repo_root, rust_target)
        source = test["source"]
        source_dir, source_file = source.rsplit("/tests/", 1)
        expected_mapped_src = f'mapped_srcs = repo_mapped_srcs("{source_dir}", ["tests/{source_file}"]'
        if expected_mapped_src not in rust_rule or f'crate_root = "{source}"' not in rust_rule:
            raise GateError(f"generated Rust target {rust_target} no longer binds {source}")
        wrapper_rule = load_buck_rule(repo_root, wrapper_target)
        expected_location = f'args = ["$(location {rust_target})"]'
        expected_deps = f'deps = ["{rust_target}"]'
        if expected_location not in wrapper_rule or expected_deps not in wrapper_rule:
            raise GateError(f"PostgreSQL wrapper {wrapper_target} no longer executes {rust_target}")
        specs.append((wrapper_target, test["name"]))
    return tuple(specs)


def assert_exact_rust_test_result(output: str, name: str, target: str) -> None:
    """Require the libtest stream for precisely one selected, passing test."""
    running = re.compile(r"^running 1 test$", re.MULTILINE)
    result = re.compile(rf"^test {re.escape(name)} \.\.\. ok$", re.MULTILINE)
    summary = re.compile(
        r"^test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; [0-9]+ filtered out;$",
        re.MULTILINE,
    )
    counts = (len(running.findall(output)), len(result.findall(output)), len(summary.findall(output)))
    if counts != (1, 1, 1):
        raise GateError(
            f"Buck2 target {target} must emit one exact libtest selection/result/summary "
            f"for {name!r}; found {counts}"
        )


def run(
    command: list[str], *, cwd: Path, env: dict[str, str], show_stdout: bool = True
) -> subprocess.CompletedProcess[str]:
    print(f"+ {' '.join(command)}", flush=True)
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    sys.stdout.write(completed.stderr)
    if show_stdout:
        sys.stdout.write(completed.stdout)
    sys.stdout.flush()
    return completed


def execute(repo_root: Path) -> int:
    manifest = load_manifest(repo_root / MANIFEST_PATH)
    harness = repo_root / BUCK_POSTGRES_HARNESS
    if not harness.is_file() or not os.access(harness, os.X_OK):
        raise GateError(
            f"Buck2 disposable PostgreSQL harness is not executable: {BUCK_POSTGRES_HARNESS}"
        )

    env = dict(os.environ)
    # CI can export reusable service URLs.  Do not allow them to cross into
    # this gate: the harness supplies bounded URLs after bootstrapping its own
    # disposable authority.
    for variable in (
        "DATABASE_URL",
        "MNT_APALIS_OWNER_DATABASE_URL",
        "MNT_APALIS_RUNTIME_DATABASE_URL",
        "MNT_APALIS_ADMIN_DATABASE_URL",
    ):
        env.pop(variable, None)

    for target in OPERATIONAL_SQLX_TARGETS[2:]:
        completed = run(
            [str(harness), target, "--test-executor-stdout=-"], cwd=repo_root, env=env
        )
        if completed.returncode != 0:
            raise GateError(
                f"Buck2 disposable PostgreSQL target {target} exited {completed.returncode}"
            )
    for target, name in guarded_test_specs(repo_root, manifest):
        exact_env = dict(env, MNT_BUCK_NEEDS_POSTGRES_TEST_EXACT=name)
        completed = run(
            [str(harness), target, "--test-executor-stdout=-"],
            cwd=repo_root,
            env=exact_env,
        )
        if completed.returncode != 0:
            raise GateError(
                f"Buck2 disposable PostgreSQL target {target} exited {completed.returncode}"
            )
        assert_exact_rust_test_result(completed.stdout, name, target)
    print(
        "PR 473 migration operational gate passed: "
        "Buck2 disposable PostgreSQL harness ran the 3 exact Apalis database tests "
        "and the 11 guarded migration regressions"
    )
    return 0

def resolve_repo_root(repo_root: Path | None, backend_dir: Path | None) -> Path:
    if repo_root is not None:
        return repo_root.resolve()
    if backend_dir is not None:
        resolved = backend_dir.resolve()
        return resolved.parent if (resolved / "Cargo.toml").is_file() else resolved
    return Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("backend_dir", nargs="?", type=Path)
    parser.add_argument("--repo-root", type=Path)
    args = parser.parse_args()
    try:
        return execute(resolve_repo_root(args.repo_root, args.backend_dir))
    except GateError as error:
        print(f"PR 473 migration operational gate FAILED: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
