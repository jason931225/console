import { useAuth } from "../../context/auth";
import { DispatchScreen } from "./DispatchScreen";
import { deriveDispatchCapabilities } from "./dispatchCapabilities";
import type { DispatchRouteContract } from "./routeContract";
import { useDispatchConsoleAuthz } from "./useDispatchConsoleAuthz";

/**
 * Module-owned route/body adapters. Shared registration (nav, screen registry)
 * remains intentionally outside this module (consolidation-owned).
 */
export function DispatchConsoleRoute({ branchId }: DispatchRouteContract) {
  return <DispatchConsoleMount branchId={branchId} />;
}

/**
 * Zero-prop registry adapter: the queue endpoint applies the caller's branch
 * scope in SQL, so the registry mount narrows nothing client-side.
 */
export function DispatchScreenBody() {
  return <DispatchConsoleMount />;
}

function DispatchConsoleMount({ branchId }: { branchId?: string }) {
  const { api, session } = useAuth();
  const authz = useDispatchConsoleAuthz();
  const capabilities = deriveDispatchCapabilities(authz, branchId);

  return (
    <DispatchScreen
      api={api}
      branchId={branchId}
      actorId={session?.user_id}
      capabilities={capabilities}
      sessionKey={session?.client_session_incarnation ?? session?.access_token}
    />
  );
}
