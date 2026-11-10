import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { normalizeTargetBrowserUrl } from "@/storage/browser-target-url";

export interface BrowserViewport {
  width: number;
  height: number;
}

export type BrowserGestureMode = "pending" | "scroll" | "drag";

export class BrowserUrlNormalizationError extends Error {
  constructor(readonly reason: string) {
    super("Browser URL must be a valid HTTP(S) address without credentials");
    this.name = "BrowserUrlNormalizationError";
  }
}

export function normalizeBrowserUrl(value: string | null | undefined): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "https://example.com";
  const localHost = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-fA-F:.]+])(?::\d+)?(?:[/?#]|$)/.test(trimmed);
  const candidate = localHost
    ? `http://${trimmed}`
    : trimmed.startsWith("//")
      ? `https:${trimmed}`
      : /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;
  const normalized = normalizeTargetBrowserUrl(candidate);
  if (!normalized.ok) throw new BrowserUrlNormalizationError(normalized.reason);
  return normalized.url;
}

/** Stable non-secret key matching the exact Gateway browser connection scope. */
export function workspaceBrowserOwnerKey(
  profile: GatewayProfile,
  server: KCoderServer,
  cwd: string,
): string {
  return JSON.stringify([
    profile.id,
    profile.baseUrl,
    profile.authorizationGeneration ?? `legacy:${profile.id}`,
    profile.deviceId,
    server.id,
    server.runtime,
    server.transport,
    [server.workspacePath === undefined ? "absent" : "value", server.workspacePath ?? ""],
    server.host,
    server.user,
    server.port,
    server.command,
    server.profile,
    server.settingsFile,
    server.accountIdentity?.principalId,
    server.accountIdentity?.username,
    server.accountIdentity?.role,
    server.chromiumBin,
    server.chromiumNoSandbox,
    server.acceptNewHostKey,
    ["value", cwd],
  ]);
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

export function browserAddressAfterFrame(
  current: string,
  pageUrl: string | null | undefined,
  editing: boolean,
  hasDraft = false,
): string {
  return !editing && !hasDraft && pageUrl?.trim() ? pageUrl : current;
}

export interface BrowserAddressDraftState {
  revision: number;
  value: string | null;
}

export function editBrowserAddressDraft(
  current: BrowserAddressDraftState,
  value: string,
): BrowserAddressDraftState {
  return { revision: current.revision + 1, value };
}

export function settleBrowserAddressDraft(
  current: BrowserAddressDraftState,
  revision: number,
  outcome:
    | { status: "pending" | "rejected" }
    | { status: "confirmed"; pageUrl: string },
): BrowserAddressDraftState {
  if (
    outcome.status !== "confirmed" ||
    !outcome.pageUrl.trim() ||
    current.revision !== revision
  )
    return current;
  return { ...current, value: null };
}

export function browserViewportForLayout(layout: { width: number; height: number }): BrowserViewport {
  const measured = layout.width >= 80 && layout.height >= 80;
  return {
    width: Math.max(320, Math.min(1920, Math.round(measured ? layout.width : 390))),
    height: Math.max(240, Math.min(1080, Math.round(measured ? layout.height : 640))),
  };
}
