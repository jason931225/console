import {
  createContext,
  useContext,
  useInsertionEffect,
  useMemo,
  useState,
} from "react";

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

const unavailableRuntimeFence: RuntimeFence = Object.freeze({
  status: "unavailable",
});

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

/**
 * Provider-local committed state. It is created for an initial mount only and
 * advances from an insertion effect, never while React is rendering a replacement.
 */
class ClientAuthorityEpochStore {
  private current: ClientAuthorityEpoch | undefined;

  createProspective(authorityKey: string): ClientAuthorityEpoch {
    if (this.current?.authorityKey === authorityKey) return this.current;
    return this.createSnapshot((this.current?.epoch ?? 0) + 1, authorityKey);
  }

  publish(snapshot: ClientAuthorityEpoch): void {
    if (this.current === snapshot) return;
    this.current = snapshot;
  }

  retire(snapshot: ClientAuthorityEpoch): void {
    if (this.current !== snapshot) return;
    this.current = undefined;
  }

  private createSnapshot(
    epoch: number,
    authorityKey: string,
  ): ClientAuthorityEpoch {
    return Object.freeze({
      epoch,
      authorityKey,
      runtimeFence: unavailableRuntimeFence,
      isCurrent: (candidate: ClientAuthorityEpoch) => this.current === candidate,
    });
  }
}

function CommittedAuthorityScope({
  children,
  snapshot,
  store,
}: {
  children: React.ReactNode;
  snapshot: ClientAuthorityEpoch;
  store: ClientAuthorityEpochStore;
}) {
  // Insertion effects run for committed trees before any layout effects. This
  // retires the prior scope before descendants can perform layout-time work.
  useInsertionEffect(() => {
    store.publish(snapshot);
    return () => {
      store.retire(snapshot);
    };
  }, [snapshot, store]);

  return (
    <ClientAuthorityEpochContext.Provider value={snapshot}>
      {children}
    </ClientAuthorityEpochContext.Provider>
  );
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
  const [store] = useState(() => new ClientAuthorityEpochStore());
  const snapshot = useMemo(
    () => store.createProspective(key),
    [key, store],
  );

  return (
    <CommittedAuthorityScope key={key} snapshot={snapshot} store={store}>
      {children}
    </CommittedAuthorityScope>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useClientAuthorityEpoch(): ClientAuthorityEpoch {
  const epoch = useContext(ClientAuthorityEpochContext);
  if (!epoch) {
    throw new Error(
      "useClientAuthorityEpoch must be used inside <ClientAuthorityEpochProvider>",
    );
  }
  return epoch;
}
