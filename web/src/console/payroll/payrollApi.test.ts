import { createConsoleApiClient, type ConsoleApiClient } from "../../api/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPayrollApi, PayrollApiError } from "./payrollApi";

describe("createPayrollApi", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the authenticated console client bearer and typed run endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ items: [], total: 0, limit: 50, offset: 0 }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    await createPayrollApi(createConsoleApiClient("bearer-token")).listRuns();
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toContain("/api/v1/payroll/runs");
    expect(request.headers.get("Authorization")).toBe("Bearer bearer-token");
    expect(request.headers.get("X-Auth-Transport")).toBe("cookie");
  });

  it("forwards contract-route params and bodies through the client instead of a module fetch", async () => {
    const api = {
      GET: vi.fn(),
      POST: vi.fn().mockResolvedValue({ data: { id: "ex-1" }, response: new Response(null, { status: 200 }) }),
    } as unknown as ConsoleApiClient;
    await createPayrollApi(api).resolveException("run-1", "ex-1", { action: "HOLD", reason: "계좌 재확인" });
    expect(api.POST).toHaveBeenCalledWith("/api/v1/payroll/runs/{id}/exceptions/{exId}/resolve", expect.objectContaining({
      params: { path: { id: "run-1", exId: "ex-1" } },
      body: { action: "HOLD", reason: "계좌 재확인" },
    }));
  });

  it("surfaces the canonical error envelope code instead of synthesizing success", async () => {
    const api = {
      GET: vi.fn(),
      POST: vi.fn().mockResolvedValue({
        error: { error: { code: "sod_violation", message: "denied" } },
        response: new Response(null, { status: 409 }),
      }),
    } as unknown as ConsoleApiClient;
    const failure = await createPayrollApi(api).decide("run-1", { decision: "APPROVE" }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(PayrollApiError);
    expect((failure as PayrollApiError).message).toBe("denied");
    expect((failure as PayrollApiError).code).toBe("sod_violation");
    expect((failure as PayrollApiError).status).toBe(409);
  });
});
