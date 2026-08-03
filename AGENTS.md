# Repository invariants

- `docs/PIVOT-2026-07-28.md` is product authority; accepted ADRs must be consistent with it. Proposed or conflicting plans are HOLD, not permission to expand scope.
- Keep one writer per root. Declare ownership, exact base SHA, immutable target, and mechanical guide before fan-out; serialize migrations, lockfiles, generated files, OpenAPI, CI, and authority records.
- Never use destructive shared-workspace Git operations or overwrite another lane's work. Preserve historical evidence.
- Do not skip, delete, quarantine, or weaken tests without an approved receipt and independent review. Record exact invocations and discovered/executed counts.
- Keep facts, inferences, hypotheses, and legal conclusions distinct. Production exposure and legal/compliance claims require separate authority and evidence.
- Every lane records pre-mortem, blast radius, detection, rollback, stop conditions, review identities, head SHA, and remaining HOLDs.

Detailed method: `docs/program/agentic-engineering-playbook.md`.
