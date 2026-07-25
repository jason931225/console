import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { AuthContextValue, AuthSession, ViewAsState } from "./auth";
import { AuthContext } from "./auth";
import {
  ClientAuthorityEpochProvider,
  useClientAuthorityEpoch,
} from "./clientAuthorityEpoch";

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

function authValue(
  activeSession: AuthSession | undefined,
  viewAs: ViewAsState | undefined = undefined,
): AuthContextValue {
  return {
    session: activeSession,
    viewAs,
  } as AuthContextValue;
}

function wrapper(
  value: AuthContextValue,
  workspaceKey?: string,
): ({ children }: { children: ReactNode }) => ReactNode {
  return ({ children }) => (
    <AuthContext.Provider value={value}>
      <ClientAuthorityEpochProvider workspaceKey={workspaceKey}>
        {children}
      </ClientAuthorityEpochProvider>
    </AuthContext.Provider>
  );
}

describe("ClientAuthorityEpochProvider", () => {
  it("projects immutable client authority facts without inventing a backend runtime fence", () => {
    const { result } = renderHook(() => useClientAuthorityEpoch(), {
      wrapper: wrapper(authValue(session()), "workspace-1"),
    });

    expect(result.current.authorityKey).toContain("incarnation-1");
    expect(result.current.runtimeFence).toEqual({ status: "unavailable" });
    expect(result.current.runtimeFenceKey).toBeUndefined();
    expect(Object.isFrozen(result.current)).toBe(true);
    expect(Object.isFrozen(result.current.runtimeFence)).toBe(true);
  });

  it("synchronously replaces the epoch for session, tenant, branch, and workspace boundaries", () => {
    let value = authValue(session());
    let workspaceKey = "workspace-1";
    const { result, rerender } = renderHook(() => useClientAuthorityEpoch(), {
      wrapper: ({ children }) => (
        <AuthContext.Provider value={value}>
          <ClientAuthorityEpochProvider workspaceKey={workspaceKey}>
            {children}
          </ClientAuthorityEpochProvider>
        </AuthContext.Provider>
      ),
    });

    const initial = result.current;

    act(() => {
      value = authValue(session({ client_session_incarnation: "incarnation-2" }));
      rerender();
    });
    const replacedSession = result.current;
    expect(replacedSession.epoch).toBeGreaterThan(initial.epoch);
    expect(replacedSession.isCurrent(initial)).toBe(false);

    const tenantContext: ViewAsState = {
      token: "tenant-token",
      client_session_incarnation: "tenant-incarnation",
      actingOrgId: "tenant-2",
      actingOrgName: "Tenant two",
      actingRole: "ADMIN",
      platformSession: session({ client_session_incarnation: "incarnation-2" }),
    };
    act(() => {
      value = authValue(
        session({ client_session_incarnation: "incarnation-2" }),
        tenantContext,
      );
      rerender();
    });
    const replacedTenant = result.current;
    expect(replacedTenant.isCurrent(replacedSession)).toBe(false);

    act(() => {
      value = authValue(
        session({
          client_session_incarnation: "tenant-incarnation",
          branches: ["branch-2"],
        }),
        tenantContext,
      );
      rerender();
    });
    const replacedBranch = result.current;
    expect(replacedBranch.isCurrent(replacedTenant)).toBe(false);

    act(() => {
      workspaceKey = "workspace-2";
      rerender();
    });
    expect(result.current.isCurrent(replacedBranch)).toBe(false);
  });
});
