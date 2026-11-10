import { useCallback, type PropsWithChildren } from "react";
import { useIsFocused } from "expo-router";

/** Remove inactive page controls from keyboard interaction before their scene is hidden. */
export function ScreenFocusBoundary({ children }: PropsWithChildren) {
  const focused = useIsFocused();
  // Ref cleanup runs during mutation, before the ancestor scene applies aria-hidden.
  // Waiting for a layout/passive effect leaves an accessibility-tree race.
  const bindSurface = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    return () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && node.contains(active)) active.blur();
    };
  }, [focused]);
  return <div ref={bindSurface} data-testid="screen-focus-boundary" inert={!focused}
    style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0 }}>
    {children}
  </div>;
}
