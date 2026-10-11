// Exercises the actual New route's handoff discovery and recovery handlers.
// Storage responses and preference timing are controlled at the module seam;
// durable storage authorization/scope behavior remains covered by storage tests.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const fixture = vi.hoisted(() => ({
  host: {
    states: [] as unknown[],
    setters: [] as Array<((update: unknown) => void) | undefined>,
    refs: [] as Array<{ current: unknown }>,
    memos: [] as Array<{ value: unknown; deps: unknown[] } | undefined>,
    effects: [] as Array<{ deps: unknown[]; cleanup?: () => void } | undefined>,
    pendingEffects: [] as Array<{ index: number; effect: () => void | (() => void); deps: unknown[]; changed: boolean }>,
    stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0,
  },
  params: {} as Record<string, unknown>,
  app: {} as any,
  routerReplacements: [] as unknown[],
  handoffQueries: [] as Array<Record<string, unknown>>,
  loadReceiptCalls: [] as unknown[][],
  verifyCalls: [] as unknown[][],
  claimInputs: [] as any[],
  prepareCalls: [] as unknown[][],
  reserveCalls: [] as unknown[][],
  receipt: null as any,
  handoff: null as any,
  pending: null as any,
  lookup: undefined as ((query: Record<string, unknown>) => Promise<any>) | undefined,
  verify: undefined as ((...args: unknown[]) => Promise<any>) | undefined,
  receiptLookup: undefined as (() => Promise<any>) | undefined,
  preferenceMode: "ready" as "ready" | "held" | "fail",
  preferenceGate: null as null | { promise: Promise<any>; reject: (error: unknown) => void; resolve: (value: unknown) => void },
  preferenceStarted: false,
  task: {
    getSnapshot: () => ({ threadId: "original-thread", title: "Original task" }),
    isDisposed: () => false,
    reconnectContext: undefined,
  },
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

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => fixture.params,
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: (value: unknown) => fixture.routerReplacements.push(value) }),
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator", Dimensions: { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove: vi.fn() }) },
  KeyboardAvoidingView: "KeyboardAvoidingView", Modal: "Modal", Platform: { OS: "web" }, Pressable: "Pressable", ScrollView: "ScrollView",
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1, absoluteFillObject: {} }, Text: "Text", TextInput: "TextInput", View: "View",
}));
vi.mock("lucide-react-native", () => Object.fromEntries(["Check", "ChevronDown", "ChevronLeft", "FolderGit2", "FolderOpen", "FolderPlus", "Server", "Sparkles", "X"].map(name => [name, name])));
vi.mock("@/components/ui", () => ({ Button: "Button", EmptyState: "EmptyState", Field: "Field", StatusDot: "StatusDot" }));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("@/features/forms/WorkspaceOperationBookkeeping", () => ({ WorkspaceOperationBookkeeping: "WorkspaceOperationBookkeeping" }));
vi.mock("@/state/AppContext", () => ({ useApp: () => fixture.app }));
vi.mock("@/state/route-profile-activation", () => ({ shouldActivateRouteProfile: () => false }));
vi.mock("@/navigation/back-or-replace", () => ({ backOrReplace: vi.fn(), profileHomeHref: (id: string) => "/h/" + id }));
vi.mock("@/i18n", () => ({ t: (value: string) => value }));
vi.mock("@/theme", () => {
  const colors = new Proxy({}, { get: (_target, key) => String(key) });
  return {
    useTheme: () => ({ colors, mode: "dark" }),
    useThemedStyles: (factory: (value: any) => unknown) => factory(colors),
    radius: { sm: 4, md: 6, lg: 8, xl: 12, pill: 999 },
    spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  };
});
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/state/profile-coordinator", () => ({ profileAuthorizationScopeKey: (profile: any) => JSON.stringify([profile.id, profile.authorizationGeneration]) }));
vi.mock("@/runtime/thread-list-projection", () => ({ threadListScopeKey: (profile: any, server: any) => JSON.stringify([profile.id, profile.authorizationGeneration, server.id]) }));
vi.mock("@/storage/workspace-profile-fence", () => ({ captureWorkspaceProfileIdentity: (profile: any) => ({ id: profile.id, baseUrl: profile.baseUrl, deviceId: profile.deviceId, authorizationGeneration: profile.authorizationGeneration }) }));
vi.mock("@/storage/workspace-preferences", () => ({
  saveWorkspaceState: vi.fn(async () => {}),
  workspaceStateAuthorizationScope: (profile: any, server: any) => JSON.stringify([profile.id, profile.authorizationGeneration, server.id]),
}));
vi.mock("@/storage/new-workspace-preferences", () => ({
  loadNewWorkspacePreference: async () => {
    fixture.preferenceStarted = true;
    if (fixture.preferenceMode === "held") return fixture.preferenceGate!.promise;
    if (fixture.preferenceMode === "fail") throw new Error("injected preference read failure");
    return null;
  },
  saveNewWorkspacePreference: async () => {},
  reasoningEffortLabel: (value: string) => value,
}));
vi.mock("@/storage/pending-workspace-operation", () => ({
  loadConfirmedWorkspaceOperationReceipt: async (...args: unknown[]) => {
    fixture.loadReceiptCalls.push(args);
    return fixture.receiptLookup ? fixture.receiptLookup() : fixture.receipt;
  },
  acknowledgeConfirmedWorkspaceOperation: async () => "consumed",
}));
vi.mock("@/storage/pending-workspace-operation-v2", () => ({
  reserveWorkspaceTaskHandoff: async (...args: unknown[]) => { fixture.reserveCalls.push(args); throw new Error("unexpected handoff reservation"); },
  loadWorkspaceTaskHandoff: async (_profile: unknown, _server: unknown, query: Record<string, unknown>) => {
    fixture.handoffQueries.push(query);
    if (!fixture.lookup) return null;
    return fixture.lookup(query);
  },
  verifyWorkspaceTaskHandoff: async (...args: unknown[]) => { fixture.verifyCalls.push(args); return fixture.verify ? fixture.verify(...args) : fixture.pending; },
  confirmWorkspaceOpenDelivery: async () => {},
}));
vi.mock("@/storage/pending-thread-creation", () => ({ readWorkspaceTaskHandoff: async () => fixture.pending }));
vi.mock("@/runtime/task-runtime", () => ({
  defaultModelOption: () => null, modelOptionSelector: (value: any) => value.id, selectedModelOption: () => null,
  listModels: async () => [], listWorkspaceOptions: async () => [], listManagedWorktrees: async () => [],
  previewManagedWorktreeArchive: async () => null, archiveManagedWorktree: async () => {},
  prepareManagedWorktreeWithReceipt: async (...args: unknown[]) => { fixture.prepareCalls.push(args); throw new Error("unexpected worktree preparation"); },
  TaskRuntime: {
    claimCreation: (input: any) => {
      fixture.claimInputs.push(input);
      return { result: Promise.resolve(fixture.task), adopt: () => true, release: vi.fn() };
    },
    demo: () => fixture.task,
  },
  taskRuntimeRegistry: { get: () => undefined, put: vi.fn() },
}));

import NewWorkspaceRoute from "../new";

const profile = {
  id: "handoff-route-profile", label: "Gateway", baseUrl: "https://gateway.invalid", accessToken: "access-test-only", rpcToken: "rpc-test-only",
  authorizationGeneration: "generation-A", deviceId: "device-A", authMode: "device" as const, expiresAt: Date.now() + 60_000,
};
const server = { id: "target-A", label: "Gateway target", runtime: "kcoder" as const, transport: "local" as const, workspacePath: "/workspace/source" };
const openReceipt = { version: 2, profileId: profile.id, id: "open-receipt-original", key: "opaque-open-receipt-key", result: "/workspace/source", completedAt: 100, consumed: false };
const handoffHandle = { key: "opaque-worktree-handoff-key", clientRequestId: "worktree-create-request-7", receiptId: "worktree-receipt-7" };
const pending = {
  clientRequestId: handoffHandle.clientRequestId, threadId: "thread-existing-7",
  linked: {
    receipt: { version: 2, id: handoffHandle.receiptId, result: "/workspace/source/.worktrees/feature-7" },
    kind: "worktree", sourcePath: "/workspace/source",
    input: { cwd: "/workspace/source/.worktrees/feature-7", prompt: "original prompt", model: "original-model", managedWorktreeSourcePath: "/workspace/source" },
    turn: { phase: "accepted", clientMessageId: "turn-message-original", turnId: "turn-existing-7" },
  },
};

function resetHost(): void {
  Object.assign(fixture.host, { states: [], setters: [], refs: [], memos: [], effects: [], pendingEffects: [], stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0 });
}
function beginRender(): void {
  fixture.host.stateIndex = 0; fixture.host.refIndex = 0; fixture.host.memoIndex = 0; fixture.host.effectIndex = 0; fixture.host.pendingEffects = [];
}
function render(): unknown {
  beginRender();
  const tree = NewWorkspaceRoute();
  const effects = fixture.host.pendingEffects; fixture.host.pendingEffects = [];
  for (const item of effects) {
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
  return elements(tree).find(element => element.props.testID === testID);
}
function hasTestId(tree: unknown, testID: string): boolean { return Boolean(byTestId(tree, testID)); }

beforeEach(() => {
  resetHost();
  fixture.params = { profileId: profile.id, serverId: server.id, cwd: "/workspace/source", operationReceiptId: openReceipt.id, operationReceiptVersion: "2", operationKind: "open", operationSourcePath: "/workspace/source" };
  fixture.app = { hydrated: true, activeProfile: profile, profiles: [profile], runtime: { servers: [server], statuses: [], loading: false }, setActiveProfile: vi.fn(), markGatewayReauthorizationRequired: vi.fn(), demo: false };
  fixture.routerReplacements.length = 0; fixture.handoffQueries.length = 0; fixture.loadReceiptCalls.length = 0; fixture.verifyCalls.length = 0;
  fixture.claimInputs.length = 0; fixture.prepareCalls.length = 0; fixture.reserveCalls.length = 0;
  fixture.receipt = openReceipt; fixture.handoff = { handle: handoffHandle, value: pending }; fixture.pending = pending;
  fixture.lookup = async query => {
    if (query.receiptId === openReceipt.id) return null;
    if (query.kind === "worktree" && query.sourcePath === "/workspace/source") return fixture.handoff;
    return null;
  };
  fixture.verify = undefined;
  fixture.receiptLookup = undefined;
  fixture.preferenceMode = "ready"; fixture.preferenceGate = null; fixture.preferenceStarted = false;
  fixture.task = { getSnapshot: () => ({ threadId: "thread-existing-7", title: "Original task" }), isDisposed: () => false, reconnectContext: undefined };
});

afterEach(() => {
  for (const effect of fixture.host.effects) effect?.cleanup?.();
  resetHost();
});

it("discovers the distinct worktree handoff while preferences are held, and keeps recovery available after preference failure", async () => {
  let rejectPreference!: (error: unknown) => void;
  const preferencePromise = new Promise<null>((_resolve, reject) => { rejectPreference = reject; });
  fixture.preferenceMode = "held";
  fixture.preferenceGate = { promise: preferencePromise, reject: rejectPreference, resolve: () => {} };

  let tree = await settle();
  expect(fixture.preferenceStarted).toBe(true);
  expect(fixture.handoffQueries).toEqual([
    { receiptId: openReceipt.id },
    { kind: "worktree", sourcePath: "/workspace/source" },
  ]);
  expect(hasTestId(tree, "recover-created-workspace-task")).toBe(true);

  rejectPreference(new Error("preference read failed"));
  tree = await settle();
  expect(hasTestId(tree, "new-workspace-preference-read-error")).toBe(true);
  expect(hasTestId(tree, "recover-created-workspace-task")).toBe(true);
});

it("fails closed when the route receipt belongs to another current scope and never searches that route's handoff", async () => {
  fixture.receiptLookup = async () => null;
  const tree = await settle();
  expect(hasTestId(tree, "workspace-task-handoff-error")).toBe(true);
  expect(hasTestId(tree, "recover-created-workspace-task")).toBe(false);
  expect(fixture.handoffQueries).toEqual([]);
  expect(fixture.prepareCalls).toEqual([]);
  expect(fixture.claimInputs).toEqual([]);
});

it("does not surface a handoff from a foreign workspace family", async () => {
  fixture.lookup = async query => query.receiptId === openReceipt.id ? null : null;
  const tree = await settle();
  expect(fixture.handoffQueries).toContainEqual({ kind: "worktree", sourcePath: "/workspace/source" });
  expect(hasTestId(tree, "recover-created-workspace-task")).toBe(false);
  expect(hasTestId(tree, "workspace-task-handoff-error")).toBe(false);
  expect(fixture.claimInputs).toEqual([]);
});

it("does not publish a source candidate when fresh exact-handle verification detects a scope change", async () => {
  fixture.verify = async () => { throw new Error("handoff authorization scope changed"); };
  const tree = await settle();
  expect(fixture.handoffQueries).toEqual([
    { receiptId: openReceipt.id },
    { kind: "worktree", sourcePath: "/workspace/source" },
  ]);
  expect(fixture.verifyCalls).toHaveLength(1);
  expect(fixture.verifyCalls[0][2]).toEqual(handoffHandle);
  expect(hasTestId(tree, "workspace-task-handoff-error")).toBe(true);
  expect(hasTestId(tree, "recover-created-workspace-task")).toBe(false);
  expect(fixture.claimInputs).toEqual([]);
});

it("keeps ambiguous source matches visible and blocks a new create or recovery dispatch", async () => {
  fixture.lookup = async query => {
    if (query.receiptId === openReceipt.id) return null;
    throw new Error("ambiguous workspace handoff matches");
  };
  const tree = await settle();
  expect(hasTestId(tree, "workspace-task-handoff-error")).toBe(true);
  expect(hasTestId(tree, "recover-created-workspace-task")).toBe(false);
  expect(byTestId(tree, "create-workspace")?.props.disabled).toBe(true);
  byTestId(tree, "create-workspace")?.props.onPress?.();
  await settle();
  expect(fixture.prepareCalls).toEqual([]);
  expect(fixture.reserveCalls).toEqual([]);
  expect(fixture.claimInputs).toEqual([]);
});

it("rechecks the verified source immediately before Create and blocks dispatch if its handoff appeared after mount", async () => {
  fixture.lookup = async () => null;
  let tree = await settle();
  expect(hasTestId(tree, "recover-created-workspace-task")).toBe(false);
  byTestId(tree, "new-workspace-prompt")?.props.onChangeText?.("a new task");
  tree = await settle();
  expect(byTestId(tree, "create-workspace")?.props.disabled).toBe(false);

  fixture.lookup = async query => query.receiptId === openReceipt.id ? null
    : query.kind === "worktree" && query.sourcePath === "/workspace/source" ? fixture.handoff : null;
  byTestId(tree, "create-workspace")?.props.onPress?.();
  tree = await settle();
  expect(hasTestId(tree, "recover-created-workspace-task")).toBe(true);
  expect(fixture.handoffQueries.slice(-2)).toEqual([
    { receiptId: openReceipt.id },
    { kind: "worktree", sourcePath: "/workspace/source" },
  ]);
  expect(fixture.prepareCalls).toEqual([]);
  expect(fixture.reserveCalls).toEqual([]);
  expect(fixture.claimInputs).toEqual([]);
});

it("recovers the selected handle and original input without minting or dispatching another workspace operation", async () => {
  let tree = await settle();
  const recover = byTestId(tree, "recover-created-workspace-task");
  expect(recover).toBeDefined();
  recover!.props.onPress();
  tree = await settle();

  expect(fixture.verifyCalls).toHaveLength(2); // mount qualification and click-time exact re-verification
  expect(fixture.verifyCalls.map(args => args[2])).toEqual([handoffHandle, handoffHandle]);
  expect(fixture.claimInputs).toHaveLength(1);
  expect(fixture.claimInputs[0]).toMatchObject({
    workspaceHandoff: handoffHandle,
    cwd: pending.linked.input.cwd,
    prompt: pending.linked.input.prompt,
    model: pending.linked.input.model,
    managedWorktreeSourcePath: pending.linked.sourcePath,
  });
  expect(fixture.prepareCalls).toEqual([]);
  expect(fixture.reserveCalls).toEqual([]);
  expect(fixture.routerReplacements).toHaveLength(1);
  expect(fixture.routerReplacements[0]).toMatchObject({ params: { threadId: "thread-existing-7", creationRequestId: handoffHandle.clientRequestId } });
});

it("requalifies the same route when only its receipt version changes", async () => {
  fixture.params.operationReceiptVersion = undefined;
  fixture.lookup = async query => fixture.params.operationReceiptVersion === "2"
    && (query.receiptId === openReceipt.id || query.kind === "worktree")
    ? query.receiptId === openReceipt.id ? null : fixture.handoff
    : null;

  let tree = await settle();
  expect(fixture.loadReceiptCalls).toEqual([]);
  expect(fixture.handoffQueries).toEqual([
    { cwd: "/workspace/source" },
    { kind: "worktree", sourcePath: "/workspace/source" },
  ]);
  expect(hasTestId(tree, "recover-created-workspace-task")).toBe(false);

  fixture.params.operationReceiptVersion = "2";
  tree = await settle();
  expect(fixture.loadReceiptCalls).toHaveLength(1);
  expect(fixture.loadReceiptCalls[0][2]).toMatchObject({ version: 2, receiptId: openReceipt.id, kind: "open", sourcePath: "/workspace/source" });
  expect(fixture.handoffQueries.slice(2)).toEqual([
    { receiptId: openReceipt.id },
    { kind: "worktree", sourcePath: "/workspace/source" },
  ]);
  expect(hasTestId(tree, "recover-created-workspace-task")).toBe(true);
});
