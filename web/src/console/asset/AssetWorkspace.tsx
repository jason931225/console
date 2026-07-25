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
import { assetStrings as text } from "../../i18n/asset";
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
  return error instanceof Error ? error.message : text.genericRequestFailure;
}

function responseData<T>(response: { data?: T; error?: unknown }, operation: string): T {
  if (response.data) return response.data;
  if (response.error && typeof response.error === "object" && "message" in response.error) {
    const message = (response.error as { message?: unknown }).message;
    if (typeof message === "string") throw new Error(message);
  }
  throw new Error(text.responseUnavailable(operation));
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
      const page = responseData(response, text.operations.equipmentList);
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
        timeline: responseData(timeline, text.operations.lifecycle),
        versions: responseData(versions, text.operations.versionHistory).items,
        candidates: manage ? responseData(candidates, text.operations.substituteCandidates).items : [],
        transfers: manage ? responseData(transfers, text.operations.ownershipTransferHistory).items : [],
        cost: readCost ? responseData(cost, text.operations.lifecycleCost) : undefined,
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
      responseData(response, text.operations.equipmentRegistration);
      form.reset();
      setShowRegister(false);
      setNotice(text.notices.equipmentRegistered);
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
      const result = responseData(response, text.operations.rollback);
      setNotice(text.notices.rollbackRecorded(result.version));
      await refreshSelected();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }

  async function assign(candidate: SubstituteCandidate) {
    if (!selected) return;
    const location = window.prompt(text.prompts.substitutionLocation);
    if (!location?.trim()) return;
    setBusy(true); setError(undefined);
    try {
      const response = await api.POST("/api/v1/equipment-substitutions", {
        body: { source_equipment_id: selected.row.equipment_id, substitute_equipment_id: candidate.equipment_id, assignment_location: location.trim() },
      });
      const assignment = responseData(response, text.operations.substitutionAssignment);
      setSubstitution({ assignment, sourceEquipmentId: selected.row.equipment_id, sessionKey });
      setNotice(text.notices.substitutionAssigned);
      await load(query);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }

  async function returnSubstitution() {
    if (!substitution || !selected || substitution.sourceEquipmentId !== selected.row.equipment_id || substitution.sessionKey !== sessionKey) return;
    setBusy(true); setError(undefined);
    try {
      const response = await api.POST("/api/v1/equipment-substitutions/{id}/return", { params: { path: { id: substitution.assignment.id } }, body: {} });
      responseData(response, text.operations.substitutionReturn);
      setSubstitution(undefined);
      setNotice(text.notices.substitutionReturned);
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
      responseData(response, text.operations.ownershipTransferRequest);
      setNotice(text.notices.ownershipTransferRequested);
      await refreshSelected();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }

  async function decideTransfer(id: string, decision: "approve" | "reject") {
    const comment = window.prompt(decision === "approve" ? text.prompts.approveTransferComment : text.prompts.rejectTransferComment);
    if (comment === null) return;
    setBusy(true); setError(undefined);
    try {
      const response = await api.POST("/api/v1/equipment/ownership-transfer-requests/{id}/decisions", { params: { path: { id } }, body: { decision, comment } });
      responseData(response, text.operations.ownershipTransferDecision);
      setNotice(decision === "approve" ? text.notices.ownershipTransferApproved : text.notices.ownershipTransferRejected);
      await refreshSelected();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }

  return <main className="min-h-full bg-canvas p-4 text-ink sm:p-6" aria-busy={loading || busy}>
    <div className="mx-auto grid max-w-[1600px] gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-bold tracking-tight">{text.title}</h1><p className="text-sm text-steel">{text.subtitle}</p></div>
        {selected && capabilities.canManage(selected.row.branch_id) ? <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => { setShowSites((open) => !open); }}>{text.siteCoordinates}</Button>
          {capabilities.canImport(selected.row.branch_id) ? <Button type="button" size="sm" variant="secondary" onClick={() => { setShowImport((open) => !open); }}>{text.importSpreadsheet}</Button> : null}
          <Button type="button" size="sm" onClick={() => { setShowRegister((open) => !open); }}>{text.registerEquipment}</Button>
        </div> : null}
      </header>
      {notice ? <p role="status" className="text-sm font-medium text-brand-teal">{notice}</p> : null}
      {error ? <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"><span>{error}</span><Button type="button" size="xs" variant="secondary" onClick={() => { const row = retryDetailRow.current; if (row !== undefined) { void open(row); } else { void load(retryListQuery.current || ""); } }}>{text.retry}</Button></div> : null}
      {showRegister ? <RegisterForm busy={busy} onSubmit={(event) => { void register(event); }} /> : null}
      {showImport ? <EquipmentImportPanel api={api} onImported={() => { void load(); }} /> : null}
      {showSites ? <SiteGeographyPanel api={api} /> : null}
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.9fr)]">
        <Card className="grid gap-3">
          <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void load(query); }}>
            <label className="sr-only" htmlFor="asset-search">{text.searchLabel}</label>
            <input id="asset-search" className="min-h-10 flex-1 rounded border border-line px-3 text-sm" value={query} onChange={(event) => { setQuery(event.target.value); }} placeholder={text.searchPlaceholder} />
            <Button type="submit" size="sm" variant="secondary">{text.search}</Button>
          </form>
          <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-steel"><tr><th className="p-2">{text.columns.equipmentNumber}</th><th className="p-2">{text.columns.status}</th><th className="p-2">{text.columns.customerSite}</th><th className="p-2">{text.columns.updated}</th></tr></thead><tbody>
            {rows.map((row) => <tr key={row.equipment_id} className="border-t border-line"><td className="p-2"><button type="button" className="font-mono font-bold underline underline-offset-4" onClick={() => void open(row)} aria-label={text.detailOpenAriaLabel(row.equipment_no)}>{row.equipment_no}</button><div className="text-xs text-steel">{row.management_no ?? row.model ?? "—"}</div></td><td className="p-2">{row.status}</td><td className="p-2">{row.customer_name}<div className="text-xs text-steel">{row.site_name}</div></td><td className="p-2 whitespace-nowrap text-xs">{formatKoreanDateTime(row.updated_at)}</td></tr>)}
          </tbody></table></div>
          {!loading && rows.length === 0 ? <p role="status" className="p-4 text-sm text-steel">{text.noMatchingEquipment}</p> : null}
        </Card>
        {selected ? <AssetDetail detail={selected} capabilities={capabilities} busy={busy} substitution={substitution} sessionKey={sessionKey} onRollback={rollback} onAssign={assign} onReturn={returnSubstitution} onTransfer={createTransfer} onDecide={decideTransfer} /> : <Card><p role="status" className="text-sm text-steel">{text.selectEquipment}</p></Card>}
      </section>
    </div>
  </main>;
}

function RegisterForm({ busy, onSubmit }: { busy: boolean; onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void }) {
  const id = useId();
  return <Card><form className="grid gap-3 sm:grid-cols-2" onSubmit={onSubmit}>
    <h2 className="sm:col-span-2 text-lg font-semibold">{text.registerEquipment}</h2>
    <Field id={`${id}-no`} label={text.fields.equipmentNumber} name="equipment_no" required /><Field id={`${id}-management`} label={text.fields.managementNumber} name="management_no" />
    <Field id={`${id}-customer`} label={text.fields.customer} name="customer_name" required /><Field id={`${id}-site`} label={text.fields.site} name="site_name" required />
    <Field id={`${id}-spec`} label={text.fields.specification} name="specification" required /><Field id={`${id}-ton`} label={text.fields.capacity} name="ton_text" required />
    <label className="grid gap-1 text-sm font-medium text-steel" htmlFor={`${id}-status`}>{text.fields.status}<select id={`${id}-status`} name="status" className="min-h-10 rounded border border-line px-3" defaultValue={text.statusOptions[0]}>{text.statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
    <div className="flex items-end"><Button type="submit" disabled={busy}>{text.register}</Button></div>
  </form></Card>;
}

function Field({ id, label, name, required = false }: { id: string; label: string; name: string; required?: boolean }) { return <label className="grid gap-1 text-sm font-medium text-steel" htmlFor={id}>{label}<input id={id} name={name} required={required} className="min-h-10 rounded border border-line px-3 text-ink" /></label>; }

function AssetDetail({ detail, capabilities, busy, substitution, sessionKey, onRollback, onAssign, onReturn, onTransfer, onDecide }: { detail: Detail; capabilities: Props["capabilities"]; busy: boolean; substitution?: SessionSubstitution; sessionKey: string; onRollback: (version: number) => Promise<void>; onAssign: (candidate: SubstituteCandidate) => Promise<void>; onReturn: () => Promise<void>; onTransfer: (event: SyntheticEvent<HTMLFormElement>) => Promise<void>; onDecide: (id: string, decision: "approve" | "reject") => Promise<void> }) {
  const { row, timeline, versions, candidates, transfers, cost } = detail;
  return <div className="grid gap-4"><Card className="grid gap-3"><header><h2 className="text-lg font-semibold">{row.equipment_no}</h2><p className="text-sm text-steel">{row.customer_name} · {row.site_name}</p></header><dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-steel">{text.fields.status}</dt><dd>{row.status}</dd></div><div><dt className="text-steel">{text.fields.owner}</dt><dd>{row.asset_owner ?? "—"}</dd></div><div><dt className="text-steel">{text.fields.specification}</dt><dd>{row.specification} / {row.ton_text}</dd></div><div><dt className="text-steel">{text.fields.vin}</dt><dd className="font-mono">{row.vin ?? "—"}</dd></div></dl></Card>
    <Card className="grid gap-3"><h3 className="font-semibold">{text.operations.lifecycle}</h3>{timeline ? <><ol className="grid gap-2">{timeline.lifecycle_events.map((event) => <li key={event.id} className="border-l-2 border-signal pl-3"><div className="text-sm font-medium">{event.href ? <a className="underline underline-offset-4" href={event.href}>{event.label}</a> : event.label}</div><div className="text-xs text-steel">{event.description ?? event.event_date ?? event.occurred_at ?? ""}</div></li>)}</ol><div className="flex flex-wrap gap-2">{timeline.graph.nodes.map((node) => node.href ? <a key={node.id} href={node.href} className="rounded border border-line px-2 py-1 text-xs underline">{node.label}</a> : <span key={node.id} className="rounded border border-line px-2 py-1 text-xs">{node.label}</span>)}</div>{timeline.graph.edges.length ? <p className="text-xs text-steel">{timeline.graph.edges.map((edge) => edge.label).join(" · ")}</p> : null}</> : <p className="text-sm text-steel">{text.lifecycleUnavailable}</p>}</Card>
    <Card className="grid gap-2"><h3 className="font-semibold">{text.operations.versionHistory}</h3>{versions.length ? <ul className="grid gap-2">{versions.map((version) => <li key={version.version} className="flex items-center justify-between gap-2 border-t border-line pt-2 text-sm"><span>{text.versionSummary(version.version, version.status, formatKoreanDateTime(version.createdAt))}</span>{capabilities.canManage(row.branch_id) ? <Button type="button" size="xs" variant="secondary" disabled={busy} onClick={() => { void onRollback(version.version); }}>{text.rollback}</Button> : null}</li>)}</ul> : <p className="text-sm text-steel">{text.noSavedVersions}</p>}</Card>
    {capabilities.canReadCost(row.branch_id) && cost ? <Card className="grid gap-2"><h3 className="font-semibold">{text.lifecycleCost}</h3><dl className="grid grid-cols-2 gap-2 text-sm"><Money label={text.costLabels.totalCostOfOwnership} value={cost.tco_won} /><Money label={text.costLabels.maintenanceCost} value={cost.maintenance_total_won} /><Money label={text.costLabels.residualValue} value={cost.residual_value_won} /><Money label={text.costLabels.monthlyCost} value={cost.cost_per_month_won} /></dl>{cost.timeline.map((entry) => <div key={entry.id} className="flex justify-between border-t border-line pt-2 text-sm"><span>{entry.memo || entry.source}</span><Won amount={entry.amount_won} /></div>)}</Card> : null}
    {capabilities.canManage(row.branch_id) ? <Card className="grid gap-3"><h3 className="font-semibold">{text.substitution}</h3><p className="text-xs text-steel">{text.substitutionReturnLimitation}</p>{substitution && substitution.sourceEquipmentId === row.equipment_id && substitution.sessionKey === sessionKey ? <div className="flex items-center justify-between text-sm"><span>{text.substitutionAssigned(substitution.assignment.assignment_location)}</span><Button type="button" size="xs" variant="secondary" disabled={busy} onClick={() => { void onReturn(); }}>{text.returnSubstitution}</Button></div> : candidates.length ? <ul className="grid gap-2">{candidates.map((candidate) => <li key={candidate.equipment_id} className="flex items-center justify-between gap-2 text-sm"><span>{candidate.equipment_no} · {candidate.ton_text} · {candidate.match_kind}</span><Button type="button" size="xs" variant="secondary" disabled={busy} onClick={() => { void onAssign(candidate); }}>{text.assignSubstitution}</Button></li>)}</ul> : <p className="text-sm text-steel">{text.noCompatibleSubstitutes}</p>}</Card> : null}
    {capabilities.canManage(row.branch_id) ? <Card className="grid gap-3"><h3 className="font-semibold">{text.ownershipTransfer}</h3><form className="grid gap-2" onSubmit={(event) => { void onTransfer(event); }}><Field id={`owner-${row.equipment_id}`} label={text.fields.newLegalOwner} name="to_owner" required /><label className="grid gap-1 text-sm font-medium text-steel">{text.fields.transferReason}<textarea name="reason" required className="min-h-16 rounded border border-line p-2 text-ink" /></label><Button type="submit" size="sm" disabled={busy}>{text.requestTransfer}</Button></form>{transfers.map((transfer) => <div key={transfer.id} className="grid gap-1 border-t border-line pt-2 text-sm"><span>{transfer.from_owner} → {transfer.to_owner} · {transfer.status}</span><span className="text-xs text-steel">{transfer.current_step ?? text.completed}</span>{transfer.status === "PENDING" ? <div className="flex gap-2"><Button type="button" size="xs" disabled={busy} onClick={() => { void onDecide(transfer.id, "approve"); }}>{text.approve}</Button><Button type="button" size="xs" variant="secondary" disabled={busy} onClick={() => { void onDecide(transfer.id, "reject"); }}>{text.reject}</Button></div> : null}</div>)}</Card> : null}
  </div>;
}

function Money({ label, value }: { label: string; value: number | null | undefined }) { return <div><dt className="text-steel">{label}</dt><dd><Won amount={value ?? 0} /></dd></div>; }
