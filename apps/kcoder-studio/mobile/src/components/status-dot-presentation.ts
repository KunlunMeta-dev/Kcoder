import type { ThemeColors } from "@/theme";
import { t } from "@/i18n";
import type { ConnectionStatus } from "./connection-status-presentation";

type StatusDotColors = Pick<ThemeColors, "green" | "red" | "yellow" | "blue">;

/** Keep unknown neutral/informational so it is not mistaken for a failed connection. */
export function statusDotColor(
  status: ConnectionStatus,
  colors: StatusDotColors,
): string {
  switch (status) {
    case "online":
      return colors.green;
    case "offline":
      return colors.red;
    case "checking":
      return colors.yellow;
    case "unknown":
      return colors.blue;
  }
}

/** Localized spoken name for the status dot, independent of its color. */
export function statusDotAccessibilityLabel(status: ConnectionStatus): string {
  const key = {
    online: "settings.status_online",
    offline: "settings.status_offline",
    checking: "settings.status_checking",
    unknown: "task.unknown",
  }[status];
  return t(key);
}

/**
 * Hide a status dot from accessibility when its row already announces the
 * same visible status text. Standalone dots retain their localized name.
 */
export function statusDotAccessibilityProps(
  status: ConnectionStatus,
  decorative: boolean,
) {
  if (decorative) {
    return {
      accessible: false,
      accessibilityElementsHidden: true,
      importantForAccessibility: "no-hide-descendants" as const,
      "aria-hidden": true,
    };
  }
  return {
    accessible: true,
    accessibilityRole: "image" as const,
    accessibilityLabel: statusDotAccessibilityLabel(status),
  };
}
