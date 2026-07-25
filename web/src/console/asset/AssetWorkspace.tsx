import { useCallback, useEffect, useId, useRef, useState, type SyntheticEvent } from "react";

import type { components } from "@maintenance/api-client-ts";

import type {
  AssetLifecycleCostSummary,
  CreateEquipmentRequest,
  EquipmentListItem,
  EquipmentTimelineGraph,
  SubstituteAssignment,
  SubstituteCandidate,
} from "../../api/types";
import type { ConsoleApiClient } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { EquipmentImportPanel } from "../../features/equipment/EquipmentImportPanel";
import { SiteGeographyPanel } from "../../features/equipment/SiteGeographyPanel";
import { formatKoreanDateTime } from "../../lib/datetime";
import { Won } from "../../lib/format";

type Props = {
  api: ConsoleApiClient;
  sessionKey: string;
  capabilities: {
    canRead: boolean;
    canManage: (branch: string) => boolean;
    canReadCost: (branch: string) => boolean;
    canImport: (branch: string) => boolean;
  };
};

type EquipmentVersion = components["schemas"]["EquipmentVersion"];
type OwnershipTransfer = components["schemas"]["OwnershipTransfer"];

type Detail = {
  row: EquipmentListItem;
  timeline?: EquipmentTimelineGraph;
  versions: EquipmentVersion[];
  candidates: SubstituteCandidate[];
  transfers: OwnershipTransfer[];
  cost?: AssetLifecycleCostSummary;
};

type SessionSubstitution = {
  assignment: SubstituteAssignment;
  sourceEquipmentId: string;
  sessionKey: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "요청을 처리하지 못했습니다. 다시 시도해 주세요.";
}

function responseData<T>(response: { data?: T; error?: unknown }, operation: string): T {
  if (response.data) return response.data;
  if (response.error && typeof response.error === "object" && "message" in response.error) {
    const message = (response.error as { message?: unknown }).message;
    if (typeof message === "string") throw new Error(message);
  }
  throw new Error(`${operation} 요청이 거부되었거나 응답이 없습니다.`);
}

function value(data: FormData, name: string): string {
  const raw = data.get(name);
  return typeof raw === "string" ? raw.trim() : "";
}

export function AssetWorkspace({ api, sessionKey, capabilities }: Props) {
  const [rows, setRows] = useState<EquipmentListItem[]>([]);
  const [selected, setSelected] = useState<Detail>();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [substitution, setSubstitution] = useState<SessionSubstitution>();
  const [showRegister, setShowRegister] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showSites, setShowSites] = useState(false);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const listAbort = useRef(new AbortController());
  const detailAbort = useRef(new AbortController());
  const retryListQuery = useRef<string | undefined>(undefined);
  const retryDetailRow = useRef<EquipmentListItem | undefined>(undefined);

  const load = useCallback(async (q = "") => {
    listGeneration.current += 1;
    listAbort.current.abort();
    const controller = new AbortController();
    listAbort.current = controller;
    const generation = listGeneration.current;
    setLoading(true);
    setError(undefined);
    try {
      const response = await api.GET("/api/v1/equipment/list", {
        params: { query: { q: q || undefined, limit: 50, offset: 0 } }, signal: controller.signal,
      });
      const page = responseData(response, "장비 목록");
      if (controller.signal.aborted || generation !== listGeneration.current) return;
      setRows(page.items);
    } catch (cause) {
      if (!controller.signal.aborted && generation === listGeneration.current) {
        retryListQuery.current = q;
        setError(errorMessage(cause));
      }
    } finally {
      if (generation === listGeneration.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(() => {
      setRows([]); setSelected(undefined); setSubstitution(undefined); setError(undefined); setNotice(undefined);
      void load("");
    });
    return () => { listAbort.current.abort(); detailAbort.current.abort(); };
  }, [api, load, sessionKey]);

  async function open(row: EquipmentListItem) {
    detailGeneration.current += 1;
    detailAbort.current.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    const generation = detailGeneration.current;
    setSubstitution(undefined);
    setSelected(undefined);
    setBusy(true);
    setError(undefined);
    try {
      const [timeline, versions, candidates, transfers, cost] = await Promise.all([
        api.GET("/api/v1/equipment/{id}/timeline-graph", { params: { path: { id: row.equipment_id } }, signal: controller.signal }),
        api.GET("/api/v1/equipment/{id}/versions", { params: { path: { id: row.equipment_id } }, signal: controller.signal }),
        capabilities.canManage(row.branch_id)
          ? api.GET("/api/v1/equipment/{id}/substitutes", { params: { path: { id: row.equipment_id } }, signal: controller.signal })
          : Promise.resolve({ data: undefined }),
        capabilities.canManage(row.branch_id)
          ? api.GET("/api/v1/equipment/{id}/ownership-transfer-requests", { params: { path: { id: row.equipment_id } }, signal: controller.signal })
          : Promise.resolve({ data: undefined }),
        capabilities.canReadCost(row.branch_id)
          ? api.GET("/api/v1/financial/equipment/{equipmentId}/lifecycle-cost", { params: { path: { equipmentId: row.equipment_id } }, signal: controller.signal })
          : Promise.resolve({ data: undefined }),
      ]);
      if (controller.signal.aborted || generation !== detailGeneration.current) return;
      const manage = capabilities.canManage(row.branch_id);
      const readCost = capabilities.canReadCost(row.branch_id);
      setSelected({
        row,
        timeline: responseData(timeline, "생애주기"),
        versions: responseData(versions, "버전 이력").items,
        candidates: manage ? responseData(candidates, "대차 후보").items : [],
        transfers: manage ? responseData(transfers, "소유권 이전 이력").items : [],
        cost: readCost ? responseData(cost, "생애주기 비용") : undefined,
      });
    } catch (cause) {
      if (!controller.signal.aborted && generation === detailGeneration.current) {
        retryDetailRow.current = row;
        setError(errorMessage(cause));
      }
    } finally {
      if (generation === detailGeneration.current) setBusy(false);
    }
  }

  async function refreshSelected() {
    if (selected) await open(selected.row);
    await load(query);
  }

  async function register(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const body: CreateEquipmentRequest = {
      equipment_no: value(data, "equipment_no"),
      customer_name: value(data, "customer_name"),
      site_name: value(data, "site_name"),
      status: value(data, "status") as CreateEquipmentRequest["status"],
      specification: value(data, "specification"),
      ton_text: value(data, "ton_text"),
      management_no: value(data, "management_no") || null,
    };
    setBusy(true);
    setError(undefined);
    try {
      const response = await api.POST("/api/v1/equipment", { body });
      responseData(response, "장비 등록");
      form.reset();
      setShowRegister(false);
      setNotice("장비를 등록했습니다.");
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally { setBusy(false); }
  }

  async function rollback(version: number) {
    if (!selected) return;
    setBusy(true); setError(undefined);
    try {
      const response = await api.POST("/api/v1/equipment/{id}/versions/{version}/rollback", {
        params: { path: { id: selected.row.equipment_id, version } },
      });
      const result = responseData(response, "되돌림");
      setNotice(`버전 ${String(result.version)}으로 되돌림 이력을 추가했습니다.`);
      await refreshSelected();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }

  async function assign(candidate: SubstituteCandidate) {
    if (!selected) return;
    const location = window.prompt("대차 배치 위치를 입력하세요.");
    if (!location?.trim()) return;
    setBusy(true); setError(undefined);
    try {
      const response = await api.POST("/api/v1/equipment-substitutions", {
        body: { source_equipment_id: selected.row.equipment_id, substitute_equipment_id: candidate.equipment_id, assignment_location: location.trim() },
      });
      const assignment = responseData(response, "대차 배정");
      setSubstitution({ assignment, sourceEquipmentId: selected.row.equipment_id, sessionKey });
      setNotice("대차 배정을 기록했습니다.");
      await load(query);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }

  async function returnSubstitution() {
    if (!substitution || !selected || substitution.sourceEquipmentId !== selected.row.equipment_id || substitution.sessionKey !== sessionKey) return;
    setBusy(true); setError(undefined);
    try {
      const response = await api.POST("/api/v1/equipment-substitutions/{id}/return", { params: { path: { id: substitution.assignment.id } }, body: {} });
      responseData(response, "대차 반납");
      setSubstitution(undefined);
      setNotice("대차 반납을 기록했습니다.");
      await refreshSelected();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }

  async function createTransfer(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const data = new FormData(event.currentTarget);
    setBusy(true); setError(undefined);
    try {
      const response = await api.POST("/api/v1/equipment/{id}/ownership-transfer-requests", {
        params: { path: { id: selected.row.equipment_id } },
        body: { to_owner: value(data, "to_owner"), reason: value(data, "reason") },
      });
      responseData(response, "소유권 이전 요청");
      setNotice("소유권 이전 요청을 등록했습니다.");
      await refreshSelected();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }

  async function decideTransfer(id: string, decision: "approve" | "reject") {
    const comment = window.prompt(decision === "approve" ? "승인 의견" : "반려 사유");
    if (comment === null) return;
    setBusy(true); setError(undefined);
    try {
      const response = await api.POST("/api/v1/equipment/ownership-transfer-requests/{id}/decisions", { params: { path: { id } }, body: { decision, comment } });
      responseData(response, "소유권 이전 결정");
      setNotice(decision === "approve" ? "소유권 이전 단계를 승인했습니다." : "소유권 이전을 반려했습니다.");
      await refreshSelected();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }

  return <main className="min-h-full bg-canvas p-4 text-ink sm:p-6" aria-busy={loading || busy}>
    <div className="mx-auto grid max-w-[1600px] gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-bold tracking-tight">자산</h1><p className="text-sm text-steel">장비 원장 · 생애주기 · 비용</p></div>
        {selected && capabilities.canManage(selected.row.branch_id) ? <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => { setShowSites((open) => !open); }}>현장 좌표</Button>
          {capabilities.canImport(selected.row.branch_id) ? <Button type="button" size="sm" variant="secondary" onClick={() => { setShowImport((open) => !open); }}>엑셀 가져오기</Button> : null}
          <Button type="button" size="sm" onClick={() => { setShowRegister((open) => !open); }}>장비 등록</Button>
        </div> : null}
      </header>
      {notice ? <p role="status" className="text-sm font-medium text-brand-teal">{notice}</p> : null}
      {error ? <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"><span>{error}</span><Button type="button" size="xs" variant="secondary" onClick={() => { const row = retryDetailRow.current; if (row !== undefined) { void open(row); } else { void load(retryListQuery.current || ""); } }}>다시 시도</Button></div> : null}
      {showRegister ? <RegisterForm busy={busy} onSubmit={(event) => { void register(event); }} /> : null}
      {showImport ? <EquipmentImportPanel api={api} onImported={() => { void load(); }} /> : null}
      {showSites ? <SiteGeographyPanel api={api} /> : null}
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.9fr)]">
        <Card className="grid gap-3">
          <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void load(query); }}>
            <label className="sr-only" htmlFor="asset-search">장비 검색</label>
            <input id="asset-search" className="min-h-10 flex-1 rounded border border-line px-3 text-sm" value={query} onChange={(event) => { setQuery(event.target.value); }} placeholder="호기, 모델, 고객 또는 현장 검색" />
            <Button type="submit" size="sm" variant="secondary">검색</Button>
          </form>
          <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-steel"><tr><th className="p-2">호기</th><th className="p-2">상태</th><th className="p-2">고객 · 현장</th><th className="p-2">갱신</th></tr></thead><tbody>
            {rows.map((row) => <tr key={row.equipment_id} className="border-t border-line"><td className="p-2"><button type="button" className="font-mono font-bold underline underline-offset-4" onClick={() => void open(row)} aria-label={`${row.equipment_no} 상세 열기`}>{row.equipment_no}</button><div className="text-xs text-steel">{row.management_no ?? row.model ?? "—"}</div></td><td className="p-2">{row.status}</td><td className="p-2">{row.customer_name}<div className="text-xs text-steel">{row.site_name}</div></td><td className="p-2 whitespace-nowrap text-xs">{formatKoreanDateTime(row.updated_at)}</td></tr>)}
          </tbody></table></div>
          {!loading && rows.length === 0 ? <p role="status" className="p-4 text-sm text-steel">조건에 맞는 장비가 없습니다.</p> : null}
        </Card>
        {selected ? <AssetDetail detail={selected} capabilities={capabilities} busy={busy} substitution={substitution} sessionKey={sessionKey} onRollback={rollback} onAssign={assign} onReturn={returnSubstitution} onTransfer={createTransfer} onDecide={decideTransfer} /> : <Card><p role="status" className="text-sm text-steel">목록에서 장비를 선택하면 이력, 관계 및 비용을 확인합니다.</p></Card>}
      </section>
    </div>
  </main>;
}

function RegisterForm({ busy, onSubmit }: { busy: boolean; onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void }) {
  const id = useId();
  return <Card><form className="grid gap-3 sm:grid-cols-2" onSubmit={onSubmit}>
    <h2 className="sm:col-span-2 text-lg font-semibold">장비 등록</h2>
    <Field id={`${id}-no`} label="장비 번호" name="equipment_no" required /><Field id={`${id}-management`} label="관리 번호" name="management_no" />
    <Field id={`${id}-customer`} label="고객" name="customer_name" required /><Field id={`${id}-site`} label="현장" name="site_name" required />
    <Field id={`${id}-spec`} label="규격" name="specification" required /><Field id={`${id}-ton`} label="톤수" name="ton_text" required />
    <label className="grid gap-1 text-sm font-medium text-steel" htmlFor={`${id}-status`}>상태<select id={`${id}-status`} name="status" className="min-h-10 rounded border border-line px-3" defaultValue="spare"><option value="spare">spare</option><option value="rented">rented</option><option value="repair">repair</option><option value="disposed">disposed</option></select></label>
    <div className="flex items-end"><Button type="submit" disabled={busy}>등록</Button></div>
  </form></Card>;
}

function Field({ id, label, name, required = false }: { id: string; label: string; name: string; required?: boolean }) { return <label className="grid gap-1 text-sm font-medium text-steel" htmlFor={id}>{label}<input id={id} name={name} required={required} className="min-h-10 rounded border border-line px-3 text-ink" /></label>; }

function AssetDetail({ detail, capabilities, busy, substitution, sessionKey, onRollback, onAssign, onReturn, onTransfer, onDecide }: { detail: Detail; capabilities: Props["capabilities"]; busy: boolean; substitution?: SessionSubstitution; sessionKey: string; onRollback: (version: number) => Promise<void>; onAssign: (candidate: SubstituteCandidate) => Promise<void>; onReturn: () => Promise<void>; onTransfer: (event: SyntheticEvent<HTMLFormElement>) => Promise<void>; onDecide: (id: string, decision: "approve" | "reject") => Promise<void> }) {
  const { row, timeline, versions, candidates, transfers, cost } = detail;
  return <div className="grid gap-4"><Card className="grid gap-3"><header><h2 className="text-lg font-semibold">{row.equipment_no}</h2><p className="text-sm text-steel">{row.customer_name} · {row.site_name}</p></header><dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-steel">상태</dt><dd>{row.status}</dd></div><div><dt className="text-steel">소유자</dt><dd>{row.asset_owner ?? "—"}</dd></div><div><dt className="text-steel">규격</dt><dd>{row.specification} / {row.ton_text}</dd></div><div><dt className="text-steel">VIN</dt><dd className="font-mono">{row.vin ?? "—"}</dd></div></dl></Card>
    <Card className="grid gap-3"><h3 className="font-semibold">생애주기</h3>{timeline ? <><ol className="grid gap-2">{timeline.lifecycle_events.map((event) => <li key={event.id} className="border-l-2 border-signal pl-3"><div className="text-sm font-medium">{event.href ? <a className="underline underline-offset-4" href={event.href}>{event.label}</a> : event.label}</div><div className="text-xs text-steel">{event.description ?? event.event_date ?? event.occurred_at ?? ""}</div></li>)}</ol><div className="flex flex-wrap gap-2">{timeline.graph.nodes.map((node) => node.href ? <a key={node.id} href={node.href} className="rounded border border-line px-2 py-1 text-xs underline">{node.label}</a> : <span key={node.id} className="rounded border border-line px-2 py-1 text-xs">{node.label}</span>)}</div>{timeline.graph.edges.length ? <p className="text-xs text-steel">{timeline.graph.edges.map((edge) => edge.label).join(" · ")}</p> : null}</> : <p className="text-sm text-steel">생애주기 정보를 불러오지 못했습니다.</p>}</Card>
    <Card className="grid gap-2"><h3 className="font-semibold">버전 이력</h3>{versions.length ? <ul className="grid gap-2">{versions.map((version) => <li key={version.version} className="flex items-center justify-between gap-2 border-t border-line pt-2 text-sm"><span>v{version.version} · {version.status} · {formatKoreanDateTime(version.createdAt)}</span>{capabilities.canManage(row.branch_id) ? <Button type="button" size="xs" variant="secondary" disabled={busy} onClick={() => { void onRollback(version.version); }}>되돌림</Button> : null}</li>)}</ul> : <p className="text-sm text-steel">저장된 버전이 없습니다.</p>}</Card>
    {capabilities.canReadCost(row.branch_id) && cost ? <Card className="grid gap-2"><h3 className="font-semibold">생애주기 비용</h3><dl className="grid grid-cols-2 gap-2 text-sm"><Money label="총소유비용" value={cost.tco_won} /><Money label="정비비" value={cost.maintenance_total_won} /><Money label="잔존가치" value={cost.residual_value_won} /><Money label="월 비용" value={cost.cost_per_month_won} /></dl>{cost.timeline.map((entry) => <div key={entry.id} className="flex justify-between border-t border-line pt-2 text-sm"><span>{entry.memo || entry.source}</span><Won amount={entry.amount_won} /></div>)}</Card> : null}
    {capabilities.canManage(row.branch_id) ? <Card className="grid gap-3"><h3 className="font-semibold">대차</h3><p className="text-xs text-steel">이 화면에서는 현재 세션에서 만든 대차만 반납할 수 있습니다. 새로고침 또는 세션 변경 뒤에는 이 화면에서 해당 대차를 확인하거나 반납할 수 없습니다.</p>{substitution && substitution.sourceEquipmentId === row.equipment_id && substitution.sessionKey === sessionKey ? <div className="flex items-center justify-between text-sm"><span>배정됨 · {substitution.assignment.assignment_location}</span><Button type="button" size="xs" variant="secondary" disabled={busy} onClick={() => { void onReturn(); }}>반납</Button></div> : candidates.length ? <ul className="grid gap-2">{candidates.map((candidate) => <li key={candidate.equipment_id} className="flex items-center justify-between gap-2 text-sm"><span>{candidate.equipment_no} · {candidate.ton_text} · {candidate.match_kind}</span><Button type="button" size="xs" variant="secondary" disabled={busy} onClick={() => { void onAssign(candidate); }}>대차 배정</Button></li>)}</ul> : <p className="text-sm text-steel">호환 가능한 대차 후보가 없습니다.</p>}</Card> : null}
    {capabilities.canManage(row.branch_id) ? <Card className="grid gap-3"><h3 className="font-semibold">소유권 이전</h3><form className="grid gap-2" onSubmit={(event) => { void onTransfer(event); }}><Field id={`owner-${row.equipment_id}`} label="새 법적 소유자" name="to_owner" required /><label className="grid gap-1 text-sm font-medium text-steel">이전 사유<textarea name="reason" required className="min-h-16 rounded border border-line p-2 text-ink" /></label><Button type="submit" size="sm" disabled={busy}>이전 요청</Button></form>{transfers.map((transfer) => <div key={transfer.id} className="grid gap-1 border-t border-line pt-2 text-sm"><span>{transfer.from_owner} → {transfer.to_owner} · {transfer.status}</span><span className="text-xs text-steel">{transfer.current_step ?? "완료"}</span>{transfer.status === "PENDING" ? <div className="flex gap-2"><Button type="button" size="xs" disabled={busy} onClick={() => { void onDecide(transfer.id, "approve"); }}>승인</Button><Button type="button" size="xs" variant="secondary" disabled={busy} onClick={() => { void onDecide(transfer.id, "reject"); }}>반려</Button></div> : null}</div>)}</Card> : null}
  </div>;
}

function Money({ label, value }: { label: string; value: number | null | undefined }) { return <div><dt className="text-steel">{label}</dt><dd><Won amount={value ?? 0} /></dd></div>; }
