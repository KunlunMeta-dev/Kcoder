import { useEffect, useRef } from "react";
import { Platform, type ViewInstance } from "react-native";

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useModalFocusTrap(visible: boolean, onClose: () => void, initialFocusSelector?: string, escapeOnKeyUp = false) {
  const surfaceRef = useRef<ViewInstance>(null);
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
        if (escapeOnKeyUp) event.stopPropagation();
        else closeRef.current();
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
    // React Native Web Modal also closes on keyup; consume that event when Escape navigates back.
    const keyup = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("keydown", keydown, true);
    if (escapeOnKeyUp) document.addEventListener("keyup", keyup, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      if (escapeOnKeyUp) document.removeEventListener("keyup", keyup, true);
      if (previous?.isConnected && !previous.closest('[inert], [hidden], [aria-hidden="true"]')) previous.focus();
    };
  }, [escapeOnKeyUp, initialFocusSelector, visible]);

  return surfaceRef;
}
