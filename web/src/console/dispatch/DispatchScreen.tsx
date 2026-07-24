import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { ConsoleApiClient } from "../../api/client";
import { dispatchStrings as text } from "../../i18n/dispatch";
import { StatusChip } from "../components";
import {
  createDispatchApi,
  type DispatchApi,
  type DispatchAuditRecord,
  type DispatchCandidate,
  type DispatchLinkKind,
  type DispatchPriority,
  type DispatchQueueItem,
  type DispatchResponseSummary,
  type ObjectHead,
} from "./dispatchApi";
import type { DispatchCapabilities } from "./dispatchCapabilities";
import "./dispatch.css";

type Props = {
  api: ConsoleApiClient;
  /** Present only when the mount contract pins one branch; the queue itself is branch-scoped in SQL. */
  branchId?: string;
  actorId: string | undefined;
  capabilities: DispatchCapabilities;
  /** Changes whenever auth replaces the effective tenant/session. */
  sessionKey: string | undefined;
};

const apiFenceIds = new WeakMap<object, number>();
let nextApiFenceId = 1;

function apiFenceKey(api: ConsoleApiClient): number {
  const reference = api as object;
  const existing = apiFenceIds.get(reference);
  if (existing) return existing;
  const id = nextApiFenceId++;
  apiFenceIds.set(reference, id);
  return id;
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

/** Contractual SLA proximity window (design: 1-hour P1 SLA lens). */
const SLA_IMMINENT_MINUTES = 60;

type ChipTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent" | "purple";

function statusLabel(status: string): string {
  if (status in text.woStatus) return text.woStatus[status as keyof typeof text.woStatus];
  return text.woStatus.unknown;
}

function dispatchStatusLabel(status: string): string {
  if (status in text.dispatchStatus) {
    return text.dispatchStatus[status as keyof typeof text.dispatchStatus];
  }
  return status;
}

function priorityLabel(priority: DispatchPriority): string | undefined {
  if (priority === "UNSET") return undefined;
  return text.priority[priority];
}

function priorityTone(priority: DispatchPriority): ChipTone {
  if (priority === "P1") return "danger";
  if (priority === "OUTSOURCE") return "purple";
  return "info";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function clock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Deterministic `M/D HH:MM` — locale-independent so tests and UI agree. */
function stamp(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getMonth() + 1)}/${String(date.getDate())} ${clock(date)}`;
}

function calendarDays(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / 86400000);
}

interface DueChip {
  label: string;
  tone: ChipTone;
  imminent: boolean;
}

function dueChip(item: DispatchQueueItem, now: Date): DueChip {
  const assigned = Boolean(item.assigned_mechanic_id);
  if (!item.target_due_at) {
    return { label: text.due.unset, tone: assigned ? "ok" : "neutral", imminent: false };
  }
  const due = new Date(item.target_due_at);
  const diffMs = due.getTime() - now.getTime();
  if (diffMs <= 0) return { label: text.due.overdue, tone: "danger", imminent: true };
  const minutes = Math.ceil(diffMs / 60000);
  if (minutes <= SLA_IMMINENT_MINUTES) {
    return {
      label: text.due.slaMinutes(minutes),
      tone: assigned ? "warn" : "danger",
      imminent: true,
    };
  }
  const days = calendarDays(now, due);
  const base = days === 0 ? text.due.today(clock(due))
    : days === 1 ? text.due.tomorrow(clock(due))
    : text.due.dDay(days);
  const label = assigned ? `${base} ${text.due.assignedSuffix}` : base;
  return { label, tone: assigned ? "ok" : "warn", imminent: false };
}

/** 접수 → 계획·부품예약 → 실행 → 정산 → 전표 (absent for statuses off the chain). */
const FLOW_STAGE: Partial<Record<string, number>> = {
  RECEIVED: 0,
  UNASSIGNED: 0,
  ASSIGNED: 1,
  PART_WAITING: 1,
  DELAYED: 1,
  IN_PROGRESS: 2,
  TEMPORARY_ACTION: 2,
  EQUIPMENT_IN_USE: 2,
  REVISIT_REQUIRED: 2,
  REPORT_SUBMITTED: 3,
  ADMIN_REVIEW: 3,
  FINAL_COMPLETED: 4,
  ARCHIVED: 4,
};

const FLOW_STEPS = [
  text.flow.received,
  text.flow.plan,
  text.flow.execute,
  text.flow.settle,
  text.flow.voucher,
] as const;

type SectionState<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; items: T[] };

/** A panel layer's resolved data, pinned to the dispatch it was fetched for. */
interface KeyedSection<T> {
  dispatchId: string;
  state: SectionState<T>;
}

function sectionView<T>(
  allowed: boolean,
  dispatchId: string | undefined,
  keyed: KeyedSection<T> | undefined,
): SectionState<T> | undefined {
  if (!allowed || !dispatchId) return undefined;
  return keyed && keyed.dispatchId === dispatchId ? keyed.state : { status: "loading" };
}

interface QueueFilter {
  unassignedOnly: boolean;
  imminentOnly: boolean;
  priority?: DispatchPriority;
}

const NO_FILTER: QueueFilter = { unassignedOnly: false, imminentOnly: false };

interface PeekTarget {
  kind: DispatchLinkKind;
  id: string;
}

type PeekState =
  | { status: "loading"; target: PeekTarget }
  | { status: "absent"; target: PeekTarget }
  | { status: "error"; target: PeekTarget }
  | { status: "ready"; target: PeekTarget; head: ObjectHead };

/**
 * Re-mount synchronously whenever effective authority changes. Effects run too
 * late to fence an old tenant/session's selection, drafts, or busy state.
 */
export function DispatchScreen(props: Props) {
  const capabilityKey = Object.values(props.capabilities).join(":");
  const sessionFence = [
    props.sessionKey ?? "no-session",
    props.branchId ?? "all-branches",
    props.actorId ?? "no-actor",
    apiFenceKey(props.api),
    capabilityKey,
  ].join(":");
  return <DispatchScreenBody key={sessionFence} {...props} />;
}

function DispatchScreenBody({ api, branchId, capabilities, sessionKey }: Props) {
  const [items, setItems] = useState<DispatchQueueItem[]>([]);
  const [nextAfter, setNextAfter] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<QueueFilter>(NO_FILTER);
  const [roster, setRoster] = useState<Map<string, string>>();
  const [candidates, setCandidates] = useState<KeyedSection<DispatchCandidate>>();
  const [responses, setResponses] = useState<KeyedSection<DispatchResponseSummary>>();
  const [history, setHistory] = useState<KeyedSection<DispatchAuditRecord>>();
  const [picked, setPicked] = useState<{ dispatchId: string; mechanicId: string }>();
  const [peek, setPeek] = useState<PeekState>();
  const generation = useRef(0);
  const operation = useRef<AbortController | undefined>(undefined);
  const listRef = useRef<HTMLUListElement | null>(null);
  const dispatchApi: DispatchApi = useMemo(() => createDispatchApi(api), [api]);
  const now = new Date();

  const isCurrent = useCallback((token: number) => generation.current === token, []);

  const load = useCallback(async () => {
    if (!capabilities.canRead) {
      setItems([]);
      setSelectedId(undefined);
      setLoading(false);
      return;
    }
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const token = ++generation.current;
    setLoading(true);
    setError(undefined);
    try {
      const page = await dispatchApi.queue({}, controller.signal);
      if (isCurrent(token)) {
        setItems(branchId ? page.items.filter((item) => item.branch_id === branchId) : page.items);
        setNextAfter(page.next_after);
      }
    } catch (cause) {
      if (isCurrent(token) && !controller.signal.aborted) setError(message(cause, text.loadError));
    } finally {
      if (isCurrent(token)) setLoading(false);
    }
  }, [branchId, capabilities.canRead, dispatchApi, isCurrent]);

  const loadMore = useCallback(async () => {
    if (!nextAfter || !capabilities.canRead) return;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const token = ++generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const page = await dispatchApi.queue({ after: nextAfter }, controller.signal);
      if (isCurrent(token)) {
        const fresh = branchId
          ? page.items.filter((item) => item.branch_id === branchId)
          : page.items;
        setItems((current) => {
          const known = new Set(current.map((item) => item.work_order_id));
          return [...current, ...fresh.filter((item) => !known.has(item.work_order_id))];
        });
        setNextAfter(page.next_after);
      }
    } catch (cause) {
      if (isCurrent(token) && !controller.signal.aborted) setError(message(cause, text.loadError));
    } finally {
      if (isCurrent(token)) setBusy(false);
    }
  }, [branchId, capabilities.canRead, dispatchApi, isCurrent, nextAfter]);

  useEffect(() => {
    generation.current += 1;
    operation.current?.abort();
    const start = window.setTimeout(() => {
      void load();
    }, 0);
    return () => {
      window.clearTimeout(start);
      operation.current?.abort();
    };
  }, [branchId, load, sessionKey]);

  /** Roster read is name-resolution only — a denial silently keeps raw ids. */
  useEffect(() => {
    if (!capabilities.canRead) return;
    const controller = new AbortController();
    void dispatchApi
      .users(controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        const names = new Map<string, string>();
        for (const user of page.items) names.set(user.id, user.display_name);
        setRoster(names);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [capabilities.canRead, dispatchApi]);

  const selected = items.find((item) => item.work_order_id === selectedId);
  const selectedDispatchId = selected?.dispatch?.id;

  /**
   * Per-dispatch panel layers: candidates / responses / history. Results are
   * keyed to their dispatch id, so a stale layer never renders under a newer
   * selection and the effect writes no synchronous state.
   */
  useEffect(() => {
    if (!selectedDispatchId) return;
    const controller = new AbortController();
    const arm = <T,>(
      allowed: boolean,
      set: (keyed: KeyedSection<T>) => void,
      fetchItems: () => Promise<T[]>,
    ) => {
      if (!allowed) return;
      void fetchItems()
        .then((list) => {
          if (!controller.signal.aborted) {
            set({ dispatchId: selectedDispatchId, state: { status: "ready", items: list } });
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            set({ dispatchId: selectedDispatchId, state: { status: "error" } });
          }
        });
    };
    arm(capabilities.canAssign, setCandidates, async () => {
      const page = await dispatchApi.candidates(selectedDispatchId, controller.signal);
      return page.items;
    });
    arm(capabilities.canRead, setResponses, async () => {
      const page = await dispatchApi.responses(selectedDispatchId, controller.signal);
      return page.items;
    });
    arm(capabilities.canReadHistory, setHistory, async () =>
      dispatchApi.history(selectedDispatchId, controller.signal),
    );
    return () => {
      controller.abort();
    };
  }, [capabilities.canAssign, capabilities.canRead, capabilities.canReadHistory, dispatchApi, selectedDispatchId]);

  /** Object peek resolve — 403/404 render as the same absent state (no leakage). */
  useEffect(() => {
    if (!peek || peek.status !== "loading") return;
    const controller = new AbortController();
    const target = peek.target;
    void dispatchApi
      .resolveObject(target.kind, target.id, controller.signal)
      .then((head) => {
        if (controller.signal.aborted) return;
        setPeek(head.exists ? { status: "ready", target, head } : { status: "absent", target });
      })
      .catch(() => {
        if (!controller.signal.aborted) setPeek({ status: "absent", target });
      });
    return () => {
      controller.abort();
    };
  }, [dispatchApi, peek]);

  const crewName = useCallback(
    (mechanicId: string | undefined | null): string | undefined => {
      if (!mechanicId) return undefined;
      return roster?.get(mechanicId) ?? mechanicId;
    },
    [roster],
  );

  const mutate = useCallback(
    async (work: (signal: AbortSignal) => Promise<string | undefined>) => {
      operation.current?.abort();
      const controller = new AbortController();
      operation.current = controller;
      const token = ++generation.current;
      setBusy(true);
      setError(undefined);
      setNotice(undefined);
      try {
        const result = await work(controller.signal);
        if (isCurrent(token)) {
          if (result) setNotice(result);
          await load();
        }
      } catch (cause) {
        if (isCurrent(token) && !controller.signal.aborted) {
          setError(message(cause, text.actionError));
        }
      } finally {
        if (isCurrent(token)) setBusy(false);
      }
    },
    [isCurrent, load],
  );

  const requestDispatch = useCallback(async () => {
    if (!selected || !capabilities.canRequest) return;
    const code = selected.request_no;
    await mutate(async (signal) => {
      await dispatchApi.startDispatch(selected.work_order_id, signal);
      return text.actions.requested(code);
    });
  }, [capabilities.canRequest, dispatchApi, mutate, selected]);

  /** The pick is only valid for the dispatch it was made on — fail closed otherwise. */
  const pickedMechanicId =
    picked && picked.dispatchId === selectedDispatchId ? picked.mechanicId : undefined;

  const confirmAssign = useCallback(async () => {
    if (!selected || !selectedDispatchId || !pickedMechanicId || !capabilities.canAssign) return;
    const code = selected.request_no;
    const name = crewName(pickedMechanicId) ?? pickedMechanicId;
    await mutate(async (signal) => {
      await dispatchApi.forceAssign(selectedDispatchId, pickedMechanicId, signal);
      return text.actions.assigned(code, name);
    });
  }, [capabilities.canAssign, crewName, dispatchApi, mutate, pickedMechanicId, selected, selectedDispatchId]);

  const onListKeyDown = useCallback((event: KeyboardEvent<HTMLUListElement>) => {
    const key = event.key;
    const forward = key === "j" || key === "ArrowDown";
    const backward = key === "k" || key === "ArrowUp";
    if (!forward && !backward) return;
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("[data-dispatch-row]") ?? [],
    );
    if (!rows.length) return;
    const index = rows.findIndex((row) => row === document.activeElement);
    const next = index === -1 ? 0 : Math.min(Math.max(index + (forward ? 1 : -1), 0), rows.length - 1);
    rows[next]?.focus();
    event.preventDefault();
  }, []);

  const query = search.trim().toLowerCase();
  const visible = items.filter((item) => {
    if (filter.unassignedOnly && item.assigned_mechanic_id) return false;
    if (filter.imminentOnly && !dueChip(item, now).imminent) return false;
    if (filter.priority && item.priority !== filter.priority) return false;
    if (!query) return true;
    const crew = crewName(item.assigned_mechanic_id) ?? "";
    return `${item.request_no} ${item.symptom} ${crew}`.toLowerCase().includes(query);
  });
  const unassignedCount = items.filter((item) => !item.assigned_mechanic_id).length;
  const imminentCount = items.filter((item) => dueChip(item, now).imminent).length;
  const presentPriorities = [...new Set(items.map((item) => item.priority))].filter(
    (priority): priority is Exclude<DispatchPriority, "UNSET"> => priority !== "UNSET",
  );
  const candidatesView = sectionView(capabilities.canAssign, selectedDispatchId, candidates);
  const responsesView = sectionView(capabilities.canRead, selectedDispatchId, responses);
  const historyView = sectionView(capabilities.canReadHistory, selectedDispatchId, history);
  const availableCrewCount =
    candidatesView?.status === "ready"
      ? candidatesView.items.filter((candidate) => candidate.response !== "DECLINE").length
      : undefined;
  const filtered =
    filter.unassignedOnly || filter.imminentOnly || Boolean(filter.priority) || query.length > 0;
  const canRequestSelected =
    capabilities.canRequest && Boolean(selected) && !selected?.dispatch && !selected?.assigned_mechanic_id;
  const assignOpen =
    capabilities.canAssign && Boolean(selected?.dispatch) && selected?.dispatch?.status !== "AUTO_ASSIGNED";

  if (!capabilities.canRead) {
    return (
      <main className="dispatch">
        <section className="dispatch__list-zone" aria-labelledby="dispatch-title">
          <h1 id="dispatch-title">{text.title}</h1>
          <p role="status">{text.denied}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="dispatch" aria-busy={loading || busy}>
      <section className="dispatch__list-zone" aria-labelledby="dispatch-title">
        <div className="dispatch__toolbar">
          <h1 id="dispatch-title">{text.title}</h1>
          <div className="dispatch__stats" role="group" aria-label={text.statsLabel}>
            <button
              className="dispatch__stat"
              type="button"
              aria-pressed={filter.unassignedOnly}
              aria-label={`${text.stats.unassigned} ${String(unassignedCount)}`}
              onClick={() => { setFilter((f) => ({ ...f, unassignedOnly: !f.unassignedOnly })); }}
            >
              <span>{text.stats.unassigned}</span>
              <strong className="dispatch__stat-danger">{unassignedCount}</strong>
            </button>
            <button
              className="dispatch__stat"
              type="button"
              aria-pressed={filter.imminentOnly}
              aria-label={`${text.stats.slaImminent} ${String(imminentCount)}`}
              onClick={() => { setFilter((f) => ({ ...f, imminentOnly: !f.imminentOnly })); }}
            >
              <span>{text.stats.slaImminent}</span>
              <strong className="dispatch__stat-danger">{imminentCount}</strong>
            </button>
            {availableCrewCount !== undefined && (
              <span className="dispatch__stat">
                <span>{text.stats.availableCrew}</span>
                <strong>{availableCrewCount}</strong>
              </span>
            )}
          </div>
          <input
            className="dispatch__search"
            type="search"
            aria-label={text.searchLabel}
            placeholder={text.searchPlaceholder}
            value={search}
            onChange={(event) => { setSearch(event.target.value); }}
          />
          {capabilities.canRequest && (
            <button
              className="dispatch__primary"
              type="button"
              disabled={!canRequestSelected || busy}
              onClick={() => void requestDispatch()}
            >
              {text.actions.requestDispatch}
            </button>
          )}
        </div>
        {presentPriorities.length > 0 && (
          <div className="dispatch__filters" role="group" aria-label={text.filtersLabel}>
            {presentPriorities.map((priority) => (
              <button
                key={priority}
                className="dispatch__filter"
                type="button"
                aria-pressed={filter.priority === priority}
                onClick={() => {
                  setFilter((f) => ({
                    ...f,
                    priority: f.priority === priority ? undefined : priority,
                  }));
                }}
              >
                {text.priority[priority]}
              </button>
            ))}
          </div>
        )}
        {error && (
          <div className="dispatch__alert" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => { void load(); }}>{text.retry}</button>
          </div>
        )}
        {notice && <p className="dispatch__notice" role="status">{notice}</p>}
        {loading ? (
          <p role="status">{text.loading}</p>
        ) : (
          <>
            <div className="dispatch__cols" aria-hidden="true">
              <span>{text.cols.order}</span>
              <span>{text.cols.work}</span>
              <span>{text.cols.crew}</span>
              <span>{text.cols.due}</span>
            </div>
            <ul
              className="dispatch__queue"
              aria-label={text.queueLabel}
              ref={listRef}
              onKeyDown={onListKeyDown}
            >
              {visible.length ? (
                visible.map((item) => {
                  const due = dueChip(item, now);
                  const crew = crewName(item.assigned_mechanic_id);
                  const type = priorityLabel(item.priority);
                  return (
                    <li key={item.work_order_id}>
                      <button
                        className={
                          item.work_order_id === selectedId
                            ? "dispatch__row dispatch__row--selected"
                            : "dispatch__row"
                        }
                        type="button"
                        data-dispatch-row
                        aria-pressed={item.work_order_id === selectedId}
                        onClick={() => { setSelectedId(item.work_order_id); }}
                      >
                        <span className="dispatch__code">{item.request_no}</span>
                        <span className="dispatch__work">
                          <span className="dispatch__symptom">{item.symptom}</span>
                          <span className="dispatch__row-chips">
                            {type && <StatusChip tone={priorityTone(item.priority)}>{type}</StatusChip>}
                            <StatusChip tone="neutral">{statusLabel(item.status)}</StatusChip>
                            {item.dispatch && (
                              <StatusChip tone={item.dispatch.status === "AUTO_ASSIGNED" ? "ok" : "info"}>
                                {dispatchStatusLabel(item.dispatch.status)}
                              </StatusChip>
                            )}
                          </span>
                        </span>
                        <span className="dispatch__crew">
                          {crew ?? <StatusChip tone="danger">{text.unassigned}</StatusChip>}
                        </span>
                        <span className="dispatch__due">
                          <StatusChip tone={due.tone}>{due.label}</StatusChip>
                        </span>
                      </button>
                    </li>
                  );
                })
              ) : (
                <li className="dispatch__empty" role="status">
                  {filtered ? text.emptyFiltered : text.empty}
                </li>
              )}
            </ul>
            {nextAfter && (
              <button
                className="dispatch__more"
                type="button"
                disabled={busy}
                onClick={() => void loadMore()}
              >
                {text.loadMore}
              </button>
            )}
          </>
        )}
      </section>
      <section className="dispatch__panel" aria-label={text.panel.label} aria-live="polite">
        {!selected ? (
          <p>{text.panel.select}</p>
        ) : (
          <>
            <header className="dispatch__panel-head">
              <h2 className="dispatch__code">{selected.request_no}</h2>
              <span className="dispatch__row-chips">
                {priorityLabel(selected.priority) && (
                  <StatusChip tone={priorityTone(selected.priority)}>
                    {priorityLabel(selected.priority)}
                  </StatusChip>
                )}
                <StatusChip tone="neutral">{statusLabel(selected.status)}</StatusChip>
                {selected.dispatch && (
                  <StatusChip tone={selected.dispatch.status === "AUTO_ASSIGNED" ? "ok" : "info"}>
                    {dispatchStatusLabel(selected.dispatch.status)}
                  </StatusChip>
                )}
              </span>
            </header>
            <p className="dispatch__symptom">{selected.symptom}</p>
            {FLOW_STAGE[selected.status] !== undefined && (
              <ol className="dispatch__flow" aria-label={text.flow.label}>
                {FLOW_STEPS.map((step, index) => {
                  const stage = FLOW_STAGE[selected.status] ?? 0;
                  const state = index < stage ? "done" : index === stage ? "cur" : "next";
                  return (
                    <li
                      key={step}
                      className={
                        state === "done"
                          ? "dispatch__flow-step dispatch__flow-step--done"
                          : state === "cur"
                            ? "dispatch__flow-step dispatch__flow-step--cur"
                            : "dispatch__flow-step"
                      }
                      aria-current={state === "cur" ? "step" : undefined}
                    >
                      {step}
                    </li>
                  );
                })}
              </ol>
            )}
            <dl className="dispatch__kv">
              <dt>{text.panel.due}</dt>
              <dd>{selected.target_due_at ? stamp(selected.target_due_at) : text.due.unset}</dd>
              <dt>{text.panel.updated}</dt>
              <dd>{stamp(selected.updated_at)}</dd>
            </dl>
            <div className="dispatch__links" role="group" aria-label={text.panel.linksLabel}>
              <button
                className="dispatch__link"
                type="button"
                onClick={() => {
                  setPeek({ status: "loading", target: { kind: "work_order", id: selected.work_order_id } });
                }}
              >
                <span>{text.panel.workOrder}</span>
                <span className="dispatch__code">{selected.request_no}</span>
              </button>
              <button
                className="dispatch__link"
                type="button"
                onClick={() => {
                  setPeek({ status: "loading", target: { kind: "equipment", id: selected.equipment_id } });
                }}
              >
                <span>{text.panel.equipment}</span>
              </button>
              {selected.assigned_mechanic_id && (
                <button
                  className="dispatch__link"
                  type="button"
                  onClick={() => {
                    setPeek({
                      status: "loading",
                      target: { kind: "person", id: selected.assigned_mechanic_id ?? "" },
                    });
                  }}
                >
                  <span>{text.panel.crew}</span>
                  <span>{crewName(selected.assigned_mechanic_id)}</span>
                </button>
              )}
            </div>
            {selected.dispatch && (
              <section className="dispatch__section" aria-label={text.broadcast.title}>
                <h3>{text.broadcast.title}</h3>
                <div className="dispatch__row-chips">
                  <StatusChip tone="neutral">{text.broadcast.targets(selected.dispatch.target_count)}</StatusChip>
                  <StatusChip tone="ok">{text.broadcast.accepted(selected.dispatch.accepted_count)}</StatusChip>
                  <StatusChip tone="warn">{text.broadcast.declined(selected.dispatch.declined_count)}</StatusChip>
                  <StatusChip tone="neutral">
                    {text.broadcast.windowEndsAt(stamp(selected.dispatch.accept_window_ends_at))}
                  </StatusChip>
                  {selected.dispatch.manual_call_required && (
                    <StatusChip tone="danger">{text.broadcast.manualCallRequired}</StatusChip>
                  )}
                </div>
                {selected.dispatch.status === "AUTO_ASSIGNED" && selected.assigned_mechanic_id && (
                  <StatusChip tone="ok" role="status">
                    {text.broadcast.assignedDone(crewName(selected.assigned_mechanic_id) ?? "")}
                  </StatusChip>
                )}
              </section>
            )}
            {assignOpen && candidatesView && (
              <section className="dispatch__section" aria-label={text.candidates.title}>
                <h3>{text.candidates.title}</h3>
                {candidatesView.status === "loading" && <p role="status">{text.candidates.loading}</p>}
                {candidatesView.status === "error" && <p role="alert">{text.candidates.error}</p>}
                {candidatesView.status === "ready" && (
                  candidatesView.items.length ? (
                    <>
                      <div className="dispatch__candidates" role="radiogroup" aria-label={text.candidates.title}>
                        {candidatesView.items.map((candidate) => {
                          const workloadTotal =
                            candidate.workload.p1 + candidate.workload.p2 +
                            candidate.workload.p3 + candidate.workload.other;
                          return (
                            <label key={candidate.mechanic_id} className="dispatch__candidate">
                              <input
                                type="radio"
                                name="dispatch-candidate"
                                value={candidate.mechanic_id}
                                checked={pickedMechanicId === candidate.mechanic_id}
                                disabled={busy || candidate.response === "DECLINE"}
                                onChange={() => {
                                  if (selectedDispatchId) {
                                    setPicked({
                                      dispatchId: selectedDispatchId,
                                      mechanicId: candidate.mechanic_id,
                                    });
                                  }
                                }}
                              />
                              <span className="dispatch__candidate-name">
                                {crewName(candidate.mechanic_id)}
                              </span>
                              <span className="dispatch__row-chips">
                                {candidate.gps_ranked && candidate.distance_meters !== undefined ? (
                                  <StatusChip tone="info">
                                    {text.candidates.distanceKm((candidate.distance_meters / 1000).toFixed(1))}
                                  </StatusChip>
                                ) : (
                                  <StatusChip tone="neutral">{text.candidates.scheduleBased}</StatusChip>
                                )}
                                <StatusChip tone="neutral">{text.candidates.workload(workloadTotal)}</StatusChip>
                                {candidate.response === "ACCEPT" && (
                                  <StatusChip tone="ok">{text.responses.accept}</StatusChip>
                                )}
                                {candidate.response === "DECLINE" && (
                                  <StatusChip tone="warn">{text.responses.decline}</StatusChip>
                                )}
                              </span>
                              <span className="dispatch__candidate-note">{candidate.score_reason}</span>
                            </label>
                          );
                        })}
                      </div>
                      <button
                        className="dispatch__primary"
                        type="button"
                        disabled={!pickedMechanicId || busy}
                        onClick={() => void confirmAssign()}
                      >
                        {text.actions.confirmAssign}
                      </button>
                    </>
                  ) : (
                    <p role="status">{text.candidates.empty}</p>
                  )
                )}
              </section>
            )}
            {selected.dispatch && responsesView && (
              <section className="dispatch__section" aria-label={text.responses.title}>
                <h3>{text.responses.title}</h3>
                {responsesView.status === "loading" && <p role="status">{text.loading}</p>}
                {responsesView.status === "error" && <p role="alert">{text.responses.error}</p>}
                {responsesView.status === "ready" && (
                  responsesView.items.length ? (
                    <ul className="dispatch__log">
                      {responsesView.items.map((response) => (
                        <li key={`${response.user_id}-${response.responded_at}`}>
                          <span>{crewName(response.user_id)}</span>
                          <StatusChip tone={response.response === "ACCEPT" ? "ok" : "warn"}>
                            {response.response === "ACCEPT" ? text.responses.accept : text.responses.decline}
                          </StatusChip>
                          <span className="dispatch__time">{stamp(response.responded_at)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p role="status">{text.responses.empty}</p>
                  )
                )}
              </section>
            )}
            {selected.dispatch && historyView && (
              <section className="dispatch__section" aria-label={text.history.title}>
                <h3>{text.history.title}</h3>
                {historyView.status === "loading" && <p role="status">{text.loading}</p>}
                {historyView.status === "error" && <p role="alert">{text.history.error}</p>}
                {historyView.status === "ready" && (
                  historyView.items.length ? (
                    <ul className="dispatch__log">
                      {historyView.items.map((record) => (
                        <li key={record.id}>
                          <span>{record.actor ? crewName(record.actor) : text.history.systemActor}</span>
                          <span>{record.action}</span>
                          <span className="dispatch__time">{stamp(record.occurred_at)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p role="status">{text.history.empty}</p>
                  )
                )}
              </section>
            )}
          </>
        )}
      </section>
      {peek && (
        <div
          className="dispatch__peek"
          role="dialog"
          aria-modal="true"
          aria-label={text.peek.label}
          onKeyDown={(event) => {
            if (event.key === "Escape") setPeek(undefined);
          }}
        >
          <div className="dispatch__peek-card">
            <header className="dispatch__panel-head">
              <StatusChip tone="info">{text.peek.kinds[peek.target.kind]}</StatusChip>
              <button
                className="dispatch__filter"
                type="button"
                autoFocus
                onClick={() => { setPeek(undefined); }}
              >
                {text.peek.close}
              </button>
            </header>
            {peek.status === "loading" && <p role="status">{text.peek.loading}</p>}
            {peek.status === "absent" && <p role="status">{text.peek.absent}</p>}
            {peek.status === "error" && <p role="alert">{text.peek.error}</p>}
            {peek.status === "ready" && (
              <div className="dispatch__peek-body">
                {peek.head.code && <span className="dispatch__code">{peek.head.code}</span>}
                {peek.head.title && <strong>{peek.head.title}</strong>}
                {peek.head.status && <StatusChip tone="neutral">{peek.head.status}</StatusChip>}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
