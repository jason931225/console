# Console

Console is a Rust platform for a governed company object engine: **Ontology / Foundry / Policy → Company / OrgUnit / Employee → HR → Payroll**. This is the current product boundary; ERP, finance, communications, compliance products, ingest/evidence, office editing, AI judgment, and unrelated verticals are out of scope.

## Repository map
- `backend/` — Rust workspace, ontology, authorization, HR/payroll substrate, REST application, migrations.
- `docs/PIVOT-2026-07-28.md` — canonical product and repository truth.
- `docs/decisions/` — immutable accepted decisions (historical decisions are never rewritten).
- `docs/program/` — current delivery method and machine-readable registers; historical records are labelled.
- `scripts/` — executable CI/preflight and verification gates.

## Supported local checks
From `backend/`: `cargo fmt --all --check`, `cargo check --workspace`, and targeted `cargo test` for changed crates. Run repository gate scripts named by the applicable CI workflow. Record the exact command, revision, toolchain, and test counts in the lane receipt.

## Authority
Precedence is Pivot, accepted ADRs consistent with it, current roadmap/pipeline, machine-readable registers, exact candidate evidence, then historical plans and runtime state. See `AGENTS.md` and `docs/program/agentic-engineering-playbook.md`.
