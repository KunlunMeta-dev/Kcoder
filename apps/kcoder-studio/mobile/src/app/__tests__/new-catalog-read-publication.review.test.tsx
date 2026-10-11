// Candidate test for the static-02 New route. It uses the existing hook-host
// pattern and browser-profile fixture; the catalog APIs and GatewayRpcClient
// remain real while the WebSocket responses are controlled locally.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const fixture = vi.hoisted(() => ({
  host: {
    states: [] as unknown[], setters: [] as Array<((value: unknown) => void) | undefined>,
    refs: [] as Array<{ current: unknown }>, memos: [] as Array<{ value: unknown; deps: unknown[] } | undefined>,
    effects: [] as Array<{ deps: unknown[]; cleanup?: () => void } | undefined>,
    pendingEffects: [] as Array<{ index: number; effect: () => void | (() => void); deps: unknown[]; changed: boolean }>,
    stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0,
  },
  params: {} as Record<string, unknown>,
  app: {} as any,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = fixture.host.stateIndex++;
      if (!(index in fixture.host.states)) fixture.host.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      fixture.host.setters[index] ??= (update: unknown) => {
        fixture.host.states[index] = typeof update === "function" ? (update as (previous: unknown) => unknown)(fixture.host.states[index]) : update;
      };
      return [fixture.host.states[index], fixture.host.setters[index]];
    },
    useRef: (initial: unknown) => {
      const index = fixture.host.refIndex++;
      return fixture.host.refs[index] ??= { current: initial };
    },
    useMemo: (factory: () => unknown, deps: unknown[]) => {
      const index = fixture.host.memoIndex++;
      const old = fixture.host.memos[index];
      if (old && deps.length === old.deps.length && deps.every((value, i) => Object.is(value, old.deps[i]))) return old.value;
      const value = factory(); fixture.host.memos[index] = { value, deps }; return value;
    },
    useCallback: (callback: (...args: any[]) => unknown, deps: unknown[]) => {
      const index = fixture.host.memoIndex++;
      const old = fixture.host.memos[index];
      if (old && deps.length === old.deps.length && deps.every((value, i) => Object.is(value, old.deps[i]))) return old.value;
      fixture.host.memos[index] = { value: callback, deps }; return callback;
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[] = []) => {
      const index = fixture.host.effectIndex++;
      const old = fixture.host.effects[index];
      const changed = !old || deps.length !== old.deps.length || !deps.every((value, i) => Object.is(value, old.deps[i]));
      fixture.host.pendingEffects.push({ index, effect, deps, changed });
    },
  };
});

vi.mock("expo-router", () => ({ useLocalSearchParams: () => fixture.params, useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }) }));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator", Dimensions: { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove: vi.fn() }) },
  KeyboardAvoidingView: "KeyboardAvoidingView", Modal: "Modal", Platform: { OS: "web" }, Pressable: "Pressable", ScrollView: "ScrollView",
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1, absoluteFillObject: {} }, Text: "Text", TextInput: "TextInput", View: "View",
}));
vi.mock("lucide-react-native", () => Object.fromEntries(["Check", "ChevronDown", "ChevronLeft", "FolderGit2", "FolderOpen", "FolderPlus", "Server", "Sparkles", "X"].map((name) => [name, name])));
vi.mock("@/components/ui", () => ({ Button: "Button", EmptyState: "EmptyState", Field: "Field", StatusDot: "StatusDot" }));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("@/features/forms/WorkspaceOperationBookkeeping", () => ({ WorkspaceOperationBookkeeping: "WorkspaceOperationBookkeeping" }));
vi.mock("@/state/AppContext", () => ({ useApp: () => fixture.app }));
vi.mock("@/state/route-profile-activation", () => ({ shouldActivateRouteProfile: () => false }));
vi.mock("@/navigation/back-or-replace", () => ({ backOrReplace: vi.fn(), profileHomeHref: (id: string) => "/h/" + id }));
vi.mock("@/i18n", () => ({ t: (value: string) => value }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/theme", () => {
  const colors = new Proxy({}, { get: (_target, key) => String(key) });
  return {
    colors,
    useTheme: () => ({ colors, mode: "dark" }),
    useThemedStyles: (factory: (value: any) => unknown) => factory(colors),
    radius: { sm: 6, md: 10, lg: 14 },
    spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  };
});
vi.mock("@/state/profile-coordinator", () => ({ profileAuthorizationScopeKey: (profile: any) => JSON.stringify([profile.id, profile.authorizationGeneration]) }));
vi.mock("@/storage/new-workspace-preferences", () => ({ loadNewWorkspacePreference: async () => null, saveNewWorkspacePreference: async () => {}, reasoningEffortLabel: (value: string) => value }));
vi.mock("@/storage/workspace-preferences", () => ({ saveWorkspaceState: async () => {}, workspaceStateAuthorizationScope: (profile: any, server: any) => JSON.stringify([profile.id, profile.authorizationGeneration, server.id]) }));
vi.mock("@/storage/pending-workspace-operation", () => ({ loadConfirmedWorkspaceOperationReceipt: async () => null, acknowledgeConfirmedWorkspaceOperation: async () => "consumed" }));
vi.mock("@/storage/pending-workspace-operation-v2", () => ({ reserveWorkspaceTaskHandoff: async () => { throw new Error("unexpected handoff reservation"); }, loadWorkspaceTaskHandoff: async () => null, verifyWorkspaceTaskHandoff: async () => null, confirmWorkspaceOpenDelivery: async () => {} }));
vi.mock("@/storage/pending-thread-creation", () => ({ readWorkspaceTaskHandoff: async () => null }));
vi.mock("@/runtime/task-runtime", async () => {
  const [models, workspaces] = await Promise.all([import("@/runtime/task-runtime/modelCatalog"), import("@/runtime/task-runtime/workspaces")]);
  return {
    defaultModelOption: models.defaultModelOption, modelOptionSelector: models.modelOptionSelector, selectedModelOption: models.selectedModelOption,
    listModels: models.listModels, listWorkspaceOptions: workspaces.listWorkspaceOptions,
    listManagedWorktrees: async () => [], previewManagedWorktreeArchive: async () => null, archiveManagedWorktree: async () => {},
    prepareManagedWorktreeWithReceipt: async () => { throw new Error("unexpected worktree preparation"); },
    TaskRuntime: { claimCreation: () => { throw new Error("unexpected task creation"); }, demo: () => ({}) },
    taskRuntimeRegistry: { get: () => undefined, put: vi.fn() },
  };
});

import NewWorkspaceRoute from "../new";
import { installBrowserProfileFixture } from "@/test/browser-profile-fixture";
import { installGatewayAuthorizationResolver } from "@/gateway/http";
import { taskRuntimeTestHelpers } from "@/runtime/task-runtime/connectionFactory";
import { clearModelCache } from "@/runtime/task-runtime/modelCatalog";
import { clearWorkspaceOptionsCache } from "@/runtime/task-runtime/workspaces";
import { catalogReadScopeKey } from "@/runtime/task-runtime/new-catalog-read-source";
import { ScopedReadCache } from "@/runtime/scoped-read-cache";

class RouteRpcSocket {
  static OPEN = 1;
  static instances: RouteRpcSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly sent: Array<{ id?: number; method?: string }> = [];
  closeCount = 0;

  constructor(readonly url: string) { RouteRpcSocket.instances.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
  send(raw: string): void {
    const message = JSON.parse(raw) as { id?: number; method?: string };
    this.sent.push(message);
    if (message.method === "initialize") queueMicrotask(() => this.receive({ id: message.id, result: { protocolVersion: "2026-07-27" } }));
  }
  receive(value: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", ...value }) }); }
  respond(method: string, result: unknown): void {
    const request = [...this.sent].reverse().find((item) => item.method === method && typeof item.id === "number");
    if (!request?.id) throw new Error(`no pending ${method} request`);
    this.receive({ id: request.id, result });
  }
  close(): void { this.closeCount += 1; this.readyState = 3; this.onclose?.(); }
}

const profile = {
  id: "new-route-profile-A", label: "Gateway A", baseUrl: "https://gateway.invalid", accessToken: "access-test", rpcToken: "rpc-test",
  authorizationGeneration: "family-A", deviceId: "device-A", authMode: "device" as const, expiresAt: Date.now() + 60_000,
};
const serverA = { id: "target-A", label: "Target A", description: "A", runtime: "kcoder" as const, transport: "local" as const, workspacePath: "/workspace/A" };
const serverB = { id: "target-B", label: "Target B", description: "B", runtime: "kcoder" as const, transport: "local" as const, workspacePath: "/workspace/B" };
let uninstallAuthorization: (() => void) | undefined;
let restoreCacheAdmissionSpy: (() => void) | undefined;

function resetHost(): void {
  Object.assign(fixture.host, { states: [], setters: [], refs: [], memos: [], effects: [], pendingEffects: [], stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0 });
}
function beginRender(): void {
  fixture.host.stateIndex = 0; fixture.host.refIndex = 0; fixture.host.memoIndex = 0; fixture.host.effectIndex = 0; fixture.host.pendingEffects = [];
}
function render(): unknown {
  beginRender();
  const tree = NewWorkspaceRoute();
  const pending = fixture.host.pendingEffects; fixture.host.pendingEffects = [];
  for (const item of pending) {
    if (!item.changed) continue;
    fixture.host.effects[item.index]?.cleanup?.();
    const cleanup = item.effect();
    fixture.host.effects[item.index] = { deps: item.deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
  }
  return tree;
}
async function settle(): Promise<unknown> {
  let tree: unknown;
  for (let pass = 0; pass < 20; pass += 1) {
    tree = render();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  }
  return render();
}
function elements(node: unknown): Array<ReactElement<Record<string, any>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children as ReactNode)];
}
function byTestId(tree: unknown, testID: string): ReactElement<Record<string, any>> | undefined {
  return elements(tree).find((element) => element.props.testID === testID);
}
function safeSocketTarget(socket: RouteRpcSocket | undefined): { server: string | null; workspace: string | null } {
  if (!socket) return { server: null, workspace: null };
  const actualUrl = new URL(socket.url);
  return { server: actualUrl.searchParams.get("server"), workspace: actualUrl.searchParams.get("workspace") };
}
async function waitForSocket(index: number, methods: string[], phase: string, sourceKey: string): Promise<RouteRpcSocket> {
  await vi.waitFor(() => {
    const socket = RouteRpcSocket.instances[index];
    const actualTarget = safeSocketTarget(socket);
    expect(socket, `phase=${phase} socketIndex=${index} sourceKey=${sourceKey} actualTarget=${JSON.stringify(actualTarget)} missing=socket`).toBeDefined();
    const sentMethods = socket?.sent.map((item) => item.method).filter((method): method is string => Boolean(method)) ?? [];
    const missing = methods.filter((method) => !sentMethods.includes(method));
    expect(missing, `phase=${phase} socketIndex=${index} sourceKey=${sourceKey} actualTarget=${JSON.stringify(actualTarget)} missing=${JSON.stringify(missing)} sent=${JSON.stringify(sentMethods)}`).toEqual([]);
  });
  return RouteRpcSocket.instances[index]!;
}
function respondWorkspace(socket: RouteRpcSocket, path: string): void {
  socket.respond("runtime.workspaces.list", { items: [{ workspacePath: path, label: path }] });
  socket.respond("runtime.worktrees.list", { items: [] });
}
function respondModels(socket: RouteRpcSocket): void {
  socket.respond("runtime.models.list", { data: [{ id: "provider::model", model: "model", displayName: "Model", providerId: "provider", providerName: "Provider", isDefault: true }] });
}

beforeEach(() => {
  resetHost();
  fixture.params = { profileId: profile.id, serverId: serverA.id };
  fixture.app = {
    hydrated: true, activeProfile: profile, profiles: [profile],
    runtime: { servers: [serverA, serverB], statuses: [], loading: false, reauthorizationRequired: false },
    setActiveProfile: vi.fn(), markGatewayReauthorizationRequired: vi.fn(), demo: false,
  };
  RouteRpcSocket.instances = [];
  installBrowserProfileFixture([profile]);
  uninstallAuthorization = installGatewayAuthorizationResolver(async () => {});
  vi.stubGlobal("WebSocket", RouteRpcSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  restoreCacheAdmissionSpy?.(); restoreCacheAdmissionSpy = undefined;
  for (const effect of fixture.host.effects) effect?.cleanup?.();
  resetHost();
  uninstallAuthorization?.(); uninstallAuthorization = undefined;
  taskRuntimeTestHelpers.resetConnector();
  clearModelCache(); clearWorkspaceOptionsCache();
  RouteRpcSocket.instances = [];
});

it("keeps a lawful external A waiter alive after selecting B and never publishes A's result into B's form", async () => {
  await settle();
  const socketA = await waitForSocket(0, ["runtime.workspaces.list", "runtime.worktrees.list", "runtime.models.list"], "A initial load", catalogReadScopeKey(profile, serverA));
  const { listWorkspaceOptions } = await import("@/runtime/task-runtime");
  const cacheAdmissionSpy = vi.spyOn(ScopedReadCache.prototype, "get");
  restoreCacheAdmissionSpy = () => cacheAdmissionSpy.mockRestore();
  const externalA = listWorkspaceOptions(profile, serverA);
  const externalAResult = externalA.then(
    (value) => ({ state: "fulfilled" as const, value }),
    (error) => ({ state: "rejected" as const, error }),
  );
  await settle();
  const scopeKeyA = catalogReadScopeKey(profile, serverA);
  expect(cacheAdmissionSpy.mock.calls.filter(([key]) => key === scopeKeyA)).toHaveLength(1);
  expect(RouteRpcSocket.instances).toHaveLength(1);
  cacheAdmissionSpy.mockRestore(); restoreCacheAdmissionSpy = undefined;

  const firstTree = render();
  const selectB = byTestId(firstTree, `server-option-${serverB.id}`);
  expect(selectB).toBeDefined();
  selectB?.props.onPress?.();
  await settle();
  const socketB = await waitForSocket(1, ["runtime.workspaces.list", "runtime.worktrees.list", "runtime.models.list"], "B after selection", catalogReadScopeKey(profile, serverB));
  expect(socketA.closeCount).toBe(0);

  respondWorkspace(socketB, "/workspace/B");
  respondModels(socketB);
  let tree = await settle();
  expect(byTestId(tree, `workspace-option-${encodeURIComponent("/workspace/B")}`)).toBeDefined();

  respondWorkspace(socketA, "/workspace/A");
  const settledExternalA = await externalAResult;
  if (settledExternalA.state === "rejected") throw settledExternalA.error;
  expect(settledExternalA.value).toMatchObject([{ path: "/workspace/A" }]);
  tree = await settle();
  expect(byTestId(tree, `workspace-option-${encodeURIComponent("/workspace/B")}`)).toBeDefined();
  expect(byTestId(tree, `workspace-option-${encodeURIComponent("/workspace/A")}`)).toBeUndefined();
  expect(RouteRpcSocket.instances).toHaveLength(2);
});
