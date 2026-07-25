# Console north star — confirmed intent (2026-07-24, interview-confirmed)

## Outcome

The console realized as a **corporate operating system on one ontology** — every
entity, operation, action, and state a typed, policy-governed, lifecycle-tracked
object in a single graph ("game engine for the corporation"; benchmark:
Palantir Foundry). The modules are faithful **lenses** over that substrate,
matching the Claude Design prototype's grammar exactly.

## Confirmed decisions

- **User:** every employee of the conglomerate (not just admins), per persona,
  deny-by-omission.
- **Fidelity = grammar + intent, never seed data.** The prototype's layouts,
  cards, steppers, chips, keyboard flows, drill links are the spec; its mock
  rows/counts are illustrations — copying them into the product is a defect.
  Design intent is distilled from the claude_design markdowns
  (design-intent-register), not only from pixels.
- **Backend-thin surfaces → build the backend.** When a module's design section
  is richer than the backend, the missing backend surface is built to full
  production enterprise standard (RLS as `mnt_rt`, deny-by-default PBAC, audit,
  lifecycle, canonical envelopes, idempotency, story-level integration tests) —
  not shipped as a truthful-but-thin screen with a recorded gap.
- **Ontology integration model = (a) projection registration**, per §18/D1/D2:
  domain crates stay the owning writers; every module object type (payroll run,
  posting, applicant, evaluation cycle, rental agreement, ASN, notice, org
  change, …) is REGISTERED in the shared ontology engine as a typed projection
  with its 3 layers (semantic / kinetic / dynamic), links, governed Actions, and
  policy resources — drillable in the graph explorer and 3-layer object cards.
  No re-architecture through the generic instance store.
- **§18 engine residuals close to production grade** — foremost: projected-type
  action dispatch routed through domain use-cases (replace NotWiredYet).
- **Priority: north star + maturity/polish** — substrate depth and production
  maturity over breadth; §4-25 closed-loop polish is part of done.
- **Zero stubs/fillers**, per HANDOFF §0 do-not-ship scaffold + DESIGN §4-12 +
  the program's non-negotiable module completion contract.

## Constraints

Everything stacks onto PR #488 (single stacked integration spine). ADR-0025
dark-mounting governs exposure (`EXPOSED_SCREEN_KEYS` stays evidence-gated).
Codex-fleet coexistence disciplines: hot-check before editing shared crates,
manifests for collision roots, plain-merge before push.

## Out of scope

Pixel-cloning prototype seed rows/counts; re-architecting verified domain
crates through the generic store; production exposure decisions.
