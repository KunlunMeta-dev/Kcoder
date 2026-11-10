import type { GatewayConnectionRoutes } from "../../../shared/gatewayConnectionRoutes.js";
import { MAX_PAIRING_LINK_LENGTH, parsePairingLink } from "./pairing";

export interface WebPairingIntent {
  readonly kind: "intent";
  readonly pathname: string;
  readonly gateway: string;
  readonly token: string;
  readonly connectionRoutes?: GatewayConnectionRoutes;
}

export interface InvalidWebPairingIntent {
  readonly kind: "invalid";
  readonly pathname: string;
}

export type WebPairingBootstrapState = WebPairingIntent | InvalidWebPairingIntent;

interface PairingLocation {
  pathname: string;
  search: string;
  hash: string;
}

interface PairingHistory {
  state: unknown;
  replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
}

let pendingState: WebPairingBootstrapState | null = null;

function normalizedPath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function isMobileConnectPath(pathname: string): boolean {
  const path = normalizedPath(pathname);
  if (path === "/connect" || path === "/mobile/connect") return true;
  return /^\/g\/[A-Za-z0-9_-]+\/mobile\/connect$/.test(path);
}

function scrubCredentialUrl(
  location: PairingLocation,
  history: PairingHistory,
  removeQueryToken: boolean,
): boolean {
  let search = location.search;
  if (removeQueryToken) {
    const query = new URLSearchParams(search);
    query.delete("token");
    const remaining = query.toString();
    search = remaining ? `?${remaining}` : "";
  }
  try {
    history.replaceState(history.state, "", `${location.pathname}${search}`);
    return true;
  } catch {
    return false;
  }
}

export function captureWebPairingIntent(
  location: PairingLocation,
  history: PairingHistory,
): WebPairingBootstrapState | null {
  if (!isMobileConnectPath(location.pathname) || !location.hash.startsWith("#token=")) return null;

  const pathname = normalizedPath(location.pathname);
  const query = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.slice(1));
  const gateways = query.getAll("gateway");
  const urls = query.getAll("url");
  const tokens = fragment.getAll("token");
  const fragmentKeys = Array.from(fragment.keys());
  const hasCompletePair =
    !query.has("token") && gateways.length + urls.length === 1 && tokens.length === 1 &&
    fragmentKeys.length === 1 && fragmentKeys[0] === "token" &&
    Boolean((gateways[0] ?? urls[0])?.trim()) && Boolean(tokens[0]) &&
    location.pathname.length + location.search.length + location.hash.length <= MAX_PAIRING_LINK_LENGTH;

  let parsedPairing: ReturnType<typeof parsePairingLink> | undefined;
  if (hasCompletePair) {
    try {
      const syntheticUrl = new URL("kcoder-studio://connect");
      query.forEach((value, key) => syntheticUrl.searchParams.append(key, value));
      syntheticUrl.searchParams.append("token", tokens[0]!);
      parsedPairing = parsePairingLink(syntheticUrl.toString());
    } catch {
      // A malformed or contradictory query must not reach the connection flow.
    }
  }

  if (!scrubCredentialUrl(location, history, query.has("token")) || !hasCompletePair || !parsedPairing) {
    const invalidState = Object.freeze({ kind: "invalid" as const, pathname });
    pendingState = invalidState;
    return invalidState;
  }

  const intent = Object.freeze({
    kind: "intent" as const,
    pathname,
    gateway: parsedPairing.gateway,
    token: parsedPairing.token,
    ...(parsedPairing.connectionRoutes ? { connectionRoutes: parsedPairing.connectionRoutes } : {}),
  });
  pendingState = intent;
  return intent;
}

export function getWebPairingBootstrapState(
  routePathname: string,
  browserPathname: string,
): WebPairingBootstrapState | null {
  if (!pendingState || !isMobileConnectPath(routePathname)) return null;
  const routePath = normalizedPath(routePathname);
  if (routePath !== "/connect" && routePath !== pendingState.pathname) return null;
  if (normalizedPath(browserPathname) !== pendingState.pathname) return null;
  return pendingState;
}

export function clearWebPairingBootstrapState(state: WebPairingBootstrapState): void {
  if (pendingState === state) pendingState = null;
}

export function initializeWebPairingIntent(): WebPairingBootstrapState | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  const { location, history } = window;
  if (!location.hash) {
    const prefix = normalizedPath(location.pathname).match(/^(\/g\/([A-Za-z0-9_-]{1,64}))\/mobile\/connect$/);
    if (prefix) {
      try {
        const key = "kcoder.account-pairing";
        const stored = window.sessionStorage.getItem(key);
        if (stored) {
          window.sessionStorage.removeItem(key);
          const value = JSON.parse(stored);
          const gateway = location.origin + prefix[1];
          const expectedQuery = new URLSearchParams({ gateway, gatewayId: prefix[2]! });
          if (value?.pathname === location.pathname && /^kcacct1_[A-Za-z0-9_-]{43}$/.test(value.token) &&
              location.search === `?${expectedQuery}`) {
            pendingState = Object.freeze({ kind: "intent", pathname: value.pathname, gateway, token: value.token });
            return pendingState;
          }
        }
      } catch {
        // An unavailable or invalid tab handoff leaves the ordinary connection flow in place.
      }
    }
  }
  return captureWebPairingIntent(location, history);
}

initializeWebPairingIntent();
