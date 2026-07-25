/**
 * Shell adapter for the authenticated communications rail.
 *
 * ConsoleShell owns the visible rail chrome, responsive drawer, and concrete
 * messenger navigation. This adapter deliberately owns no fetching or local
 * optimistic state: CommsRailContainer fences requests by auth scope and
 * rereads the server after every mutation.
 */
import { formatKoreanTime } from "../../lib/datetime";
import { ko } from "../../i18n/ko";
import { CommsRailContainer, type CommsRailCopy } from "../comms-rail";
import { overviewStrings, railCategoryStrings } from "../screens/overview/strings";
import type { CommsRailApi } from "../screens/overview/overviewApi";

export interface CommsRailPanelProps {
  /** Retained for the shell's public contract; authenticated transport reads useAuth(). */
  accessToken?: string;
  /** Retained for compatibility; the live rail only accepts the authenticated transport. */
  api?: CommsRailApi;
  /** Opens only a real API-issued messenger thread route supplied by ConsoleShell. */
  onOpenMessengerThread?: (threadId: string) => void;
}

function shellCommsRailCopy(): CommsRailCopy {
  const overview = overviewStrings();
  const categories = railCategoryStrings();
  const shell = ko.shell.commsRail;
  return {
    landmark: ko.commsRail.label,
    drawerTitle: ko.commsRail.label,
    close: ko.commsRail.close,
    open: ko.commsRail.open,
    source: {
      messenger: shell.sections.messenger,
      mail: shell.sections.mail,
      notifications: shell.sections.notifications,
      notices: categories.notice,
    },
    state: {
      loading: overview.loading,
      empty: overview.empty.rail,
      denied: ko.page.permissionDenied,
      malformed: shell.loadFailed,
      error: shell.loadFailed,
      retry: ko.page.retry,
      retrying: overview.loading,
    },
    action: {
      "mark-messenger-read": ko.console.mail.read.markRead,
      "mark-mail-read": ko.console.mail.read.markRead,
      "mark-notification-read": ko.console.mail.read.markRead,
    },
    unread: (count) => overview.rail.unread(count),
    collapse: (source) => `${source} ${ko.shell.commsRail.collapse}`,
    expand: (source) => `${source} ${ko.commsRail.open}`,
    detail: ko.shell.commsRail.back,
    occurredAt: formatKoreanTime,
  };
}

/**
 * Production mount for the shell rail. Only messenger currently has a real
 * shell-owned drill command; every other target remains an honest static row.
 */
export function CommsRailPanel({ onOpenMessengerThread }: CommsRailPanelProps) {
  return (
    <CommsRailContainer
      copy={shellCommsRailCopy()}
      embedded
      onOpenMessengerThread={onOpenMessengerThread}
    />
  );
}

/** A rail render failure remains contained inside the shell's error boundary. */
export function CommsRailFallback() {
  return <p style={{ margin: 0, padding: "var(--sp-2) var(--sp-4)", color: "var(--faint)", fontSize: "var(--text-sm)" }}>{overviewStrings().error}</p>;
}
