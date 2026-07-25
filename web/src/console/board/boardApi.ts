import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../api/client";

export type NoticeProgress = components["schemas"]["NoticeProgress"];
export type BranchSummary = components["schemas"]["BranchSummary"];

export type NoticeCategory = "general" | "legal" | "hr_order" | "training";
export type NoticeAudienceScope = "org" | "branches";

export interface NoticeAudienceBranch {
  id: string;
  name: string;
}

export interface NoticeMyReceipt {
  acknowledged_at: string | null;
}

/**
 * CAP-BOARD-CONSOLE contract `NoticeSummary` — the generated schema plus the
 * gap-closure fields the parallel backend lane adds (category, scoped
 * audience, caller receipt, embedded manager progress). The generated client
 * catches up at integration (see the frontend integration manifest); until
 * then this type IS the sync-point contract.
 */
export type BoardNotice = components["schemas"]["NoticeSummary"] & {
  category: NoticeCategory;
  audience_scope: NoticeAudienceScope;
  /** Empty for `org` scope. */
  audience_branches: NoticeAudienceBranch[];
  /** Null when the caller is not a snapshot recipient (e.g. drafts). */
  my_receipt: NoticeMyReceipt | null;
  /** Present only for NoticeManage callers. */
  progress: NoticeProgress | null;
};

export interface NoticeAudienceInput {
  scope: NoticeAudienceScope;
  /** Required non-empty iff `scope === "branches"`. */
  branch_ids?: string[];
}

export interface CreateNoticeDraftInput {
  title: string;
  body: string;
  category?: NoticeCategory;
  audience?: NoticeAudienceInput;
}

export interface UpdateNoticeDraftInput {
  title?: string;
  body?: string;
  category?: NoticeCategory;
  audience?: NoticeAudienceInput;
}

export interface NoticeReceipt {
  recipient_user_id: string;
  display_name: string;
  acknowledged_at: string | null;
}

export interface NoticeReceiptPage {
  items: NoticeReceipt[];
  total: number;
}

export class BoardApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "BoardApiError";
  }
}

function message(error: unknown, status: number): string {
  if (error && typeof error === "object" && "error" in error) {
    const body = error as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message;
  }
  return `Board request failed (${String(status)})`;
}

function requireData<T>(response: { data?: T; error?: unknown; response: Response }): T {
  if (response.data !== undefined) return response.data;
  throw new BoardApiError(message(response.error, response.response.status), response.response.status);
}

interface RawResult {
  data?: unknown;
  error?: unknown;
  response: Response;
}

type RawCall = (
  path: string,
  init?: {
    params?: { path?: Record<string, string>; query?: Record<string, unknown> };
    body?: unknown;
    signal?: AbortSignal;
  },
) => Promise<RawResult>;

/** Notice transport bound to the authenticated ConsoleApiClient. */
export function createBoardApi(api: ConsoleApiClient) {
  // ponytail: PATCH /notices/{id} and GET /notices/{id}/receipts are
  // contract-ahead of the generated client; these raw casts (and the
  // `as BoardNotice` widenings below) drop at the integrator's client regen.
  const raw = api as unknown as Record<"GET" | "PATCH", RawCall>;
  return {
    list: async (limit?: number, signal?: AbortSignal) => {
      const response = await api.GET("/api/v1/notices", {
        params: { query: limit === undefined ? {} : { limit } },
        signal,
      });
      return requireData(response) as unknown as BoardNotice[];
    },
    get: async (id: string, signal?: AbortSignal) => {
      const response = await api.GET("/api/v1/notices/{id}", {
        params: { path: { id } },
        signal,
      });
      return requireData(response) as unknown as BoardNotice;
    },
    createDraft: async (input: CreateNoticeDraftInput, signal?: AbortSignal) => {
      const response = await api.POST("/api/v1/notices", { body: input, signal });
      return requireData(response) as unknown as BoardNotice;
    },
    updateDraft: async (id: string, input: UpdateNoticeDraftInput, signal?: AbortSignal) => {
      const response = await raw.PATCH("/api/v1/notices/{id}", {
        params: { path: { id } },
        body: input,
        signal,
      });
      return requireData(response) as BoardNotice;
    },
    publish: async (id: string, signal?: AbortSignal) => {
      const response = await api.POST("/api/v1/notices/{id}/publish", {
        params: { path: { id } },
        signal,
      });
      return requireData(response) as unknown as BoardNotice;
    },
    ack: async (id: string, signal?: AbortSignal) => {
      const response = await api.POST("/api/v1/notices/{id}/ack", {
        params: { path: { id } },
        signal,
      });
      if (!response.response.ok) {
        throw new BoardApiError(message(response.error, response.response.status), response.response.status);
      }
    },
    progress: async (id: string, signal?: AbortSignal) => {
      const response = await api.GET("/api/v1/notices/{id}/progress", {
        params: { path: { id } },
        signal,
      });
      return requireData(response);
    },
    receipts: async (
      id: string,
      query: { acknowledged?: boolean; limit: number; offset: number },
      signal?: AbortSignal,
    ) => {
      const response = await raw.GET("/api/v1/notices/{id}/receipts", {
        params: {
          path: { id },
          query: {
            ...(query.acknowledged === undefined ? {} : { acknowledged: query.acknowledged }),
            limit: query.limit,
            offset: query.offset,
          },
        },
        signal,
      });
      return requireData(response) as NoticeReceiptPage;
    },
    listBranches: async (signal?: AbortSignal) => {
      const response = await api.GET("/api/v1/branches", { signal });
      return requireData(response);
    },
  };
}

export type BoardApi = ReturnType<typeof createBoardApi>;
