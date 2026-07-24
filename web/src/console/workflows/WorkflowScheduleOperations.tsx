import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { ApiCallError } from "../../api/ontologyActions";
import { useAuth } from "../../context/auth";
import { PolicyGated, usePolicyGate } from "../policy";
import "../tokens.css";
import {
  listScheduleRuns,
  listWorkflowSchedules,
  previewWorkflowSchedule,
  updateWorkflowSchedule,
  type WorkflowSchedule,
  type WorkflowScheduleRun,
} from "./scheduleApi";

const ACTIONS = {
  viewRules: "console.automate.tab.rules.view",
  viewSchedules: "console.automate.tab.schedules.view",
  viewMonitors: "console.automate.tab.monitors.view",
  select: "console.automate.schedule.select",
  update: "console.automate.schedule.toggle",
} as const;

type AutomationTab = "rules" | "schedules" | "monitors";

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
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  boxShadow: "var(--shadow)",
};
const button: CSSProperties = {
  minHeight: 36,
  padding: "0 var(--sp-4)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
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
export function WorkflowScheduleOperations({
  onTabChange,
}: {
  onTabChange?: (tab: AutomationTab) => void;
}) {
  const { api, session } = useAuth();
  const gate = usePolicyGate();
  const [schedules, setSchedules] = useState<WorkflowSchedule[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [runs, setRuns] = useState<WorkflowScheduleRun[]>([]);
  const [preview, setPreview] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string>();
  const [error, setError] = useState<string>();
  const scheduleRequest = useRef(0);
  const detailRequest = useRef(0);

  const loadSchedules = useCallback(
    async (signal?: AbortSignal) => {
      const request = ++scheduleRequest.current;
      setLoading(true);
      try {
        const next = await listWorkflowSchedules(api, signal);
        if (request !== scheduleRequest.current || signal?.aborted) return;
        setSchedules(next);
        setSelectedId((current) =>
          current && next.some((item) => item.id === current)
            ? current
            : next[0]?.id,
        );
        setError(undefined);
      } catch (caught) {
        if (signal?.aborted || request !== scheduleRequest.current) return;
        setError(errorMessage(caught));
      } finally {
        if (request === scheduleRequest.current && !signal?.aborted)
          setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadSchedules(controller.signal);
    return () => controller.abort();
  }, [loadSchedules, session?.access_token, session?.org_id]);

  const selected = schedules.find((item) => item.id === selectedId);

  useEffect(() => {
    if (!selected) {
      setRuns([]);
      setPreview([]);
      return;
    }
    const controller = new AbortController();
    const request = ++detailRequest.current;
    void Promise.all([
      previewWorkflowSchedule(
        api,
        selected.cron_expr,
        selected.timezone,
        controller.signal,
      ),
      listScheduleRuns(api, selected.id, controller.signal),
    ])
      .then(([nextPreview, nextRuns]) => {
        if (controller.signal.aborted || request !== detailRequest.current)
          return;
        setPreview(nextPreview.fire_times);
        setRuns(nextRuns);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || request !== detailRequest.current)
          return;
        setError(errorMessage(caught));
      });
    return () => controller.abort();
  }, [
    api,
    selected?.id,
    selected?.cron_expr,
    selected?.timezone,
    session?.access_token,
    session?.org_id,
  ]);

  const toggle = useCallback(async () => {
    if (
      !selected ||
      pendingId ||
      !gate.can(ACTIONS.update, { kind: "workflow_schedule", id: selected.id })
    )
      return;
    setPendingId(selected.id);
    setError(undefined);
    try {
      const updated = await updateWorkflowSchedule(api, selected.id, {
        enabled: !selected.enabled,
      });
      setSchedules((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      // Read again after the mutation; the backend remains the lifecycle authority.
      await loadSchedules();
    } catch (caught) {
      await loadSchedules();
      setError(errorMessage(caught));
    } finally {
      setPendingId(undefined);
    }
  }, [api, gate, loadSchedules, pendingId, selected]);

  const canViewSchedules = gate.can(ACTIONS.viewSchedules, {
    kind: "automate_tab",
    id: "schedules",
  });

  return (
    <main aria-labelledby="workflow-schedule-title" style={shell}>
      <header>
        <h1 id="workflow-schedule-title">예약 작업</h1>
        <div role="tablist" aria-label="자동화 허브 탭" style={row}>
          {gate.can(ACTIONS.viewRules, {
            kind: "automate_tab",
            id: "rules",
          }) ? (
            <button
              type="button"
              role="tab"
              aria-selected="false"
              style={button}
              onClick={() => onTabChange?.("rules")}
            >
              워크플로
            </button>
          ) : null}
          {canViewSchedules ? (
            <button
              type="button"
              role="tab"
              aria-selected="true"
              style={selectedButton}
            >
              예약
            </button>
          ) : null}
          {gate.can(ACTIONS.viewMonitors, {
            kind: "automate_tab",
            id: "monitors",
          }) ? (
            <button
              type="button"
              role="tab"
              aria-selected="false"
              style={button}
              onClick={() => onTabChange?.("monitors")}
            >
              분석·감시
            </button>
          ) : null}
        </div>
        <p>
          테넌트 권한으로 조회된 워크플로 예약의 실행 주기와 이력을 확인하고
          활성 상태를 변경합니다.
        </p>
      </header>
      {!canViewSchedules ? (
        <p>접근 가능한 탭 없음</p>
      ) : (
        <>
          {error ? <p role="alert">{error}</p> : null}
          <div style={grid}>
            <section aria-label="예약 목록" style={card}>
              <div style={row}>
                <h2>예약 목록</h2>
                <span>{schedules.length}개</span>
              </div>
              {loading ? <p>예약을 불러오는 중…</p> : null}
              {!loading && schedules.length === 0 ? (
                <p>현재 권한 범위에 예약 작업이 없습니다.</p>
              ) : null}
              {schedules.map((item) => (
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
                    onClick={() => setSelectedId(item.id)}
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
                    action={ACTIONS.update}
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
    </main>
  );
}
