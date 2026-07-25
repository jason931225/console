import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import type { AuthSession } from "../../context/auth";
import { dispatchStrings as text } from "../../i18n/dispatch";
import { AuthTestProvider } from "../../test/AuthTestProvider";
import type { DispatchQueueItem } from "./dispatchApi";
import { DispatchScreenBody } from "./DispatchConsoleRoute";

const session = (incarnation = "session-a"): AuthSession => ({
  access_token: "token",
  user_id: "actor-1",
  org_id: "org-1",
  client_session_incarnation: incarnation,
});

const row: DispatchQueueItem = {
  work_order_id: "wo-1",
  request_no: "WO-2643",
  branch_id: "branch-a",
  status: "UNASSIGNED",
  priority: "P1",
  symptom: "지게차 유압 누유",
  equipment_id: "eq-1",
  customer_id: "cust-1",
  site_id: "site-1",
  updated_at: "2026-07-24T01:00:00Z",
};

const ok = <T,>(data: T) => ({ data, response: new Response(null, { status: 200 }) });

function client() {
  const api = { GET: vi.fn(), POST: vi.fn() } as unknown as ConsoleApiClient;
  vi.mocked(api.GET).mockImplementation(((path: string) =>
    Promise.resolve(
      path === "/api/v1/console/dispatch/queue" ? ok({ items: [row] }) : ok({ items: [] }),
    )) as never);
  return api;
}

function authzResponse(capabilities: unknown[]) {
  return new Response(
    JSON.stringify({
      roles: ["BRANCH_MANAGER"],
      branch_scope: { kind: "branches", branches: ["branch-a"] },
      capabilities,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function mounted(api: ConsoleApiClient) {
  return (
    <AuthTestProvider session={session()} overrides={{ api }}>
      <DispatchScreenBody />
    </AuthTestProvider>
  );
}

describe("DispatchScreenBody", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mounts the queue from the parsed MeAuthzResponse allow capability", async () => {
    const api = client();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        authzResponse([
          { feature: "work_order_read_all", permission: "allow", branch_scope: { kind: "branches", branches: ["branch-a"] } },
          { feature: "assignee_manage", permission: "allow", branch_scope: { kind: "branches", branches: ["branch-a"] } },
        ]),
      ),
    );
    render(mounted(api));
    expect(await screen.findByText("WO-2643")).toBeVisible();
    await waitFor(() =>
      { expect(api.GET).toHaveBeenCalledWith("/api/v1/console/dispatch/queue", expect.anything()); },
    );
    expect(screen.queryByRole("button", { name: text.actions.requestDispatch })).toBeNull();
  });

  it("denies request_only capabilities without fetching the queue", async () => {
    const api = client();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        authzResponse([
          { feature: "work_order_read_all", permission: "request_only", branch_scope: { kind: "all" } },
        ]),
      ),
    );
    render(mounted(api));
    expect(await screen.findByText(text.denied)).toBeVisible();
    expect(api.GET).not.toHaveBeenCalled();
  });
});
