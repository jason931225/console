import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { AuthTestProvider } from "../../test/AuthTestProvider";
import { PolicyGateProvider } from "../policy";
import { WorkflowScheduleOperations } from "./WorkflowScheduleOperations";

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
