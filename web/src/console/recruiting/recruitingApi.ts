import type { ConsoleApiClient } from "../../api/client";

/**
 * Recruiting transport bound to the authenticated ConsoleApiClient.
 *
 * CONTRACT: `/api/v1/recruiting` per the CAP-RECRUITING scout digest — the
 * backend lane builds the same contract in parallel, so every path, field, and
 * error shape here is the sync point (deviation is a defect, not a preference).
 *
 * The generated `@maintenance/api-client-ts` schema predates the recruiting
 * tag, so the paths below are retyped module-locally against the contract and
 * the client is cast once at this boundary. When the integrator regenerates
 * the clients, swap these DTOs for `components["schemas"]` and delete the cast.
 */

export type RecruitPostingStatus = "DRAFT" | "PUBLISHED" | "CLOSED";
export type RecruitEmploymentType = "REGULAR" | "RESIDENT_SHIFT" | "PART_TIME" | "POOL_DAILY";
export type RecruitPostingScope = "INTERNAL" | "EXTERNAL";
export type RecruitApplicantStage = "APPLIED" | "SCREENING" | "INTERVIEW" | "OFFER" | "HIRED";
export type RecruitAssessmentScore = "SUITABLE" | "NEUTRAL" | "UNSUITABLE";
export type RecruitRejectReason =
  | "CAREER_SHORTFALL"
  | "ROLE_MISMATCH"
  | "COMP_MISMATCH"
  | "ACCEPTED_ELSEWHERE"
  | "OTHER";
export type RecruitOfferStatus = "EXTENDED" | "SUPERSEDED" | "WITHDRAWN" | "ACCEPTED" | "DECLINED";
export type RecruitOfferPeriod = "MONTHLY" | "DAILY";
export type RecruitOfferDecision = "ACCEPTED" | "DECLINED";

export interface RecruitStageCounts {
  applied: number;
  screening: number;
  interview: number;
  offer: number;
}

export interface RecruitPostingView {
  id: string;
  code: string;
  role_title: string;
  company: string;
  worksite: string;
  employment_type: RecruitEmploymentType;
  scope: RecruitPostingScope;
  headcount: number;
  hired_count: number;
  deadline: string | null;
  requirements: string[];
  status: RecruitPostingStatus;
  position_ref: string | null;
  updated_at: string;
  stage_counts: RecruitStageCounts;
}

export interface RecruitAssessmentView {
  score: RecruitAssessmentScore;
  assessed_by: string;
  assessed_at: string;
}

export interface RecruitApplicantView {
  id: string;
  applicant_no: string;
  posting_id: string;
  name: string;
  stage: RecruitApplicantStage;
  hold: boolean;
  doc_requested: boolean;
  rejected: boolean;
  reject_reason: RecruitRejectReason | null;
  assessment: RecruitAssessmentView | null;
  profile_lines: string[];
  source_document: string | null;
  hired_employee_id: string | null;
  applied_at: string;
  updated_at: string;
}

export interface RecruitOfferView {
  id: string;
  version: number;
  amount: string;
  amount_period: RecruitOfferPeriod;
  reply_deadline: string | null;
  status: RecruitOfferStatus;
  created_at: string;
}

export interface RecruitStageEventView {
  id: string;
  action: string;
  occurred_at: string;
  actor_name?: string | null;
  note?: string | null;
}

export interface RecruitPreflightCheck {
  key: string;
  ok: boolean;
  note: string;
}

export interface RecruitPreflightResponse {
  checks: RecruitPreflightCheck[];
  publishable: boolean;
}

export interface RecruitPostingListResponse {
  items: RecruitPostingView[];
}

export interface RecruitPostingDetailResponse {
  posting: RecruitPostingView;
  applicants: RecruitApplicantView[];
}

export interface RecruitApplicantDetailResponse {
  applicant: RecruitApplicantView;
  offers: RecruitOfferView[];
  events: RecruitStageEventView[];
}

export interface RecruitTalentPoolItem {
  applicant_no: string;
  name: string;
  role_title: string;
  reason: RecruitRejectReason;
  rejected_at: string;
}

export interface RecruitTalentPoolResponse {
  items: RecruitTalentPoolItem[];
}

export interface CreateRecruitPostingRequest {
  role_title: string;
  company: string;
  worksite: string;
  employment_type: RecruitEmploymentType;
  scope: RecruitPostingScope;
  headcount: number;
  deadline?: string;
  requirements: string[];
  position_ref?: string;
}

export interface HireRecruitApplicantRequest {
  employee_number: string;
  phone: string;
  org_unit: string;
  position: string;
  site: string;
  home_branch_id: string;
  base_pay: string;
}

export interface HireRecruitApplicantResponse {
  employee_id: string;
  applicant: RecruitApplicantView;
  posting: RecruitPostingView;
}

export class RecruitingApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly checks?: RecruitPreflightCheck[],
  ) {
    super(message);
    this.name = "RecruitingApiError";
  }
}

export function isDenied(error: unknown): boolean {
  return error instanceof RecruitingApiError && (error.status === 401 || error.status === 403);
}

export function isConflict(error: unknown): boolean {
  return error instanceof RecruitingApiError && error.status === 409;
}

function envelopeMessage(error: unknown, status: number): string {
  if (error && typeof error === "object" && "error" in error) {
    const body = error as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message;
  }
  return `Recruiting request failed (${String(status)})`;
}

function parseChecks(error: unknown): RecruitPreflightCheck[] | undefined {
  if (!error || typeof error !== "object") return undefined;
  const raw = (error as { checks?: unknown }).checks;
  if (!Array.isArray(raw)) return undefined;
  const checks: RecruitPreflightCheck[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const check = item as Record<string, unknown>;
    if (typeof check.key !== "string" || typeof check.ok !== "boolean") continue;
    checks.push({ key: check.key, ok: check.ok, note: typeof check.note === "string" ? check.note : "" });
  }
  return checks.length > 0 ? checks : undefined;
}

interface TransportInit {
  params?: {
    path?: Record<string, string>;
    query?: Record<string, string | undefined>;
  };
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

interface TransportResult {
  data?: unknown;
  error?: unknown;
  response: Response;
}

/** The verbs of the openapi-fetch client, untyped over the recruiting paths. */
interface RecruitingTransport {
  GET: (path: string, init?: TransportInit) => Promise<TransportResult>;
  POST: (path: string, init?: TransportInit) => Promise<TransportResult>;
  PUT: (path: string, init?: TransportInit) => Promise<TransportResult>;
}

function requireData(result: TransportResult): unknown {
  if (result.response.ok && result.data !== undefined) return result.data;
  throw new RecruitingApiError(
    envelopeMessage(result.error, result.response.status),
    result.response.status,
    parseChecks(result.error),
  );
}

function requireOk(result: TransportResult): void {
  if (result.response.ok) return;
  throw new RecruitingApiError(
    envelopeMessage(result.error, result.response.status),
    result.response.status,
    parseChecks(result.error),
  );
}

export interface RecruitPostingListQuery {
  status?: RecruitPostingStatus;
  scope?: RecruitPostingScope;
}

/** Recruiting transport bound to the authenticated ConsoleApiClient. */
export function createRecruitingApi(api: ConsoleApiClient) {
  // ponytail: one boundary cast — the generated client predates the recruiting
  // tag; retarget to typed generated paths when clients/ts regenerates.
  const transport = api as unknown as RecruitingTransport;
  return {
    listPostings: async (query?: RecruitPostingListQuery, signal?: AbortSignal) => {
      const result = await transport.GET("/api/v1/recruiting/postings", {
        params: { query: { status: query?.status, scope: query?.scope } },
        signal,
      });
      return requireData(result) as RecruitPostingListResponse;
    },
    getPosting: async (id: string, signal?: AbortSignal) => {
      const result = await transport.GET("/api/v1/recruiting/postings/{id}", {
        params: { path: { id } },
        signal,
      });
      return requireData(result) as RecruitPostingDetailResponse;
    },
    createPosting: async (input: CreateRecruitPostingRequest, signal?: AbortSignal) => {
      const result = await transport.POST("/api/v1/recruiting/postings", { body: input, signal });
      return requireData(result) as RecruitPostingView;
    },
    updatePosting: async (
      id: string,
      input: CreateRecruitPostingRequest & { expected_updated_at: string },
      signal?: AbortSignal,
    ) => {
      const result = await transport.PUT("/api/v1/recruiting/postings/{id}", {
        params: { path: { id } },
        body: input,
        signal,
      });
      return requireData(result) as RecruitPostingView;
    },
    preflightPosting: async (id: string, signal?: AbortSignal) => {
      const result = await transport.POST("/api/v1/recruiting/postings/{id}/preflight", {
        params: { path: { id } },
        signal,
      });
      return requireData(result) as RecruitPreflightResponse;
    },
    publishPosting: async (
      id: string,
      input: { attest_exposure_scope: boolean; expected_updated_at: string },
      signal?: AbortSignal,
    ) => {
      const result = await transport.POST("/api/v1/recruiting/postings/{id}/publish", {
        params: { path: { id } },
        body: input,
        signal,
      });
      requireOk(result);
    },
    closePosting: async (id: string, input: { expected_updated_at: string }, signal?: AbortSignal) => {
      const result = await transport.POST("/api/v1/recruiting/postings/{id}/close", {
        params: { path: { id } },
        body: input,
        signal,
      });
      requireOk(result);
    },
    createApplicant: async (
      postingId: string,
      input: { name: string; profile_lines: string[]; source_document?: string },
      signal?: AbortSignal,
    ) => {
      const result = await transport.POST("/api/v1/recruiting/postings/{id}/applicants", {
        params: { path: { id: postingId } },
        body: input,
        signal,
      });
      return requireData(result) as RecruitApplicantView;
    },
    getApplicant: async (id: string, signal?: AbortSignal) => {
      const result = await transport.GET("/api/v1/recruiting/applicants/{id}", {
        params: { path: { id } },
        signal,
      });
      return requireData(result) as RecruitApplicantDetailResponse;
    },
    advanceApplicant: async (id: string, input: { expected_updated_at: string }, signal?: AbortSignal) => {
      const result = await transport.POST("/api/v1/recruiting/applicants/{id}/advance", {
        params: { path: { id } },
        body: input,
        signal,
      });
      requireOk(result);
    },
    assessApplicant: async (id: string, input: { score: RecruitAssessmentScore }, signal?: AbortSignal) => {
      const result = await transport.POST("/api/v1/recruiting/applicants/{id}/assess", {
        params: { path: { id } },
        body: input,
        signal,
      });
      requireOk(result);
    },
    holdApplicant: async (id: string, input: { hold: boolean }, signal?: AbortSignal) => {
      const result = await transport.POST("/api/v1/recruiting/applicants/{id}/hold", {
        params: { path: { id } },
        body: input,
        signal,
      });
      requireOk(result);
    },
    requestDocuments: async (id: string, signal?: AbortSignal) => {
      const result = await transport.POST("/api/v1/recruiting/applicants/{id}/request-documents", {
        params: { path: { id } },
        signal,
      });
      requireOk(result);
    },
    rejectApplicant: async (
      id: string,
      input: { reason: RecruitRejectReason; note?: string },
      signal?: AbortSignal,
    ) => {
      const result = await transport.POST("/api/v1/recruiting/applicants/{id}/reject", {
        params: { path: { id } },
        body: input,
        signal,
      });
      requireOk(result);
    },
    reinstateApplicant: async (id: string, signal?: AbortSignal) => {
      const result = await transport.POST("/api/v1/recruiting/applicants/{id}/reinstate", {
        params: { path: { id } },
        signal,
      });
      requireOk(result);
    },
    extendOffer: async (
      id: string,
      input: { amount: string; amount_period: RecruitOfferPeriod; reply_deadline: string },
      signal?: AbortSignal,
    ) => {
      const result = await transport.POST("/api/v1/recruiting/applicants/{id}/offer", {
        params: { path: { id } },
        body: input,
        signal,
      });
      return requireData(result) as RecruitOfferView;
    },
    adjustOffer: async (
      id: string,
      input: { amount: string; reply_deadline?: string },
      signal?: AbortSignal,
    ) => {
      const result = await transport.POST("/api/v1/recruiting/offers/{id}/adjust", {
        params: { path: { id } },
        body: input,
        signal,
      });
      return requireData(result) as RecruitOfferView;
    },
    withdrawOffer: async (id: string, input: { reason: string }, signal?: AbortSignal) => {
      const result = await transport.POST("/api/v1/recruiting/offers/{id}/withdraw", {
        params: { path: { id } },
        body: input,
        signal,
      });
      requireOk(result);
    },
    recordOfferReply: async (
      id: string,
      input: { decision: RecruitOfferDecision },
      signal?: AbortSignal,
    ) => {
      const result = await transport.POST("/api/v1/recruiting/offers/{id}/record-reply", {
        params: { path: { id } },
        body: input,
        signal,
      });
      requireOk(result);
    },
    hireApplicant: async (id: string, input: HireRecruitApplicantRequest, signal?: AbortSignal) => {
      const result = await transport.POST("/api/v1/recruiting/applicants/{id}/hire", {
        params: { path: { id } },
        body: input,
        signal,
      });
      return requireData(result) as HireRecruitApplicantResponse;
    },
    listTalentPool: async (signal?: AbortSignal) => {
      const result = await transport.GET("/api/v1/recruiting/talent-pool", { signal });
      return requireData(result) as RecruitTalentPoolResponse;
    },
    listBranches: async (signal?: AbortSignal) => {
      // Branch reference data for the hire handshake — already in the generated client.
      const result = await api.GET("/api/v1/branches", { signal });
      if (result.data !== undefined) return result.data;
      throw new RecruitingApiError(
        envelopeMessage(result.error, result.response.status),
        result.response.status,
      );
    },
  };
}

export type RecruitingApi = ReturnType<typeof createRecruitingApi>;
