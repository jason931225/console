import { useEffect, useState } from "react";

import { useActiveBranchId, useAuth } from "../../context/auth";
import {
  DENY_ALL_PROJECTION,
  makePolicyGate,
  parseAuthzResponse,
  type PolicyGate,
} from "../policy/authz";
import { AssetWorkspace } from "../asset/AssetWorkspace";

function useAssetGate(): PolicyGate {
  const { api, session } = useAuth();
  const key = `${session?.client_session_incarnation ?? ""}:${session?.access_token ?? ""}`;
  const [gate, setGate] = useState(() => makePolicyGate(DENY_ALL_PROJECTION, false));

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      setGate(makePolicyGate(DENY_ALL_PROJECTION, false));
    });
    void api.GET("/api/v1/me/authz", { signal: controller.signal }).then((response) => {
      if (controller.signal.aborted || !response.data) return;
      setGate(makePolicyGate(parseAuthzResponse(response.data), true));
    }).catch(() => {
      // The asset surface intentionally stays deny-by-omission on authz failure.
    });
    return () => { controller.abort(); };
  }, [api, key]);

  return gate;
}

/** Authoritative authz-backed asset screen. JWT claims are never used as UI authority. */
export function AssetModuleScreen() {
  const { api, session } = useAuth();
  const activeBranchId = useActiveBranchId();
  const gate = useAssetGate();
  const sessionKey = `${session?.client_session_incarnation ?? ""}:${session?.access_token ?? ""}`;
  const allows = (feature: string, branch?: string) => gate.ready && gate.allows({ feature, branch });

  if (!gate.ready) return <main className="min-h-full bg-canvas p-6 text-sm text-steel" role="status">권한을 확인하는 중입니다.</main>;
  if (!allows("work_order_read_all", activeBranchId)) return null;
  return <AssetWorkspace
    key={sessionKey}
    api={api}
    sessionKey={sessionKey}
    capabilities={{
      canRead: true,
      canManage: (branch) => allows("equipment_manage", branch),
      canReadCost: (branch) => allows("equipment_cost_ledger_read", branch),
      canImport: (branch) => allows("master_list_import", branch),
    }}
  />;
}
