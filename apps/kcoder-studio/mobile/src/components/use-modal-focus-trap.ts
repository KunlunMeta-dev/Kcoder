import { useEffect, useRef } from "react";
import { Platform, type View } from "react-native";

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useModalFocusTrap(visible: boolean, onClose: () => void, initialFocusSelector?: string) {
  const surfaceRef = useRef<View>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (Platform.OS !== "web" || !visible || typeof document === "undefined") return;
    const surface = surfaceRef.current as unknown as HTMLElement | null;
    if (!surface) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    surface.setAttribute("tabindex", "-1");
    const focusables = () => Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
    const requestedFocus = initialFocusSelector
      ? surface.querySelector<HTMLElement>(initialFocusSelector)
      : null;
    (requestedFocus ?? focusables()[0] ?? surface).focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        surface.focus();
        return;
      }
      const current = document.activeElement;
      const index = items.indexOf(current as HTMLElement);
      const next = event.shiftKey
        ? items[(index <= 0 ? items.length : index) - 1]
        : items[(index + 1) % items.length];
      event.preventDefault();
      next.focus();
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [initialFocusSelector, visible]);

  return surfaceRef;
}
