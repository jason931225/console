import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { createDispatchApi, DispatchApiError } from "./dispatchApi";

function ok<T>(data: T) {
  return { data, response: new Response(null, { status: 200 }) };
}

function fail(status: number, body?: unknown) {
  return { error: body, response: new Response(null, { status }) };
}

function client() {
  return { GET: vi.fn(), POST: vi.fn() } as unknown as ConsoleApiClient;
}

describe("createDispatchApi", () => {
  it("passes keyset queue query params through the shared client", async () => {
    const api = client();
    vi.mocked(api.GET).mockResolvedValue(ok({ items: [], next_after: "cursor" }));
    const page = await createDispatchApi(api).queue({ status: "RECEIVED", limit: 10, after: "a|b" });
    expect(page.next_after).toBe("cursor");
    expect(api.GET).toHaveBeenCalledWith("/api/v1/console/dispatch/queue", {
      params: { query: { status: "RECEIVED", limit: 10, after: "a|b" } },
      signal: undefined,
    });
  });

  it("surfaces the canonical RestError envelope message and status", async () => {
    const api = client();
    vi.mocked(api.GET).mockResolvedValue(
      fail(403, { error: { code: "FORBIDDEN", message: "권한이 없습니다" } }),
    );
    const attempt = createDispatchApi(api).queue();
    await expect(attempt).rejects.toThrow("권한이 없습니다");
    await expect(attempt).rejects.toMatchObject({ name: "DispatchApiError", status: 403 });
  });

  it("rejects a shape-mismatched page instead of rendering fabricated rows", async () => {
    const api = client();
    vi.mocked(api.GET).mockResolvedValue(ok({ rows: [] }));
    await expect(createDispatchApi(api).queue()).rejects.toBeInstanceOf(DispatchApiError);
  });

  it("drops malformed audit records instead of inventing history fields", async () => {
    const api = client();
    vi.mocked(api.GET).mockResolvedValue(
      ok({
        items: [
          { id: "a1", action: "상신", target_id: "d1", occurred_at: "2026-07-24T01:00:00Z" },
          { id: "broken" },
        ],
      }),
    );
    const records = await createDispatchApi(api).history("d1");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: "a1", actor: undefined, action: "상신" });
  });

  it("encodes the dispatch id into candidate/response paths", async () => {
    const api = client();
    vi.mocked(api.GET).mockResolvedValue(ok({ items: [] }));
    await createDispatchApi(api).candidates("d/1");
    expect(api.GET).toHaveBeenCalledWith("/api/v1/p1-dispatches/d%2F1/candidates", {
      signal: undefined,
    });
  });
});
