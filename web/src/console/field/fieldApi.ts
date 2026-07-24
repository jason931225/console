import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../api/client";

/**
 * 고객·현장 transport. Two route families:
 *
 *  • Existing support-desk routes (`/api/v1/support/tickets*`) go through the
 *    typed generated client directly.
 *  • The CAP-FIELD-CONSOLE routes (`/api/v1/field/sites*`, ticket `link` /
 *    `acceptance`) are being built by the backend lane in parallel under the
 *    same written contract — the DTOs below ARE that contract (deviation is a
 *    defect on whichever side drifted). They are invoked through the same
 *    authenticated client; once the integrator regenerates the client from the
 *    `field` openapi tag, these local types collapse onto
 *    `components["schemas"]` aliases with no call-site change.
 */

export type TicketStatus = components["schemas"]["SupportTicketStatus"];
export type TicketPriority = components["schemas"]["SupportTicketPriority"];
export type TicketCategory = components["schemas"]["SupportTicketCategory"];
export type TicketComment = components["schemas"]["SupportTicketComment"];
export type CreateTicketRequest = components["schemas"]["CreateInternalTicketRequest"];

/** TicketSummary + the additive field-lane denormalizations (all optional). */
export type TicketSummary = components["schemas"]["SupportTicketSummary"] & {
  site_id?: string | null;
  site_name?: string | null;
  customer_id?: string | null;
  customer_name?: string | null;
  work_order_id?: string | null;
};

export interface TicketDetail {
  ticket: TicketSummary;
  comments: TicketComment[];
}

export interface TicketPage {
  items: TicketSummary[];
  next_cursor: string | null;
  total: number;
}

export type FieldSlaState = "OK" | "AT_RISK" | "BREACHED";

export interface FieldSiteRow {
  site_id: string;
  site_name: string;
  branch_id: string;
  customer_id: string;
  customer_name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  open_ticket_count: number;
  breached_ticket_count: number;
  next_due_at: string | null;
  active_work_order_count: number;
  last_arrival_at: string | null;
  sla: FieldSlaState;
}

export interface FieldSitePage {
  items: FieldSiteRow[];
  next_cursor: string | null;
  total: number;
}

export interface FieldSlaSummary {
  state: FieldSlaState;
  open: number;
  breached: number;
  next_due_at: string | null;
  resolved_within_sla_90d: number;
  resolved_breached_90d: number;
}

export interface FieldWorkOrderRef {
  id: string;
  request_no: string | null;
  status: string;
  priority: string | null;
  target_due_at: string | null;
  report_submitted_at: string | null;
  result_type: string | null;
  created_at: string;
}

export interface FieldAttendanceEvent {
  user_id: string;
  user_name: string | null;
  work_order_id: string | null;
  kind: "ARRIVAL" | "DEPARTURE";
  occurred_at: string;
}

export type AcceptanceKind = "CUSTOMER_ACCEPTED" | "CUSTOMER_DECLINED";
export type AcceptanceChannel = "IN_PERSON" | "PHONE" | "EMAIL" | "MESSENGER";

export interface TicketAcceptanceView {
  id: string;
  ticket_id: string;
  kind: AcceptanceKind;
  channel: AcceptanceChannel;
  accepted_by: string;
  note: string | null;
  recorded_by_user_id: string;
  recorded_by_name: string | null;
  occurred_at: string;
}

export interface RecordAcceptanceRequest {
  kind: AcceptanceKind;
  channel: AcceptanceChannel;
  accepted_by: string;
  note?: string;
}

export interface LinkTicketRequest {
  site_id?: string;
  work_order_id?: string;
}

export interface FieldSiteDetail {
  site: {
    id: string;
    name: string;
    branch_id: string;
    customer_id: string;
    customer_name: string;
    address: string | null;
    province: string | null;
    city: string | null;
    postal_code: string | null;
    lat: number | null;
    lon: number | null;
    geofence_radius_m: number | null;
    contact: string | null;
  };
  sla: FieldSlaSummary;
  tickets: TicketSummary[];
  work_orders: FieldWorkOrderRef[];
  attendance: FieldAttendanceEvent[];
  acceptances: TicketAcceptanceView[];
}

export interface ListFieldSitesQuery {
  q?: string;
  customer_id?: string;
  sla?: FieldSlaState;
  limit?: number;
  cursor?: string;
}

export class FieldApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "FieldApiError";
  }
}

function errorMessage(error: unknown, status: number): string {
  if (error && typeof error === "object" && "error" in error) {
    const body = error as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message;
  }
  return `Field request failed (${String(status)})`;
}

function requireData<T>(response: { data?: T; error?: unknown; response: Response }): T {
  if (response.data !== undefined) return response.data;
  throw new FieldApiError(errorMessage(response.error, response.response.status), response.response.status);
}

interface RawResult {
  data?: unknown;
  error?: unknown;
  response: Response;
}

/** Structural view of the openapi-fetch client for contract routes the
 * generated schema does not carry yet (see module header). Path templating,
 * auth, refresh and caching behave identically to typed calls. */
interface ContractClient {
  GET: (
    path: string,
    init?: {
      params?: { path?: Record<string, string>; query?: Record<string, unknown> };
      signal?: AbortSignal;
    },
  ) => Promise<RawResult>;
  POST: (
    path: string,
    init?: {
      params?: { path?: Record<string, string> };
      body?: unknown;
      signal?: AbortSignal;
    },
  ) => Promise<RawResult>;
}

function requireContractData(result: RawResult): unknown {
  if (result.data !== undefined) return result.data;
  throw new FieldApiError(errorMessage(result.error, result.response.status), result.response.status);
}

/** Field transport bound to the authenticated ConsoleApiClient. */
export function createFieldApi(api: ConsoleApiClient) {
  const contract = api as unknown as ContractClient;
  return {
    listSites: async (query: ListFieldSitesQuery = {}, signal?: AbortSignal) => {
      const result = await contract.GET("/api/v1/field/sites", {
        params: { query: { ...query } },
        signal,
      });
      return requireContractData(result) as FieldSitePage;
    },
    getSite: async (siteId: string, signal?: AbortSignal) => {
      const result = await contract.GET("/api/v1/field/sites/{id}", {
        params: { path: { id: siteId } },
        signal,
      });
      return requireContractData(result) as FieldSiteDetail;
    },
    listTickets: async (
      query: { include_untriaged?: boolean; limit?: number; cursor?: string } = {},
      signal?: AbortSignal,
    ): Promise<TicketPage> => {
      const response = await api.GET("/api/v1/support/tickets", {
        params: { query },
        signal,
      });
      return requireData(response);
    },
    getTicket: async (ticketId: string, signal?: AbortSignal): Promise<TicketDetail> => {
      const response = await api.GET("/api/v1/support/tickets/{id}", {
        params: { path: { id: ticketId } },
        signal,
      });
      return requireData(response);
    },
    createTicket: async (input: CreateTicketRequest, signal?: AbortSignal): Promise<TicketSummary> => {
      const response = await api.POST("/api/v1/support/tickets", { body: input, signal });
      return requireData(response);
    },
    assignTicket: async (
      ticketId: string,
      input: { assignee_user_id: string; branch_id?: string },
      signal?: AbortSignal,
    ): Promise<TicketSummary> => {
      const response = await api.POST("/api/v1/support/tickets/{id}/assign", {
        params: { path: { id: ticketId } },
        body: input,
        signal,
      });
      return requireData(response);
    },
    transitionTicket: async (
      ticketId: string,
      toStatus: TicketStatus,
      signal?: AbortSignal,
    ): Promise<TicketSummary> => {
      const response = await api.POST("/api/v1/support/tickets/{id}/transition", {
        params: { path: { id: ticketId } },
        body: { to_status: toStatus },
        signal,
      });
      return requireData(response);
    },
    addComment: async (
      ticketId: string,
      input: { body: string; is_internal_note?: boolean },
      signal?: AbortSignal,
    ): Promise<TicketComment> => {
      const response = await api.POST("/api/v1/support/tickets/{id}/comments", {
        params: { path: { id: ticketId } },
        body: input,
        signal,
      });
      return requireData(response);
    },
    linkTicket: async (ticketId: string, input: LinkTicketRequest, signal?: AbortSignal) => {
      const result = await contract.POST("/api/v1/support/tickets/{id}/link", {
        params: { path: { id: ticketId } },
        body: input,
        signal,
      });
      return requireContractData(result) as TicketSummary;
    },
    recordAcceptance: async (
      ticketId: string,
      input: RecordAcceptanceRequest,
      signal?: AbortSignal,
    ) => {
      const result = await contract.POST("/api/v1/support/tickets/{id}/acceptance", {
        params: { path: { id: ticketId } },
        body: input,
        signal,
      });
      return requireContractData(result) as TicketAcceptanceView;
    },
  };
}

export type FieldApi = ReturnType<typeof createFieldApi>;
