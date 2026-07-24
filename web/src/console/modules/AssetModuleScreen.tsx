import { useMemo } from "react";

import { useAuth } from "../../context/auth";
import { AssetWorkspace } from "../asset/AssetWorkspace";

const READ_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "EXECUTIVE", "MECHANIC", "RECEPTIONIST"]);
const MANAGE_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "EXECUTIVE"]);
const COST_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "EXECUTIVE"]);

/**
 * Asset is deliberately a self-contained vertical: every row, event and amount
 * comes from an equipment API response. The shell owns registry wiring; this
 * adapter only translates the authenticated session into local capabilities.
 */
export function AssetModuleScreen() {
  const { api, session } = useAuth();
  const capabilities = useMemo(() => {
    const roles = session?.roles ?? [];
    const grants = new Set(session?.feature_grants ?? []);
    const hasRole = (allowed: Set<string>) => roles.some((role) => allowed.has(role));
    return {
      canRead: grants.has("work_order_read_all") || hasRole(READ_ROLES),
      canManage: grants.has("equipment_manage") || hasRole(MANAGE_ROLES),
      canReadCost: grants.has("equipment_cost_ledger_read") || hasRole(COST_ROLES),
    };
  }, [session?.feature_grants, session?.roles]);

  if (!capabilities.canRead) return null;
  return <AssetWorkspace api={api} capabilities={capabilities} />;
}
