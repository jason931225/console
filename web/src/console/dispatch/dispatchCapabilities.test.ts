import { describe, expect, it } from "vitest";

import { deriveDispatchCapabilities, type DispatchFeature } from "./dispatchCapabilities";

function gateOf(allowed: DispatchFeature[], expectBranch?: string) {
  const seen: (string | undefined)[] = [];
  return {
    seen,
    gate: {
      allows: (query: { feature: DispatchFeature; branch?: string; minPermission: "allow" }) => {
        seen.push(query.branch);
        if (expectBranch !== undefined && query.branch !== expectBranch) return false;
        return allowed.includes(query.feature);
      },
    },
  };
}

describe("deriveDispatchCapabilities", () => {
  it("maps each backend feature onto exactly one affordance", () => {
    const { gate } = gateOf(["work_order_read_all", "assignee_manage"]);
    expect(deriveDispatchCapabilities(gate)).toEqual({
      canRead: true,
      canRequest: false,
      canRespond: false,
      canAssign: true,
      canReadHistory: false,
    });
  });

  it("narrows every query to the pinned branch when the mount provides one", () => {
    const { gate, seen } = gateOf(["work_order_read_all"], "branch-a");
    const capabilities = deriveDispatchCapabilities(gate, "branch-a");
    expect(capabilities.canRead).toBe(true);
    expect(seen.every((branch) => branch === "branch-a")).toBe(true);
  });

  it("queries without a branch for the registry mount (server scopes in SQL)", () => {
    const { gate, seen } = gateOf(["work_order_read_all"]);
    deriveDispatchCapabilities(gate);
    expect(seen.every((branch) => branch === undefined)).toBe(true);
  });
});
