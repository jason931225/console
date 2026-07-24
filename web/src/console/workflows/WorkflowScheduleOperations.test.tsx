import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { AuthTestProvider } from "../../test/AuthTestProvider";
import { PolicyGateProvider } from "../policy";
import { WorkflowScheduleOperations } from "./WorkflowScheduleOperations";
import type { WorkflowScheduleRun } from "./scheduleApi";

const schedule = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "평일 KPI 스냅샷",
  cron_expr: "0 9 * * 1-5",
  timezone: "Asia/Seoul",
  definition_id: "22222222-2222-4222-8222-222222222222",
  enabled: false,
  next_run_at: null,
  last_run_at: "2026-07-23T00:00:00Z",
  last_status: "FAILED" as const,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-23T00:00:00Z",
};

function api(): ConsoleApiClient {
  const GET = vi.fn(async (path: string) => {
    if (path === "/api/v1/workflow-studio/schedules")
      return { data: { items: [schedule] }, response: new Response() };
    if (path === "/api/v1/workflow-studio/schedules/{id}/runs")
      return {
        data: {
          items: [
            {
              run_id: "33333333-3333-4333-8333-333333333333",
              status: "FAILED",
              definition_id: schedule.definition_id,
              definition_version: 3,
              started_at: "2026-07-23T00:00:00Z",
              failed_at: "2026-07-23T00:01:00Z",
            },
          ],
        },
        response: new Response(),
      };
    throw new Error(`unexpected GET ${path}`);
  });
  const POST = vi.fn(async () => ({
    data: {
      cron_expr: schedule.cron_expr,
      timezone: schedule.timezone,
      fire_times: ["2026-07-27T00:00:00Z"],
    },
    response: new Response(),
  }));
  const PATCH = vi.fn(async () => ({
    data: { ...schedule, enabled: true, next_run_at: "2026-07-27T00:00:00Z" },
    response: new Response(),
  }));
  return { GET, POST, PATCH } as unknown as ConsoleApiClient;
}

function renderPanel(client = api()) {
  const result = render(
    <AuthTestProvider
      session={{
        access_token: "test",
        org_id: "org-1",
        user_id: "u-1",
        roles: ["SUPER_ADMIN"],
        feature_grants: [],
      }}
      overrides={{ api: client }}
    >
      <PolicyGateProvider gate={{ can: () => true }}>
        <WorkflowScheduleOperations />
      </PolicyGateProvider>
    </AuthTestProvider>,
  );
  return { ...result, client };
}

describe("WorkflowScheduleOperations", () => {
  it("loads tenant-authorized schedule, future occurrences, and immutable schedule run history", async () => {
    renderPanel();
    expect(
      await screen.findByRole("button", { name: "평일 KPI 스냅샷 선택" }),
    ).toBeVisible();
    expect(screen.getByText("다음 실행 없음")).toBeVisible();
    expect(await screen.findByText("2026-07-27T00:00:00Z")).toBeVisible();
    expect(screen.getByText("FAILED")).toBeVisible();
  });

  it("enables a durable schedule once, then reloads authoritative server state", async () => {
    const { client } = renderPanel();
    await userEvent.click(
      await screen.findByRole("button", { name: "예약 활성화" }),
    );
    await waitFor(() => expect(client.PATCH).toHaveBeenCalledTimes(1));
    expect(client.PATCH).toHaveBeenCalledWith(
      "/api/v1/workflow-studio/schedules/{id}",
      {
        params: { path: { id: schedule.id } },
        body: { enabled: true },
      },
    );
    await waitFor(() => expect(client.GET).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("button", { name: "예약 활성화" })).toBeVisible();
  });

  it("renders a denied mutation as a truthful error without changing the schedule locally", async () => {
    const client = api();
    vi.mocked(client.PATCH).mockResolvedValue({
      data: undefined,
      error: { error: { message: "denied", code: "forbidden" } },
      response: new Response(undefined, { status: 403 }),
    } as never);
    renderPanel(client);
    await userEvent.click(
      await screen.findByRole("button", { name: "예약 활성화" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "예약 변경이 거부되었습니다",
    );
    expect(screen.getByRole("button", { name: "예약 활성화" })).toBeVisible();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("WorkflowScheduleOperations scope fences", () => {
  it("rejects a deferred prior-session schedule list after an A→B switch", async () => {
    const first = deferred<{ data: { items: typeof schedule[] }; response: Response }>();
    const second = deferred<{ data: { items: typeof schedule[] }; response: Response }>();
    const GET = vi.fn().mockImplementation((path: string) => {
      if (path !== "/api/v1/workflow-studio/schedules") throw new Error(`unexpected GET ${path}`);
      return GET.mock.calls.length === 1 ? first.promise : second.promise;
    });
    const client = { GET, POST: vi.fn(), PATCH: vi.fn() } as unknown as ConsoleApiClient;
    const sessionA = { access_token: "token-a", org_id: "org-a", user_id: "a", roles: ["SUPER_ADMIN"], feature_grants: [] };
    const sessionB = { ...sessionA, access_token: "token-b", org_id: "org-b", user_id: "b" };
    const view = render(
      <AuthTestProvider session={sessionA} overrides={{ api: client }}>
        <PolicyGateProvider gate={{ can: () => true }}><WorkflowScheduleOperations /></PolicyGateProvider>
      </AuthTestProvider>,
    );
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(1));

    view.rerender(
      <AuthTestProvider session={sessionB} overrides={{ api: client }}>
        <PolicyGateProvider gate={{ can: () => true }}><WorkflowScheduleOperations /></PolicyGateProvider>
      </AuthTestProvider>,
    );
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
    first.resolve({ data: { items: [{ ...schedule, label: "A 전용 예약" }] }, response: new Response() });
    await Promise.resolve();
    expect(screen.queryByText("A 전용 예약")).toBeNull();

    second.resolve({ data: { items: [{ ...schedule, label: "B 전용 예약" }] }, response: new Response() });
    expect(await screen.findByText("B 전용 예약")).toBeVisible();
    expect(screen.queryByText("A 전용 예약")).toBeNull();
  });

  it("clears preview and history together when the selected schedule detail request fails", async () => {
    const GET = vi.fn(async (path: string) => {
      if (path === "/api/v1/workflow-studio/schedules") return { data: { items: [schedule] }, response: new Response() };
      if (path === "/api/v1/workflow-studio/schedules/{id}/runs") return { data: undefined, error: { error: { message: "conflict", code: "conflict" } }, response: new Response(undefined, { status: 409 }) };
      throw new Error(`unexpected GET ${path}`);
    });
    const POST = vi.fn(async () => ({ data: { cron_expr: schedule.cron_expr, timezone: schedule.timezone, fire_times: ["2026-07-30T00:00:00Z"] }, response: new Response() }));
    const client = { GET, POST, PATCH: vi.fn() } as unknown as ConsoleApiClient;
    renderPanel(client);

    expect(await screen.findByRole("alert")).toHaveTextContent("예약 상태가 변경되었습니다");
    expect(screen.queryByText("2026-07-30T00:00:00Z")).toBeNull();
    expect(screen.getByText("예정된 실행이 없습니다.")).toBeVisible();
    expect(screen.getByText("실행 기록 없음")).toBeVisible();
  });

  it("rejects late preview and history results after selecting another schedule", async () => {
    const scheduleB = {
      ...schedule,
      id: "44444444-4444-4444-8444-444444444444",
      label: "월말 정산",
      cron_expr: "0 18 28-31 * *",
    };
    const firstPreview = deferred<{ data: { cron_expr: string; timezone: string; fire_times: string[] }; response: Response }>();
    const firstRuns = deferred<{ data: { items: WorkflowScheduleRun[] }; response: Response }>();
    const secondPreview = deferred<{ data: { cron_expr: string; timezone: string; fire_times: string[] }; response: Response }>();
    const secondRuns = deferred<{ data: { items: WorkflowScheduleRun[] }; response: Response }>();
    const GET = vi.fn((path: string, options?: { params?: { path?: { id?: string } } }) => {
      if (path === "/api/v1/workflow-studio/schedules") return Promise.resolve({ data: { items: [schedule, scheduleB] }, response: new Response() });
      if (path === "/api/v1/workflow-studio/schedules/{id}/runs")
        return options?.params?.path?.id === schedule.id ? firstRuns.promise : secondRuns.promise;
      throw new Error(`unexpected GET ${path}`);
    });
    const POST = vi.fn((_: string, options: { body: { cron_expr: string } }) =>
      options.body.cron_expr === schedule.cron_expr ? firstPreview.promise : secondPreview.promise,
    );
    const client = { GET, POST, PATCH: vi.fn() } as unknown as ConsoleApiClient;
    renderPanel(client);

    await screen.findByRole("button", { name: "월말 정산 선택" });
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "월말 정산 선택" }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(2));

    secondPreview.resolve({ data: { cron_expr: scheduleB.cron_expr, timezone: scheduleB.timezone, fire_times: ["2026-07-31T09:00:00Z"] }, response: new Response() });
    secondRuns.resolve({ data: { items: [] }, response: new Response() });
    expect(await screen.findByText("2026-07-31T09:00:00Z")).toBeVisible();

    firstPreview.resolve({ data: { cron_expr: schedule.cron_expr, timezone: schedule.timezone, fire_times: ["2026-07-27T00:00:00Z"] }, response: new Response() });
    firstRuns.resolve({ data: { items: [{ run_id: "late-a", status: "FAILED", definition_id: schedule.definition_id, definition_version: 3, started_at: "2026-07-27T00:00:00Z", failed_at: "2026-07-27T00:01:00Z" }] }, response: new Response() });
    await Promise.resolve();

    expect(screen.queryByText("2026-07-27T00:00:00Z")).toBeNull();
    expect(screen.queryByText(/late-a/)).toBeNull();
  });
});
