import { describe, expect, it } from "vitest";

import { linkKey, rowTarget, sameLink, timeLabel } from "./notifModel";

const objectLink = { type: "object", kind: "approval_run", id: "run-1" } as const;

describe("notif link model", () => {
  it("keys object and screen links distinctly and symmetrically", () => {
    expect(linkKey(objectLink)).toBe("object:approval_run:run-1");
    expect(linkKey({ type: "screen", screen: "sales" })).toBe("screen:sales");
    expect(sameLink(objectLink, { ...objectLink })).toBe(true);
    expect(sameLink(objectLink, { type: "screen", screen: "sales" })).toBe(false);
  });

  it("drills object links to the source object", () => {
    expect(rowTarget(objectLink)).toEqual({ type: "object", kind: "approval_run", id: "run-1" });
  });

  it("navigates only evidence-exposed screens (ADR-0025)", () => {
    expect(rowTarget({ type: "screen", screen: "sales" })).toEqual({ type: "screen", path: "/console/sales" });
    // Mounted-but-dark and unknown screens both stay ack-able non-links.
    expect(rowTarget({ type: "screen", screen: "mywork" })).toBeUndefined();
    expect(rowTarget({ type: "screen", screen: "not-a-screen" })).toBeUndefined();
  });

  it("formats a compact row timestamp and passes unparsable values through", () => {
    expect(timeLabel("2026-07-24T09:00:00Z")).toMatch(/\d/);
    expect(timeLabel("nonsense")).toBe("nonsense");
  });
});
