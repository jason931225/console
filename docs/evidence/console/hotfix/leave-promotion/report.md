# Hotfix — 연차사용촉진 (근로기준법 제61조): the fabricated statutory procedure

**Lane** `hf-leave-promotion` · **worktree** `hf-leave-promotion-20260725` ·
**date** 2026-07-25 · **charter ref** WAVE4-CHARTER-DEPTH §8 item 3 (L-D3)

> "the only *wrongly-fabricated* finding in the whole audit … the one truthfulness
> *defect* as opposed to a truthfulness *gap*."

---

## 1. The fabrication, located precisely

Three defects, all in the §61 push path, all shipping the same failure mode: a
document that reads as an authoritative legal notice and is not one.

### 1.1 `validate_round` — the named finding

`backend/crates/leave/domain/src/lib.rs:575-589` (pre-fix):

```rust
pub fn validate_round(kind: PromotionKind, round: i16) -> Result<i16, KernelError> {
    match kind {
        PromotionKind::Promotion => {
            if round == 1 || round == 2 { Ok(round) }
            else { Err(KernelError::validation("연차 촉진 round must be 1 or 2 (§61)")) }
        }
        PromotionKind::Refusal => Ok(2),
    }
}
```

**Claims** (doc comment, `lib.rs:520-523`): "연차 사용 촉진 has two rounds under §61
(round 1 = 사용 촉구, round 2 = 시기 지정); after round 2 the employer may serve a
노무수령거부 notice to decline the labor **and extinguish the leave-pay liability**."

**Does**: checks that an integer is 1 or 2. Nothing else. No window, no ordering,
no predecessor. `PromotionKind::Refusal => Ok(2)` normalises *any* input and does
not check that a round-2 통보 was ever served.

The pre-existing integration test
(`leave_rls_surfaces_as_runtime_role.rs:2153`, pre-fix) is the proof: it served
round 1, round 2 and the refusal at three consecutive `OffsetDateTime::now_utc()`
calls — milliseconds apart — and asserted success.

### 1.2 The refusal notice asserted a legal conclusion it cannot reach

`backend/crates/leave/adapter-postgres/src/lib.rs:1577` (pre-fix):

```
"본 통지로써 해당 연차에 대한 사용자의 금전 보상 의무가 소멸함을 안내드립니다."
```

("By this notice, the employer's monetary compensation obligation for this leave
is extinguished.")

That sentence is false in the general case and the system had no way to make it
true. §61 relief requires (a) every step in 서면 inside its statutory window, (b)
the worker not using the leave, and (c) — per 대법원 2019다279283 — the employer
actually refusing the labour and giving no work instructions. The code checked
none of the three.

### 1.3 A round-2 notice that designated nothing, and a client-supplied day count

- `adapter-postgres/src/lib.rs:1558-1560` (pre-fix): the round-2 body said
  "사용 시기를 지정하여 통보하오니" while designating **no dates**. §61①2 requires
  the 통보 to designate 사용 시기; a 통보 without them is not a §61①2 통보.
- `rest/src/lib.rs:619-620` + `application/src/lib.rs:195` (pre-fix):
  `#[serde(default)] unused_days: f64` — an unverified client float, defaulting
  to `0`, printed onto the notice as "귀하의 미사용 연차 {n}일". §61①1 requires the
  employer to state the employee's own 미사용 휴가 일수.

### 1.4 One latent defect found while fixing (now fails closed, not fixed)

`0123_create_leave_promotions.sql:43` — `UNIQUE (org_id, target_employee_id,
kind, round)` is per-employee-forever, not per leave period. An employee can
receive exactly one round-1 촉구 for their entire employment; the second year's
push would hit `ON CONFLICT DO NOTHING` and be returned as an idempotent success
carrying **last year's** row. Migrations are a shared collision root, so this is
filed as `manifests/migration.json` and guarded in code (§4.4).

---

## 2. The real rule, from live authoritative sources

Every parameter below was read from a live source on **2026-07-25**. None came
from model memory.

| # | Source | URL | Accessed |
|---|---|---|---|
| S1 | 국가법령정보센터 — 근로기준법 제61조 | <https://www.law.go.kr/lsLinkProc.do?ancYd=20160302&lsClsCd=L&lsNm=%EA%B7%BC%EB%A1%9C%EA%B8%B0%EC%A4%80%EB%B2%95&lsId=2031481&joNo=006100000&mode=4> | 2026-07-25 |
| S2 | CaseNote — 근로기준법 제61조 (cross-check of S1; 시행 2020. 3. 31., 법률 제17185호) | <https://casenote.kr/법령/근로기준법/제61조> | 2026-07-25 |
| S3 | CaseNote — 근로기준법 제60조제7항 (the 소멸 period §61 counts back from) | <https://casenote.kr/법령/근로기준법/제60조> | 2026-07-25 |
| S4 | 고용노동부 빠른인터넷상담 — 노무수령 거부의사 (citing 대법원 2019다279283, 2020. 2. 27. 선고) | <https://www.moel.go.kr/minwon/fastcounsel/fastcounselView.do?inetDcssMngId=202310041607201011000> | 2026-07-25 |
| S5 | 대법원 판결 안내 — 미지급 연차휴가수당 등의 지급을 청구하는 사건 | <https://scourt.go.kr/supreme/news/NewsViewAction2.work?gubun=4&searchOption=&searchWord=&seqnum=7013> | 2026-07-25 |
| S6 | 샤플 — 연차촉진 절차 운영 가이드 (the published calendar convention) | <https://www.shoplworks.com/blog-insight/annual-leave-promotion-procedure-calculation-jun> | 2026-07-25 |

### 2.1 Statute text (S1, cross-checked S2)

**제61조제1항** — "사용자가 제60조제1항ㆍ제2항 및 제4항에 따른 유급휴가(계속하여 근로한
기간이 1년 미만인 근로자의 제60조제2항에 따른 유급휴가는 제외한다)의 사용을 촉진하기
위하여 다음 각 호의 조치를 하였음에도 불구하고 근로자가 휴가를 사용하지 아니하여
제60조제7항 본문에 따라 소멸된 경우에는 사용자는 그 사용하지 아니한 휴가에 대하여
보상할 의무가 없고, 제60조제7항 단서에 따른 사용자의 귀책사유에 해당하지 아니하는
것으로 본다."

1. "제60조제7항 본문에 따른 기간이 끝나기 **6개월 전을 기준으로 10일 이내**에 사용자가
   근로자별로 사용하지 아니한 휴가 일수를 알려주고, 근로자가 그 사용 시기를 정하여
   사용자에게 통보하도록 **서면으로** 촉구할 것"
2. "제1호에 따른 촉구에도 불구하고 근로자가 촉구를 받은 때부터 **10일 이내**에 사용하지
   아니한 휴가의 전부 또는 일부의 사용 시기를 정하여 사용자에게 통보하지 아니하면
   제60조제7항 본문에 따른 기간이 끝나기 **2개월 전까지** 사용자가 사용하지 아니한 휴가의
   **사용 시기를 정하여** 근로자에게 **서면으로** 통보할 것"

**제61조제2항** (계속근로 1년 미만, 제60조제2항 휴가):

1. "최초 1년의 근로기간이 끝나기 **3개월 전을 기준으로 10일 이내**에 … 서면으로 촉구할
   것. **다만**, 사용자가 서면 촉구한 후 발생한 휴가에 대해서는 최초 1년의 근로기간이
   끝나기 **1개월 전을 기준으로 5일 이내**에 촉구하여야 한다."
2. "… 최초 1년의 근로기간이 끝나기 **1개월 전까지** … 서면으로 통보할 것. **다만**,
   제1호 단서에 따라 촉구한 휴가에 대해서는 최초 1년의 근로기간이 끝나기 **10일 전까지**
   서면으로 통보하여야 한다."

**제60조제7항** (S3) — "…휴가는 1년간(계속하여 근로한 기간이 1년 미만인 근로자의
제2항에 따른 유급휴가는 최초 1년의 근로가 끝날 때까지의 기간을 말한다) 행사하지
아니하면 소멸된다. 다만, 사용자의 귀책사유로 사용하지 못한 경우에는 그러하지 아니하다."

### 2.2 노무수령 거부 — not in the statute, required by the courts (S4, S5)

고용노동부 (S4): "연차휴가사용촉진조치를 취하시는 경우, 해당 근로자가 자신의 휴가
지정일에 출근하는 경우 사용자는 '**노무수령 거부의사**'를 명확히 표하시어야 할 것",
citing 대법원 **2019다279283** (2020. 2. 27. 선고). Where the worker works the
designated day and the employer accepts the labour or issues work instructions,
the 보상 의무 survives regardless of a formally correct 촉진.

**Consequence for this system**: the extinguishment of 미사용수당 liability is a
finding of fact about employer conduct, not a computation. It is therefore never
asserted by the software.

### 2.3 Day-count convention

`…끝나기 N개월 전` is implemented as the calendar date N months before the period
end, with the window opening the **following** day so the remaining span is
exactly N months. For a 회계연도 1/1–12/31 period this reproduces the published
administrative answer (S6): "회계연도 기준으로 12월 31일에 연차가 소멸된다면,
**7월 1일부터 7월 10일** 사이에 통지를 완료해야 합니다", and a 2차 통보 기한 of
**10월 31일**. Both are pinned by name in
`backend/crates/leave/domain/src/promotion.rs` tests
(`annual_first_round_window_matches_the_published_fiscal_year_answer`,
`annual_second_round_deadline_matches_the_published_fiscal_year_answer`).

---

## 3. Choice: IMPLEMENT, with a fail-closed gate on what is not computable

The lane allowed either a correct implementation or an explicit
unimplemented-gate. **Implemented**, because the §61 windows are pure
statutory-deterministic date arithmetic over two inputs — the 연차 사용기간 종료일
and the §61 track — and the truthfulness doctrine says such rules get built with
citations and tests rather than gated.

What is *not* implemented, and is gated instead:

| Not computable | Treatment |
|---|---|
| Whether the employer actually refused the labour on the designated day (대법원 2019다279283) | The notice declares the refusal and explicitly states that the 보상 의무 면제 여부 is determined by the lawfulness of the procedure and the fact of non-use, **and that this notice does not settle it**. |
| The 연차 사용기간 종료일 and the track | Required request inputs. The platform has no authoritative source: `employees.hire_date` is free-form `TEXT` from the Excel import and there is no org-level 연차 산정 기준 setting. The HR admin supplies the org-policy fact; the server does the statutory arithmetic on it and records both in the audit snapshot. |
| A second 연차 사용기간 for the same employee | HTTP 409 naming `manifests/migration.json`. Never a silent return of last period's row. |
| The employee's 미사용 연차 일수 when the roster has not established it | HTTP 409. Never a printed `0`. |

---

## 4. What changed

### 4.1 New: `backend/crates/leave/domain/src/promotion.rs`

Pure, dependency-free statutory rules. Every constant carries its clause; the
module header carries the verbatim statute text and the six citations above.

| Track | 1차 촉구 window | 2차 통보 기한 | Clause |
|---|---|---|---|
| `annual` | `period_end − 6개월 + 1일` … `+10일` | `period_end − 2개월` | §61①1, §61①2 |
| `first_year_early` | `period_end − 3개월 + 1일` … `+10일` | `period_end − 1개월` | §61②1 본문, §61②2 본문 |
| `first_year_late` | `period_end − 1개월 + 1일` … `+5일` | `period_end − 10일` | §61②1 단서, §61②2 단서 |

Plus: round 2 requires a recorded round 1 and may only be served **after** the
worker's 10-day reply window has closed (§61①2 / §61②2 "촉구를 받은 때부터 10일
이내에 … 통보하지 아니하면"); a refusal requires a recorded round-2 designation,
may not precede it, and may not follow the end of the leave period; a round-2
notice must designate at least one in-period, non-duplicate future date
(§61①2 "사용 시기를 정하여"). Month subtraction clamps to the end of a shorter
month (3-31 − 1개월 → 2-28 / 2-29).

`validate_round` is **deleted**. `validate_push(kind, round, &PromotionContext)`
replaces it.

### 4.2 Notice bodies rewritten

- Round 1 states the roster's exact 미사용 일수, the 소멸 date, the §61①1 10-day
  written-reply obligation, and what happens on no reply.
- Round 2 states the designated dates.
- The refusal declares the refusal of labour on the recorded designated dates,
  states that no work instructions will be given, and ends with the honest
  conditional: "…미사용수당 보상 의무의 면제 여부는 촉진 절차의 적법성과 실제 휴가
  미사용 사실에 따라 결정되며, **본 통지가 그 효과를 확정하지 않습니다**
  (대법원 2019다279283)."

The refusal reads its designated dates **back from the recorded 2차 통보 notice**,
so it can only ever refuse labour on days that were actually designated.

### 4.3 Server-sourced unused days

`unused_days` is removed from both request bodies. The store reads
`employees.leave_remaining` as `NUMERIC(10,2)::text` — exact, no float on a legal
document — and returns 409 when it is `NULL`.

### 4.4 Fail-closed cross-period guard

Each delivered notice's `source_id` is
`leave-{kind}-{employee}-r{round}-{track}-{YYYY-MM-DD}`. Before treating a
recorded push as this push's predecessor or as an idempotent repeat, the adapter
compares that `source_id`; a mismatch is a 409 naming the migration manifest.
This closes §1.4 without touching the shared migrations root.

### 4.5 Audit

Every push now records a `statutory_basis` snapshot — statute paragraph, track,
`leave_period_end`, `served_on`, `designated_dates`, and the computed window or
deadline (or, for a refusal, the 대법원 citation) — so the arithmetic can be
re-derived from the audit trail alone. The `legal_basis` column on
`leave_promotions`, previously never written, is now populated.

`served_on` is the KST business date (`occurred_at.to_offset(+09:00)`); Korea has
observed a fixed +09:00 since 1988.

---

## 5. Verification

| Check | Command | Result |
|---|---|---|
| Statutory boundary units | `cargo test -p mnt-leave-domain` | **20 passed, 0 failed** (13 in `promotion::tests` + `push_validation_routes_each_kind_to_its_statutory_rule`) |
| Compile, all leave crates + tests | `cargo check -p mnt-leave-domain -p mnt-leave-application -p mnt-leave-adapter-postgres -p mnt-leave-rest --all-targets` | clean |
| Lint | `cargo clippy … --all-targets` | clean, 0 warnings |
| Format | `cargo fmt -p mnt-leave-{domain,application,adapter-postgres,rest}` | applied |
| New SQL vs live schema | `PREPARE` of the changed `find_promotion` join, the `leave_remaining::text` read, and the amended `INSERT … RETURNING id` against dev `mnt_dev` | all three `PREPARE` OK |
| Runtime-role integration | `cargo test -p mnt-leave-adapter-postgres --test leave_rls_surfaces_as_runtime_role statutory` | **BLOCKED — see §6** |

Boundary cases covered by the unit tests: 2026-06-30 / 07-01 / 07-10 / 07-11
around the annual 1차 window; 2026-10-31 / 11-01 around the 2차 기한; the
10-day reply window at day 10 vs day 11; the §61②1 본문 (11-29…12-08, 기한
01-28) and §61②1 단서 (01-29…02-02, 기한 02-18) windows off a 2026-02-28 period
end; month-end clamping across leap and non-leap Februaries; refusal ordering and
period bounds; empty / duplicate / out-of-period designated dates; round 0 and 3.

## 6. Named gap — the runtime-role integration test is written but has not executed

`statutory_push_enforces_the_section_61_windows_as_runtime_role` in
`backend/crates/leave/adapter-postgres/tests/leave_rls_surfaces_as_runtime_role.rs`
exists, compiles, and asserts every window against the real `mnt_rt` pool
(each `expect_err` pinned to its `ErrorKind`, the notice payloads read back from
`inbox_docs`, and an explicit assertion that the refusal body does **not**
contain "소멸함" and **does** cite 2019다279283). It has **not been run**, for two
shared-infrastructure reasons, neither of which this lane may work around:

1. **The Docker VM disk is 100% full** — 188 GB of 197 GB, ~48 MB free;
   migrations abort with SQLSTATE `53100`. The database itself is small
   (588 MB PGDATA + 1.1 GB wal-archive); 187.7 GB sits in 707 Docker local
   volumes, of which 84.86 GB is reclaimable and 676 of the 684 dangling volumes
   are anonymous 64-hex garbage (listed in
   `docker-volume-reclaim-candidates.txt` beside this report). Reclaiming them
   was permission-denied.
2. **Migration `0196` requires the `mnt_buck_admin` identity** —
   `platform_force_role_topology.superuser_test_bootstrap_required` demands
   `SESSION_USER = CURRENT_USER = 'mnt_buck_admin'` together with
   `mnt.sqlx_test_bootstrap = 'buck-sqlx-superuser-v1'`. `mnt_buck_admin` exists
   on dev PG (superuser, no `CREATEDB`) but its credential is not available to
   this lane.

Both were reported to the wave lead. The command to close this gap, unchanged:

```
cd backend && DATABASE_URL='postgres://mnt_buck_admin:<pw>@127.0.0.1:55432/mnt_dev?options%5Bmnt.sqlx_test_bootstrap%5D=buck-sqlx-superuser-v1' \
  cargo test -p mnt-leave-adapter-postgres --test leave_rls_surfaces_as_runtime_role statutory
```

## 7. Manifests filed for the integrator (shared collision roots)

| File | Root | Blocking |
|---|---|---|
| `manifests/openapi.json` | `backend/openapi/openapi.yaml`, `clients/**` | yes — the request bodies changed |
| `manifests/web.json` | `web/**` | yes — `LeaveBody.tsx` `pushPromotion` sends the old body and will 422 |
| `manifests/migration.json` | `backend/crates/platform/db/migrations/**` | no — the lane fails closed without it |

## 8. Residual risk

- Until `manifests/web.json` lands, the console 촉진 button returns 422. That is
  the intended fail-closed state: a visible error beats the previous behaviour of
  silently emitting a legally void notice, and the server's message names the
  exact valid window.
- Until `manifests/migration.json` lands, an org cannot run 촉진 for a second
  연차 사용기간 on the same employee (409, not a wrong answer).
- §61 requires **서면**. The delivery here is a receipt-gated document in the
  개인 수신함. Whether that satisfies 서면 for a given employer depends on the
  employer operating a complete electronic approval system; this is an
  externally-certified matter for the employer's 노무사 and is **not** asserted by
  the software. Not a code gap — recorded so no one mistakes delivery for
  certification.
- The engine AP- run stays `pending_engine_definition` (pre-existing gap #1,
  unchanged by this lane and still honest).
