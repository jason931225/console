import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { runIdempotencyKey } from "../../api/automate";
import { ApiCallError } from "../../api/ontologyActions";
import type { WorkflowDefinitionResponse } from "../../api/types";
import { assertPasskeyStepUp } from "../../auth/webauthn";
import { useAuth, type AuthSession } from "../../context/auth";
import type { ConsoleApiClient } from "../../api/client";
import { PolicyGated, usePolicyGate, type PolicyGate } from "../policy";
import "../tokens.css";
import {
  createWorkflowSchedule,
  listScheduleRuns,
  listWorkflowSchedules,
  previewWorkflowSchedule,
  updateWorkflowSchedule,
  type WorkflowSchedule,
  type WorkflowScheduleCreate,
  type WorkflowScheduleRun,
} from "./scheduleApi";

const ACTIONS = {
  viewSchedules: "console.automate.tab.schedules.view",
  create: "console.automate.schedule.create",
  select: "console.automate.schedule.select",
  edit: "console.automate.schedule.edit",
  toggle: "console.automate.schedule.toggle",
  run: "console.automate.schedule.run",
  approveRevision: "console.automate.schedule.revision.approve",
  withdrawRevision: "console.automate.schedule.revision.withdraw",
} as const;

const INITIAL_FORM: WorkflowScheduleCreate = {
  label: "",
  cron_expr: "0 9 * * 1-5",
  timezone: "Asia/Seoul",
  definition_id: "",
  enabled: true,
};


const shell: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  padding: "var(--sp-6)",
  color: "var(--ink)",
  background: "var(--canvas)",
};
const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(240px, 340px) minmax(0, 1fr)",
  gap: "var(--sp-5)",
  alignItems: "start",
};
const card: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
  padding: "var(--sp-5)",
  background: "var(--surface)",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "var(--border)",
  borderRadius: "var(--radius-card)",
  boxShadow: "var(--shadow)",
};
const button: CSSProperties = {
  minHeight: 36,
  padding: "0 var(--sp-4)",
  borderRadius: "var(--radius-md)",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};
const selectedButton: CSSProperties = {
  ...button,
  textAlign: "left",
  background: "var(--accent-subtle)",
  borderColor: "var(--accent)",
};
const row: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
  alignItems: "center",
  justifyContent: "space-between",
};

function formatTime(value: string | null | undefined): string {
  return value ?? "다음 실행 없음";
}

function statusLabel(schedule: WorkflowSchedule): string {
  return schedule.enabled ? "활성" : "비활성";
}

function statusTone(status: string | null | undefined): string {
  return status ?? "실행 기록 없음";
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiCallError) {
    if (error.status === 403)
      return "예약 변경이 거부되었습니다. 현재 권한으로는 이 예약을 변경할 수 없습니다.";
    if (error.status === 409)
      return "예약 상태가 변경되었습니다. 최신 상태를 다시 불러왔습니다.";
  }
  return "예약 정보를 처리하지 못했습니다. 최신 상태를 다시 시도하세요.";
}

/** Durable schedule lifecycle surface: backend-owned schedules, preview, and run history. */
export function WorkflowScheduleOperations() {
  const { api, session } = useAuth();
  const gate = usePolicyGate();
  const scopeKey = session
    ? `${session.access_token}:${session.org_id ?? "platform"}`
    : "anonymous";

  // A scope-keyed child unmounts all retained data before another tenant can
  // render it. Async work is additionally fenced by the child lifetime.
  return <WorkflowScheduleScope key={scopeKey} api={api} gate={gate} session={session} />;
}

interface WorkflowScheduleScopeProps {
  api: ConsoleApiClient;
  gate: PolicyGate;
  session: AuthSession | undefined;
}

function WorkflowScheduleScope({ api, gate, session }: WorkflowScheduleScopeProps) {
  const [schedules, setSchedules] = useState<WorkflowSchedule[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<{
    scheduleId: string;
    preview: string[];
    runs: WorkflowScheduleRun[];
  }>();
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string>();
  const [error, setError] = useState<string>();
  const [acceptedScope, setAcceptedScope] = useState<string>();
  const [definitions, setDefinitions] = useState<WorkflowDefinitionResponse[]>([]);
  const [form, setForm] = useState<WorkflowScheduleCreate>(INITIAL_FORM);
  const [editing, setEditing] = useState(false);
  const scheduleRequest = useRef(0);
  const detailRequest = useRef(0);
  const active = useRef(true);
  const scopeKey = session
    ? `${session.access_token}:${session.org_id ?? "platform"}`
    : "anonymous";

  useEffect(() => () => {
    active.current = false;
  }, []);
  const isActive = useCallback(() => active.current, []);

  const loadSchedules = useCallback(
    async (signal?: AbortSignal) => {
      const request = ++scheduleRequest.current;
      setLoading(true);
      try {
        const [next, definitionResponse] = await Promise.all([
          listWorkflowSchedules(api, signal),
          api.GET("/api/v1/workflow-studio/definitions", { signal }),
        ]);
        if (!definitionResponse.data)
          throw new ApiCallError(definitionResponse.response.status, definitionResponse.error);
        if (request !== scheduleRequest.current || signal?.aborted) return;
        setSchedules(next);
        setDefinitions(definitionResponse.data.items);
        setAcceptedScope(scopeKey);
        setSelectedId((current) =>
          current && next.some((item) => item.id === current) ? current : next[0]?.id,
        );
        setError(undefined);
      } catch (caught) {
        if (signal?.aborted || request !== scheduleRequest.current) return;
        setError(errorMessage(caught));
      } finally {
        if (request === scheduleRequest.current && !signal?.aborted) setLoading(false);
      }
    },
    [api, scopeKey],
  );

  useEffect(() => {
    const controller = new AbortController();
    // Defer the load so this effect does not synchronously cascade state updates.
    void Promise.resolve().then(() => loadSchedules(controller.signal));
    return () => {
      controller.abort();
    };
  }, [loadSchedules]);

  const scopedSchedules = acceptedScope === scopeKey ? schedules : [];
  const selected = scopedSchedules.find((item) => item.id === selectedId);
  const selectedDefinition = definitions.find(
    (definition) => definition.id === selected?.definition_id,
  );

  useEffect(() => {
    if (!selected || acceptedScope !== scopeKey) return;
    const controller = new AbortController();
    const request = ++detailRequest.current;
    void Promise.all([
      previewWorkflowSchedule(api, selected.cron_expr, selected.timezone, controller.signal),
      listScheduleRuns(api, selected.id, controller.signal),
    ])
      .then(([nextPreview, nextRuns]) => {
        if (controller.signal.aborted || request !== detailRequest.current) return;
        setDetail({ scheduleId: selected.id, preview: nextPreview.fire_times, runs: nextRuns });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || request !== detailRequest.current) return;
        setDetail({ scheduleId: selected.id, preview: [], runs: [] });
        setError(errorMessage(caught));
      });
    return () => {
      controller.abort();
    };
  }, [acceptedScope, api, scopeKey, selected]);

  // Detail visibility is derived from its owning schedule, so prior previews
  // and history cannot flash while a new selected schedule is loading.
  const visibleDetail = detail?.scheduleId === selected?.id ? detail : undefined;
  const preview = visibleDetail?.preview ?? [];
  const runs = visibleDetail?.runs ?? [];

  const toggle = useCallback(async () => {
    if (
      !selected ||
      pendingId ||
      !gate.can(ACTIONS.toggle, { kind: "workflow_schedule", id: selected.id })
    )
      return;
    setPendingId(selected.id);
    setError(undefined);
    try {
      const updated = await updateWorkflowSchedule(api, selected.id, {
        enabled: !selected.enabled,
      });
      if (!isActive()) return;
      setSchedules((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      // Read again after the mutation; the backend remains the lifecycle authority.
      await loadSchedules();
    } catch (caught) {
      if (!isActive()) return;
      await loadSchedules();
      if (!isActive()) return;
      setError(errorMessage(caught));
    } finally {
      if (isActive()) setPendingId(undefined);
    }
  }, [api, gate, isActive, loadSchedules, pendingId, selected]);

  const save = useCallback(async () => {
    if (
      pendingId ||
      !gate.can(editing ? ACTIONS.edit : ACTIONS.create, {
        kind: "workflow_schedule",
        id: selected?.id ?? "new",
      })
    )
      return;
    setError(undefined);
    setPendingId(selected?.id ?? "creating");
    try {
      if (editing && selected) {
        await updateWorkflowSchedule(api, selected.id, {
          label: form.label,
          cron_expr: form.cron_expr,
          timezone: form.timezone,
        });
      } else {
        await createWorkflowSchedule(api, form);
      }
      if (!isActive()) return;
      setEditing(false);
      setForm(INITIAL_FORM);
      await loadSchedules();
    } catch (caught) {
      if (!isActive()) return;
      await loadSchedules();
      if (!isActive()) return;
      setError(errorMessage(caught));
    } finally {
      if (isActive()) setPendingId(undefined);
    }
  }, [api, editing, form, gate, isActive, loadSchedules, pendingId, selected]);

  const startEdit = useCallback(() => {
    if (
      !selected ||
      !gate.can(ACTIONS.edit, { kind: "workflow_schedule", id: selected.id })
    )
      return;
    setForm({
      label: selected.label,
      cron_expr: selected.cron_expr,
      timezone: selected.timezone,
      definition_id: selected.definition_id,
      enabled: selected.enabled,
    });
    setEditing(true);
  }, [gate, selected]);

  const runNow = useCallback(async () => {
    if (!selected || pendingId) return;
    setPendingId(selected.id);
    setError(undefined);
    try {
      const response = await api.POST("/api/v1/workflow-studio/definitions/{id}/run", {
        params: { path: { id: selected.definition_id } },
        body: {
          trigger_type: "SCHEDULE",
          idempotency_key: runIdempotencyKey(selected.definition_id, "SCHEDULE"),
        },
      });
      if (!response.data) throw new ApiCallError(response.response.status, response.error);
      if (!isActive()) return;
      await loadSchedules();
    } catch (caught) {
      if (!isActive()) return;
      setError(errorMessage(caught));
    } finally {
      if (isActive()) setPendingId(undefined);
    }
  }, [api, isActive, loadSchedules, pendingId, selected]);

  const revise = useCallback(
    async (action: "approve" | "withdraw") => {
      if (!selectedDefinition?.pending_version || pendingId) return;
      if (
        action === "approve" &&
        session?.user_id &&
        selectedDefinition.pending_staged_by?.toLowerCase() ===
          session.user_id.toLowerCase()
      ) {
        setError("자신이 올린 개정은 승인할 수 없습니다.");
        return;
      }
        setPendingId(selected?.id);
      setError(undefined);
      try {
        const stepUp = action === "approve" ? await assertPasskeyStepUp(api) : undefined;
        if (!isActive()) return;
        const params = {
          path: { id: selectedDefinition.id, rev: selectedDefinition.pending_version },
        };
        const response =
          action === "approve"
            ? await api.POST(
                "/api/v1/workflow-studio/definitions/{id}/revisions/{rev}/approve",
                { ...params, body: { step_up: stepUp } },
              )
            : await api.POST(
                "/api/v1/workflow-studio/definitions/{id}/revisions/{rev}/withdraw",
              params,
              );
        if (!response.data) throw new ApiCallError(response.response.status, response.error);
        if (!isActive()) return;
        await loadSchedules();
      } catch (caught) {
        if (!isActive()) return;
        setError(errorMessage(caught));
      } finally {
        if (isActive()) setPendingId(undefined);
      }
    },
    [api, isActive, loadSchedules, pendingId, selected?.id, selectedDefinition, session],
  );

  const canViewSchedules = gate.can(ACTIONS.viewSchedules, {
    kind: "automate_tab",
    id: "schedules",
  });
  const canCreateSchedules = gate.can(ACTIONS.create, {
    kind: "workflow_schedule",
    id: "new",
  });
  const canUpdateSelected = selected
    ? gate.can(ACTIONS.edit, { kind: "workflow_schedule", id: selected.id })
    : false;
  const showScheduleForm = editing ? canUpdateSelected : canCreateSchedules;

  return (
    <section aria-labelledby="workflow-schedule-title" style={shell}>
      <header>
        <h1 id="workflow-schedule-title">예약 작업</h1>
        <p>
          예약의 주기, 실행 이력, 수동 실행은 durable schedule resource가
          담당합니다. 연결된 워크플로 정의의 개정은 이 예약에 연결된 정의에만
          적용됩니다.
        </p>
      </header>
      {!canViewSchedules ? (
        <p>접근 가능한 탭 없음</p>
      ) : (
        <>
          {error ? <p role="alert">{error}</p> : null}
          {showScheduleForm ? <form
            aria-label={editing ? "예약 작업 편집" : "예약 작업 추가"}
            style={card}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <h2>{editing ? "예약 작업 편집" : "예약 작업 추가"}</h2>
            <label>
              이름
              <input
                value={form.label}
                required
                onChange={(event) => {
                  const label = event.currentTarget.value;
                  setForm((current) => ({ ...current, label }));
                }}
              />
            </label>
            <label>
              크론
              <input
                value={form.cron_expr}
                required
                onChange={(event) => {
                  const cronExpr = event.currentTarget.value;
                  setForm((current) => ({ ...current, cron_expr: cronExpr }));
                }}
              />
            </label>
            <label>
              시간대
              <input
                value={form.timezone ?? "Asia/Seoul"}
                required
                onChange={(event) => {
                  const timezone = event.currentTarget.value;
                  setForm((current) => ({ ...current, timezone }));
                }}
              />
            </label>
            <label>
              연결된 워크플로 정의
              <select
                value={form.definition_id}
                disabled={editing}
                required
                onChange={(event) => {
                  const definitionId = event.currentTarget.value;
                  setForm((current) => ({ ...current, definition_id: definitionId }));
                }}
              >
                <option value="">워크플로 정의 선택</option>
                {definitions.map((definition) => (
                  <option key={definition.id} value={definition.id}>
                    {definition.display_name}
                  </option>
                ))}
              </select>
            </label>
            {editing ? (
              <p>실행 이력을 보존하기 위해 연결된 워크플로 정의는 변경할 수 없습니다.</p>
            ) : null}
            <div style={row}>
              <button type="submit" style={button} disabled={Boolean(pendingId)}>
                {editing ? "예약 변경 저장" : "예약 작업 추가"}
              </button>
              {editing ? (
                <button
                  type="button"
                  style={button}
                  onClick={() => {
                    setEditing(false);
                    setForm(INITIAL_FORM);
                  }}
                >
                  취소
                </button>
              ) : null}
            </div>
          </form> : null}
          <div style={grid}>
            <section aria-label="예약 목록" style={card}>
              <div style={row}>
                <h2>예약 목록</h2>
                <span>{scopedSchedules.length}개</span>
              </div>
              {loading ? <p>예약을 불러오는 중…</p> : null}
              {!loading && scopedSchedules.length === 0 ? (
                <p>현재 권한 범위에 예약 작업이 없습니다.</p>
              ) : null}
              {scopedSchedules.map((item) => (
                <PolicyGated
                  key={item.id}
                  action={ACTIONS.select}
                  resource={{ kind: "workflow_schedule", id: item.id }}
                >
                  <button
                    type="button"
                    aria-pressed={item.id === selected?.id}
                    aria-label={`${item.label} 선택`}
                    style={item.id === selected?.id ? selectedButton : button}
                    onClick={() => { setSelectedId(item.id); }}
                  >
                    {item.label} · {statusLabel(item)}
                  </button>
                </PolicyGated>
              ))}
            </section>
            <section aria-label="예약 상세" style={card}>
              {!selected ? (
                <p>예약을 선택하세요.</p>
              ) : (
                <>
                  <div style={row}>
                    <h2>{selected.label}</h2>
                    <strong>{statusLabel(selected)}</strong>
                  </div>
                  <dl>
                    <dt>크론</dt>
                    <dd>{selected.cron_expr}</dd>
                    <dt>시간대</dt>
                    <dd>{selected.timezone}</dd>
                    <dt>다음 실행</dt>
                    <dd>{formatTime(selected.next_run_at)}</dd>
                    <dt>마지막 실행</dt>
                    <dd>{formatTime(selected.last_run_at)}</dd>
                    <dt>마지막 결과</dt>
                    <dd>{statusTone(selected.last_status)}</dd>
                  </dl>
                  <PolicyGated
                    action={ACTIONS.toggle}
                    resource={{ kind: "workflow_schedule", id: selected.id }}
                  >
                    <button
                      type="button"
                      style={button}
                      disabled={pendingId === selected.id}
                      onClick={() => void toggle()}
                    >
                      {pendingId === selected.id
                        ? "예약 변경 중…"
                        : selected.enabled
                          ? "예약 비활성화"
                          : "예약 활성화"}
                    </button>
                  </PolicyGated>
                  <PolicyGated
                    action={ACTIONS.edit}
                    resource={{ kind: "workflow_schedule", id: selected.id }}
                  >
                    <button type="button" style={button} onClick={startEdit}>
                      예약 편집
                    </button>
                  </PolicyGated>
                  <PolicyGated
                    action={ACTIONS.run}
                    resource={{ kind: "workflow_schedule", id: selected.id }}
                  >
                    <button
                      type="button"
                      style={button}
                      disabled={pendingId === selected.id}
                      onClick={() => void runNow()}
                    >
                      지금 실행
                    </button>
                  </PolicyGated>
                  {selectedDefinition?.pending_version ? (
                    <div style={row}>
                      <span>연결된 정의 개정 {selectedDefinition.pending_version}</span>
                      <PolicyGated
                        action={ACTIONS.approveRevision}
                        resource={{ kind: "workflow_schedule", id: selected.id }}
                      >
                        <button type="button" style={button} onClick={() => void revise("approve")}>
                          개정 승인
                        </button>
                      </PolicyGated>
                      <PolicyGated
                        action={ACTIONS.withdrawRevision}
                        resource={{ kind: "workflow_schedule", id: selected.id }}
                      >
                        <button type="button" style={button} onClick={() => void revise("withdraw")}>
                          개정 철회
                        </button>
                      </PolicyGated>
                    </div>
                  ) : null}
                  <section aria-labelledby="workflow-schedule-preview">
                    <h3 id="workflow-schedule-preview">다음 실행 미리보기</h3>
                    {preview.length ? (
                      <ol>
                        {preview.map((time) => (
                          <li key={time}>{time}</li>
                        ))}
                      </ol>
                    ) : (
                      <p>예정된 실행이 없습니다.</p>
                    )}
                  </section>
                  <section aria-labelledby="workflow-schedule-history">
                    <h3 id="workflow-schedule-history">실행 이력</h3>
                    {runs.length ? (
                      <ol>
                        {runs.map((run) => (
                          <li key={run.run_id}>
                            {run.status} · {run.started_at} · 정의 v
                            {run.definition_version}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p>실행 기록 없음</p>
                    )}
                  </section>
                </>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}
