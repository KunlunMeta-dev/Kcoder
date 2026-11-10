import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  captureWebPairingIntent,
  clearWebPairingBootstrapState,
  getWebPairingBootstrapState,
  initializeWebPairingIntent,
} from "./web-pairing-bootstrap";

const gateway = "http://127.0.0.1:4187";
const encodedGateway = encodeURIComponent(gateway);
const routeGateway = "https://relay.example/g/relay-a";
const routePublicKey = "d2".repeat(32);
const connectionRoutes = {
  version: 1 as const,
  gatewayId: createHash("sha256").update(Buffer.from(routePublicKey, "hex")).digest("hex"),
  publicKey: routePublicKey,
  endpoints: [
    { kind: "public" as const, url: "https://alternate-relay.example/g/tenant-a" },
    { kind: "public" as const, url: routeGateway },
  ],
};
const encodedRoutes = encodeURIComponent(JSON.stringify(connectionRoutes));
const routePaths = ["/connect", "/mobile/connect", "/g/relay-a/mobile/connect"];

function makeLocation(
  pathname = "/mobile/connect",
  search = `?gateway=${encodedGateway}`,
  hash = "#token=synthetic-token",
) {
  return { pathname, search, hash };
}

function makeHistory() {
  return {
    state: { navigation: "kept" },
    replaceState: vi.fn(),
  };
}

function clearPendingState() {
  for (const pathname of routePaths) {
    const state = getWebPairingBootstrapState(pathname, pathname);
    if (state) clearWebPairingBootstrapState(state);
  }
}

beforeEach(() => {
  clearPendingState();
  vi.unstubAllGlobals();
});

afterEach(() => {
  clearPendingState();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Web pairing bootstrap", () => {
  it.each(routePaths)("captures complete credentials on %s before Router initialization", (pathname) => {
    const location = makeLocation(pathname);
    const history = makeHistory();
    const state = captureWebPairingIntent(location, history);

    expect(state).toMatchObject({ kind: "intent", pathname, gateway, token: "synthetic-token" });
    expect(history.replaceState).toHaveBeenCalledWith(
      history.state,
      "",
      `${pathname}${location.search}`,
    );
    expect(history.replaceState.mock.calls[0]?.[2]).not.toContain("synthetic-token");
    expect(getWebPairingBootstrapState("/connect", pathname)).toBe(state);
  });

  it("rejects arbitrary mount prefixes and cross-mount or cross-route retrieval", () => {
    const history = makeHistory();
    expect(captureWebPairingIntent(makeLocation("/untrusted/mobile/connect"), history)).toBeNull();
    expect(captureWebPairingIntent(makeLocation("/mobileish/connect"), history)).toBeNull();
    expect(history.replaceState).not.toHaveBeenCalled();

    const state = captureWebPairingIntent(makeLocation("/g/relay-a/mobile/connect"), history);
    expect(state?.kind).toBe("intent");
    expect(getWebPairingBootstrapState("/connect", "/g/relay-b/mobile/connect")).toBeNull();
    expect(getWebPairingBootstrapState("/g/relay-b/mobile/connect", "/g/relay-a/mobile/connect")).toBeNull();
    expect(getWebPairingBootstrapState("/mobile/welcome", "/g/relay-a/mobile/connect")).toBeNull();
  });

  it("keeps the non-secret routes query while scrubbing a fragment token", () => {
    const pathname = "/g/relay-a/mobile/connect";
    const search = `?gateway=${encodeURIComponent(routeGateway)}&gatewayId=relay-a&routes=${encodedRoutes}`;
    const location = makeLocation(pathname, search);
    const history = makeHistory();
    const state = captureWebPairingIntent(location, history);

    expect(state).toMatchObject({ kind: "intent", pathname, gateway: routeGateway, token: "synthetic-token", connectionRoutes });
    expect(history.replaceState).toHaveBeenCalledWith(history.state, "", `${pathname}${search}`);
    expect(history.replaceState.mock.calls[0]?.[2]).toContain(`routes=${encodedRoutes}`);
    expect(history.replaceState.mock.calls[0]?.[2]).not.toContain("synthetic-token");
  });

  it.each([
    ["duplicate gateway", makeLocation("/mobile/connect", `?gateway=${encodedGateway}&gateway=${encodedGateway}`)],
    ["missing gateway", makeLocation("/mobile/connect", "")],
    ["missing token", makeLocation("/mobile/connect", `?gateway=${encodedGateway}`, "#token=")],
    ["duplicate token", makeLocation("/mobile/connect", `?gateway=${encodedGateway}`, "#token=one&token=two")],
    ["extra fragment field", makeLocation("/mobile/connect", `?gateway=${encodedGateway}`, "#token=one&gateway=other")],
    ["duplicate routes", makeLocation("/mobile/connect", `?gateway=${encodeURIComponent(routeGateway)}&routes=${encodedRoutes}&routes=${encodedRoutes}`)],
    ["descriptor candidate mismatch", makeLocation("/mobile/connect", `?gateway=${encodedGateway}&routes=${encodedRoutes}`)],
  ])("scrubs and marks ambiguous credentials invalid: %s", (_label, location) => {
    const history = makeHistory();
    const state = captureWebPairingIntent(location, history);

    expect(state).toMatchObject({ kind: "invalid", pathname: "/mobile/connect" });
    expect(history.replaceState).toHaveBeenCalledWith(
      history.state,
      "",
      `${location.pathname}${location.search}`,
    );
    expect(history.replaceState.mock.calls[0]?.[2]).not.toContain("synthetic-token");
    expect(getWebPairingBootstrapState("/connect", "/mobile/connect")).toBe(state);
  });

  it("scrubs a conflicting query token and blocks it as an invalid pairing", () => {
    const history = makeHistory();
    const location = makeLocation("/mobile/connect", `?gateway=${encodedGateway}&token=query-token`);
    const state = captureWebPairingIntent(location, history);

    expect(state).toMatchObject({ kind: "invalid" });
    expect(history.replaceState.mock.calls[0]?.[2]).toBe(`/mobile/connect?gateway=${encodedGateway}`);
    expect(getWebPairingBootstrapState("/connect", "/mobile/connect")).toBe(state);
  });

  it("preserves routes when scrubbing a conflicting query token", () => {
    const history = makeHistory();
    const search = `?gateway=${encodeURIComponent(routeGateway)}&gatewayId=relay-a&routes=${encodedRoutes}&token=query-token`;
    const state = captureWebPairingIntent(makeLocation("/mobile/connect", search), history);

    expect(state).toMatchObject({ kind: "invalid" });
    const cleaned = history.replaceState.mock.calls[0]?.[2];
    expect(cleaned).toContain(`routes=${encodedRoutes}`);
    expect(cleaned).not.toContain("query-token");
  });

  it("rejects pairing URLs beyond the bounded URL size and removes the fragment", () => {
    const history = makeHistory();
    const state = captureWebPairingIntent(
      makeLocation("/mobile/connect", `?gateway=${encodedGateway}&note=${"x".repeat(9000)}`),
      history,
    );
    expect(state).toMatchObject({ kind: "invalid" });
    expect(history.replaceState.mock.calls[0]?.[2]).not.toContain("synthetic-token");
  });

  it("marks a recognized pairing URL invalid when browser history cannot be cleaned", () => {
    const history = makeHistory();
    history.replaceState.mockImplementation(() => {
      throw new Error("history unavailable");
    });

    expect(captureWebPairingIntent(makeLocation(), history)).toMatchObject({ kind: "invalid" });
    expect(getWebPairingBootstrapState("/connect", "/mobile/connect")).toMatchObject({ kind: "invalid" });
  });

  it("keeps query-token links on the existing route path", () => {
    const history = makeHistory();
    const location = makeLocation("/mobile/connect", `?gateway=${encodedGateway}&token=legacy-token`, "");
    expect(captureWebPairingIntent(location, history)).toBeNull();
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it("keeps the intent stable across repeated renders and clears it after commit", () => {
    const state = captureWebPairingIntent(makeLocation(), makeHistory());
    expect(state?.kind).toBe("intent");
    if (!state || state.kind !== "intent") throw new Error("expected a complete pairing intent");

    const firstRender = getWebPairingBootstrapState("/connect", "/mobile/connect");
    const strictModeRender = getWebPairingBootstrapState("/connect", "/mobile/connect");
    expect(firstRender).toBe(state);
    expect(strictModeRender).toBe(state);

    clearWebPairingBootstrapState(state);
    expect(getWebPairingBootstrapState("/connect", "/mobile/connect")).toBeNull();
  });

  it("does not capture anything in SSR and native contexts without browser globals", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    expect(initializeWebPairingIntent()).toBeNull();
  });

  it.each([true, false])("consumes the tab handoff only for the exact mounted Gateway (%s)", sameGateway => {
    const pathname = "/g/relay-a/mobile/connect";
    const token = `kcacct1_${"a".repeat(43)}`;
    const origin = "https://relay.example";
    const gateway = origin + "/g/relay-a";
    const location = { origin, pathname, hash: "", search: `?${new URLSearchParams({
      gateway: sameGateway ? gateway : "https://another.example/g/relay-a",
      gatewayId: "relay-a",
    })}` };
    const history = makeHistory();
    const stored = new Map([["kcoder.account-pairing", JSON.stringify({ pathname, token })]]);
    vi.stubGlobal("document", {});
    vi.stubGlobal("window", { location, history, sessionStorage: {
      getItem: (key: string) => stored.get(key),
      removeItem: (key: string) => stored.delete(key),
    } });
    const intent = initializeWebPairingIntent();
    expect(intent).toEqual(sameGateway ? { kind: "intent", pathname, gateway, token } : null);
    expect(stored.size).toBe(0);
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(initializeWebPairingIntent()).toBeNull();
  });

  it("does not log captured credentials", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    captureWebPairingIntent(makeLocation(), makeHistory());

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
