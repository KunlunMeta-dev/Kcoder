import type { PressableProps } from "react-native";

/** Keep secondary row actions available without reserving an extra icon column. */
export function rowActions(label: string, open: () => void): Pick<PressableProps,
  "onLongPress" | "accessibilityActions" | "onAccessibilityAction"> {
  return {
    onLongPress: open,
    accessibilityActions: [{ name: "longpress", label }],
    onAccessibilityAction: event => {
      if (event.nativeEvent.actionName === "longpress") open();
    },
  };
}
