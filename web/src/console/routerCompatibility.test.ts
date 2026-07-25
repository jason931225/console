import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const routerPackage = ["react", "router"].join("-");
const retiredRouterPackage = `${routerPackage}-dom`;
const moduleSources = [
  "./directory/DirectoryScreenBody.tsx",
  "./evaluation/EvaluationScreen.tsx",
  "./evaluation/EvaluationScreen.test.tsx",
  "./notif/NotifScreen.tsx",
  "./notif/NotifScreen.test.tsx",
  "./org/OrgConsoleRoute.tsx",
  "./payroll/PayrollScreen.tsx",
  "./payroll/PayrollScreen.test.tsx",
  "./recruiting/RecruitingScreenBody.tsx",
  "./recruiting/RecruitingScreenBody.test.tsx",
];

describe("PR490 router compatibility", () => {
  it("keeps the remaining module surfaces on the React Router v8 package", () => {
    for (const sourcePath of moduleSources) {
      const source = readFileSync(fileURLToPath(new URL(sourcePath, import.meta.url)), "utf8");
      expect(source).not.toContain(retiredRouterPackage);
      expect(source).toContain(routerPackage);
    }
  });
});
