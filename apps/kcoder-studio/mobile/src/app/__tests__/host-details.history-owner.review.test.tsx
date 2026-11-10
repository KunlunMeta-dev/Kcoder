import React, { createContext } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  context: null as any,
  catalogRead: vi.fn(),
  modalProps: null as any,
}));

vi.mock("expo-router", async () => {
  const { useContext } = await import("react");
  return {
    useLocalSearchParams: () => useContext<any>(fixture.context).params,
    useRouter: () => ({ push() {}, replace() {} }),
    useIsFocused: () => useContext<any>(fixture.context).focused,
  };
});
vi.mock("@/state/AppContext", async () => {
  const { useContext } = await import("react");
  return { useApp: () => useContext<any>(fixture.context).app };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View",
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
}));
vi.mock("lucide-react-native", () => Object.fromEntries(["Bot", "ChevronLeft", "FileText", "Folder", "Globe2", "History", "Laptop", "RefreshCw", "Server", "SquareTerminal"].map(name => [name, name])));
vi.mock("@/components/ui", () => ({ EmptyState: "EmptyState", StatusDot: "StatusDot" }));
vi.mock("@/components/history-refresh-modal", async () => {
  const React = await import("react");
  return {
    HistoryRefreshModal: (props: any) => {
      fixture.modalProps = props;
      return React.createElement("HistoryRefreshModal", {
        testID: "history-refresh-dialog",
        "data-profile": props.target.profile.id,
        "data-server": props.target.server.id,
        "data-owner": props.target.owner,
        "data-workspaces": props.target.workspaces.join("|"),
      });
    },
  };
});
vi.mock("@/runtime/task-runtime/workspaces", () => ({
  listWorkspaceOptions: (...args: any[]) => fixture.catalogRead(...args),
  workspaceThreadScopeIdentity: (path: string | undefined) => path?.trim() || "/",
}));
vi.mock("@/runtime/thread-list-projection", () => ({
  threadListReadOwner: (profile: any, server: any, options: { archived: boolean }) => `${profile.id}:${profile.authorizationGeneration}:${server.id}:${options.archived}`,
}));
vi.mock("@/state/profile-coordinator", () => ({
  profileAuthorizationScopeKey: (profile: any) => `${profile.id}:${profile.authorizationGeneration}`,
}));
vi.mock("@/i18n", () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key}:${Object.values(values).join(":")}` : key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/theme", () => {
  const colors = new Proxy({}, { get: (_target, key) => String(key) });
  return {
    useTheme: () => ({ colors }),
    useThemedStyles: (factory: (colors: any) => unknown) => factory(colors),
    radius: { md: 8, lg: 12 }, spacing: { sm: 8, md: 12, lg: 16, xl: 24 },
  };
});

import HostDetailsRoute from "../host-details";

type Profile = { id: string; label: string; authorizationGeneration: string; baseUrl: string; accessToken: string; rpcToken: string };
type RouteState = { params: { profileId: string; serverId: string }; focused: boolean; app: any };
const RouteContext = createContext<RouteState | null>(null);
fixture.context = RouteContext;
type Mounted = { renderer: ReactTestRenderer; state: RouteState };
const mounted: Mounted[] = [];

function profile(id: string, authorizationGeneration: string): Profile {
  return { id, label: id, authorizationGeneration, baseUrl: "https://gateway.test", accessToken: "test", rpcToken: "test" };
}
function server(id = "target") {
  return { id, label: id, transport: "local", runtime: "kcoder", workspacePath: `/${id}` };
}
function routeTree(state: RouteState) {
  return <RouteContext.Provider value={state}><HostDetailsRoute /></RouteContext.Provider>;
}
async function mount(state: RouteState): Promise<Mounted> {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(routeTree(state)); });
  const view = { renderer, state };
  mounted.push(view);
  return view;
}
async function update(view: Mounted): Promise<void> {
  await act(async () => { view.renderer.update(routeTree(view.state)); });
}
function node(view: Mounted, testID: string) {
  return view.renderer.root.findByProps({ testID });
}
function has(view: Mounted, testID: string): boolean {
  return view.renderer.root.findAllByProps({ testID }).length > 0;
}
async function press(view: Mounted, testID: string): Promise<void> {
  await act(async () => { node(view, testID).props.onPress(); });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
function stateFor(activeProfile: Profile): RouteState {
  const selectedServer = server();
  return {
    params: { profileId: activeProfile.id, serverId: selectedServer.id },
    focused: true,
    app: {
      activeProfile,
      demo: false,
      refresh: vi.fn(),
      runtime: {
        servers: [selectedServer], statuses: [], loading: false, serversReady: true,
        statusRefreshing: false, statusError: null, reauthorizationRequired: false,
      },
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.catalogRead.mockReset();
  fixture.modalProps = null;
});
afterEach(async () => {
  for (const view of [...mounted]) {
    await act(async () => { view.renderer.unmount(); });
    mounted.splice(mounted.indexOf(view), 1);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("ignores a late workspace catalog from the previous active profile", async () => {
  const first = profile("gateway-A", "auth-A");
  const second = profile("gateway-B", "auth-B");
  const firstCatalog = deferred<Array<{ path: string; label: string; kind: "workspace" }>>();
  const secondCatalog = deferred<Array<{ path: string; label: string; kind: "workspace" }>>();
  fixture.catalogRead.mockImplementation((owner: Profile) => owner.id === first.id ? firstCatalog.promise : secondCatalog.promise);
  const view = await mount(stateFor(first));
  expect(fixture.catalogRead).toHaveBeenCalledTimes(1);

  view.state.params.profileId = second.id;
  view.state.app.activeProfile = second;
  await update(view);
  expect(fixture.catalogRead).toHaveBeenCalledTimes(2);

  await act(async () => { firstCatalog.resolve([{ path: "/stale", label: "stale", kind: "workspace" }]); await firstCatalog.promise; });
  expect(node(view, "host-refresh-known-history").props.disabled).toBe(true);
  expect(has(view, "history-refresh-dialog")).toBe(false);

  await act(async () => { secondCatalog.resolve([{ path: "/fresh", label: "fresh", kind: "workspace" }]); await secondCatalog.promise; });
  expect(node(view, "host-refresh-known-history").props.disabled).toBe(false);
  await press(view, "host-refresh-known-history");
  expect(node(view, "history-refresh-dialog").props["data-profile"]).toBe(second.id);
  expect(node(view, "history-refresh-dialog").props["data-workspaces"]).toBe("/target|/fresh");
});

it("cancels the visible confirmation across focus and reauthorization loss, and an old close cannot clear a newer one", async () => {
  const owner = profile("gateway-A", "auth-A");
  fixture.catalogRead.mockResolvedValue([{ path: "/known", label: "known", kind: "workspace" }]);
  const view = await mount(stateFor(owner));
  await flush();
  await press(view, "host-refresh-known-history");
  expect(has(view, "history-refresh-dialog")).toBe(true);
  const oldModal = fixture.modalProps;

  view.state.focused = false;
  await update(view);
  expect(has(view, "history-refresh-dialog")).toBe(false);
  expect(oldModal.isTargetCurrent()).toBe(false);
  view.state.focused = true;
  await update(view);
  await flush();
  expect(has(view, "history-refresh-dialog")).toBe(false);

  await press(view, "host-refresh-known-history");
  expect(has(view, "history-refresh-dialog")).toBe(true);
  const newerModal = fixture.modalProps;
  await act(async () => { oldModal.onClose(); });
  expect(has(view, "history-refresh-dialog")).toBe(true);
  expect(fixture.modalProps.target).toBe(newerModal.target);

  view.state.app.runtime.reauthorizationRequired = true;
  await update(view);
  expect(has(view, "history-refresh-dialog")).toBe(false);
  expect(newerModal.isTargetCurrent()).toBe(false);
  view.state.app.runtime.reauthorizationRequired = false;
  await update(view);
  await flush();
  expect(has(view, "history-refresh-dialog")).toBe(false);
});

it("preserves a ready refresh confirmation across same-config server replacement during refresh", async () => {
  const owner = profile("gateway-A", "auth-A");
  fixture.catalogRead.mockResolvedValue([{ path: "/known", label: "known", kind: "workspace" }]);
  const view = await mount(stateFor(owner));
  await flush();
  await press(view, "host-refresh-known-history");
  expect(has(view, "history-refresh-dialog")).toBe(true);
  const readyTarget = fixture.modalProps.target;

  view.state.app.refresh = vi.fn(async () => {
    const runtime = view.state.app.runtime;
    view.state.app.runtime = { ...runtime, servers: runtime.servers.map((item: any) => ({ ...item })) };
  });
  await update(view);
  await act(async () => {
    fixture.modalProps.onReady();
    await Promise.resolve();
  });
  await update(view);

  expect(view.state.app.refresh).toHaveBeenCalledOnce();
  expect(fixture.catalogRead).toHaveBeenCalledTimes(1);
  expect(has(view, "history-refresh-dialog")).toBe(true);
  expect(fixture.modalProps.target).toBe(readyTarget);
  expect(node(view, "history-refresh-dialog").props["data-workspaces"]).toBe("/target|/known");

  const runtime = view.state.app.runtime;
  view.state.app.runtime = { ...runtime, servers: runtime.servers.map((item: any) => ({ ...item, workspacePath: "/changed" })) };
  await update(view);
  await flush();
  expect(has(view, "history-refresh-dialog")).toBe(false);
  expect(fixture.catalogRead).toHaveBeenCalledTimes(2);
});
