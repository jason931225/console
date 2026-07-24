import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../api/client";

export type DispatchStatus = components["schemas"]["DispatchStatus"];
export type WorkOrderStatus = components["schemas"]["WorkOrderStatus"];
export type ObjectHead = components["schemas"]["ObjectHead"];

/**
 * Backend-resolvable object kinds the dispatch surface links to (§4-18).
 * `registry_customers` has no read surface yet (objects resolver registers no
 * customer kind), so the design's 고객 link stays absent rather than dead —
 * recorded as a backend gap in the module evidence.
 */
export type DispatchLinkKind = "work_order" | "equipment" | "person";

export type DispatchPriority = "P1" | "P2" | "P3" | "OUTSOURCE" | "UNSET";
export type DispatchResponseKind = "ACCEPT" | "DECLINE";

/**
 * Console queue / candidates / responses-read DTOs mirror the CAP-DISPATCH
 * backend contract verbatim. The routes are additive and land in the generated
 * @maintenance/api-client-ts on the consolidation client regeneration; until
 * then this module owns the wire types and calls them through the same
 * authenticated client (401 refresh, device header, read cache preserved).
 */
export interface DispatchQueueDispatch {
  id: string;
  status: DispatchStatus;
  accept_window_ends_at: string;
  accepted_count: number;
  declined_count: number;
  target_count: number;
  manual_call_required: boolean;
}

export interface DispatchQueueItem {
  work_order_id: string;
  request_no: string;
  branch_id: string;
  status: WorkOrderStatus;
  priority: DispatchPriority;
  symptom: string;
  equipment_id: string;
  customer_id: string;
  site_id: string;
  target_due_at?: string;
  assigned_mechanic_id?: string;
  dispatch?: DispatchQueueDispatch;
  updated_at: string;
}

export interface DispatchQueuePage {
  items: DispatchQueueItem[];
  next_after?: string;
}

export interface DispatchCandidateWorkload {
  p1: number;
  p2: number;
  p3: number;
  other: number;
}

export interface DispatchCandidate {
  mechanic_id: string;
  score_milli: number;
  gps_ranked: boolean;
  distance_meters?: number;
  location_recorded_at?: string;
  workload: DispatchCandidateWorkload;
  score_reason: string;
  response?: DispatchResponseKind;
  responded_at?: string;
}

export interface DispatchCandidatePage {
  items: DispatchCandidate[];
}

/** Mirrors the dispatch application crate's `P1DispatchResponseSummary`. */
export interface DispatchResponseSummary {
  dispatch_id: string;
  user_id: string;
  response: DispatchResponseKind;
  responded_at: string;
  score_milli: number | null;
  gps_ranked: boolean;
  distance_meters: number | null;
  score_reason: string | null;
}

export interface DispatchResponsePage {
  items: DispatchResponseSummary[];
}

/** One platform audit record scoped to target_type=p1_dispatch (`/api/audit`). */
export interface DispatchAuditRecord {
  id: string;
  actor: string | undefined;
  action: string;
  target_id: string;
  occurred_at: string;
}

export interface DispatchQueueQuery {
  status?: string;
  limit?: number;
  after?: string;
}

export class DispatchApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "DispatchApiError";
  }
}

function envelopeMessage(error: unknown, status: number): string {
  if (error && typeof error === "object" && "error" in error) {
    const body = error as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message;
  }
  return `Dispatch request failed (${String(status)})`;
}

function requireData<T>(response: { data?: T; error?: unknown; response: Response }): T {
  if (response.data !== undefined) return response.data;
  throw new DispatchApiError(
    envelopeMessage(response.error, response.response.status),
    response.response.status,
  );
}

interface UntypedResult {
  data?: unknown;
  error?: unknown;
  response: Response;
}

type UntypedGet = (
  path: string,
  init?: { params?: { query?: Record<string, string | number> }; signal?: AbortSignal },
) => Promise<UntypedResult>;

/**
 * Routes not yet in the generated client go through the same middleware-bound
 * client instance; the cast only widens the accepted path strings. Remove once
 * consolidation regenerates @maintenance/api-client-ts with the dispatch tags.
 */
function untypedGet(api: ConsoleApiClient): UntypedGet {
  return (api as unknown as { GET: UntypedGet }).GET.bind(api);
}

function requireItems(result: UntypedResult, path: string): unknown {
  const data = requireData(result);
  if (!data || typeof data !== "object" || !Array.isArray((data as { items?: unknown }).items)) {
    throw new DispatchApiError(`Dispatch response shape mismatch (${path})`, result.response.status);
  }
  return data;
}

function auditRecordFrom(raw: unknown): DispatchAuditRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.action !== "string" ||
    typeof record.target_id !== "string" ||
    typeof record.occurred_at !== "string"
  ) {
    return undefined;
  }
  return {
    id: record.id,
    actor: typeof record.actor === "string" ? record.actor : undefined,
    action: record.action,
    target_id: record.target_id,
    occurred_at: record.occurred_at,
  };
}

/** Dispatch transport bound to the authenticated ConsoleApiClient. */
export function createDispatchApi(api: ConsoleApiClient) {
  const rawGet = untypedGet(api);
  return {
    queue: async (query: DispatchQueueQuery = {}, signal?: AbortSignal) => {
      const params: Record<string, string | number> = {};
      if (query.status) params.status = query.status;
      if (query.limit !== undefined) params.limit = query.limit;
      if (query.after) params.after = query.after;
      const result = await rawGet("/api/v1/console/dispatch/queue", {
        params: { query: params },
        signal,
      });
      return requireItems(result, "queue") as DispatchQueuePage;
    },
    candidates: async (dispatchId: string, signal?: AbortSignal) => {
      const result = await rawGet(
        `/api/v1/p1-dispatches/${encodeURIComponent(dispatchId)}/candidates`,
        { signal },
      );
      return requireItems(result, "candidates") as DispatchCandidatePage;
    },
    responses: async (dispatchId: string, signal?: AbortSignal) => {
      const result = await rawGet(
        `/api/v1/p1-dispatches/${encodeURIComponent(dispatchId)}/responses`,
        { signal },
      );
      return requireItems(result, "responses") as DispatchResponsePage;
    },
    startDispatch: async (workOrderId: string, signal?: AbortSignal) => {
      const response = await api.POST("/api/v1/work-orders/{workOrderId}/p1-dispatch", {
        params: { path: { workOrderId } },
        // Branch-scoped broadcast — the documented server default made explicit.
        body: { include_region: false },
        signal,
      });
      return requireData(response);
    },
    forceAssign: async (dispatchId: string, mechanicId: string, signal?: AbortSignal) => {
      const response = await api.POST("/api/v1/p1-dispatches/{dispatchId}/force-assign", {
        params: { path: { dispatchId } },
        body: { mechanic_id: mechanicId },
        signal,
      });
      return requireData(response);
    },
    /**
     * Roster read for crew-name resolution only. Callers treat a denial as
     * "resolve nothing" and fall back to raw mechanic ids — never an error
     * surface, never fabricated names.
     */
    users: async (signal?: AbortSignal) => {
      const response = await api.GET("/api/v1/users", {
        params: { query: { limit: 200 } },
        signal,
      });
      return requireData(response);
    },
    /**
     * Canonical object resolve (deny-by-omission: 403/404 both surface as an
     * error the peek renders as absent/denied — never leaked detail).
     */
    resolveObject: async (kind: DispatchLinkKind, id: string, signal?: AbortSignal) => {
      const response = await api.GET("/api/objects/{kind}/{id}", {
        params: { path: { kind, id } },
        signal,
      });
      return requireData(response);
    },
    /** Platform audit read filtered to p1_dispatch — the module history layer. */
    history: async (dispatchId: string, signal?: AbortSignal) => {
      const result = await rawGet("/api/audit", {
        params: {
          query: {
            target_type: "p1_dispatch",
            target_id: dispatchId,
            limit: 20,
            offset: 0,
          },
        },
        signal,
      });
      const page = requireItems(result, "history") as { items: unknown[] };
      return page.items.flatMap((item) => {
        const record = auditRecordFrom(item);
        return record ? [record] : [];
      });
    },
  };
}

export type DispatchApi = ReturnType<typeof createDispatchApi>;
