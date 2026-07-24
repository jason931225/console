export type DispatchFeature =
  | "work_order_read_all"
  | "work_order_create"
  | "work_order_start"
  | "assignee_manage"
  | "audit_log_read";

/** Canonical policy gate exposes typed feature, permission, and branch queries. */
export interface DispatchPolicyGate {
  allows: (query: {
    feature: DispatchFeature;
    branch?: string;
    minPermission: "allow";
  }) => boolean;
}

export interface DispatchCapabilities {
  /** Queue lens + responses read (work_order_read_all). */
  canRead: boolean;
  /** Start a P1 dispatch broadcast (work_order_create). */
  canRequest: boolean;
  /** Accept/decline an own offer (work_order_start) — technician persona. */
  canRespond: boolean;
  /** Candidates read + force-assign (assignee_manage). */
  canAssign: boolean;
  /** Platform audit history layer (audit_log_read). */
  canReadHistory: boolean;
}

/**
 * Pure projection adapter matching the dispatch backend feature gates. The
 * queue itself is branch-filtered in SQL server-side; `branchId` narrows the
 * affordance check only when the mount contract pins one branch.
 */
export function deriveDispatchCapabilities(
  gate: DispatchPolicyGate,
  branchId?: string,
): DispatchCapabilities {
  const allows = (feature: DispatchFeature) =>
    gate.allows({ feature, ...(branchId ? { branch: branchId } : {}), minPermission: "allow" });
  return {
    canRead: allows("work_order_read_all"),
    canRequest: allows("work_order_create"),
    canRespond: allows("work_order_start"),
    canAssign: allows("assignee_manage"),
    canReadHistory: allows("audit_log_read"),
  };
}
