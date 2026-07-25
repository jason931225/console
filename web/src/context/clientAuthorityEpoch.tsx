import { createContext, useContext, useMemo, useRef } from "react";

import { useAuth } from "./auth";

export type RuntimeFence = Readonly<{
  /** A backend build identity is required before a runtime fence can exist. */
  status: "unavailable";
}>;

export interface ClientAuthorityEpoch {
  /** Monotonically increases within this provider when its authority scope changes. */
  readonly epoch: number;
  /** Stable, non-secret partition key for the current client authority scope. */
  readonly authorityKey: string;
  /**
   * Deliberately absent until the server supplies an exact backend build identity.
   * A client-side value would not prove which runtime handled a request.
   */
  readonly runtimeFenceKey?: string;
  readonly runtimeFence: RuntimeFence;
  /** True only while this exact immutable snapshot remains the current scope. */
  readonly isCurrent: (snapshot: ClientAuthorityEpoch) => boolean;
}

const ClientAuthorityEpochContext = createContext<ClientAuthorityEpoch | null>(
  null,
);

function authorityScopeKey({
  sessionIncarnation,
  userId,
  orgId,
  roles,
  groupRoles,
  featureGrants,
  branches,
  isPlatform,
  tenant,
  workspaceKey,
}: {
  sessionIncarnation?: string;
  userId?: string;
  orgId?: string;
  roles?: readonly string[];
  groupRoles?: readonly string[];
  featureGrants?: readonly string[];
  branches?: readonly string[];
  isPlatform?: boolean;
  tenant?: {
    incarnation?: string;
    orgId: string;
    role: string;
    mode?: string;
    source?: string;
  };
  workspaceKey?: string;
}): string {
  return JSON.stringify({
    sessionIncarnation: sessionIncarnation ?? null,
    userId: userId ?? null,
    orgId: orgId ?? null,
    roles: roles ?? [],
    groupRoles: groupRoles ?? [],
    featureGrants: featureGrants ?? [],
    branches: branches ?? [],
    isPlatform: isPlatform ?? false,
    tenant: tenant ?? null,
    workspaceKey: workspaceKey ?? null,
  });
}

export function ClientAuthorityEpochProvider({
  children,
  workspaceKey,
}: {
  children: React.ReactNode;
  /** Current workspace identity; replacing it forms a query/action fence. */
  workspaceKey?: string;
}) {
  const { session, viewAs } = useAuth();
  const previousKeyRef = useRef<string | undefined>(undefined);
  const epochRef = useRef(0);
  const currentSnapshotRef = useRef<ClientAuthorityEpoch | undefined>(undefined);

  const key = authorityScopeKey({
    sessionIncarnation: session?.client_session_incarnation,
    userId: session?.user_id,
    orgId: session?.org_id,
    roles: session?.roles,
    groupRoles: session?.group_roles,
    featureGrants: session?.feature_grants,
    branches: session?.branches,
    isPlatform: session?.isPlatform,
    tenant: viewAs
      ? {
          incarnation: viewAs.client_session_incarnation,
          orgId: viewAs.actingOrgId,
          role: viewAs.actingRole,
          mode: viewAs.mode,
          source: viewAs.source,
        }
      : undefined,
    workspaceKey,
  });

  const snapshot = useMemo(() => {
    if (previousKeyRef.current !== key) {
      previousKeyRef.current = key;
      epochRef.current += 1;
    }

    const nextSnapshot = Object.freeze({
      epoch: epochRef.current,
      authorityKey: key,
      runtimeFence: Object.freeze({ status: "unavailable" as const }),
      isCurrent: (candidate: ClientAuthorityEpoch) =>
        currentSnapshotRef.current === candidate,
    });
    currentSnapshotRef.current = nextSnapshot;
    return nextSnapshot;
  }, [key]);

  return (
    <ClientAuthorityEpochContext.Provider value={snapshot}>
      {children}
    </ClientAuthorityEpochContext.Provider>
  );
}

export function useClientAuthorityEpoch(): ClientAuthorityEpoch {
  const epoch = useContext(ClientAuthorityEpochContext);
  if (!epoch) {
    throw new Error(
      "useClientAuthorityEpoch must be used inside <ClientAuthorityEpochProvider>",
    );
  }
  return epoch;
}
