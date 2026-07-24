import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../api/client";

export type RegionSummary = components["schemas"]["RegionSummary"];
export type BranchSummary = components["schemas"]["BranchSummary"];
export type HrOrgChartResponse = components["schemas"]["HrOrgChartResponse"];
export type HrOrgChartCompany = components["schemas"]["HrOrgChartCompany"];
export type HrOrgChartUnit = components["schemas"]["HrOrgChartUnit"];
export type SelfProfile = components["schemas"]["UserSummary"];

/**
 * Org-change governance contract (CAP-ORG-CONSOLE scout digest). The backend
 * lane builds `backend/crates/orgchange/rest` against the same digest; until
 * the OpenAPI schema lands via the integrator these DTOs are the sync point —
 * any deviation from the digest is a defect on whichever side deviated.
 */
export type OrgChangeKind = "NEW" | "REORG" | "DISSOLVE";
export type OrgChangeStatus =
  | "DRAFT"
  | "PRECHECKED"
  | "IN_APPROVAL"
  | "APPROVED"
  | "APPLIED"
  | "SETTLING"
  | "ARCHIVED"
  | "REJECTED"
  | "CANCELLED";
export type OrgChangeTargetKind = "ENTITY" | "REGION" | "BRANCH" | "SITE" | "ORG_UNIT";

export interface OrgChangeTarget {
  kind: OrgChangeTargetKind;
  ref: string;
  label: string;
}

export type OrgProposalOp =
  | { op: "CREATE_REGION"; name: string }
  | { op: "RENAME_REGION"; region_id: string; name: string }
  | { op: "DEACTIVATE_REGION"; region_id: string }
  | { op: "CREATE_BRANCH"; region_id: string; name: string }
  | { op: "RENAME_BRANCH"; branch_id: string; name?: string; region_id?: string }
  | { op: "DEACTIVATE_BRANCH"; branch_id: string }
  | { op: "CREATE_SITE"; customer_id: string; name: string }
  | { op: "UPDATE_SITE"; site_id: string; fields: Record<string, unknown> }
  | { op: "REASSIGN_ORG_UNIT"; from_org_unit: string; to_org_unit: string; scope: { company: string } };

export type OrgApprovalRoleKey = "hr" | "finance" | "legal" | "executive";
export type OrgApprovalDecision = "PENDING" | "APPROVED" | "REJECTED";

export interface OrgChangeApprovalStep {
  id: string;
  step_order: number;
  role_key: OrgApprovalRoleKey;
  decision: OrgApprovalDecision;
  decided_by?: string | null;
  decided_at?: string | null;
  memo?: string | null;
}

export type OrgSettlementItemKey =
  | "TRANSFER_EMPLOYEES"
  | "POSITIONS"
  | "COST_CENTERS"
  | "CLOSE_OPEN_DOCS"
  | "ASSETS"
  | "PAYROLL_SOCIAL_FINAL";

export interface OrgChangeSettlementItem {
  id: string;
  item_key: OrgSettlementItemKey;
  label: string;
  done: boolean;
  done_by?: string | null;
  done_at?: string | null;
  memo?: string | null;
}

export interface OrgChangeEvent {
  at: string;
  actor: string;
  action: string;
  from_status?: OrgChangeStatus | null;
  to_status?: OrgChangeStatus | null;
  reason: string;
}

export interface OrgChangePreflightBlocker {
  code: string;
  label: string;
  dependent_kind: string;
  count: number;
}

export interface OrgChangePreflightWarning {
  code: string;
  label: string;
}

export interface OrgChangePreflightReport {
  computed_at: string;
  stale: boolean;
  blockers: OrgChangePreflightBlocker[];
  warnings: OrgChangePreflightWarning[];
  headcount: number;
  dependents_total: number;
}

export interface OrgChangeSummary {
  id: string;
  code: string;
  kind: OrgChangeKind;
  status: OrgChangeStatus;
  target: OrgChangeTarget;
  effective_date: string;
  reason: string;
  headcount: number;
  site_count: number;
  team_count: number;
  drafted_by: string;
  created_at: string;
  updated_at: string;
  supersedes_id?: string | null;
}

export interface OrgChangeDetail extends OrgChangeSummary {
  proposal: OrgProposalOp[];
  preflight?: OrgChangePreflightReport | null;
  approval_steps: OrgChangeApprovalStep[];
  settlement_items: OrgChangeSettlementItem[];
  events: OrgChangeEvent[];
}

export interface OrgChangePage {
  items: OrgChangeSummary[];
  total: number;
}

export interface CreateOrgChangeRequest {
  kind: OrgChangeKind;
  target: OrgChangeTarget;
  effective_date: string;
  reason: string;
  proposal: OrgProposalOp[];
}

export interface UpdateOrgChangeDraftRequest {
  kind?: OrgChangeKind;
  target?: OrgChangeTarget;
  effective_date?: string;
  reason?: string;
  proposal?: OrgProposalOp[];
}

export interface OrgEntitySummary {
  org_id: string;
  slug: string;
  name: string;
  status: string;
}

export class OrgApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "OrgApiError";
  }
}

function message(error: unknown, status: number): string {
  if (error && typeof error === "object" && "error" in error) {
    const body = error as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message;
  }
  return `Org request failed (${String(status)})`;
}

function requireData<T>(response: { data?: T; error?: unknown; response: Response }): T {
  if (response.data !== undefined) return response.data;
  throw new OrgApiError(message(response.error, response.response.status), response.response.status);
}

interface RawResult {
  data?: unknown;
  error?: unknown;
  response: Response;
}

type RawRequest = (path: string, init?: Record<string, unknown>) => Promise<RawResult>;

/**
 * The org-change routes are not in the generated OpenAPI client yet (backend
 * lane in flight; integrator owns backend/openapi + clients). This single cast
 * point keeps every call on the authenticated ConsoleApiClient (auth, refresh,
 * read-cache) and is deleted when the generated paths land.
 */
function rawClient(api: ConsoleApiClient): { GET: RawRequest; POST: RawRequest; PATCH: RawRequest } {
  const client = api as unknown as Record<"GET" | "POST" | "PATCH", RawRequest>;
  return { GET: client.GET, POST: client.POST, PATCH: client.PATCH };
}

async function typed<T>(call: Promise<RawResult>): Promise<T> {
  const result = await call;
  return requireData(result as { data?: T; error?: unknown; response: Response });
}

/** Org module transport bound to the authenticated ConsoleApiClient. */
export function createOrgApi(api: ConsoleApiClient) {
  const raw = rawClient(api);
  return {
    regions: async (signal?: AbortSignal): Promise<RegionSummary[]> => {
      const response = await api.GET("/api/v1/regions", { signal });
      return requireData(response);
    },
    branches: async (signal?: AbortSignal): Promise<BranchSummary[]> => {
      const response = await api.GET("/api/v1/branches", { signal });
      return requireData(response);
    },
    orgChart: async (signal?: AbortSignal): Promise<HrOrgChartResponse> => {
      const response = await api.GET("/api/v1/hr/org-chart", { signal });
      return requireData(response);
    },
    me: async (signal?: AbortSignal): Promise<SelfProfile> => {
      const response = await api.GET("/api/v1/users/me", { signal });
      return requireData(response);
    },
    entities: (signal?: AbortSignal) =>
      typed<OrgEntitySummary[]>(raw.GET("/api/v1/org-entities", { signal })),
    listChanges: (query?: { status?: OrgChangeStatus; kind?: OrgChangeKind; limit?: number; offset?: number }, signal?: AbortSignal) =>
      typed<OrgChangePage>(raw.GET("/api/v1/org-changes", { params: { query: query ?? {} }, signal })),
    getChange: (id: string, signal?: AbortSignal) =>
      typed<OrgChangeDetail>(raw.GET("/api/v1/org-changes/{id}", { params: { path: { id } }, signal })),
    createChange: (input: CreateOrgChangeRequest, signal?: AbortSignal) =>
      typed<OrgChangeDetail>(raw.POST("/api/v1/org-changes", { body: input, signal })),
    updateDraft: (id: string, input: UpdateOrgChangeDraftRequest, signal?: AbortSignal) =>
      typed<OrgChangeDetail>(raw.PATCH("/api/v1/org-changes/{id}", { params: { path: { id } }, body: input, signal })),
    preflight: (id: string, signal?: AbortSignal) =>
      typed<OrgChangePreflightReport>(raw.POST("/api/v1/org-changes/{id}/preflight", { params: { path: { id } }, signal })),
    submit: (id: string, signal?: AbortSignal) =>
      typed<OrgChangeDetail>(raw.POST("/api/v1/org-changes/{id}/submit", { params: { path: { id } }, signal })),
    decide: (id: string, stepId: string, input: { decision: "APPROVED" | "REJECTED"; memo?: string }, signal?: AbortSignal) =>
      typed<OrgChangeDetail>(raw.POST("/api/v1/org-changes/{id}/approval-steps/{stepId}/decision", {
        params: { path: { id, stepId } },
        body: input,
        signal,
      })),
    effectuate: (id: string, signal?: AbortSignal) =>
      typed<OrgChangeDetail>(raw.POST("/api/v1/org-changes/{id}/effectuate", { params: { path: { id } }, signal })),
    completeSettlement: (id: string, itemId: string, signal?: AbortSignal) =>
      typed<OrgChangeDetail>(raw.POST("/api/v1/org-changes/{id}/settlement-items/{itemId}/complete", {
        params: { path: { id, itemId } },
        signal,
      })),
    archive: (id: string, signal?: AbortSignal) =>
      typed<OrgChangeDetail>(raw.POST("/api/v1/org-changes/{id}/archive", { params: { path: { id } }, signal })),
    cancel: (id: string, reason: string, signal?: AbortSignal) =>
      typed<OrgChangeDetail>(raw.POST("/api/v1/org-changes/{id}/cancel", { params: { path: { id } }, body: { reason }, signal })),
  };
}

export type OrgApi = ReturnType<typeof createOrgApi>;
