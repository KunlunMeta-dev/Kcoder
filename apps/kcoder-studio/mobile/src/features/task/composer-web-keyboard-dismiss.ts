/** Observe a touch browser's keyboard-sized viewport restoration without resizing the page. */
export function subscribeComposerWebKeyboardDismiss(isFocused: () => boolean, onDismiss: () => void): () => void {
  if (typeof window === "undefined" || !window.visualViewport ||
    !(window.matchMedia?.("(pointer: coarse)").matches || navigator.maxTouchPoints > 0)) return () => {};
  const viewport = window.visualViewport;
  let width = viewport.width;
  let fullHeight = viewport.height;
  let wasOpen = false;
  const observe = () => {
    if (Math.abs(viewport.scale - 1) > 0.01 || Math.abs(viewport.width - width) > 1) {
      width = viewport.width; fullHeight = viewport.height; wasOpen = false;
      return;
    }
    fullHeight = Math.max(fullHeight, viewport.height);
    if (!isFocused()) { wasOpen = false; return; }
    const open = fullHeight - viewport.height >= Math.max(120, fullHeight * 0.2);
    if (wasOpen && !open) onDismiss();
    wasOpen = open;
  };
  viewport.addEventListener("resize", observe);
  return () => viewport.removeEventListener("resize", observe);
}
