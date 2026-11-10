// Actual ConnectRoute effects in a deterministic hook host; no browser or network.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { GatewayHttpError } from "@/gateway/http-errors";

type Effect = { deps: readonly unknown[]; cleanup?: () => void };
const pairingPublicKey = "f3".repeat(32);
const connectionRoutes = {
  version: 1 as const,
  gatewayId: createHash("sha256").update(Buffer.from(pairingPublicKey, "hex")).digest("hex"),
  publicKey: pairingPublicKey,
  endpoints: [
    { kind: "public" as const, url: "https://pairing.invalid" },
  ],
};
const host = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  effects: [] as Effect[],
  stateIndex: 0,
  refIndex: 0,
  effectIndex: 0,
  connect: vi.fn<(input: { baseUrl: string; token: string; signal: AbortSignal; connectionRoutes?: unknown }) => Promise<{ id: string } | null>>(),
  params: {
    gateway: "https://pairing.invalid",
    token: "synthetic-pairing",
    routes: undefined as string | undefined,
  } as { gateway?: string; gatewayId?: string; token?: string; routes?: string },
  pathname: "/connect",
  hydrated: true,
  profiles: [] as Array<{ id: string; baseUrl: string; accessToken: string; connectionRoutes?: typeof connectionRoutes }>,
  activate: vi.fn(async (_id: string) => {}),
  pairingBootstrap: null as unknown,
  router: { replace: vi.fn(), setParams: vi.fn() },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState(initial: unknown) {
      const index = host.stateIndex++;
      if (!(index in host.states)) host.states[index] = initial;
      return [host.states[index], (value: unknown) => {
        host.states[index] = typeof value === "function"
          ? (value as (current: unknown) => unknown)(host.states[index])
          : value;
      }];
    },
    useRef(initial: unknown) { return host.refs[host.refIndex++] ??= { current: initial }; },
    useEffect(callback: () => void | (() => void), deps: readonly unknown[]) {
      const index = host.effectIndex++;
      const previous = host.effects[index];
      if (previous && previous.deps.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      previous?.cleanup?.();
      const cleanup = callback();
      host.effects[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
    },
  };
});
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => host.params,
  usePathname: () => host.pathname,
  useRouter: () => host.router,
}));
vi.mock("expo-constants", () => ({ default: { nativeAppVersion: "2.4.1", android: { versionCode: 20 } } }));
vi.mock("react-native", () => ({
  Platform: { OS: "web" }, ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", Text: "Text", View: "View",
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("lucide-react-native", () => ({ ChevronLeft: "ChevronLeft", Link2: "Link2", RotateCcw: "RotateCcw" }));
vi.mock("@/components/ui", () => ({ Button: "Button" }));
vi.mock("@/state/AppContext", () => ({ useApp: () => ({ hydrated: host.hydrated, connectGateway: host.connect, profiles: host.profiles, setActiveProfile: host.activate }) }));
vi.mock("@/gateway/web-pairing-bootstrap", () => ({
  getWebPairingBootstrapState: () => host.pairingBootstrap,
  clearWebPairingBootstrapState: (state: unknown) => {
    if (host.pairingBootstrap === state) host.pairingBootstrap = null;
  },
}));
vi.mock("@/i18n", () => ({ t: (key: string, params?: Record<string, string | number>) => {
  if (key === "connect.http_status_detail") return `${key}:${params?.status ?? ""}`;
  if (key === "connect.route_app_build") return `${key}:${params?.version}/${params?.build}`;
  return key;
} }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/theme", () => ({
  useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}), radius: {}, spacing: {},
}));

import ConnectRoute from "../connect";

function render() {
  host.stateIndex = host.refIndex = host.effectIndex = 0;
  return ConnectRoute();
}

function cleanup() {
  for (const effect of host.effects) effect.cleanup?.();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

beforeEach(() => {
  host.states = []; host.refs = []; host.effects = [];
  host.connect.mockReset(); host.router.replace.mockReset(); host.router.setParams.mockReset();
  host.params = { gateway: "https://pairing.invalid", token: "synthetic-pairing", routes: undefined };
  host.pathname = "/connect";
  host.hydrated = true;
  host.profiles = [];
  host.activate.mockReset().mockResolvedValue(undefined);
  host.pairingBootstrap = null;
  vi.stubGlobal("location", { pathname: "/mobile/connect" });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("resumes the saved Gateway after a full reload of a scrubbed pairing URL", async () => {
  host.params = { gateway: "https://pairing.invalid" };
  host.profiles = [{ id: "saved-profile", baseUrl: "https://pairing.invalid", accessToken: "saved-access" }];
  render(); render();
  await vi.waitFor(() => expect(host.router.replace).toHaveBeenCalledWith({ pathname: "/h/[profileId]", params: { profileId: "saved-profile" } }));
  expect(host.activate).toHaveBeenCalledWith("saved-profile");
  expect(host.connect).not.toHaveBeenCalled();
});

it("resumes only a matching saved route descriptor", async () => {
  host.params = { gateway: "https://pairing.invalid", routes: JSON.stringify(connectionRoutes) };
  host.profiles = [{ id: "saved-profile", baseUrl: "https://pairing.invalid", accessToken: "saved-access", connectionRoutes }];
  render(); render();
  await vi.waitFor(() => expect(host.activate).toHaveBeenCalledWith("saved-profile"));
  expect(host.connect).not.toHaveBeenCalled();
});

it.each(["different Gateway", "explicit empty token", "malformed routes", "different route identity"])(
  "does not restore a saved profile for %s", async kind => {
    host.params = { gateway: "https://pairing.invalid" };
    host.profiles = [{ id: "saved-profile", baseUrl: "https://pairing.invalid", accessToken: "saved-access", connectionRoutes }];
    if (kind === "different Gateway") host.params.gateway = "https://other.invalid";
    if (kind === "explicit empty token") host.params.token = "";
    if (kind === "malformed routes") host.params.routes = "{";
    if (kind === "different route identity") host.params.routes = JSON.stringify({ ...connectionRoutes, gatewayId: "f".repeat(64) });
    render(); render();
    await Promise.resolve();
    expect(host.activate).not.toHaveBeenCalled();
    expect(host.connect).not.toHaveBeenCalled();
  },
);

it("does not navigate after saved-profile activation is superseded by leaving the page", async () => {
  const activation = deferred<void>();
  host.params = { gateway: "https://pairing.invalid" };
  host.profiles = [{ id: "saved-profile", baseUrl: "https://pairing.invalid", accessToken: "saved-access" }];
  host.activate.mockReturnValue(activation.promise);
  render(); render();
  cleanup();
  activation.resolve();
  await activation.promise;
  await Promise.resolve();
  expect(host.router.replace).not.toHaveBeenCalled();
});

it("does not guess between two saved identities for the same Gateway", async () => {
  host.params = { gateway: "https://pairing.invalid" };
  host.profiles = ["first", "second"].map(id => ({ id, baseUrl: "https://pairing.invalid", accessToken: "saved-access" }));
  render(); render();
  await Promise.resolve();
  expect(host.activate).not.toHaveBeenCalled();
  expect(host.connect).not.toHaveBeenCalled();
});

it("keeps different Gateway mounts on the same origin isolated when restoring", async () => {
  host.params = { gateway: "https://pairing.invalid/g/second" };
  host.profiles = [
    { id: "first-profile", baseUrl: "https://pairing.invalid/g/first", accessToken: "first-access" },
    { id: "second-profile", baseUrl: "https://pairing.invalid/g/second", accessToken: "second-access" },
  ];
  render(); render();
  await vi.waitFor(() => expect(host.activate).toHaveBeenCalledWith("second-profile"));
  expect(host.connect).not.toHaveBeenCalled();
});

it("shows an activation failure and allows retrying without a new pairing token", async () => {
  host.params = { gateway: "https://pairing.invalid" };
  host.profiles = [{ id: "saved-profile", baseUrl: "https://pairing.invalid", accessToken: "saved-access" }];
  host.activate.mockRejectedValueOnce(new Error("Storage temporarily unavailable"));
  render(); render();
  await vi.waitFor(() => expect(findButton(render(), "pairing-retry")).not.toBeNull());
  findButton(render(), "pairing-retry")?.onPress?.();
  render();
  await vi.waitFor(() => expect(host.router.replace).toHaveBeenCalledWith({ pathname: "/h/[profileId]", params: { profileId: "saved-profile" } }));
  expect(host.connect).not.toHaveBeenCalled();
});

it("shows safe HTTP recovery guidance while keeping the raw status behind Details", async () => {
  host.connect.mockRejectedValueOnce(new GatewayHttpError(404, "Device limit reached"));
  render(); render();
  await vi.waitFor(() => expect(findButton(render(), "pairing-retry")).not.toBeNull());

  const collapsed = render();
  expect(textContent(collapsed)).toContain("Device limit reached");
  expect(textContent(collapsed)).toContain("connect.http_address_not_found");
  expect(findByTestID(collapsed, "gateway-http-status")).toBeNull();
  findByTestID(collapsed, "gateway-http-details-toggle")?.props?.onPress?.();

  const expanded = render();
  expect(textContent(expanded)).toContain("connect.http_status_detail:404");
});

it("hands a committed connection to the destination before navigation cleanup can abort its activation", async () => {
  const connected = deferred<{ id: string } | null>();
  host.connect.mockReturnValue(connected.promise);
  host.router.replace.mockImplementation(() => cleanup());
  render(); render();
  const signal = host.connect.mock.calls[0]![0].signal;
  expect(signal.aborted).toBe(false);
  connected.resolve({ id: "paired-profile" });
  await vi.waitFor(() => expect(host.router.replace).toHaveBeenCalledWith({ pathname: "/h/[profileId]", params: { profileId: "paired-profile" } }));
  expect(signal.aborted).toBe(false);
});

it("still aborts an unfinished connection when the route leaves and ignores its late commit", async () => {
  const connected = deferred<{ id: string } | null>();
  host.connect.mockReturnValue(connected.promise);
  render(); render();
  const signal = host.connect.mock.calls[0]![0].signal;
  cleanup();
  expect(signal.aborted).toBe(true);
  connected.resolve({ id: "stale-profile" });
  await connected.promise;
  await Promise.resolve();
  expect(host.router.replace).not.toHaveBeenCalled();
});

function findButton(node: unknown, testID: string): { onPress?: () => void } | null {
  if (node === null || typeof node !== "object") return null;
  const element = node as { type?: unknown; props?: { testID?: string; onPress?: () => void; children?: unknown } };
  if (element.type === "Button" && element.props?.testID === testID) return element.props;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findButton(child, testID);
    if (found) return found;
  }
  return null;
}

function findByTestID(node: unknown, testID: string): { props?: { onPress?: () => void } } | null {
  if (node === null || typeof node !== "object") return null;
  const element = node as { props?: { testID?: string; onPress?: () => void; children?: unknown } };
  if (element.props?.testID === testID) return element;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findByTestID(child, testID);
    if (found) return found;
  }
  return null;
}

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (node === null || typeof node !== "object") return "";
  const element = node as { props?: { children?: unknown } };
  return textContent(element.props?.children);
}

it("shows safe route guidance and expandable stage and build diagnostics", async () => {
  const failure = Object.assign(new Error("token=private"), {
    name: "GatewayRouteResolutionError", code: "GATEWAY_ROUTE_UNAVAILABLE", failure: "network",
  });
  host.connect.mockRejectedValueOnce(failure);
  render(); render();
  const collapsed = await vi.waitFor(() => {
    const tree = render();
    expect(findByTestID(tree, "gateway-route-error")).not.toBeNull();
    return tree;
  });
  expect(textContent(collapsed)).toContain("connect.route_network_failed");
  expect(textContent(collapsed)).not.toContain("token=private");
  expect(findByTestID(collapsed, "gateway-route-details")).toBeNull();
  findByTestID(collapsed, "gateway-route-details-toggle")!.props!.onPress!();
  expect(textContent(render())).toContain("GATEWAY_ROUTE_UNAVAILABLE/network");
  expect(textContent(render())).toContain("connect.route_app_build:2.4.1/20");
});

it("passes the route descriptor through a failed attempt and its retry", async () => {
  host.params = {
    gateway: "https://pairing.invalid",
    token: "synthetic-pairing",
    routes: JSON.stringify(connectionRoutes),
  };
  host.connect.mockRejectedValueOnce(new Error("temporary failure"));
  host.connect.mockResolvedValueOnce({ id: "paired-profile" });

  render();
  render();
  await vi.waitFor(() => expect(host.connect).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(findButton(render(), "pairing-retry")).not.toBeNull());
  expect(host.connect.mock.calls[0]?.[0].connectionRoutes).toEqual(connectionRoutes);

  findButton(render(), "pairing-retry")?.onPress?.();
  render();
  await vi.waitFor(() => expect(host.connect).toHaveBeenCalledTimes(2));
  expect(host.connect.mock.calls[1]?.[0].connectionRoutes).toEqual(connectionRoutes);
});

function setPairingBootstrap(
  gateway = "https://pairing.invalid",
  routes = connectionRoutes,
  token = "synthetic-pairing",
) {
  host.pairingBootstrap = {
    kind: "intent",
    pathname: "/connect",
    gateway,
    token,
    connectionRoutes: routes,
  };
}

it("retains the consumed web bootstrap token for the same route scope until hydration completes", async () => {
  host.hydrated = false;
  host.connect.mockResolvedValue({ id: "paired-profile" });
  host.params = {
    gateway: "https://pairing.invalid",
    routes: JSON.stringify(connectionRoutes),
  };
  setPairingBootstrap();

  render();
  expect(host.pairingBootstrap).toBeNull();
  expect(host.connect).not.toHaveBeenCalled();

  // This render represents the rerender after the fragment bootstrap was consumed.
  render();
  expect(host.connect).not.toHaveBeenCalled();

  host.hydrated = true;
  render();
  await vi.waitFor(() => expect(host.connect).toHaveBeenCalledTimes(1));
  expect(host.connect.mock.calls[0]?.[0]).toMatchObject({
    baseUrl: "https://pairing.invalid",
    token: "synthetic-pairing",
    connectionRoutes,
  });
});

it.each(["gateway", "path", "routes", "explicit invalid token"] as const)(
  "does not reuse a consumed bootstrap token after its %s scope changes",
  (changedScope) => {
    host.hydrated = false;
    host.params = {
      gateway: "https://pairing.invalid",
      routes: JSON.stringify(connectionRoutes),
    };
    setPairingBootstrap();
    render();
    expect(host.pairingBootstrap).toBeNull();

    if (changedScope === "gateway") {
      host.params.gateway = "https://other-pairing.invalid";
      host.params.routes = JSON.stringify({
        ...connectionRoutes,
        endpoints: [
          connectionRoutes.endpoints[0],
          { ...connectionRoutes.endpoints[1], url: "https://other-pairing.invalid" },
        ],
      });
    } else if (changedScope === "path") {
      host.pathname = "/different-connect-path";
    } else if (changedScope === "routes") {
      host.params.routes = JSON.stringify({
        ...connectionRoutes,
        endpoints: [
          { ...connectionRoutes.endpoints[0], url: "http://192.168.1.21:4173" },
          connectionRoutes.endpoints[1],
        ],
      });
    } else {
      host.params.token = "";
    }

    host.hydrated = true;
    render();
    expect(host.connect).not.toHaveBeenCalled();
  },
);
