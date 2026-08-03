---
id: ADR-0009
status: accepted
doc_status: published
date: 2026-06-12
owner: jasonlee
consensus: ralplan iteration 3 (Planner/Architect/Critic APPROVE, 2026-06-12)
amended_by: [ADR-0031]
related: [ADR-0012, ADR-0031]
---

# ADR-0009 — Dual-native (Swift+Kotlin) parity strategy via single OpenAPI contract + CI parity gate

## Status
Accepted (consensus-approved plan §2.9).

## Context
The user chose native Swift (iOS) + Kotlin (Android) apps over a single React Native codebase (informed decision, interview R6) for maximal mobile UX. Two codebases create parity-drift risk — the plan's #1 pre-mortem scenario.

## Decision
Parity is enforced structurally, not by discipline. **Target, per ADR-0031 and not yet built:** one
`openapi.yaml` **emitted** from the wire-DTO contracts crate, with a CI gate failing when the committed
document differs from the emitted one. **What HEAD has, stated so this clause is not read as describing
the present:** no contracts crate exists, no emitter exists, and `openapi.yaml` is hand-maintained and
served verbatim via `include_str!` in `backend/app/src/lib.rs`. At ADR-0031 acceptance,
`check-openapi-app.mjs` compared the app-served document to the committed file, which `include_str!`
made tautologically equal; that script has since been retired. The surviving
`check:platform-contract-drift` gate compares only platform HTTP method/path inventory with the
committed text, so nothing today verifies an emitted document against a committed one or schemas
against wire types. **Accepted but unreconciled with HEAD:** ts/swift/kotlin client generation and
its drift gate (T1.9), the dual-build gate over both apps (T1.8), and per-slice
web+Android-then-iOS sequencing remain binding because no accepted ADR amends them. Their
`clients/`, `web/`, `android/`, and `ios/` artifacts are absent from HEAD and the generator scripts
are gone from `package.json`; under authority rule 6 that is a governance gap, not withdrawal. The
per-release parity checklist also remains binding for any applicable surface.

## Consequences
+ Best platform UX (camera pipeline, push handling, passkeys are platform-native anyway).
− Roughly 2× client implementation cost per slice — accepted by the user explicitly; the contract/codegen machinery is the mitigation, and it has its own CI gate.

## Alternatives considered
Expo/React Native single codebase (research-recommended; user overrode); RN + native modules hybrid (offered; declined).
