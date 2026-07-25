import { act, render, renderHook } from "@testing-library/react";
import {
  startTransition,
  Suspense,
  useLayoutEffect,
  useState,
} from "react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { AuthContextValue, AuthSession, ViewAsState } from "./auth";
import { AuthContext } from "./auth";
import {
  ClientAuthorityEpochProvider,
  useClientAuthorityEpoch,
} from "./clientAuthorityEpoch";
import type { ClientAuthorityEpoch } from "./clientAuthorityEpoch";

function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    access_token: "token",
    client_session_incarnation: "incarnation-1",
    user_id: "user-1",
    org_id: "tenant-1",
    branches: ["branch-1"],
    ...overrides,
  };
}

function viewAs(overrides: Partial<ViewAsState> = {}): ViewAsState {
  return {
    token: "tenant-token",
    client_session_incarnation: "tenant-incarnation",
    actingOrgId: "tenant-2",
    actingOrgName: "Tenant two",
    actingRole: "ADMIN",
    platformSession: session(),
    ...overrides,
  };
}

function authValue(
  activeSession: AuthSession | undefined,
  activeViewAs?: ViewAsState,
): AuthContextValue {
  return {
    session: activeSession,
    viewAs: activeViewAs,
  } as AuthContextValue;
}

function renderEpoch(
  initialValue: AuthContextValue = authValue(session()),
  initialWorkspaceKey = "workspace-1",
) {
  let value = initialValue;
  let workspaceKey = initialWorkspaceKey;
  const rendered = renderHook(() => useClientAuthorityEpoch(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <AuthContext.Provider value={value}>
        <ClientAuthorityEpochProvider workspaceKey={workspaceKey}>
          {children}
        </ClientAuthorityEpochProvider>
      </AuthContext.Provider>
    ),
  });

  return {
    ...rendered,
    replace(nextValue: AuthContextValue, nextWorkspaceKey = workspaceKey) {
      act(() => {
        value = nextValue;
        workspaceKey = nextWorkspaceKey;
        rendered.rerender();
      });
      return rendered.result.current;
    },
  };
}

function expectRetired(
  before: ClientAuthorityEpoch,
  after: ClientAuthorityEpoch,
) {
  expect(after.epoch).toBeGreaterThan(before.epoch);
  expect(after.isCurrent(before)).toBe(false);
  expect(before.isCurrent(before)).toBe(false);
}

describe("ClientAuthorityEpochProvider", () => {
  it("projects immutable client authority facts without inventing a backend runtime fence", () => {
    const { result } = renderEpoch();

    expect(result.current.authorityKey).toContain("incarnation-1");
    expect(result.current.runtimeFence).toEqual({ status: "unavailable" });
    expect(result.current.runtimeFenceKey).toBeUndefined();
    expect(Object.isFrozen(result.current)).toBe(true);
    expect(Object.isFrozen(result.current.runtimeFence)).toBe(true);
  });

  it("retires the prior snapshot for a session-only replacement", () => {
    const epoch = renderEpoch();
    const before = epoch.result.current;
    const after = epoch.replace(authValue(session({ user_id: "user-2" })));

    expectRetired(before, after);
  });

  it("retires the prior snapshot for an incarnation-only replacement", () => {
    const epoch = renderEpoch();
    const before = epoch.result.current;
    const after = epoch.replace(
      authValue(session({ client_session_incarnation: "incarnation-2" })),
    );

    expectRetired(before, after);
  });

  it("retires the prior snapshot for a tenant-only replacement", () => {
    const tenantA = viewAs({ actingOrgId: "tenant-a" });
    const tenantB = viewAs({ actingOrgId: "tenant-b" });
    const epoch = renderEpoch(authValue(session(), tenantA));
    const before = epoch.result.current;
    const after = epoch.replace(authValue(session(), tenantB));

    expectRetired(before, after);
  });

  it("retires the prior snapshot for a branch-only replacement", () => {
    const epoch = renderEpoch();
    const before = epoch.result.current;
    const after = epoch.replace(authValue(session({ branches: ["branch-2"] })));

    expectRetired(before, after);
  });

  it("retires the prior snapshot for a workspace-only replacement", () => {
    const epoch = renderEpoch();
    const before = epoch.result.current;
    const after = epoch.replace(authValue(session()), "workspace-2");

    expectRetired(before, after);
  });

  it("never revives an earlier snapshot when authority returns from B to A", () => {
    const epoch = renderEpoch(authValue(session()), "workspace-a");
    const firstA = epoch.result.current;
    const middleB = epoch.replace(authValue(session()), "workspace-b");
    const secondA = epoch.replace(authValue(session()), "workspace-a");

    expect(secondA.authorityKey).toBe(firstA.authorityKey);
    expect(secondA.epoch).toBeGreaterThan(middleB.epoch);
    expect(secondA.isCurrent(firstA)).toBe(false);
    expect(secondA.isCurrent(middleB)).toBe(false);
    expect(firstA.isCurrent(firstA)).toBe(false);
    expect(middleB.isCurrent(middleB)).toBe(false);
    expect(secondA.isCurrent(secondA)).toBe(true);
  });

  it("does not retire the committed snapshot for an uncommitted replacement render", () => {
    let beginSuspendedReplacement: (() => void) | undefined;
    let committedSnapshot: ClientAuthorityEpoch | undefined;
    const never = new Promise<never>(() => {});
    const suspendedRender = Object.assign(new Error("suspended render"), {
      then: never.then.bind(never),
    });

    function CommitProbe() {
      const epoch = useClientAuthorityEpoch();
      useLayoutEffect(() => {
        committedSnapshot = epoch;
      }, [epoch]);
      return null;
    }

    function SuspendWhen({ suspended }: { suspended: boolean }) {
      if (suspended) throw suspendedRender;
      return null;
    }

    function Harness() {
      const [replacement, setReplacement] = useState(false);
      beginSuspendedReplacement = () => {
        startTransition(() => {
          setReplacement(true);
        });
      };
      return (
        <AuthContext.Provider
          value={authValue(
            session({
              client_session_incarnation: replacement
                ? "incarnation-2"
                : "incarnation-1",
            }),
          )}
        >
          <ClientAuthorityEpochProvider workspaceKey="workspace-1">
            <CommitProbe />
            <Suspense fallback={null}>
              <SuspendWhen suspended={replacement} />
            </Suspense>
          </ClientAuthorityEpochProvider>
        </AuthContext.Provider>
      );
    }

    render(<Harness />);
    const before = committedSnapshot;
    if (!before) throw new Error("Initial authority epoch did not commit");

    act(() => {
      beginSuspendedReplacement?.();
    });

    expect(before.isCurrent(before)).toBe(true);
  });
});
