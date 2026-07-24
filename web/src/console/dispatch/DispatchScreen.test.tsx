import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { dispatchStrings as text } from "../../i18n/dispatch";
import type { DispatchQueueItem } from "./dispatchApi";
import type { DispatchCapabilities } from "./dispatchCapabilities";
import { DispatchScreen } from "./DispatchScreen";

const manager: DispatchCapabilities = {
  canRead: true, canRequest: true, canRespond: false, canAssign: true, canReadHistory: true,
};
const readOnly: DispatchCapabilities = {
  canRead: true, canRequest: false, canRespond: false, canAssign: false, canReadHistory: false,
};
const denied: DispatchCapabilities = {
  canRead: false, canRequest: false, canRespond: false, canAssign: false, canReadHistory: false,
};

const soon = () => new Date(Date.now() + 38 * 60000).toISOString();

const item = (over: Partial<DispatchQueueItem> = {}): DispatchQueueItem => ({
  work_order_id: "wo-1",
  request_no: "WO-2643",
  branch_id: "branch-a",
  status: "UNASSIGNED",
  priority: "P1",
  symptom: "지게차 유압 누유",
  equipment_id: "eq-1",
  customer_id: "cust-1",
  site_id: "site-1",
  target_due_at: soon(),
  updated_at: "2026-07-24T01:00:00Z",
  ...over,
});

const forcePending = () => ({
  id: "d-1",
  status: "MANAGER_FORCE_PENDING" as const,
  accept_window_ends_at: "2026-07-24T02:00:00Z",
  accepted_count: 1,
  declined_count: 1,
  target_count: 3,
  manual_call_required: true,
});

const broadcasting = (): DispatchQueueItem => item({ dispatch: forcePending() });

function ok<T>(data: T) {
  return { data, response: new Response(null, { status: 200 }) };
}

function fail(status: number, message: string) {
  return { error: { error: { code: "E", message } }, response: new Response(null, { status }) };
}

type RouteMap = Partial<Record<string, () => unknown>>;

function client(routes: RouteMap = {}) {
  const api = { GET: vi.fn(), POST: vi.fn() } as unknown as ConsoleApiClient;
  vi.mocked(api.GET).mockImplementation(((path: string) => {
    const handler = routes[path];
    if (handler) return Promise.resolve(handler());
    return Promise.resolve(ok({ items: [] }));
  }) as never);
  return api;
}

const queuePath = "/api/v1/console/dispatch/queue";
const usersPath = "/api/v1/users";
const candidatesPath = "/api/v1/p1-dispatches/d-1/candidates";
const responsesPath = "/api/v1/p1-dispatches/d-1/responses";
const auditPath = "/api/audit";

const rosterPage = () =>
  ok({
    items: [
      { id: "mech-1", display_name: "김성호" },
      { id: "mech-2", display_name: "박정비" },
    ],
    limit: 200,
    offset: 0,
    total: 2,
  });

function renderScreen(capabilities = manager, api = client({ [queuePath]: () => ok({ items: [item()] }) })) {
  return render(
    <DispatchScreen
      api={api}
      actorId="actor-1"
      capabilities={capabilities}
      sessionKey="session-a"
    />,
  );
}

describe("DispatchScreen", () => {
  it("denies an unauthorized user before fetching or exposing actions", () => {
    const api = client();
    renderScreen(denied, api);
    expect(screen.getByText(text.denied)).toBeVisible();
    expect(screen.queryByRole("button", { name: text.actions.requestDispatch })).toBeNull();
    expect(api.GET).not.toHaveBeenCalled();
  });

  it("retries an initial queue error and then renders backend rows", async () => {
    let calls = 0;
    const api = client({
      [queuePath]: () => {
        calls += 1;
        return calls === 1 ? fail(500, "서버 오류") : ok({ items: [item()] });
      },
      [usersPath]: rosterPage,
    });
    renderScreen(manager, api);
    expect(await screen.findByRole("alert")).toHaveTextContent("서버 오류");
    await userEvent.click(screen.getByRole("button", { name: text.retry }));
    expect(await screen.findByText("WO-2643")).toBeVisible();
  });

  it("states why the queue is empty and what happens next", async () => {
    renderScreen(manager, client({ [queuePath]: () => ok({ items: [] }) }));
    expect(await screen.findByText(text.empty)).toBeVisible();
  });

  it("renders exception-first stats, 미배정 chip, and SLA chip from real rows", async () => {
    const api = client({
      [queuePath]: () =>
        ok({
          items: [
            item(),
            item({
              work_order_id: "wo-2",
              request_no: "WO-2641",
              priority: "P2",
              assigned_mechanic_id: "mech-1",
              target_due_at: new Date(Date.now() + 3 * 86400000).toISOString(),
            }),
          ],
        }),
      [usersPath]: rosterPage,
    });
    renderScreen(manager, api);
    expect(await screen.findByText("WO-2643")).toBeVisible();
    const unassignedStat = screen.getByRole("button", { name: `${text.stats.unassigned} 1` });
    expect(screen.getByRole("button", { name: `${text.stats.slaImminent} 1` })).toBeVisible();
    expect(await screen.findByText("김성호")).toBeVisible();
    // Rendered twice by design: once as the row's enum chip, once as its filter.
    expect(screen.getAllByText(text.priority.P1)).toHaveLength(2);
    expect(screen.getByText(/SLA \d+분/)).toBeVisible();

    await userEvent.click(unassignedStat);
    expect(screen.queryByText("WO-2641")).toBeNull();
    expect(screen.getByText("WO-2643")).toBeVisible();
  });

  it("filters by search text down to the truthful filtered-empty state", async () => {
    renderScreen(manager, client({ [queuePath]: () => ok({ items: [item()] }) }));
    expect(await screen.findByText("WO-2643")).toBeVisible();
    await userEvent.type(screen.getByRole("searchbox", { name: text.searchLabel }), "없는검색어");
    expect(screen.getByText(text.emptyFiltered)).toBeVisible();
  });

  it("moves row focus with J/K and opens the panel with Enter", async () => {
    const api = client({
      [queuePath]: () => ok({ items: [item(), item({ work_order_id: "wo-2", request_no: "WO-2641" })] }),
    });
    renderScreen(manager, api);
    const first = await screen.findByRole("button", { name: /WO-2643/ });
    first.focus();
    await userEvent.keyboard("j");
    expect(screen.getByRole("button", { name: /WO-2641/ })).toHaveFocus();
    await userEvent.keyboard("k");
    expect(first).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("region", { name: text.panel.label })).toHaveTextContent(text.panel.due);
  });

  it("starts a broadcast from the primary action only for an eligible selection", async () => {
    const api = client({ [queuePath]: () => ok({ items: [item()] }), [usersPath]: rosterPage });
    vi.mocked(api.POST).mockResolvedValue(ok({ id: "d-9" }));
    renderScreen(manager, api);
    const primary = await screen.findByRole("button", { name: text.actions.requestDispatch });
    expect(primary).toBeDisabled();
    await userEvent.click(await screen.findByRole("button", { name: /WO-2643/ }));
    expect(primary).toBeEnabled();
    await userEvent.click(primary);
    await waitFor(() =>
      { expect(api.POST).toHaveBeenCalledWith("/api/v1/work-orders/{workOrderId}/p1-dispatch", {
        params: { path: { workOrderId: "wo-1" } },
        body: { include_region: false },
        signal: expect.anything(),
      }); },
    );
    expect(await screen.findByText(text.actions.requested("WO-2643"))).toBeVisible();
  });

  it("keeps 배차 확정 fail-closed until a candidate is picked, then force-assigns", async () => {
    let assigned = false;
    const api = client({
      [queuePath]: () =>
        ok({
          items: [
            assigned
              ? item({
                  status: "ASSIGNED",
                  assigned_mechanic_id: "mech-2",
                  dispatch: { ...forcePending(), status: "AUTO_ASSIGNED" },
                })
              : broadcasting(),
          ],
        }),
      [usersPath]: rosterPage,
      [candidatesPath]: () =>
        ok({
          items: [
            {
              mechanic_id: "mech-2",
              score_milli: 1200,
              gps_ranked: true,
              distance_meters: 12400,
              workload: { p1: 1, p2: 0, p3: 1, other: 0 },
              score_reason: "distance+workload",
            },
            {
              mechanic_id: "mech-1",
              score_milli: 3500,
              gps_ranked: false,
              workload: { p1: 2, p2: 1, p3: 0, other: 1 },
              score_reason: "schedule fallback",
              response: "DECLINE",
              responded_at: "2026-07-24T01:10:00Z",
            },
          ],
        }),
      [responsesPath]: () => ok({ items: [] }),
      [auditPath]: () => ok({ items: [] }),
    });
    vi.mocked(api.POST).mockImplementation((() => {
      assigned = true;
      return Promise.resolve(ok({ id: "d-1" }));
    }) as never);
    renderScreen(manager, api);
    await userEvent.click(await screen.findByRole("button", { name: /WO-2643/ }));

    const confirm = await screen.findByRole("button", { name: text.actions.confirmAssign });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(text.candidates.distanceKm("12.4"))).toBeVisible();
    expect(screen.getByText(text.candidates.scheduleBased)).toBeVisible();
    const declined = screen.getByRole("radio", { name: /김성호/ });
    expect(declined).toBeDisabled();

    await userEvent.click(screen.getByRole("radio", { name: /박정비/ }));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() =>
      { expect(api.POST).toHaveBeenCalledWith("/api/v1/p1-dispatches/{dispatchId}/force-assign", {
        params: { path: { dispatchId: "d-1" } },
        body: { mechanic_id: "mech-2" },
        signal: expect.anything(),
      }); },
    );
    expect(await screen.findByText(text.actions.assigned("WO-2643", "박정비"))).toBeVisible();
    expect(await screen.findByText(text.broadcast.assignedDone("박정비"))).toBeVisible();
  });

  it("omits candidates, history, and the primary action for a read-only operator", async () => {
    const api = client({
      [queuePath]: () => ok({ items: [broadcasting()] }),
      [responsesPath]: () => ok({ items: [] }),
    });
    renderScreen(readOnly, api);
    await userEvent.click(await screen.findByRole("button", { name: /WO-2643/ }));
    expect(await screen.findByText(text.responses.empty)).toBeVisible();
    expect(screen.queryByText(text.candidates.title)).toBeNull();
    expect(screen.queryByText(text.history.title)).toBeNull();
    expect(screen.queryByRole("button", { name: text.actions.requestDispatch })).toBeNull();
    expect(api.GET).not.toHaveBeenCalledWith(candidatesPath, expect.anything());
    expect(api.GET).not.toHaveBeenCalledWith(auditPath, expect.anything());
  });

  it("falls back to raw mechanic ids when the roster read is denied", async () => {
    const api = client({
      [queuePath]: () => ok({ items: [item({ assigned_mechanic_id: "mech-9" })] }),
      [usersPath]: () => fail(403, "forbidden"),
    });
    renderScreen(manager, api);
    expect(await screen.findByText("mech-9")).toBeVisible();
  });

  it("renders the audit history layer for the selected dispatch", async () => {
    const api = client({
      [queuePath]: () => ok({ items: [broadcasting()] }),
      [usersPath]: rosterPage,
      [candidatesPath]: () => ok({ items: [] }),
      [responsesPath]: () => ok({ items: [] }),
      [auditPath]: () =>
        ok({
          items: [
            { id: "a1", actor: "mech-1", action: "상신", target_id: "d-1", occurred_at: "2026-07-24T01:00:00Z" },
          ],
        }),
    });
    renderScreen(manager, api);
    await userEvent.click(await screen.findByRole("button", { name: /WO-2643/ }));
    const historySection = await screen.findByRole("region", { name: text.history.title });
    await waitFor(() => { expect(historySection).toHaveTextContent("상신"); });
    expect(historySection).toHaveTextContent("김성호");
  });

  it("peeks a linked object head and renders scope-denied resolves as absent", async () => {
    const api = client({
      [queuePath]: () => ok({ items: [item({ assigned_mechanic_id: "mech-1" })] }),
      [usersPath]: rosterPage,
    });
    vi.mocked(api.GET).mockImplementation(((path: string, init?: { params?: { path?: { kind?: string } } }) => {
      if (path === "/api/objects/{kind}/{id}") {
        const kind = init?.params?.path?.kind;
        return Promise.resolve(
          kind === "person"
            ? ok({ kind: "person", id: "mech-1", exists: true, code: null, title: "김성호", status: "active" })
            : ok({ kind, id: "x", exists: false, code: null, title: null, status: null }),
        );
      }
      if (path === queuePath) return Promise.resolve(ok({ items: [item({ assigned_mechanic_id: "mech-1" })] }));
      if (path === usersPath) return Promise.resolve(rosterPage());
      return Promise.resolve(ok({ items: [] }));
    }) as never);
    renderScreen(manager, api);
    await userEvent.click(await screen.findByRole("button", { name: /WO-2643/ }));

    await userEvent.click(screen.getByRole("button", { name: new RegExp(text.panel.crew) }));
    const dialog = await screen.findByRole("dialog", { name: text.peek.label });
    await waitFor(() => {
      expect(dialog).toHaveTextContent("김성호");
    });
    expect(dialog).toHaveTextContent(text.peek.kinds.person);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: new RegExp(text.panel.equipment) }));
    expect(await screen.findByText(text.peek.absent)).toBeVisible();
  });

  it("keeps the queue single-column responsive under the module breakpoint", () => {
    const css = readFileSync(join(process.cwd(), "src/console/dispatch/dispatch.css"), "utf8");
    const mobile = css.split("@media (max-width: 1000px)")[1];
    expect(mobile).toBeDefined();
    expect(mobile).toContain("grid-template-columns: 1fr");
  });
});
