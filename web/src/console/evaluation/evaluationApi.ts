import type { ConsoleApiClient } from "../../api/client";

/**
 * HR evaluation transport — `/api/v1/evaluation` (backend/crates/evaluation,
 * dark-landing lane). The backend router is built in a parallel lane and is NOT
 * yet in `backend/openapi` / the generated clients, so the DTOs below are typed
 * locally against the shared capability contract. When the consolidation
 * integrator regenerates the clients, these aliases collapse onto
 * `components["schemas"]` and the `RawEvaluationTransport` cast disappears.
 */

export type EvaluationGrade = "S" | "A" | "B" | "C" | "D";
export type EvaluationCycleKind = "REGULAR" | "PROBATION";
export type EvaluationCycleStage =
  | "DRAFT"
  | "OPEN"
  | "CALIBRATION"
  | "FINALIZED"
  | "ARCHIVED";
export type EvaluationSubjectState =
  | "ENROLLED"
  | "IN_REVIEW"
  | "REVIEWED"
  | "CALIBRATED"
  | "FINALIZED";
export type EvaluationReviewKind = "SELF" | "MANAGER";
export type EvaluationReviewStatus = "DRAFT" | "SUBMITTED";
export type EvaluationMetricKind = "KPI" | "ATTENDANCE" | "TASK" | "CUSTOM";
export type EvaluationEvidenceKind =
  | "ATTENDANCE"
  | "WORK_ORDER"
  | "APPROVAL"
  | "KPI"
  | "OTHER";

export interface EvaluationCycleSummary {
  id: string;
  name: string;
  kind: EvaluationCycleKind;
  period_label: string;
  due_date: string;
  stage: EvaluationCycleStage;
  subjects_total: number;
  manager_submitted: number;
  self_submitted: number;
  calibrated: number;
  finalized: number;
  created_at: string;
}

export interface EvaluationUnitProgress {
  org_unit: string;
  total: number;
  manager_submitted: number;
}

export interface EvaluationSubjectSummary {
  id: string;
  cycle_id: string;
  employee_id: string;
  employee_name: string;
  org_unit?: string | null;
  manager_user_id: string;
  state: EvaluationSubjectState;
  final_grade?: EvaluationGrade | null;
  rv_code?: string | null;
}

export interface EvaluationCycleDetail extends EvaluationCycleSummary {
  opened_at?: string | null;
  calibration_started_at?: string | null;
  finalized_at?: string | null;
  archived_at?: string | null;
  created_by: string;
  progress_by_unit: EvaluationUnitProgress[];
  subjects: EvaluationSubjectSummary[];
}

export interface EvaluationCyclePage {
  items: EvaluationCycleSummary[];
  limit: number;
  offset: number;
  total: number;
}

export interface EvaluationGoal {
  id: string;
  title: string;
  metric_kind: EvaluationMetricKind;
  target_label: string;
  weight_pct: number;
  sort_order: number;
}

export interface EvaluationEvidenceLink {
  id: string;
  object_kind: EvaluationEvidenceKind;
  object_ref: string;
  label: string;
  sort_order: number;
}

export interface EvaluationReview {
  id: string;
  subject_id: string;
  kind: EvaluationReviewKind;
  status: EvaluationReviewStatus;
  evaluator_user_id: string;
  grade?: EvaluationGrade | null;
  note?: string | null;
  evidence_links: EvaluationEvidenceLink[];
  submitted_at?: string | null;
  updated_at: string;
}

export interface EvaluationSubjectDetail extends EvaluationSubjectSummary {
  goals: EvaluationGoal[];
  reviews: EvaluationReview[];
  calibrated_grade?: EvaluationGrade | null;
  calibration_reason?: string | null;
  calibrated_by?: string | null;
  calibrated_at?: string | null;
  finalized_at?: string | null;
}

export interface EvaluationPreflightReport {
  next_transition: EvaluationCycleStage | null;
  blockers: string[];
  advisories: string[];
}

export interface EvaluationTaskSummary {
  subject_id: string;
  cycle_id: string;
  cycle_name: string;
  period_label: string;
  due_date: string;
  kind: EvaluationReviewKind;
  employee_id: string;
  employee_name: string;
}

export interface EvaluationTaskPage {
  items: EvaluationTaskSummary[];
  limit: number;
  offset: number;
  total: number;
}

export interface EvaluationLedgerEntry {
  rv_code: string;
  cycle_id: string;
  cycle_name: string;
  period_label: string;
  final_grade: EvaluationGrade;
  finalized_at: string;
  subject_id: string;
}

export interface EvaluationLedgerPage {
  items: EvaluationLedgerEntry[];
}

export interface CreateEvaluationCycleRequest {
  name: string;
  kind: EvaluationCycleKind;
  period_label: string;
  due_date: string;
}

export interface AddEvaluationSubjectRequest {
  cycle_id: string;
  employee_id: string;
  manager_user_id: string;
}

export interface EvaluationGoalInput {
  title: string;
  metric_kind: EvaluationMetricKind;
  target_label: string;
  weight_pct: number;
}

export interface ReplaceEvaluationGoalsRequest {
  goals: EvaluationGoalInput[];
}

export interface EvaluationEvidenceLinkInput {
  object_kind: EvaluationEvidenceKind;
  object_ref: string;
  label: string;
  sort_order: number;
}

export interface SaveEvaluationReviewRequest {
  grade?: EvaluationGrade | null;
  note?: string | null;
  evidence_links: EvaluationEvidenceLinkInput[];
}

export interface CalibrateEvaluationRequest {
  final_grade: EvaluationGrade;
  reason?: string;
}

export interface ListEvaluationCyclesQuery {
  stage?: EvaluationCycleStage;
  limit?: number;
  offset?: number;
}

export class EvaluationApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EvaluationApiError";
  }
}

function message(error: unknown, status: number): string {
  if (error && typeof error === "object" && "error" in error) {
    const body = error as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message;
  }
  return `Evaluation request failed (${String(status)})`;
}

/** Build the module's typed error from a canonical `{error:{message}}` body. */
export function evaluationApiErrorFrom(error: unknown, status: number): EvaluationApiError {
  return new EvaluationApiError(message(error, status), status);
}

interface RawResult {
  data?: unknown;
  error?: unknown;
  response: Response;
}

interface RawInit {
  params?: {
    path?: Record<string, string>;
    query?: Record<string, string | number | undefined>;
  };
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Structural view of the openapi-fetch client for paths the generated spec does
 * not carry yet. Runtime behavior (URL templating, auth, refresh, caching) is
 * identical to typed calls; only compile-time path checking is deferred to the
 * client regeneration.
 */
interface RawEvaluationTransport {
  GET(path: string, init?: RawInit): Promise<RawResult>;
  POST(path: string, init?: RawInit): Promise<RawResult>;
  PUT(path: string, init?: RawInit): Promise<RawResult>;
}

function requireData(result: RawResult): unknown {
  if (result.data !== undefined) return result.data;
  throw new EvaluationApiError(
    message(result.error, result.response.status),
    result.response.status,
  );
}

/** Evaluation transport bound to the authenticated ConsoleApiClient. */
export function createEvaluationApi(api: ConsoleApiClient) {
  const raw = api as unknown as RawEvaluationTransport;
  return {
    listCycles: async (query?: ListEvaluationCyclesQuery, signal?: AbortSignal) => {
      const result = await raw.GET("/api/v1/evaluation/cycles", {
        params: { query: { ...query } },
        signal,
      });
      return requireData(result) as EvaluationCyclePage;
    },
    createCycle: async (input: CreateEvaluationCycleRequest, signal?: AbortSignal) => {
      const result = await raw.POST("/api/v1/evaluation/cycles", { body: input, signal });
      return requireData(result) as EvaluationCycleDetail;
    },
    getCycle: async (cycleId: string, signal?: AbortSignal) => {
      const result = await raw.GET("/api/v1/evaluation/cycles/{cycleId}", {
        params: { path: { cycleId } },
        signal,
      });
      return requireData(result) as EvaluationCycleDetail;
    },
    getPreflight: async (cycleId: string, signal?: AbortSignal) => {
      const result = await raw.GET("/api/v1/evaluation/cycles/{cycleId}/preflight", {
        params: { path: { cycleId } },
        signal,
      });
      return requireData(result) as EvaluationPreflightReport;
    },
    openCycle: async (cycleId: string, signal?: AbortSignal) => {
      const result = await raw.POST("/api/v1/evaluation/cycles/{cycleId}/open", {
        params: { path: { cycleId } },
        signal,
      });
      return requireData(result) as EvaluationCycleDetail;
    },
    startCalibration: async (cycleId: string, signal?: AbortSignal) => {
      const result = await raw.POST("/api/v1/evaluation/cycles/{cycleId}/start-calibration", {
        params: { path: { cycleId } },
        signal,
      });
      return requireData(result) as EvaluationCycleDetail;
    },
    finalizeCycle: async (cycleId: string, signal?: AbortSignal) => {
      const result = await raw.POST("/api/v1/evaluation/cycles/{cycleId}/finalize", {
        params: { path: { cycleId } },
        signal,
      });
      return requireData(result) as EvaluationCycleDetail;
    },
    archiveCycle: async (cycleId: string, signal?: AbortSignal) => {
      const result = await raw.POST("/api/v1/evaluation/cycles/{cycleId}/archive", {
        params: { path: { cycleId } },
        signal,
      });
      return requireData(result) as EvaluationCycleDetail;
    },
    addSubject: async (input: AddEvaluationSubjectRequest, signal?: AbortSignal) => {
      const result = await raw.POST("/api/v1/evaluation/subjects", { body: input, signal });
      return requireData(result) as EvaluationSubjectDetail;
    },
    getSubject: async (subjectId: string, signal?: AbortSignal) => {
      const result = await raw.GET("/api/v1/evaluation/subjects/{subjectId}", {
        params: { path: { subjectId } },
        signal,
      });
      return requireData(result) as EvaluationSubjectDetail;
    },
    replaceGoals: async (
      subjectId: string,
      input: ReplaceEvaluationGoalsRequest,
      signal?: AbortSignal,
    ) => {
      const result = await raw.PUT("/api/v1/evaluation/subjects/{subjectId}/goals", {
        params: { path: { subjectId } },
        body: input,
        signal,
      });
      return requireData(result) as EvaluationSubjectDetail;
    },
    saveReview: async (
      subjectId: string,
      kind: EvaluationReviewKind,
      input: SaveEvaluationReviewRequest,
      signal?: AbortSignal,
    ) => {
      const result = await raw.PUT("/api/v1/evaluation/subjects/{subjectId}/reviews/{kind}", {
        params: { path: { subjectId, kind: kind.toLowerCase() } },
        body: input,
        signal,
      });
      return requireData(result) as EvaluationReview;
    },
    submitReview: async (
      subjectId: string,
      kind: EvaluationReviewKind,
      signal?: AbortSignal,
    ) => {
      const result = await raw.POST(
        "/api/v1/evaluation/subjects/{subjectId}/reviews/{kind}/submit",
        { params: { path: { subjectId, kind: kind.toLowerCase() } }, signal },
      );
      return requireData(result) as EvaluationReview;
    },
    calibrateSubject: async (
      subjectId: string,
      input: CalibrateEvaluationRequest,
      signal?: AbortSignal,
    ) => {
      const result = await raw.POST("/api/v1/evaluation/subjects/{subjectId}/calibrate", {
        params: { path: { subjectId } },
        body: input,
        signal,
      });
      return requireData(result) as EvaluationSubjectDetail;
    },
    myTasks: async (signal?: AbortSignal) => {
      const result = await raw.GET("/api/v1/evaluation/my-tasks", { signal });
      return requireData(result) as EvaluationTaskPage;
    },
    employeeReviews: async (employeeId: string, signal?: AbortSignal) => {
      const result = await raw.GET("/api/v1/evaluation/employees/{employeeId}/reviews", {
        params: { path: { employeeId } },
        signal,
      });
      return requireData(result) as EvaluationLedgerPage;
    },
  };
}

export type EvaluationApi = ReturnType<typeof createEvaluationApi>;
