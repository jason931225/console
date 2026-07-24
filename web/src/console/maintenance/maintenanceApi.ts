import type { components, operations } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../api/client";

export type WorkOrderStatus = components["schemas"]["WorkOrderStatus"];
export type PriorityLevel = components["schemas"]["PriorityLevel"];
export type WorkResultType = components["schemas"]["WorkResultType"];
export type AttachmentStage = components["schemas"]["AttachmentStage"];
export type WorkOrderSummary = components["schemas"]["WorkOrderSummary"];
export type CreateWorkOrder = components["schemas"]["CreateWorkOrderRequest"];
export type AssignWorkOrder = components["schemas"]["AssignWorkOrderRequest"];
export type SubmitReport = components["schemas"]["SubmitReportRequest"];
export type EvidencePresign = components["schemas"]["EvidencePresignRequest"];

// G2 gap-closure contract (workorder crates, parallel lane): optional on the
// wire; regenerated clients replace these local declarations.
export type MaintenanceType = "EMERGENCY" | "CORRECTIVE" | "PREVENTIVE" | "INSPECTION";
export type MaintenanceCause = "BREAKDOWN" | "RETURN_PREP" | "SCHEDULED" | "INSPECTION_FINDING" | "OTHER";

interface MaintenanceClassification {
  maintenance_type?: MaintenanceType | null;
  maintenance_cause?: MaintenanceCause | null;
}

export type WorkOrderRow = components["schemas"]["WorkOrderListItem"] & MaintenanceClassification;
export type WorkOrderDetail = components["schemas"]["WorkOrderDetail"] & MaintenanceClassification;

// G4 gap-closure contract: derived aggregates are optional until the backend
// lane lands them; the screen renders those stats only when present.
export type WorkOrderLens = components["schemas"]["WorkOrderObjectSetLens"] & {
  aggregates: components["schemas"]["WorkOrderLensAggregates"] & {
    preventive_on_time_rate?: number | null;
    mttr_minutes?: number | null;
  };
};

export interface WorkOrderListPage {
  items: WorkOrderRow[];
  limit: number;
  offset: number;
  total: number;
  lens?: WorkOrderLens;
}

// G1 (`equipment_id`) + G2 (`maintenance_type`/`maintenance_cause`) list
// filters — contract sync point with the backend lane.
export type WorkOrderListQuery = NonNullable<operations["listWorkOrders"]["parameters"]["query"]> & {
  equipment_id?: string;
  maintenance_type?: MaintenanceType;
  maintenance_cause?: MaintenanceCause;
};

// G3 gap-closure contract: work_order_settlements FSM
// DRAFT→SUBMITTED→APPROVED|RETURNED|VOID (four-eyes server-enforced).
export type SettlementStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "RETURNED" | "VOID";
export type SettlementLineKind = "LABOR" | "PART" | "OUTSOURCE" | "OTHER";

export interface SettlementLine {
  kind: SettlementLineKind;
  amount_krw: number;
  source_ref?: string | null;
  voucher_ref?: string | null;
}

export interface WorkOrderSettlement {
  id: string;
  work_order_id: string;
  status: SettlementStatus;
  lines: SettlementLine[];
  review_comment?: string | null;
  void_reason?: string | null;
}

export class MaintenanceApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "MaintenanceApiError";
  }
}

function message(error: unknown, status: number): string {
  if (error && typeof error === "object" && "error" in error) {
    const body = error as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message;
  }
  return `Maintenance request failed (${String(status)})`;
}

function requireData<T>(response: { data?: T; error?: unknown; response: Response }): T {
  if (response.data !== undefined) return response.data;
  throw new MaintenanceApiError(message(response.error, response.response.status), response.response.status);
}

interface RawResult {
  data?: unknown;
  error?: unknown;
  response: Response;
}

/**
 * G3 settlement routes are not in the generated client yet; openapi-fetch
 * templates unknown paths at runtime, so this narrow view keeps the calls on
 * the authenticated client (auth/refresh/cache middleware) until regen.
 */
interface RawClient {
  GET: (url: string, init?: { params?: { path?: Record<string, string> }; signal?: AbortSignal }) => Promise<RawResult>;
  POST: (url: string, init?: { params?: { path?: Record<string, string> }; body?: unknown; signal?: AbortSignal }) => Promise<RawResult>;
}

/** Work-order transport bound to the authenticated ConsoleApiClient. */
export function createMaintenanceApi(api: ConsoleApiClient) {
  const raw = api as unknown as RawClient;
  const requireSettlement = (result: RawResult) => requireData(result) as WorkOrderSettlement;
  return {
    list: async (query?: WorkOrderListQuery, signal?: AbortSignal): Promise<WorkOrderListPage> => {
      const response = await api.GET("/api/v1/work-orders", { params: { query: query ?? {} }, signal });
      return requireData(response);
    },
    detail: async (id: string, signal?: AbortSignal): Promise<WorkOrderDetail> => {
      const response = await api.GET("/api/v1/work-orders/{workOrderId}", {
        params: { path: { workOrderId: id } },
        signal,
      });
      return requireData(response);
    },
    create: async (input: CreateWorkOrder & MaintenanceClassification, signal?: AbortSignal) => {
      const response = await api.POST("/api/work-orders", { body: input, signal });
      return requireData(response);
    },
    assign: async (id: string, input: AssignWorkOrder, signal?: AbortSignal) => {
      const response = await api.PUT("/api/work-orders/{workOrderId}/assignments", {
        params: { path: { workOrderId: id } },
        body: input,
        signal,
      });
      return requireData(response);
    },
    start: async (id: string, signal?: AbortSignal) => {
      const response = await api.POST("/api/work-orders/{workOrderId}/start", {
        params: { path: { workOrderId: id } },
        signal,
      });
      return requireData(response);
    },
    report: async (id: string, input: SubmitReport, signal?: AbortSignal) => {
      const response = await api.POST("/api/work-orders/{workOrderId}/report", {
        params: { path: { workOrderId: id } },
        body: input,
        signal,
      });
      return requireData(response);
    },
    approve: async (id: string, comment: string, signal?: AbortSignal) => {
      const response = await api.POST("/api/work-orders/{workOrderId}/approve", {
        params: { path: { workOrderId: id } },
        body: { comment },
        signal,
      });
      return requireData(response);
    },
    reject: async (id: string, memo: string, signal?: AbortSignal) => {
      const response = await api.POST("/api/v1/work-orders/{workOrderId}/reject", {
        params: { path: { workOrderId: id } },
        body: { memo },
        signal,
      });
      return requireData(response);
    },
    setPriority: async (id: string, priority: PriorityLevel, signal?: AbortSignal) => {
      const response = await api.PATCH("/api/work-orders/{workOrderId}/priority", {
        params: { path: { workOrderId: id } },
        body: { priority },
        signal,
      });
      return requireData(response);
    },
    presignEvidence: async (input: EvidencePresign, signal?: AbortSignal) => {
      const response = await api.POST("/api/v1/evidence/presign", { body: input, signal });
      return requireData(response);
    },
    confirmEvidence: async (evidenceId: string, signal?: AbortSignal) => {
      const response = await api.POST("/api/v1/evidence/{evidenceId}/confirm", {
        params: { path: { evidenceId } },
        signal,
      });
      return requireData(response);
    },
    settlement: async (workOrderId: string, signal?: AbortSignal): Promise<WorkOrderSettlement | undefined> => {
      const result = await raw.GET("/api/v1/work-orders/{workOrderId}/settlement", {
        params: { path: { workOrderId } },
        signal,
      });
      if (result.data === undefined && result.response.status === 404) return undefined;
      return requireSettlement(result);
    },
    createSettlement: async (workOrderId: string, lines: SettlementLine[], signal?: AbortSignal) => {
      const result = await raw.POST("/api/v1/work-orders/{workOrderId}/settlement", {
        params: { path: { workOrderId } },
        body: { lines },
        signal,
      });
      return requireSettlement(result);
    },
    submitSettlement: async (settlementId: string, signal?: AbortSignal) => {
      const result = await raw.POST("/api/v1/settlements/{settlementId}/submit", {
        params: { path: { settlementId } },
        signal,
      });
      return requireSettlement(result);
    },
    reviewSettlement: async (
      settlementId: string,
      input: { decision: "APPROVED" | "RETURNED"; comment?: string },
      signal?: AbortSignal,
    ) => {
      const result = await raw.POST("/api/v1/settlements/{settlementId}/review", {
        params: { path: { settlementId } },
        body: input,
        signal,
      });
      return requireSettlement(result);
    },
    voidSettlement: async (settlementId: string, reason: string, signal?: AbortSignal) => {
      const result = await raw.POST("/api/v1/settlements/{settlementId}/void", {
        params: { path: { settlementId } },
        body: { reason },
        signal,
      });
      return requireSettlement(result);
    },
  };
}

export type MaintenanceApi = ReturnType<typeof createMaintenanceApi>;
