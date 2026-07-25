import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ props: undefined as Record<string, unknown> | undefined }));

vi.mock("../comms-rail", () => ({
  CommsRailContainer: (props: Record<string, unknown>) => {
    captured.props = props;
    return <div data-testid="authenticated-comms-rail" />;
  },
}));

import { CommsRailPanel } from "./CommsRailPanel";

describe("CommsRailPanel", () => {
  it("mounts the authenticated production rail inside the existing shell chrome", () => {
    const onOpenMessengerThread = vi.fn();
    render(<CommsRailPanel accessToken="legacy-shell-token" onOpenMessengerThread={onOpenMessengerThread} />);

    expect(screen.getByTestId("authenticated-comms-rail")).toBeInTheDocument();
    expect(captured.props).toMatchObject({ embedded: true, onOpenMessengerThread });
    expect(captured.props?.copy).toEqual(expect.objectContaining({
      landmark: "커뮤니케이션",
      source: expect.objectContaining({ messenger: "메신저", mail: "메일", notifications: "알림", notices: "공지" }),
    }));
  });

  it("does not invent mail, notice, or full-screen handlers at the live shell mount", () => {
    render(<CommsRailPanel />);

    expect(captured.props).not.toHaveProperty("onOpenMailThread");
    expect(captured.props).not.toHaveProperty("onOpenNotice");
    expect(captured.props).not.toHaveProperty("onOpenFullModule");
  });
});
