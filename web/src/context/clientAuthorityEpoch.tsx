import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
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
 * advances from a layout effect, never while React is rendering a replacement.
 */
class ClientAuthorityEpochStore {
  private current: ClientAuthorityEpoch;
  private readonly listeners = new Set<() => void>();

  constructor(initialAuthorityKey: string) {
    this.current = this.createSnapshot(1, initialAuthorityKey);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ClientAuthorityEpoch => this.current;

  publish(authorityKey: string): void {
    if (this.current.authorityKey === authorityKey) return;
    this.current = this.createSnapshot(this.current.epoch + 1, authorityKey);
    for (const listener of this.listeners) listener();
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
  const [store] = useState(() => new ClientAuthorityEpochStore(key));

  // Layout effects run only for committed trees and complete before browser
  // events, so query/action continuations cannot observe a retired authority.
  useLayoutEffect(() => {
    store.publish(key);
  }, [key, store]);

  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  return (
    <ClientAuthorityEpochContext.Provider value={snapshot}>
      {children}
    </ClientAuthorityEpochContext.Provider>
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
