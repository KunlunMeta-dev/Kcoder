// Real route functions and JSX handlers under a deterministic hook host.
// This is not a mounted React or browser test; workspace, task, and ACK APIs are controlled mocks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { setLocalePreference } from "@/i18n";
import NewWorkspaceRoute from "@/app/new";
import OpenProjectRoute from "@/app/open-project";

const host = vi.hoisted(() => {
  const replacements: unknown[] = [];
  const pushes: unknown[] = [];
  return {
    app: {} as any,
    params: {} as Record<string, unknown>,
    route: null as null | (() => unknown),
    replacements,
    pushes,
    router: {
      replace: (value: unknown) => replacements.push(value),
      push: (value: unknown) => pushes.push(value),
      back: () => {},
    },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
    states: [] as unknown[],
    setters: [] as Array<((update: unknown) => void) | undefined>,
    refs: [] as Array<{ current: unknown }>,
    memos: [] as Array<{ value: unknown; deps: unknown[] } | undefined>,
    effects: [] as Array<{ deps: unknown[]; cleanup?: () => void } | undefined>,
    pendingEffects: [] as Array<{ index: number; effect: () => void | (() => void); deps: unknown[]; changed: boolean }>,
    stateIndex: 0,
    refIndex: 0,
    memoIndex: 0,
    effectIndex: 0,
  };
});

const api = vi.hoisted(() => {
  const worktreeOperations: any[] = [];
  const openOperations: any[] = [];
  const creationClaims: any[] = [];
  const acknowledgements: any[] = [];
  const acknowledgmentResults: any[] = [];
  const workspaceTaskHandoffLookups: any[] = [];
  const workspaceTaskHandoffReservations: any[] = [];
  const workspaceOpenDeliveryReads: any[] = [];
  const workspaceOpenDeliveryMarks: any[] = [];
  const workspaceOpenDeliveryConfirmations: any[] = [];
  const task = {
    getSnapshot: () => ({ threadId: "task-created-once", title: "Created once" }),
    isDisposed: () => false,
    hasLiveTerminalSessions: () => false,
    close: () => {},
  };
  let acknowledgmentHandler: ((receipt: any, context: any) => Promise<string>) | null = null;

  const reset = () => {
    worktreeOperations.length = 0;
    openOperations.length = 0;
    creationClaims.length = 0;
    acknowledgements.length = 0;
    acknowledgmentResults.length = 0;
    workspaceTaskHandoffLookups.length = 0;
    workspaceTaskHandoffReservations.length = 0;
    workspaceOpenDeliveryReads.length = 0;
    workspaceOpenDeliveryMarks.length = 0;
    workspaceOpenDeliveryConfirmations.length = 0;
    acknowledgmentHandler = null;
  };
  return {
    worktreeOperations,
    openOperations,
    creationClaims,
    acknowledgements,
    workspaceTaskHandoffLookups,
    workspaceTaskHandoffReservations,
    workspaceOpenDeliveryReads,
    workspaceOpenDeliveryMarks,
    workspaceOpenDeliveryConfirmations,
    reset,
    queueAcknowledgment: (result: string) => acknowledgmentResults.push(result),
    holdAcknowledgment: (handler: (receipt: any, context: any) => Promise<string>) => { acknowledgmentHandler = handler; },
    acknowledge: async (receipt: any, context: any) => {
      acknowledgements.push({ receipt, context });
      if (acknowledgmentHandler) return acknowledgmentHandler(receipt, context);
      return acknowledgmentResults.shift() ?? "consumed";
    },
    prepareWorktree: async (profile: any, server: any, path: string, gitRef: string) => {
      worktreeOperations.push({ profile, server, path, gitRef });
      return {
        path: `${path.replace(/\/$/, "")}/.worktrees/review-created`,
        receipt: { version: 2, id: "receipt-worktree-once", kind: "worktree" },
      };
    },
    openWorkspace: async (profile: any, server: any, path: string, create: boolean) => {
      openOperations.push({ profile, server, path, create });
      return {
        path: `${path.replace(/\/$/, "")}/confirmed`,
        receipt: { version: 2, id: "receipt-open-once", kind: create ? "create" : "open" },
      };
    },
    claimCreation: (input: any) => {
      creationClaims.push(input);
      return {
        result: Promise.resolve(task),
        adopt: vi.fn(() => true),
        release: vi.fn(),
      };
    },
    loadWorkspaceTaskHandoff: async (profile: any, server: any, query: any) => {
      workspaceTaskHandoffLookups.push({ profile, server, query });
      return null;
    },
    reserveWorkspaceTaskHandoff: async (profile: any, server: any, receipt: any, input: any) => {
      workspaceTaskHandoffReservations.push({ profile, server, receipt, input });
      return { key: `review-handoff:${receipt.id}`, clientRequestId: `handoff-${receipt.id}`, receiptId: receipt.id };
    },
    readWorkspaceTaskHandoff: async (handoff: any) => ({
      clientRequestId: handoff.clientRequestId,
      linked: { kind: "worktree", input: { model: "review-model", reasoningEffort: undefined } },
    }),
    loadWorkspaceOpenDelivery: async (profile: any, server: any, kind: any, sourcePath: any) => {
      workspaceOpenDeliveryReads.push({ profile, server, kind, sourcePath });
      return null;
    },
    markWorkspaceOpenDelivery: async (profile: any, server: any, receipt: any) => {
      workspaceOpenDeliveryMarks.push({ profile, server, receipt });
    },
    confirmWorkspaceOpenDelivery: async (profile: any, server: any, receipt: any, isCurrent: any) => {
      workspaceOpenDeliveryConfirmations.push({ profile, server, receipt, isCurrent });
    },
    task,
  };
});

vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initialValue: unknown) => {
      const index = host.stateIndex++;
      if (!(index in host.states)) host.states[index] = typeof initialValue === "function" ? (initialValue as () => unknown)() : initialValue;
      if (!host.setters[index]) {
        host.setters[index] = update => {
          host.states[index] = typeof update === "function" ? (update as (previous: unknown) => unknown)(host.states[index]) : update;
        };
      }
      return [host.states[index], host.setters[index]];
    },
    useRef: (initialValue: unknown) => {
      const index = host.refIndex++;
      return host.refs[index] ??= { current: initialValue };
    },
    useMemo: (factory: () => unknown, deps: unknown[]) => {
      const index = host.memoIndex++;
      const previous = host.memos[index];
      if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return previous.value;
      const value = factory();
      host.memos[index] = { value, deps };
      return value;
    },
    useCallback: (callback: (...args: any[]) => unknown, deps: unknown[]) => {
      const index = host.memoIndex++;
      const previous = host.memos[index];
      if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return previous.value;
      host.memos[index] = { value: callback, deps };
      return callback;
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[] = []) => {
      const index = host.effectIndex++;
      const previous = host.effects[index];
      const changed = !previous || deps.length !== previous.deps.length || !deps.every((value, i) => Object.is(value, previous.deps[i]));
      host.pendingEffects.push({ index, effect, deps, changed });
    },
  };
});

vi.mock("expo-router", () => ({ useLocalSearchParams: () => host.params, useRouter: () => host.router }));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => host.insets }));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Dimensions: { get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }), addEventListener: () => ({ remove: () => {} }) },
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Modal: "Modal",
  Platform: { OS: "ios" },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFillObject: {} },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("lucide-react-native", () => Object.fromEntries([
  "Archive", "Check", "ChevronDown", "ChevronLeft", "FolderGit2", "FolderOpen", "FolderPlus",
  "Github", "RotateCcw", "Search", "Server", "Sparkles", "Trash2", "X",
].map(name => [name, name])));
vi.mock("@/components/ui", () => ({ Button: "Button", EmptyState: "EmptyState", Field: "Field", StatusDot: "StatusDot" }));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("@/features/forms/WorkspaceOperationBookkeeping", () => ({ WorkspaceOperationBookkeeping: "WorkspaceOperationBookkeeping" }));
vi.mock("@/state/AppContext", () => ({ useApp: () => host.app }));
vi.mock("@/state/route-profile-activation", () => ({ shouldActivateRouteProfile: () => false }));
vi.mock("@/navigation/back-or-replace", () => ({ backOrReplace: () => {}, profileHomeHref: (id: string) => `/home/${id}` }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/theme", () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: (_target, key) => String(key) }) }),
  useThemedStyles: (makeStyles: (colors: any) => unknown) => makeStyles(new Proxy({}, { get: (_target, key) => String(key) })),
  radius: { sm: 6, md: 10, lg: 14 },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
}));
vi.mock("@/runtime/thread-list-projection", () => ({
  threadListScopeKey: (profile: any, server: any) => JSON.stringify([
    profile.id, profile.baseUrl, profile.authorizationGeneration, profile.deviceId,
    server.id, server.workspacePath, server.accountIdentity?.principalId, server.accountIdentity?.role,
  ]),
}));
vi.mock("@/state/profile-coordinator", () => ({ profileAuthorizationScopeKey: (profile: any) => JSON.stringify([profile.id, profile.baseUrl, profile.authorizationGeneration, profile.deviceId]) }));
vi.mock("@/storage/workspace-profile-fence", () => ({ captureWorkspaceProfileIdentity: (profile: any) => ({ id: profile.id, baseUrl: profile.baseUrl, authorizationGeneration: profile.authorizationGeneration, deviceId: profile.deviceId }) }));
vi.mock("@/storage/workspace-preferences", () => ({ saveWorkspaceState: async () => {}, workspaceStateAuthorizationScope: (profile: any, server: any) => JSON.stringify([profile.id, profile.authorizationGeneration, server.id]) }));
vi.mock("@/storage/new-workspace-preferences", () => ({
  loadNewWorkspacePreference: async () => null,
  saveNewWorkspacePreference: async () => {},
  reasoningEffortLabel: (value: string) => value,
}));
vi.mock("@/storage/pending-workspace-operation", () => ({
  acknowledgeConfirmedWorkspaceOperation: (receipt: any, context: any) => api.acknowledge(receipt, context),
  loadConfirmedWorkspaceOperationReceipt: async () => null,
}));
vi.mock("@/storage/pending-workspace-operation-v2", () => ({
  loadWorkspaceTaskHandoff: (profile: any, server: any, query: any) => api.loadWorkspaceTaskHandoff(profile, server, query),
  reserveWorkspaceTaskHandoff: (profile: any, server: any, receipt: any, input: any) => api.reserveWorkspaceTaskHandoff(profile, server, receipt, input),
  confirmWorkspaceOpenDelivery: (profile: any, server: any, receipt: any, isCurrent: any) => api.confirmWorkspaceOpenDelivery(profile, server, receipt, isCurrent),
  loadWorkspaceOpenDelivery: (profile: any, server: any, kind: any, sourcePath: any) => api.loadWorkspaceOpenDelivery(profile, server, kind, sourcePath),
  markWorkspaceOpenDelivery: (profile: any, server: any, receipt: any) => api.markWorkspaceOpenDelivery(profile, server, receipt),
}));
vi.mock("@/storage/pending-thread-creation", () => ({
  readWorkspaceTaskHandoff: (handoff: any) => api.readWorkspaceTaskHandoff(handoff),
}));
vi.mock("@/runtime/task-runtime", () => ({
  defaultModelOption: (models: any[]) => models.find(model => model.isDefault) ?? models[0],
  modelOptionSelector: (model: any) => model.id,
  selectedModelOption: (models: any[], selection?: string) => models.find(model => model.id === selection),
  listWorkspaceOptions: async () => [{ path: "/srv/project", label: "Review project", kind: "workspace" }],
  listModels: async () => [{ id: "provider::model", model: "model", displayName: "Review model", providerId: "provider", providerName: "Provider", isDefault: true }],
  listManagedWorktrees: async () => [],
  previewManagedWorktreeArchive: async () => { throw new Error("not used"); },
  archiveManagedWorktree: async () => { throw new Error("not used"); },
  restoreManagedWorktree: async () => { throw new Error("not used"); },
  forgetManagedWorktree: async () => { throw new Error("not used"); },
  openWorkspaceWithReceipt: api.openWorkspace,
  prepareManagedWorktreeWithReceipt: api.prepareWorktree,
  TaskRuntime: { claimCreation: api.claimCreation, demo: () => api.task },
  taskRuntimeRegistry: {},
}));

function profile(generation = "generation-A"): GatewayProfile {
  return {
    id: "profile-1", label: "Review Gateway", baseUrl: "https://gateway.example.invalid",
    accessToken: `access-${generation}`, rpcToken: "rpc-review", expiresAt: Date.now() + 60_000,
    authorizationGeneration: generation, deviceId: "device-review", authMode: "device",
  };
}

function server(): KCoderServer {
  return {
    id: "server-1", label: "Review server", description: "controlled route fixture",
    runtime: "kcoder", transport: "local", workspacePath: "/srv/project", command: "kcoder",
  };
}

function appFor(activeProfile: GatewayProfile, activeServer: KCoderServer) {
  return {
    hydrated: true,
    activeProfile,
    profiles: [activeProfile],
    runtime: { servers: [activeServer], statuses: [{ id: activeServer.id, status: "online" }], loading: false, serversReady: true },
    setActiveProfile: async () => {},
    markGatewayReauthorizationRequired: () => {},
    demo: false,
  };
}

function resetHost(): void {
  for (const effect of host.effects) effect?.cleanup?.();
  host.app = {};
  host.params = {};
  host.route = null;
  host.replacements.length = 0;
  host.pushes.length = 0;
  host.states = [];
  host.setters = [];
  host.refs = [];
  host.memos = [];
  host.effects = [];
  host.pendingEffects = [];
  host.stateIndex = 0;
  host.refIndex = 0;
  host.memoIndex = 0;
  host.effectIndex = 0;
}

function renderRoute(): unknown {
  if (!host.route) throw new Error("route review host has no component");
  host.stateIndex = 0;
  host.refIndex = 0;
  host.memoIndex = 0;
  host.effectIndex = 0;
  host.pendingEffects = [];
  return host.route();
}

function flushEffects(): void {
  const pendingEffects = host.pendingEffects;
  host.pendingEffects = [];
  for (const pending of pendingEffects) {
    if (!pending.changed) continue;
    host.effects[pending.index]?.cleanup?.();
    const cleanup = pending.effect();
    host.effects[pending.index] = { deps: pending.deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
  }
}

function commitRoute(): unknown {
  for (let pass = 0; pass < 6; pass += 1) {
    renderRoute();
    flushEffects();
  }
  return renderRoute();
}

async function settleRoute(): Promise<unknown> {
  let tree: unknown;
  for (let pass = 0; pass < 24; pass += 1) {
    tree = commitRoute();
    await Promise.resolve();
  }
  return commitRoute();
}

function elements(node: unknown): Array<ReactElement<Record<string, any>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children as ReactNode)];
}

function byTestId(tree: unknown, testID: string): ReactElement<Record<string, any>> | undefined {
  return elements(tree).find(element => element.props.testID === testID);
}

function buttonWithText(tree: unknown, label: string): ReactElement<Record<string, any>> | undefined {
  const text = (node: unknown): string => {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    if (isValidElement(node)) return text((node.props as { children?: ReactNode }).children);
    return "";
  };
  return elements(tree).find(element => element.type === "Button" && text(element.props.children).trim() === label);
}

function press(element: ReactElement<Record<string, any>> | undefined): void {
  if (element?.props.disabled) return;
  element?.props.onPress?.();
}

async function drainMicrotasks(): Promise<void> {
  for (let pass = 0; pass < 32; pass += 1) await Promise.resolve();
}

function startNewRoute(activeProfile = profile(), activeServer = server()): unknown {
  host.app = appFor(activeProfile, activeServer);
  host.params = { profileId: activeProfile.id, serverId: activeServer.id };
  host.route = NewWorkspaceRoute;
  return commitRoute();
}

function startOpenRoute(activeProfile = profile(), activeServer = server()): unknown {
  host.app = appFor(activeProfile, activeServer);
  host.params = { profileId: activeProfile.id };
  host.route = OpenProjectRoute;
  return commitRoute();
}

async function readyNewRoute(): Promise<unknown> {
  if (!host.route) startNewRoute();
  let tree = await settleRoute();
  const path = byTestId(tree, "workspace-path");
  if (path?.props.value !== "/srv/project") path?.props.onChangeText?.("/srv/project");
  tree = commitRoute();
  byTestId(tree, "workspace-isolation-worktree")?.props.onPress?.();
  tree = commitRoute();
  byTestId(tree, "new-workspace-prompt")?.props.onChangeText?.("Create one task from the prepared worktree");
  await vi.waitFor(() => {
    tree = commitRoute();
    expect(api.workspaceTaskHandoffLookups.length).toBeGreaterThan(0);
    expect(byTestId(tree, "create-workspace")?.props.disabled).toBe(false);
  });
  return tree;
}

async function readyOpenRoute(): Promise<unknown> {
  let tree = await settleRoute();
  await vi.waitFor(() => {
    tree = commitRoute();
    expect(api.workspaceOpenDeliveryReads.length).toBeGreaterThan(0);
    expect(buttonWithText(tree, "Open project")?.props.disabled).toBe(false);
  });
  return tree;
}

beforeEach(() => {
  setLocalePreference("en");
  resetHost();
  api.reset();
});

afterEach(() => {
  setLocalePreference("system");
  resetHost();
  vi.restoreAllMocks();
});

describe("V2 unverified workspace route consumers", () => {
  it("keeps the created task and retries only its original receipt after identity verification", async () => {
    api.queueAcknowledgment("unverified");
    api.queueAcknowledgment("consumed");
    await readyNewRoute();
    let tree = commitRoute();
    const createButton = byTestId(tree, "create-workspace");
    expect(createButton?.props.disabled).toBe(false);
    press(createButton);

    await vi.waitFor(() => expect(api.acknowledgements).toHaveLength(1));
    await drainMicrotasks();
    tree = commitRoute();
    expect(byTestId(tree, "retry-created-workspace-scope")).toBeDefined();
    expect(byTestId(tree, "create-workspace")?.props.disabled).toBe(true);
    expect(host.replacements).toHaveLength(0);
    expect(api.worktreeOperations).toHaveLength(1);
    expect(api.worktreeOperations[0]).toMatchObject({ profile: { authorizationGeneration: "generation-A" }, server: { id: "server-1" }, path: "/srv/project" });
    expect(api.creationClaims).toHaveLength(1);
    press(byTestId(tree, "create-workspace"));
    expect(api.creationClaims).toHaveLength(1);

    const retry = byTestId(tree, "retry-created-workspace-scope");
    press(retry);
    await vi.waitFor(() => expect(api.acknowledgements).toHaveLength(2));
    await drainMicrotasks();

    expect(api.acknowledgements.map(entry => entry.receipt.id)).toEqual(["receipt-worktree-once", "receipt-worktree-once"]);
    expect(api.acknowledgements.every(entry => entry.context.profile.id === "profile-1" && entry.context.profile.authorizationGeneration === "generation-A" && entry.context.server.id === "server-1")).toBe(true);
    expect(api.worktreeOperations).toHaveLength(1);
    expect(api.creationClaims).toHaveLength(1);
    expect(host.replacements).toHaveLength(1);
    expect(host.replacements[0]).toMatchObject({
      pathname: "/h/[profileId]/task/[serverId]/[threadId]",
      params: { profileId: "profile-1", serverId: "server-1", threadId: "task-created-once", cwd: "/srv/project/.worktrees/review-created" },
    });
  });

  it("keeps the confirmed open path and retries only its original receipt", async () => {
    api.queueAcknowledgment("unverified");
    api.queueAcknowledgment("consumed");
    startOpenRoute();
    let tree = await readyOpenRoute();
    const submit = buttonWithText(tree, "Open project");
    expect(submit?.props.disabled).toBe(false);
    press(submit);

    await vi.waitFor(() => expect(api.acknowledgements).toHaveLength(1));
    await drainMicrotasks();
    tree = commitRoute();
    expect(byTestId(tree, "retry-opened-workspace-scope")).toBeDefined();
    expect(buttonWithText(tree, "Open project")?.props.disabled).toBe(true);
    expect(host.replacements).toHaveLength(0);
    expect(api.openOperations).toHaveLength(1);
    expect(api.openOperations[0]).toMatchObject({ profile: { authorizationGeneration: "generation-A" }, server: { id: "server-1" }, path: "/srv/project", create: false });
    press(buttonWithText(tree, "Open project"));
    expect(api.openOperations).toHaveLength(1);

    press(byTestId(tree, "retry-opened-workspace-scope"));
    await vi.waitFor(() => expect(api.acknowledgements).toHaveLength(2));
    await drainMicrotasks();

    expect(api.acknowledgements.map(entry => entry.receipt.id)).toEqual(["receipt-open-once", "receipt-open-once"]);
    expect(api.acknowledgements.every(entry => entry.context.profile.authorizationGeneration === "generation-A" && entry.context.server.id === "server-1")).toBe(true);
    expect(api.openOperations).toHaveLength(1);
    expect(host.replacements).toHaveLength(1);
    expect(host.replacements[0]).toMatchObject({
      pathname: "/new",
      params: { profileId: "profile-1", serverId: "server-1", cwd: "/srv/project/confirmed" },
    });
  });

  it("does not navigate or publish an old created task when its ACK finishes after the form owner changes", async () => {
    let release!: (result: string) => void;
    const heldAck = new Promise<string>(resolve => { release = resolve; });
    api.holdAcknowledgment(() => heldAck);
    await readyNewRoute();
    let tree = commitRoute();
    press(byTestId(tree, "create-workspace"));
    await vi.waitFor(() => expect(api.acknowledgements).toHaveLength(1));
    expect(api.acknowledgements[0]?.context.profile.authorizationGeneration).toBe("generation-A");

    const profileB = profile("generation-B");
    const serverB = server();
    host.app = appFor(profileB, serverB);
    host.params = { profileId: profileB.id, serverId: serverB.id };
    tree = await settleRoute();
    expect(byTestId(tree, "retry-created-workspace-scope")).toBeUndefined();
    release("consumed");
    await drainMicrotasks();
    tree = commitRoute();

    expect(host.replacements).toHaveLength(0);
    expect(byTestId(tree, "retry-created-workspace-scope")).toBeUndefined();
    expect(byTestId(tree, "new-workspace-error")).toBeUndefined();
    expect(api.worktreeOperations).toHaveLength(1);
    expect(api.creationClaims).toHaveLength(1);
    expect(api.acknowledgements).toHaveLength(1);
  });

  it("does not navigate an opened path after a late ACK crosses to a new owner", async () => {
    let release!: (result: string) => void;
    const heldAck = new Promise<string>(resolve => { release = resolve; });
    api.holdAcknowledgment(() => heldAck);
    startOpenRoute();
    const treeA = await readyOpenRoute();
    press(buttonWithText(treeA, "Open project"));
    await vi.waitFor(() => expect(api.acknowledgements).toHaveLength(1));

    const profileB = profile("generation-B");
    const serverB = server();
    host.app = appFor(profileB, serverB);
    host.params = { profileId: profileB.id };
    let treeB = await settleRoute();
    expect(byTestId(treeB, "retry-opened-workspace-scope")).toBeUndefined();
    release("consumed");
    await drainMicrotasks();
    treeB = commitRoute();

    expect(host.replacements).toHaveLength(0);
    expect(byTestId(treeB, "retry-opened-workspace-scope")).toBeUndefined();
    expect(byTestId(treeB, "open-project-error")).toBeUndefined();
    expect(api.openOperations).toHaveLength(1);
    expect(api.acknowledgements).toHaveLength(1);
  });
});
