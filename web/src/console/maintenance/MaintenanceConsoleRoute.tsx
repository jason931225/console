import { useAuth } from "../../context/auth";
import { MaintenanceScreen } from "./MaintenanceScreen";
import { deriveMaintenanceCapabilities } from "./maintenanceCapabilities";
import { useMaintenanceConsoleAuthz } from "./useMaintenanceConsoleAuthz";

/**
 * Module-owned route/body adapter. It consumes the console policy authz
 * projection, while shared registration remains intentionally outside this module.
 */
export function MaintenanceConsoleRoute({ branchId }: { branchId: string }) {
  return <MaintenanceConsoleBody branchId={branchId} />;
}

export function MaintenanceConsoleBody({ branchId }: { branchId: string }) {
  const { api, session } = useAuth();
  const authz = useMaintenanceConsoleAuthz();
  const capabilities = deriveMaintenanceCapabilities(authz, branchId);

  return (
    <MaintenanceScreen
      api={api}
      branchId={branchId}
      actorId={session?.user_id}
      capabilities={capabilities}
      sessionKey={session?.client_session_incarnation ?? session?.access_token}
    />
  );
}
