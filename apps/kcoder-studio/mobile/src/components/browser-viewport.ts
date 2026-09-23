export interface BrowserViewport {
  width: number;
  height: number;
}

export type BrowserGestureMode = "pending" | "scroll" | "drag";

export function normalizeBrowserUrl(value: string | null | undefined): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "https://example.com";
  if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-fA-F:.]+])(?::\d+)?(?:[/?#]|$)/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return `https://${trimmed}`;
}

export function classifyBrowserGesture(
  start: { x: number; y: number },
  current: { x: number; y: number },
): BrowserGestureMode {
  const deltaX = Math.abs(current.x - start.x);
  const deltaY = Math.abs(current.y - start.y);
  if (Math.hypot(deltaX, deltaY) < 8) return "pending";
  return deltaY >= deltaX * 1.15 ? "scroll" : "drag";
}

export function browserWheelDelta(previous: { x: number; y: number }, current: { x: number; y: number }): number {
  return Math.round((previous.y - current.y) * 1.35);
}

export function browserAddressAfterFrame(current: string, pageUrl: string | null | undefined, editing: boolean): string {
  return !editing && pageUrl?.trim() ? pageUrl : current;
}

export function browserViewportForLayout(layout: { width: number; height: number }): BrowserViewport {
  const measured = layout.width >= 80 && layout.height >= 80;
  return {
    width: Math.max(320, Math.min(1920, Math.round(measured ? layout.width : 390))),
    height: Math.max(240, Math.min(1080, Math.round(measured ? layout.height : 640))),
  };
}
