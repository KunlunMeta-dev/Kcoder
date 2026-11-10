vi.mock("@/features/interface/ConversationV3", () => ({ ConversationV3Background: () => null, ConversationV3WelcomeMark: () => null, ConversationV3Header: "ConversationV3Header" }));
vi.mock("@/features/task/useNewTaskDraftConnection", () => ({ useNewTaskDraftConnection: (_profile: unknown, server: any) => ({ ...(fixture.connections[server?.id] ?? fixture.connection) }) }));
vi.mock("@/features/task/useNewTaskDraftAttachments", () => ({ useNewTaskDraftAttachments: () => fixture.attachments ?? ({ items: [], available: false, busy: false, locked: false, error: null, sheetOpen: false, open() {}, close() {}, select: async () => {}, remove: async () => {}, freeze: () => ({}), unlockUnsent: async () => {}, releaseUnclaimed: async () => {} }) }));
// Mounted routes exercise actual form ownership and committed effects; RPC seams are deterministic.
import React, { StrictMode, createContext } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";

const fixture = vi.hoisted(() => ({
  version: "modern", lastProject: null as any, lastProjectRead: null as Promise<any> | null, rememberedProjects: [] as any[],
  connection: null as any, connections: {} as Record<string, any>, attachments: null as any, pending: null as any,
  context: null as any, workspaceFailure: null as string | null,
  options: [] as any[], models: [] as any[], preference: null as any,
  catalogCalls: [] as any[], createInputs: [] as any[], projectInputs: [] as any[], pushes: [] as any[], replacements: [] as any[],
  claimGate: null as null | Promise<any>, release: vi.fn(), adopt: vi.fn(), back: vi.fn(),
  ackGate: null as null | Promise<string>, acknowledgements: [] as any[],
  receipt: { version: 2, id: "open-receipt", key: "receipt-key", result: "/project/new", consumed: false },
}));
vi.mock("expo-router", async () => {
  const { useContext } = await import("react");
  return { useLocalSearchParams: () => useContext<any>(fixture.context).params,
    useRouter: () => ({ push: (value: unknown) => fixture.pushes.push(value), replace: (value: unknown) => fixture.replacements.push(value) }),
    useIsFocused: () => useContext<any>(fixture.context).focused,
    useNavigation: () => useContext<any>(fixture.context).navigation };
});
vi.mock("@/state/AppContext", async () => {
  const { useContext } = await import("react");
  return { useApp: () => useContext<any>(fixture.context).app };
});
vi.mock("react-native", () => ({ ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text",
  TextInput: "TextInput", View: "View", Modal: "Modal", StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  Dimensions: { get: () => ({ width: 390, height: 844 }), addEventListener: () => ({ remove() {} }) } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("lucide-react-native", () => Object.fromEntries(["Check", "ChevronDown", "ChevronLeft", "FolderGit2", "FolderOpen", "FolderPlus", "Server", "SlidersHorizontal", "Sparkles", "X", "Archive", "RotateCcw", "Search", "Trash2"].map(name => [name, name])));
vi.mock("@/components/ui", () => ({ Button: "Button", EmptyState: "EmptyState", Field: "Field", StatusDot: "StatusDot" }));
vi.mock("@/components/keyboard-safe-view", () => ({ KeyboardSafeView: "KeyboardSafeView" }));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("@/features/task/NewTaskDraft", () => ({ NewTaskDraft: "NewTaskDraft" }));
vi.mock("@/features/task/TaskExpertSelector", () => ({ TaskExpertSelector: "TaskExpertSelector" }));
vi.mock("@/storage/interface-version", () => ({ useInterfaceVersion: () => fixture.version }));
vi.mock("@/features/forms/WorkspaceOperationBookkeeping", () => ({ WorkspaceOperationBookkeeping: "WorkspaceOperationBookkeeping" }));
vi.mock("@/i18n", () => ({ t: (key: string, values?: Record<string, string>) => values ? `${key}:${Object.values(values).join(":")}` : key }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/theme", () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}), spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 }, radius: {} }));
vi.mock("@/state/route-profile-activation", () => ({ shouldActivateRouteProfile: () => false }));
vi.mock("@/navigation/back-or-replace", () => ({ backOrReplace: () => fixture.back(), profileHomeHref: (id: string) => `/h/${id}` }));
vi.mock("@/storage/new-workspace-preferences", () => ({ loadNewWorkspacePreference: async () => fixture.preference,
  loadLastDraftProject: async () => fixture.lastProjectRead ?? fixture.lastProject,
  saveLastDraftProject: async (_profileId: string, project: unknown) => { fixture.rememberedProjects.push(project); },
  saveNewWorkspacePreference: async () => {}, reasoningEffortLabel: (value: string) => value }));
vi.mock("@/storage/workspace-preferences", () => ({ saveWorkspaceState: async () => {}, workspaceStateAuthorizationScope: (profile: any, server: any) => `${profile.id}:${server.id}` }));
vi.mock("@/storage/workspace-profile-fence", () => ({ captureWorkspaceProfileIdentity: (profile: any) => ({ id: profile.id }) }));
vi.mock("@/runtime/task-runtime/new-catalog-read-source", () => ({ catalogReadScopeKey: (profile: any, server: any) => JSON.stringify([profile.id, profile.authorizationGeneration, server]),
  modelCatalogReadScopeKey: (profile: any, server: any, cwd: string) => JSON.stringify([profile.id, profile.authorizationGeneration, server, cwd]),
  createNewCatalogReadSource: () => ({ run: (_kind: unknown, load: () => Promise<unknown>) => load() }) }));
vi.mock("@/runtime/task-runtime/workspaces", () => ({ listWorkspaceCatalog: async (_profile: any, server: any) => {
  fixture.catalogCalls.push({ kind: "project", server }); return { options: fixture.options, managedWorktrees: [] };
} }));
vi.mock("@/storage/pending-thread-creation", () => ({ originalCreationInput: (value: any) => value.input, loadPendingThreadCreation: async () => fixture.pending, pendingThreadCreationKey: () => "test-pending-key", readWorkspaceTaskHandoff: async () => null }));
vi.mock("@/storage/pending-workspace-operation", () => ({ acknowledgeConfirmedWorkspaceOperation: async (...args: any[]) => {
  fixture.acknowledgements.push(args); return fixture.ackGate ?? "consumed";
},
  loadConfirmedWorkspaceOperationReceipt: async () => fixture.receipt }));
vi.mock("@/storage/pending-workspace-operation-v2", () => ({ reserveWorkspaceTaskHandoff: async () => undefined,
  loadWorkspaceTaskHandoff: async () => null, verifyWorkspaceTaskHandoff: async () => null,
  confirmWorkspaceOpenDelivery: async () => {}, markWorkspaceOpenDelivery: async () => {}, loadWorkspaceOpenDelivery: async () => null }));
vi.mock("@/runtime/task-runtime", () => ({
  defaultModelOption: (values: any[]) => values.find(value => value.isDefault), modelOptionSelector: (value: any) => value.id,
  selectedModelOption: (values: any[], selection: string) => values.find(value => value.id === selection),
  listModels: async (_profile: any, server: any, options: any) => { fixture.catalogCalls.push({ kind: "models", server, workspacePath: options?.workspacePath }); return fixture.models; },
  listWorkspaceOptions: async (_profile: any, server: any) => { fixture.catalogCalls.push({ kind: "workspaces", server }); if (fixture.workspaceFailure) throw new Error(fixture.workspaceFailure); return fixture.options; },
  openWorkspaceWithReceipt: async (_profile: any, server: any, path: string) => {
    fixture.projectInputs.push({ server, path }); return { path: "/project/new", receipt: fixture.receipt };
  },
  prepareManagedWorktreeWithReceipt: async () => { throw new Error("Unexpected worktree mutation"); },
  previewManagedWorktreeArchive: async () => null, archiveManagedWorktree: async () => {}, restoreManagedWorktree: async () => {}, forgetManagedWorktree: async () => {},
  TaskRuntime: { claimCreation: (input: any) => {
    fixture.createInputs.push(input);
    return { result: fixture.claimGate ?? Promise.resolve({ getSnapshot: () => ({ threadId: "created-thread", title: "Created" }) }), adopt: fixture.adopt, release: fixture.release };
  } }, taskRuntimeRegistry: { get: () => undefined, put: vi.fn() },
}));

import NewWorkspaceRoute from "../new";
import OpenProjectRoute from "../open-project";
import { claimNewTaskDraftHandoff, createNewTaskDraftHandoff, NEW_TASK_DRAFT_HANDOFF_TTL_MS } from "@/navigation/new-task-draft-handoff";

const profile: GatewayProfile = { id: "draft-route", label: "Gateway A", baseUrl: "https://gateway.invalid", accessToken: "test-access", rpcToken: "test-rpc",
  authorizationGeneration: "auth-A", deviceId: "device-A", authMode: "device", expiresAt: Date.now() + 60_000 };
const serverA: KCoderServer = { id: "A", label: "Target A", description: "Test target", runtime: "kcoder", transport: "local", workspacePath: "/project/A" };
const serverB: KCoderServer = { ...serverA, id: "B", label: "Target B", workspacePath: "/project/B" };
type RouteState = { params: Record<string, string>; app: any; focused: boolean; navigation: ReturnType<typeof createNavigation> };
const Context = createContext<RouteState | null>(null);
fixture.context = Context;
type Mounted = { renderer: ReactTestRenderer; state: RouteState; route: typeof NewWorkspaceRoute; strict: boolean };
const mounted: Mounted[] = [];
function createNavigation() {
  const removedListeners = new Set<() => void>();
  return {
    removedListeners,
    addListener: (_event: string, listener: () => void) => {
      removedListeners.add(listener);
      return () => removedListeners.delete(listener);
    },
  };
}
function app(servers: KCoderServer[] = [serverA], selectedProfile = profile) {
  return { hydrated: true, activeProfile: selectedProfile, profiles: [selectedProfile], runtime: { servers, statuses: [], loading: false, reauthorizationRequired: false },
    setActiveProfile: vi.fn(), refresh: vi.fn(async () => {}), markGatewayReauthorizationRequired: vi.fn(), demo: false, runtimeActivationEpoch: 1, isCurrentInteractionOwner: () => true };
}
function tree(view: Omit<Mounted, "renderer">) {
  const content = <Context.Provider value={view.state}><view.route /></Context.Provider>;
  return view.strict ? <StrictMode>{content}</StrictMode> : content;
}
async function mount(route = NewWorkspaceRoute, params: Record<string, string> = {}, selectedApp: RouteState["app"] = app(), strict = false) {
  const view = { route, state: { params, app: selectedApp, focused: true, navigation: createNavigation() }, strict };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(tree(view)); });
  const result = { ...view, renderer }; mounted.push(result); return result;
}
async function update(view: Mounted) { await act(async () => { view.renderer.update(tree(view)); }); }
function node(view: Mounted, testID: string) { return view.renderer.root.findByProps({ testID }); }
function has(view: Mounted, testID: string) { return view.renderer.root.findAllByProps({ testID }).length > 0; }
async function press(view: Mounted, testID: string) { await act(async () => { await node(view, testID).props.onPress(); }); }
async function input(view: Mounted, value: string) { await act(async () => { node(view, "new-task-draft").props.setInput(value); }); }
async function unmount(view: Mounted) {
  await act(async () => {
    view.renderer.unmount();
    view.state.navigation.removedListeners.forEach(listener => listener());
  });
  mounted.splice(mounted.indexOf(view), 1);
}
// Seed an incoming domain handoff; New no longer owns an Add Project form.
async function seedIncomingProjectHandoff(source: Mounted, model?: string, strict = false) {
  const draft = node(source, "new-task-draft").props;
  const sourceProfile = source.state.app.activeProfile;
  const sourceServer = source.state.app.runtime.servers.find((item: KCoderServer) => item.id === draft.contextActual.serverId);
  const token = createNewTaskDraftHandoff({ profile: sourceProfile, server: sourceServer, sourceIntent: "project-entry",
    draft: { prompt: draft.input, executionMode: "default", model: model ?? "",
      modelExplicit: Boolean(model), reasoningEffort: draft.reasoningEffort, isolation: "local", gitRef: "" },
    isCurrent: () => true });
  const destination = { params: { profileId: sourceProfile.id, serverId: sourceServer.id, draftHandoff: token! } };
  source.state.focused = false; await update(source);
  expect(JSON.stringify(destination)).not.toContain("unsent secret");
  return mount(OpenProjectRoute, destination.params, source.state.app, strict);
}
async function selectWorkspace(view: Mounted, serverId: string, path: string) {
  await act(async () => { node(view, "new-task-draft").props.onSelectWorkspace({ serverId, path }); });
}
async function openProject(project: Mounted) {
  await act(async () => { node(project, "open-project-path").props.onChangeText("/project/new"); });
  await press(project, "open-project-submit");
  return fixture.replacements.at(-1).params;
}

beforeEach(() => {
  fixture.version = "modern"; fixture.lastProject = null; fixture.lastProjectRead = null; fixture.rememberedProjects = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.connection = { ready: true, client: null, error: null, supportsPermissions: true, retry() {} }; fixture.connections = {}; fixture.attachments = null; fixture.pending = null;
  fixture.options = []; fixture.models = []; fixture.preference = null; fixture.claimGate = null;
  fixture.workspaceFailure = null;
  fixture.ackGate = null; fixture.acknowledgements = [];
  fixture.catalogCalls = []; fixture.createInputs = []; fixture.projectInputs = []; fixture.pushes = []; fixture.replacements = [];
  fixture.release.mockReset(); fixture.adopt.mockReset().mockReturnValue(true); fixture.back.mockReset();
});

it("shows the resolved target default without pinning its model in the first send", async () => {
  fixture.models = [{ id: "provider::current-default", displayName: "Current target default", isDefault: true }];
  const view = await mount();
  expect(node(view, "new-task-draft").props.modelLabel).toBe("task.follow_target_default_with:Current target default");
  expect(fixture.createInputs).toEqual([]);
  await input(view, "use the default");
  await act(async () => { await node(view, "new-task-draft").props.submit(); });
  expect(fixture.createInputs).toHaveLength(1);
  expect(fixture.createInputs[0].model).toBeUndefined();
  expect(fixture.createInputs[0].reasoningEffort).toBeUndefined();
});

it("keeps follow-default generic when the catalog has no declared default instead of using its first item", async () => {
  fixture.models = [{ id: "provider::unselected", displayName: "Must not guess this model" }];
  const view = await mount();
  expect(node(view, "new-task-draft").props.modelLabel).toBe("task.follow_target_default");
  await input(view, "let the target decide");
  await act(async () => { await node(view, "new-task-draft").props.submit(); });
  expect(fixture.createInputs[0].model).toBeUndefined();
});

it("V3 restores the last valid project across targets without creating a thread", async () => {
  fixture.version = "v3";
  fixture.lastProject = { serverId: "B", cwd: "/project/B/recent", scope: "stored" };
  const view = await mount(NewWorkspaceRoute, { profileId: profile.id }, app([serverA, serverB]));
  expect(node(view, "new-task-draft").props.cwd).toBe("/project/B/recent");
  expect(node(view, "new-task-draft").props.contextActual.serverLabel).toBe("Target B");
  expect(fixture.createInputs).toEqual([]);
  expect(fixture.rememberedProjects.at(-1)?.cwd).toBe("/project/B/recent");
});

it("V3 keeps typed text during a delayed last-project read and offline selection never replaces the valid default", async () => {
  fixture.version = "v3";
  let resolve!: (value: unknown) => void;
  fixture.lastProjectRead = new Promise(done => { resolve = done; });
  fixture.connections.B = { ready: false, client: null, error: "offline", supportsPermissions: false, retry() {} };
  const view = await mount(NewWorkspaceRoute, { profileId: profile.id }, app([serverA, serverB]));
  expect(node(view, "new-task-draft").props.draftEditable).toBe(true);
  await act(async () => node(view, "new-task-draft").props.setInput("Write before connecting"));
  await act(async () => resolve({ serverId: "B", cwd: "/project/B", scope: "stored" }));
  const draft = node(view, "new-task-draft").props;
  expect(draft.input).toBe("Write before connecting");
  expect(draft.draftEditable).toBe(true);
  expect(draft.ready).toBe(false);
  expect(draft.modelPickerReady).toBe(false);
  await act(async () => draft.submit());
  expect(fixture.createInputs).toEqual([]);
  expect(fixture.rememberedProjects).toEqual([]);
});

it("V3 explicit project links take precedence over the remembered project", async () => {
  fixture.version = "v3";
  fixture.lastProject = { serverId: "B", cwd: "/project/B", scope: "stored" };
  const view = await mount(NewWorkspaceRoute, { profileId: profile.id, serverId: "A", cwd: "/explicit/A" }, app([serverA, serverB]));
  expect(node(view, "new-task-draft").props.cwd).toBe("/explicit/A");
  expect(node(view, "new-task-draft").props.contextActual.serverId).toBe("A");
});
afterEach(async () => {
  for (const view of [...mounted]) await unmount(view);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it.each<Record<string, string>>([{}, { serverId: "A" }, { serverId: "A", cwd: "/explicit/uncatalogued" }])("opens every normal new route as a draft and creates only on its first send", async params => {
  const view = await mount(NewWorkspaceRoute, { profileId: profile.id, ...params });
  expect(has(view, "workspace-path")).toBe(false);
  expect(node(view, "new-task-draft").props.contextActual).toMatchObject({
    profileId: profile.id,
    serverId: params.serverId ?? "A",
    cwd: params.cwd ?? serverA.workspacePath,
  });
  expect(node(view, "new-task-draft").props.cwd).toBe(params.cwd ?? serverA.workspacePath);
  expect(node(view, "new-task-draft").props.ready).toBe(true);
  expect(fixture.createInputs).toEqual([]);
  await input(view, "first message");
  await act(async () => { await node(view, "new-task-draft").props.submit(); });
  expect(fixture.createInputs).toHaveLength(1);
  expect(fixture.createInputs[0].model).toBeUndefined();
});

it("keeps global New and the Home workspace Plus on the same draft route and honors the Plus cwd", async () => {
  fixture.options = [
    { path: "/project/A", label: "Project A", kind: "workspace" },
    { path: "/project/B", label: "Project B", kind: "workspace" },
  ];
  const global = await mount(NewWorkspaceRoute, { profileId: profile.id });
  expect(node(global, "new-task-draft").props.contextActual).toMatchObject({
    profileId: profile.id, serverId: "A", cwd: serverA.workspacePath,
  });

  fixture.preference = { cwd: "/saved/other", isolation: "local" };
  const plus = await mount(NewWorkspaceRoute, {
    profileId: profile.id, serverId: "A", cwd: "/home/plus/project",
  });
  expect(node(plus, "new-task-draft").props.contextActual).toMatchObject({
    profileId: profile.id, serverId: "A", cwd: "/home/plus/project",
  });
  expect(typeof node(plus, "new-task-draft").props.onSelectWorkspace).toBe("function");
  expect(fixture.createInputs).toEqual([]);
});

it("applies a same-target project choice to the actual draft while preserving prompt and explicit model", async () => {
  fixture.options = [
    { path: "/project/A", label: "Project A", kind: "workspace" },
    { path: "/project/B", label: "Project B", kind: "workspace" },
  ];
  fixture.models = [
    { id: "provider::chosen", displayName: "Explicit model" },
    { id: "provider::default", displayName: "Target default", isDefault: true },
  ];
  const view = await mount(NewWorkspaceRoute, { profileId: profile.id, serverId: "A" });
  await input(view, "keep this draft while changing project");
  await act(async () => { node(view, "new-task-draft").props.openModelPicker(); });
  await press(view, "new-model-option-provider%3A%3Achosen");

  const selectWorkspace = node(view, "new-task-draft").props.onSelectWorkspace as (selection: { serverId: string; path: string }) => void;
  await act(async () => { selectWorkspace({ serverId: "A", path: "/project/B" }); });
  expect(node(view, "new-task-draft").props.contextActual).toMatchObject({
    profileId: profile.id, serverId: "A", cwd: "/project/B",
  });
  expect(node(view, "new-task-draft").props).toMatchObject({
    cwd: "/project/B", input: "keep this draft while changing project", modelLabel: "Explicit model", ready: true,
  });
  expect(fixture.createInputs).toEqual([]);
});

it("scopes an unsent expert choice to its exact workspace and fences its late directory loader", async () => {
  fixture.options = [{ path: "/project/B", label: "Project B", kind: "workspace" }];
  const requests: string[] = [];
  fixture.connection = { ready: true, client: { supportsExperimental: () => true, request: async (method: string) => { requests.push(method); return {}; } }, error: null, supportsPermissions: true, retry() {} };
  const view = await mount(NewWorkspaceRoute, { profileId: profile.id, serverId: "A" });
  const before = node(view, "new-task-draft").props.expertSelector.props;
  const selected = { reference: { id: "expert-a", version: "v2", definitionSha256: "f".repeat(64) }, title: "Expert A · v2" };
  await act(async () => { await before.onSelect(selected); });
  expect(node(view, "new-task-draft").props.expertSelector.props.selection).toEqual(selected);
  expect(fixture.createInputs).toEqual([]);

  await act(async () => { node(view, "new-task-draft").props.onNew(); });
  expect(node(view, "new-task-draft").props.expertSelector.props.selection).toBeNull();
  await act(async () => { await node(view, "new-task-draft").props.expertSelector.props.onSelect(selected); });

  await selectWorkspace(view, "A", "/project/B");
  const after = node(view, "new-task-draft").props.expertSelector.props;
  expect(after.selection).not.toEqual(selected);
  const controller = new AbortController();
  await expect(before.loadExperts(null, controller.signal)).rejects.toThrow();
  expect(requests).toEqual([]);
  expect(fixture.createInputs).toEqual([]);
});

it("keeps the expert sheet overlay state scoped to the current draft owner", async () => {
  fixture.options = [{ path: "/project/B", label: "Project B", kind: "workspace" }];
  const view = await mount(NewWorkspaceRoute, { profileId: profile.id, serverId: "A" });
  const oldOwnerSelector = node(view, "new-task-draft").props.expertSelector.props;
  await act(async () => { oldOwnerSelector.onOpenChange(true); });
  expect(node(view, "new-task-draft").props.expertSelectorOpen).toBe(true);

  await selectWorkspace(view, "A", "/project/B");
  expect(node(view, "new-task-draft").props.expertSelectorOpen).toBe(false);
  const currentSelector = node(view, "new-task-draft").props.expertSelector.props;
  await act(async () => { currentSelector.onOpenChange(true); });
  await act(async () => { oldOwnerSelector.onOpenChange(false); });
  expect(node(view, "new-task-draft").props.expertSelectorOpen).toBe(true);
});

it("locks only sending when a selected expert becomes unavailable and allows clearing it", async () => {
  const supports = new Set(["agentDefinitionsV1", "threadCreationReceiptsV1"]);
  fixture.connection = {
    ready: true, client: { supportsExperimental: (capability: string) => supports.has(capability), request: async () => ({}) },
    error: null, supportsPermissions: true, retry() {},
  };
  const view = await mount(NewWorkspaceRoute, { profileId: profile.id, serverId: "A" });
  await input(view, "send after clearing the expert");
  const selected = { reference: { id: "expert-a", version: "v2", definitionSha256: "f".repeat(64) }, title: "Expert A · v2" };
  const originalSelector = node(view, "new-task-draft").props.expertSelector.props;
  await act(async () => { await originalSelector.onSelect(selected); });
  expect(node(view, "new-task-draft").props.expertSendLocked).toBe(false);

  supports.delete("agentDefinitionsV1");
  await update(view);
  const unavailableDraft = node(view, "new-task-draft").props;
  expect(unavailableDraft.expertSendLocked).toBe(true);
  expect(unavailableDraft.expertSelector.props.selection).toEqual(selected);
  expect(unavailableDraft.expertSelector.props.disabled).toBe(false);
  await act(async () => { await unavailableDraft.submit(); });
  expect(fixture.createInputs).toEqual([]);

  await act(async () => { await unavailableDraft.expertSelector.props.onSelect(null); });
  expect(node(view, "new-task-draft").props.expertSendLocked).toBe(false);
  await act(async () => { await node(view, "new-task-draft").props.submit(); });
  expect(fixture.createInputs).toHaveLength(1);
  expect(fixture.createInputs[0]).not.toHaveProperty("agentDefinition");
});

it("rejects a directory page that resolves after the draft switches targets", async () => {
  let observeList!: (params: any) => void;
  const listStarted = new Promise<any>(resolve => { observeList = resolve; });
  let resolveList!: (value: any) => void;
  const delayedList = new Promise<any>(resolve => { resolveList = resolve; });
  const requests: string[] = [];
  fixture.connection = {
    ready: true, error: null, supportsPermissions: true, retry() {},
    client: {
      supportsExperimental: () => true,
      request: async (method: string, params: any) => {
        requests.push(method);
        if (method === "settings/integrations/office/read") return {
          connectionEnabled: true, effectiveEnabled: true, persistedEnabled: true,
          restartRequired: false, revision: "a".repeat(64),
        };
        if (method === "integrations/scope/read") return {
          accountId: "account", identityGeneration: "generation", organizationId: null,
          targetId: "A", targetRevision: "revision", workspaceId: "workspace",
        };
        if (method === "integrations/assistant/list") {
          observeList(params);
          return delayedList;
        }
        throw new Error(`Unexpected RPC ${method}`);
      },
    },
  };
  const view = await mount(NewWorkspaceRoute, { profileId: profile.id, serverId: "A" }, app([serverA, serverB]));
  const staleLoader = node(view, "new-task-draft").props.expertSelector.props.loadExperts;
  const pending = staleLoader(null, new AbortController().signal);
  const listParams = await listStarted;

  await selectWorkspace(view, "B", serverB.workspacePath!);
  expect(node(view, "new-task-draft").props.expertSelector.props.selection).toBeNull();
  resolveList({
    contractVersion: "parallel-v1", entityRevision: null, error: null, observedAt: new Date(0).toISOString(),
    operationId: null, requestId: listParams.requestId, result: { items: [], total: 0, nextCursor: null }, status: "completed",
  });
  await expect(pending).rejects.toThrow("expert.directory_changed");
  expect(requests).toEqual([
    "settings/integrations/office/read", "integrations/scope/read", "integrations/assistant/list",
  ]);
  expect(fixture.createInputs).toEqual([]);
});

it("keeps an unavailable explicit model after a cwd change, blocks stale choices, and creates only after a current choice", async () => {
  fixture.options = [{ path: "/project/B", label: "Project B", kind: "workspace" }];
  fixture.models = [{ id: "p::chosen", displayName: "Chosen" }, { id: "p::old-default", displayName: "Old default", isDefault: true }];
  const view = await mount(NewWorkspaceRoute, { profileId: profile.id, serverId: "A" });
  await input(view, "workspace prompt");
  await press(view, "new-model-option-p%3A%3Achosen");
  const staleChoice = node(view, "new-model-option-p%3A%3Aold-default").props.onPress;
  const staleSubmit = node(view, "new-task-draft").props.submit;
  fixture.models = [{ id: "p::workspace-default", displayName: "Workspace default", isDefault: true }];
  await selectWorkspace(view, "A", "/project/B");
  expect(node(view, "new-task-draft").props).toMatchObject({ cwd: "/project/B", input: "workspace prompt", modelLabel: "chosen", ready: false });
  expect(has(view, "new-task-model-unavailable")).toBe(true);
  await act(async () => { staleChoice(); await staleSubmit(); await node(view, "new-task-draft").props.submit(); });
  expect(node(view, "new-task-draft").props.modelLabel).toBe("chosen");
  expect(fixture.createInputs).toEqual([]);
  expect(fixture.catalogCalls.filter(call => call.kind === "models").at(-1)?.workspacePath).toBe("/project/B");
  await press(view, "new-model-server-default");
  await act(async () => { await node(view, "new-task-draft").props.submit(); });
  expect(fixture.createInputs[0]).toMatchObject({ cwd: "/project/B", prompt: "workspace prompt" });
  expect(fixture.createInputs[0].model).toBeUndefined();
});

it("uses the selected workspace's default effort for an explicit model when effort was not explicitly chosen", async () => {
  fixture.options = [{ path: "/project/B", label: "Project B", kind: "workspace" }];
  fixture.models = [{ id: "p::chosen", displayName: "Chosen", defaultReasoningEffort: "low", supportedReasoningEfforts: ["low", "high"] }];
  const view = await mount(NewWorkspaceRoute, { profileId: profile.id, serverId: "A" });
  await input(view, "use workspace settings");
  await press(view, "new-model-option-p%3A%3Achosen");
  expect(node(view, "new-task-draft").props.reasoningEffort).toBe("low");
  fixture.models = [{ id: "p::chosen", displayName: "Chosen", defaultReasoningEffort: "high", supportedReasoningEfforts: ["low", "high"] }];
  await selectWorkspace(view, "A", "/project/B");
  expect(node(view, "new-task-draft").props).toMatchObject({ modelLabel: "Chosen", reasoningEffort: "high", ready: true });
  await act(async () => { await node(view, "new-task-draft").props.submit(); });
  expect(fixture.createInputs[0]).toMatchObject({ cwd: "/project/B", model: "p::chosen", reasoningEffort: "high" });
});

it("lets global New select a configured project on an exact target, even when targets share its path", async () => {
  const targetA = { ...serverA, workspacePath: "/shared/project" };
  const targetB = { ...serverB, workspacePath: "/shared/project" };
  fixture.preference = { cwd: "/saved/target-b", isolation: "local" };
  fixture.models = [{ id: "target-b::default", displayName: "Target B default", isDefault: true }];
  const selectedApp = app([targetA, targetB]);
  const unrelatedProfile: GatewayProfile = { ...profile, id: "unrelated-gateway", label: "Other Gateway",
    baseUrl: "https://other-gateway.invalid", authorizationGeneration: "other-auth", deviceId: "other-device" };
  selectedApp.profiles = [profile, unrelatedProfile];

  const view = await mount(NewWorkspaceRoute, { profileId: profile.id }, selectedApp);
  expect(node(view, "new-task-draft").props.ready).toBe(false);
  expect(node(view, "new-task-draft").props.contextActual).toMatchObject({ profileId: profile.id, serverId: "", cwd: "" });
  expect(node(view, "new-task-draft").props.contextWorkspaces).toEqual(expect.arrayContaining([
    expect.objectContaining({ serverId: "A", path: "/shared/project" }),
    expect.objectContaining({ serverId: "B", path: "/shared/project" }),
  ]));
  expect(node(view, "new-task-draft").props.contextWorkspaces.every((item: { serverId: string }) => ["A", "B"].includes(item.serverId))).toBe(true);

  await input(view, "keep this prompt across target selection");
  const selectWorkspace = node(view, "new-task-draft").props.onSelectWorkspace as (selection: { serverId: string; path: string }) => void;
  await act(async () => { selectWorkspace({ serverId: "B", path: "/shared/project" }); });

  expect(node(view, "new-task-draft").props.contextActual).toMatchObject({
    profileId: profile.id, serverId: "B", cwd: "/shared/project",
  });
  expect(node(view, "new-task-draft").props).toMatchObject({
    cwd: "/shared/project", input: "keep this prompt across target selection", modelLabel: "task.follow_target_default_with:Target B default", ready: true,
  });
  expect(fixture.catalogCalls.filter((call) => call.kind === "workspaces" || call.kind === "models").every((call) => call.server.id === "B")).toBe(true);
  expect(fixture.createInputs).toEqual([]);
});

it("keeps a Home Plus route's explicit target and cwd initially, then allows a deliberate switch", async () => {
  const targetA = { ...serverA, workspacePath: "/project/A" };
  const targetB = { ...serverB, workspacePath: "/project/B" };
  fixture.preference = { cwd: "/saved/target-b", isolation: "local" };
  fixture.models = [{ id: "target-b::default", displayName: "Target B default", isDefault: true }];
  fixture.options = [{ path: "/home/plus/project", label: "Plus project", kind: "workspace" }];
  const view = await mount(NewWorkspaceRoute, {
    profileId: profile.id, serverId: "A", cwd: "/home/plus/project",
  }, app([targetA, targetB]));
  expect(node(view, "new-task-draft").props.contextActual).toMatchObject({
    profileId: profile.id, serverId: "A", cwd: "/home/plus/project",
  });
  expect(node(view, "new-task-draft").props.contextWorkspaces).toEqual(expect.arrayContaining([
    expect.objectContaining({ serverId: "A", path: "/project/A" }),
    expect.objectContaining({ serverId: "B", path: "/project/B" }),
  ]));
  await input(view, "keep this Plus draft while switching target");

  const selectWorkspace = node(view, "new-task-draft").props.onSelectWorkspace as (selection: { serverId: string; path: string }) => void;
  await act(async () => { selectWorkspace({ serverId: "B", path: "/project/B" }); });
  expect(node(view, "new-task-draft").props.contextActual).toMatchObject({
    profileId: profile.id, serverId: "B", cwd: "/project/B",
  });
  expect(node(view, "new-task-draft").props).toMatchObject({
    cwd: "/project/B", input: "keep this Plus draft while switching target", modelLabel: "task.follow_target_default_with:Target B default", ready: true,
  });
  expect(fixture.createInputs).toEqual([]);
});

it("rejects a captured other-target candidate after that target identity changes under the current owner", async () => {
  const targetA = { ...serverA, workspacePath: "/project/A" };
  const targetB = { ...serverB, workspacePath: "/project/B" };
  const view = await mount(NewWorkspaceRoute, {}, app([targetA, targetB]));
  await input(view, "keep the active-target draft");
  const selectWorkspace = node(view, "new-task-draft").props.onSelectWorkspace as (selection: { serverId: string; path: string }) => void;
  await act(async () => { selectWorkspace({ serverId: "A", path: "/project/A" }); });
  expect(node(view, "new-task-draft").props.contextActual).toMatchObject({ serverId: "A", cwd: "/project/A" });
  const staleCandidateSelect = node(view, "new-task-draft").props.onSelectWorkspace as (selection: { serverId: string; path: string }) => void;

  const changedTargetB = { ...targetB, accountIdentity: { principalId: "replacement-principal", username: "replacement", role: "member" as const } };
  view.state.app = app([targetA, changedTargetB]);
  await update(view);
  expect(node(view, "new-task-draft").props.contextActual).toMatchObject({ serverId: "A", cwd: "/project/A" });
  await act(async () => { staleCandidateSelect({ serverId: "B", path: "/project/B" }); });
  expect(node(view, "new-task-draft").props.contextActual).toMatchObject({ serverId: "A", cwd: "/project/A" });
  expect(node(view, "new-task-draft").props.input).toBe("keep the active-target draft");
  expect(fixture.createInputs).toEqual([]);
});

it.each(["target", "profile"] as const)("ignores a workspace callback captured by the old %s owner", async change => {
  fixture.options = [
    { path: "/project/A", label: "Project A", kind: "workspace" },
    { path: "/project/B", label: "Project B", kind: "workspace" },
  ];
  const view = await mount(NewWorkspaceRoute, { serverId: "A" }, app([serverA, serverB]));
  const staleSelect = node(view, "new-task-draft").props.onSelectWorkspace as (selection: { serverId: string; path: string }) => void;

  if (change === "target") {
    await selectWorkspace(view, "B", serverB.workspacePath!);
  } else {
    const profileB: GatewayProfile = { ...profile, id: "draft-route-b", label: "Gateway B",
      baseUrl: "https://gateway-b.invalid", authorizationGeneration: "auth-B", deviceId: "device-B" };
    view.state.params = { profileId: profileB.id, serverId: "B" };
    view.state.app = app([serverB], profileB);
    await update(view);
  }

  const currentDraft = node(view, "new-task-draft");
  const expectedOwner = change === "target"
    ? { profileId: profile.id, serverId: "B", cwd: serverB.workspacePath }
    : { profileId: "draft-route-b", serverId: "B", cwd: serverB.workspacePath };
  expect(currentDraft.props.contextActual).toMatchObject(expectedOwner);
  if (change === "profile") {
    expect(currentDraft.props.contextWorkspaces.every((item: { serverId: string }) => item.serverId === "B")).toBe(true);
  }
  await act(async () => { staleSelect({ serverId: "A", path: "/stale/old-owner" }); });
  expect(node(view, "new-task-draft").props.contextActual).toMatchObject(expectedOwner);
  expect(fixture.createInputs).toEqual([]);
});

it("requires explicit selection with multiple servers and never falls back from an unknown route server", async () => {
  const global = await mount(NewWorkspaceRoute, {}, app([serverA, serverB]));
  expect(node(global, "new-task-draft").props.ready).toBe(false);
  expect(fixture.catalogCalls).toEqual([]);
  await input(global, "unsent");
  await act(async () => { await node(global, "new-task-draft").props.submit(); });
  expect(fixture.createInputs).toEqual([]);
  await selectWorkspace(global, "B", serverB.workspacePath!);
  expect(node(global, "new-task-draft").props.contextActual.serverId).toBe("B");
  const unknown = await mount(NewWorkspaceRoute, { serverId: "missing" });
  expect(node(unknown, "new-task-draft").props.ready).toBe(false);
  expect(node(unknown, "new-task-draft").props.cwd).toBe("");
});

it("blocks empty cwd without inventing a root directory", async () => {
  const view = await mount(NewWorkspaceRoute, {}, app([{ ...serverA, workspacePath: undefined }]));
  expect(node(view, "new-task-draft").props.cwd).toBe("");
  expect(node(view, "new-task-draft").props.ready).toBe(false);
  await input(view, "unsent"); await act(async () => { await node(view, "new-task-draft").props.submit(); });
  expect(fixture.createInputs).toEqual([]);
});

it.each(["configured", "catalog"])("accepts a real explicit %s root", async source => {
  if (source === "catalog") fixture.options = [{ path: "/", label: "Root", kind: "workspace" }];
  const view = await mount(NewWorkspaceRoute, {}, app([{ ...serverA, workspacePath: source === "configured" ? "/" : undefined }]));
  expect(node(view, "new-task-draft").props.cwd).toBe("/");
  expect(node(view, "new-task-draft").props.ready).toBe(true);
});

it("removes the advanced entry and old creation form while keeping the current draft", async () => {
  const view = await mount(); await input(view, "keep this prompt");
  expect(node(view, "new-task-draft").props.input).toBe("keep this prompt");
  for (const id of ["new-task-advanced", "workspace-path", "new-task-add-project", "workspace-isolation-worktree", "new-workspace-prompt"])
    expect(has(view, id)).toBe(false);
  expect(node(view, "new-task-draft").props.onTargetAction).toBeUndefined();
  await act(async () => { node(view, "new-task-draft").props.openModelPicker(); });
  expect(has(view, "new-model-server-default")).toBe(true);
  expect(fixture.createInputs).toEqual([]);
});

it("keeps an unknown stored cwd unavailable until an existing project is chosen", async () => {
  fixture.preference = { cwd: "/stored/not-catalogued", isolation: "local" };
  const view = await mount(); await input(view, "keep this prompt");
  expect(node(view, "new-task-draft").props.ready).toBe(false);
  await selectWorkspace(view, "A", serverA.workspacePath!);
  expect(node(view, "new-task-draft").props.ready).toBe(true);
  expect(node(view, "new-task-draft").props.input).toBe("keep this prompt");
});

it("preserves a deliberate target choice through route-server refresh while fencing a principal replacement", async () => {
  const view = await mount(NewWorkspaceRoute, { serverId: "A" }, app([serverA, serverB]));
  await input(view, "keep across chosen targets"); await selectWorkspace(view, "B", serverB.workspacePath!);
  view.state.app = app([serverA, serverB, { ...serverA, id: "C" }]); await update(view);
  expect(node(view, "new-task-draft").props.input).toBe("keep across chosen targets");
  expect(node(view, "new-task-draft").props.contextActual.serverId).toBe("B");
  view.state.app = app([serverA, { ...serverB, accountIdentity: { principalId: "another-principal", username: "other", role: "member" } }]); await update(view);
  expect(node(view, "new-task-draft").props.input).toBe("");
});

it("does not carry text to an automatically replaced server or retain an auto choice after a second server appears", async () => {
  const view = await mount(); await input(view, "target A only");
  view.state.app = app([serverB]); await update(view);
  expect(node(view, "new-task-draft").props.input).toBe("");
  view.state.app = app([serverA, serverB]); await update(view);
  expect(node(view, "new-task-draft").props.ready).toBe(false);
  expect(node(view, "new-task-draft").props.contextActual.serverId).toBe("");
});

it("fences authMode-only changes and stops adoption/navigation after authorization is denied during a held create", async () => {
  const view = await mount(); await input(view, "old authorization only");
  const oldSubmit = node(view, "new-task-draft").props.submit;
  view.state.app = app([serverA], { ...profile, authMode: "legacy" }); await update(view);
  expect(node(view, "new-task-draft").props.input).toBe("");
  await act(async () => { await oldSubmit(); }); expect(fixture.createInputs).toEqual([]);
  let resolve!: (task: unknown) => void;
  fixture.claimGate = new Promise(done => { resolve = done; });
  await input(view, "held creation");
  let creating!: Promise<void>;
  await act(async () => { creating = node(view, "new-task-draft").props.submit(); await Promise.resolve(); await Promise.resolve(); });
  expect(fixture.createInputs).toHaveLength(1);
  view.state.app = { ...view.state.app, runtime: { ...view.state.app.runtime, reauthorizationRequired: true } }; await update(view);
  expect(node(view, "new-task-draft").props.ready).toBe(false);
  await act(async () => { resolve({ getSnapshot: () => ({ threadId: "late", title: "Late" }) }); await creating; });
  expect(fixture.adopt).not.toHaveBeenCalled(); expect(fixture.replacements).toEqual([]); expect(fixture.release).toHaveBeenCalled();
});

it("restores an incoming draft through the selected project's exact V2 ACK return", async () => {
  const source = await mount(NewWorkspaceRoute, { profileId: profile.id, serverId: "A" }, app([serverB, serverA]));
  await input(source, "unsent secret"); const project = await seedIncomingProjectHandoff(source);
  expect(project.state.params.serverId).toBe("A");
  const params = await openProject(project);
  expect(params).toMatchObject({ serverId: "A", cwd: "/project/new", operationReceiptId: fixture.receipt.id, operationReceiptVersion: "2", draftHandoff: expect.any(String) });
  expect(fixture.projectInputs).toMatchObject([{ server: { id: "A" }, path: "/project/new" }]);
  const receiver = await mount(NewWorkspaceRoute, params, source.state.app, true);
  expect({ context: node(receiver, "new-task-draft").props.contextActual, ready: node(receiver, "new-task-draft").props.ready,
    sourceText: node(source, "new-task-draft").props.input, notice: has(receiver, "new-task-draft-restore-notice") })
    .toMatchObject({ context: { profileId: profile.id, serverId: "A", cwd: "/project/new" }, ready: true, sourceText: "unsent secret", notice: false });
  expect(node(receiver, "new-task-draft").props.input).toBe("unsent secret");
  expect(node(source, "new-task-draft").props.input).toBe("unsent secret");
  expect(has(receiver, "new-task-draft-restore-notice")).toBe(false);
  expect(fixture.createInputs).toEqual([]);
});

it("keeps a legal handoff across source unmount and protects a newer receiver draft before its target loads", async () => {
  const source = await mount(); await input(source, "unsent secret"); const project = await seedIncomingProjectHandoff(source);
  await unmount(source); const params = await openProject(project);
  const loadingApp = { ...app(), runtime: { ...app().runtime, loading: true } };
  const receiver = await mount(NewWorkspaceRoute, params, loadingApp); await input(receiver, "newer receiver text");
  receiver.state.app = app(); await update(receiver);
  expect(node(receiver, "new-task-draft").props.input).toBe("newer receiver text");
  expect(has(receiver, "new-task-draft-restore-notice")).toBe(false);
});

it("revokes on project cancellation, preserves the mounted source and keeps unrelated new drafts empty", async () => {
  const source = await mount(); await input(source, "unsent secret"); const project = await seedIncomingProjectHandoff(source);
  const token = project.state.params.draftHandoff;
  await press(project, "open-project-back"); expect(fixture.back).toHaveBeenCalled();
  await unmount(project);
  expect(claimNewTaskDraftHandoff(token, profile, serverA)).toBeUndefined();
  source.state.focused = true; await update(source);
  expect(node(source, "new-task-draft").props.input).toBe("unsent secret");
  const independent = await mount(); expect(node(independent, "new-task-draft").props.input).toBe("");
});

it("keeps an incoming draft handoff through StrictMode effect replay", async () => {
  const source = await mount(); await input(source, "unsent secret");
  const project = await seedIncomingProjectHandoff(source, undefined, true);
  const token = project.state.params.draftHandoff;

  expect(claimNewTaskDraftHandoff(token, profile, serverA)).toBeDefined();

  await unmount(project);
  expect(claimNewTaskDraftHandoff(token, profile, serverA)).toBeUndefined();
});

it("reports expired handoff failure visibly without clearing the source draft or sending", async () => {
  const source = await mount(); await input(source, "unsent secret"); const project = await seedIncomingProjectHandoff(source);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + NEW_TASK_DRAFT_HANDOFF_TTL_MS);
  const params = await openProject(project);
  expect(params.draftRestoreFailed).toBe("1");
  const receiver = await mount(NewWorkspaceRoute, params);
  expect(has(receiver, "new-task-draft-restore-notice")).toBe(true);
  expect(node(source, "new-task-draft").props.input).toBe("unsent secret");
  expect(fixture.createInputs).toEqual([]);
});

it("retains an unavailable explicit model through Add Project and requires a new choice", async () => {
  fixture.models = [{ id: "p::chosen", displayName: "Chosen" }, { id: "p::default", displayName: "Default", isDefault: true }];
  const source = await mount(); await input(source, "unsent secret");
  await press(source, "new-model-option-p%3A%3Achosen");
  const project = await seedIncomingProjectHandoff(source, "p::chosen"); const params = await openProject(project);
  fixture.models = [{ id: "p::new-default", displayName: "New default", isDefault: true }];
  const receiver = await mount(NewWorkspaceRoute, params);
  expect(node(receiver, "new-task-draft").props.modelLabel).toBe("chosen");
  expect(node(receiver, "new-task-draft").props.ready).toBe(false);
  expect(node(receiver, "new-task-draft").props.modelPickerReady).toBe(true);
  expect(has(receiver, "new-task-model-unavailable")).toBe(true);
  await act(async () => { await node(receiver, "new-task-draft").props.submit(); }); expect(fixture.createInputs).toEqual([]);
  await press(receiver, "new-model-server-default"); expect(node(receiver, "new-task-draft").props.ready).toBe(true);
});

it("requires an explicit target in Add Project when a route target is missing or several are available", async () => {
  const unknown = await mount(OpenProjectRoute, { serverId: "missing" });
  expect(node(unknown, "open-project-submit").props.disabled).toBe(true);
  const multiple = await mount(OpenProjectRoute, {}, app([serverA, serverB]));
  expect(node(multiple, "open-project-submit").props.disabled).toBe(true);
  expect(fixture.catalogCalls).toEqual([]);
});

it.each(["observation revision", "account username"])("does not continue an old project owner after %s changes during its held ACK", async change => {
  const original = { ...serverA, observationTargetIdentity: "a".repeat(64), accountIdentity: { principalId: "same-principal", username: "original", role: "member" } };
  const source = await mount(NewWorkspaceRoute, { serverId: "A" }, app([original]));
  await input(source, "unsent secret"); const project = await seedIncomingProjectHandoff(source);
  let acknowledge!: (value: string) => void;
  fixture.ackGate = new Promise(resolve => { acknowledge = resolve; });
  await act(async () => { node(project, "open-project-path").props.onChangeText("/project/new"); });
  await press(project, "open-project-submit");
  await vi.waitFor(() => expect(fixture.acknowledgements).toHaveLength(1));
  const changed = change === "observation revision" ? { ...original, observationTargetIdentity: "b".repeat(64) }
    : { ...original, accountIdentity: { ...original.accountIdentity, username: "replacement" } };
  project.state.app = app([changed]); await update(project);
  await act(async () => { acknowledge("consumed"); });
  expect(fixture.projectInputs).toHaveLength(1);
  expect(fixture.replacements).toEqual([]);
  expect(fixture.createInputs).toEqual([]);
  expect(node(source, "new-task-draft").props.input).toBe("unsent secret");
  expect(has(project, "new-task-draft-restore-notice")).toBe(true);
});


it("offers project-bar retry without raw Gateway errors while leaving projects empty and sending unavailable", async () => {
  const selectedApp = app([]);
  Object.assign(selectedApp.runtime, { error: "Network request failed" });
  const view = await mount(NewWorkspaceRoute, {}, selectedApp);
  expect(has(view, "new-task-gateway-error")).toBe(false);
  expect(node(view, "new-task-draft").props.contextRetry.busy).toBe(false);
  expect(node(view, "new-task-draft").props.contextActual.connectionStatus).toBe("offline");
  expect(node(view, "new-task-draft").props.contextWorkspaces).toEqual([]);
  expect(node(view, "new-task-draft").props.ready).toBe(false);
  await act(async () => { await node(view, "new-task-draft").props.contextRetry.onRetry(); });
  expect(selectedApp.refresh).toHaveBeenCalledTimes(1);
  expect(fixture.createInputs).toEqual([]);
});


it("selects a configured offline target through ordinary projects and returns without losing the draft", async () => {
  const offlineTarget: KCoderServer = { ...serverB, transport: "ssh", host: "unreachable.invalid" };
  const retry = vi.fn();
  fixture.connections.B = { ready: false, client: null, error: "SSH connection failed", supportsPermissions: false, retry };
  const view = await mount(NewWorkspaceRoute, { serverId: "A" }, app([serverA, offlineTarget]));
  await input(view, "keep this draft");
  const oldSubmit = node(view, "new-task-draft").props.submit;
  await selectWorkspace(view, "B", "/project/B");
  const draft = node(view, "new-task-draft").props;
  expect(draft.contextWorkspaces).toEqual(expect.arrayContaining([
    expect.objectContaining({ serverId: "A", path: "/project/A" }),
    expect.objectContaining({ serverId: "B", path: "/project/B" }),
  ]));
  expect(draft).toMatchObject({ input: "keep this draft", ready: false, modelPickerReady: false });
  expect(draft.contextActual).toMatchObject({ profileId: profile.id, serverId: "B", cwd: "/project/B", connectionStatus: "offline" });
  await act(async () => { await oldSubmit(); await draft.submit(); await draft.contextRetry.onRetry(); });
  expect(fixture.createInputs).toEqual([]);
  expect(retry).toHaveBeenCalledOnce();
  expect(view.state.app.refresh).not.toHaveBeenCalled();
  await selectWorkspace(view, "A", "/project/A");
  await act(async () => { await draft.contextRetry.onRetry(); });
  expect(retry).toHaveBeenCalledOnce();
  expect(node(view, "new-task-draft").props).toMatchObject({ input: "keep this draft", ready: true });
  expect(node(view, "new-task-draft").props.contextActual).toMatchObject({ serverId: "A", cwd: "/project/A", connectionStatus: "online" });
});

it("reports catalog failure separately from loading without making failed project reads sendable", async () => {
  fixture.workspaceFailure = "Catalog unavailable";
  const view = await mount(NewWorkspaceRoute, {}, app([{ ...serverA, workspacePath: undefined }]));
  expect(node(view, "new-task-draft").props.contextWorkspacesError).toBe("Catalog unavailable");
  expect(node(view, "new-task-draft").props.ready).toBe(false);
  expect(has(view, "retry-new-workspace-catalogs")).toBe(false);
  expect(has(view, "new-workspace-error")).toBe(false);
  expect(node(view, "new-task-draft").props.contextRetry).toBeDefined();
});

it("settles project availability without a saved Gateway without inventing a project", async () => {
  const selectedApp = { ...app([]), activeProfile: null, profiles: [] };
  const view = await mount(NewWorkspaceRoute, {}, selectedApp);
  expect(node(view, "new-task-draft").props).toMatchObject({ contextWorkspacesReady: true, contextWorkspaces: [], contextWorkspacesError: null, ready: false });
  expect(node(view, "new-task-draft").props.contextActual.connectionStatus).toBe("offline");
  expect(node(view, "new-task-draft").props.contextRetry).toBeUndefined();
  expect(fixture.createInputs).toEqual([]);
});

it("freezes explicit model, supported effort and first-turn permissions into the creation input", async () => {
  fixture.models = [{ id: "fixture::model", displayName: "Exact model", providerId: "fixture", providerName: "Fixture", model: "model", supportedReasoningEfforts: ["low", "high"] }];
  const view = await mount(NewWorkspaceRoute, { profileId: profile.id });
  await input(view, "first configured message");
  await press(view, "new-model-option-fixture%3A%3Amodel");
  await press(view, "new-reasoning-option-high");
  await act(async () => { node(view, "new-task-draft").props.onSelectPermission("ask"); });
  await act(async () => { await node(view, "new-task-draft").props.submit(); });
  expect(fixture.createInputs[0]).toMatchObject({ prompt: "first configured message", model: "fixture::model", reasoningEffort: "high", permissionMode: "ask" });
});

it("submits a local attachment-only draft and unlocks it after a definitely-unsent connection failure", async () => {
  const freeze = vi.fn(() => ({ localAttachmentIds: ["a".repeat(32)], attachmentDraftId: "draft-A" }));
  const unlockUnsent = vi.fn(async () => {});
  fixture.attachments = { items: [{ id: "a".repeat(32) }], busy: false, freeze, unlockUnsent, releaseUnclaimed: async () => {} };
  fixture.claimGate = Promise.reject(new Error("connection failed before dispatch"));
  fixture.claimGate.catch(() => {});
  const view = await mount(NewWorkspaceRoute, { profileId: profile.id });
  await act(async () => { await node(view, "new-task-draft").props.submit(); });
  expect(fixture.createInputs[0]).toMatchObject({ prompt: "new.draft_attachment_only_prompt", localAttachmentIds: ["a".repeat(32)], attachmentDraftId: "draft-A" });
  expect(freeze).toHaveBeenCalledOnce(); expect(unlockUnsent).toHaveBeenCalledOnce();
  expect(node(view, "new-task-draft").props.locked).toBe(false);
});

it("discovers a persisted original submission after reload and recovers its exact input and attachment IDs", async () => {
  const original = { cwd: "/project/A", prompt: "original message", permissionMode: "ask", localAttachmentIds: ["b".repeat(32)], attachmentDraftId: "original-draft" };
  fixture.pending = { clientRequestId: "original-create", dispatched: true, input: original };
  const view = await mount(NewWorkspaceRoute, { profileId: profile.id });
  expect(node(view, "new-task-draft").props).toMatchObject({ ready: false, locked: true });
  await act(async () => { await node(view, "new-task-draft").props.submit(); });
  expect(fixture.createInputs).toEqual([]);
  await press(view, "recover-original-new-task");
  expect(fixture.createInputs).toHaveLength(1);
  expect(fixture.createInputs[0]).toMatchObject(original);
  expect(fixture.replacements.at(-1).params.threadId).toBe("created-thread");
});

it("requires actual workspace initialization and offers retry without claiming HTTP reachability is ready", async () => {
  const retry = vi.fn(); fixture.connection = { ready: false, client: null, error: "RPC init failed", supportsPermissions: false, retry };
  const view = await mount(NewWorkspaceRoute, { profileId: profile.id });
  expect(node(view, "new-task-draft").props.ready).toBe(false);
  expect(node(view, "new-task-draft").props.contextActual.connectionStatus).toBe("offline");
  await input(view, "never dispatched");
  await act(async () => { await node(view, "new-task-draft").props.submit(); });
  expect(fixture.createInputs).toEqual([]);
  expect(has(view, "new-task-configuration-error")).toBe(false);
  await act(async () => { await node(view, "new-task-draft").props.contextRetry.onRetry(); });
  expect(retry).toHaveBeenCalledOnce();
  expect(view.state.app.refresh).not.toHaveBeenCalled();
});

it("preserves an explicit effort on catalog retry and blocks it when refreshed support disappears", async () => {
  fixture.workspaceFailure = "catalog temporarily failed";
  fixture.models = [{ id: "fixture::default", displayName: "Default", providerCurrent: true, isDefault: true, supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" }];
  const view = await mount(NewWorkspaceRoute, { profileId: profile.id });
  await press(view, "new-reasoning-option-high");
  expect(node(view, "new-task-draft").props.reasoningEffort).toBe("high");
  fixture.workspaceFailure = null;
  fixture.models = [{ ...fixture.models[0], supportedReasoningEfforts: ["low"] }];
  await act(async () => { await node(view, "new-task-draft").props.contextRetry.onRetry(); });
  expect(node(view, "new-task-draft").props.reasoningEffort).toBe("high");
  expect(node(view, "new-task-draft").props.ready).toBe(false);
  expect(has(view, "new-task-reasoning-unavailable")).toBe(true);
  await press(view, "new-reasoning-option-low");
  await input(view, "valid effort");
  await act(async () => { await node(view, "new-task-draft").props.submit(); });
  expect(fixture.createInputs[0]).toMatchObject({ reasoningEffort: "low" }); expect(fixture.createInputs[0].model).toBeUndefined();
});
it("keeps visible local attachments on their project instead of silently sending only text on another project", async () => {
  fixture.attachments = { items: [{ id: "a".repeat(32) }], busy: false, freeze: () => ({}), unlockUnsent: async () => {}, releaseUnclaimed: async () => {} };
  const view = await mount(NewWorkspaceRoute, { profileId: profile.id, serverId: "A" }, app([serverA, serverB]));
  await input(view, "with file"); await selectWorkspace(view, "B", "/project/B");
  expect(node(view, "new-task-draft").props.contextActual.serverId).toBe("A");
  expect(node(view, "new-task-draft").props.draftAttachments.items).toHaveLength(1);
  expect(node(view, "new-workspace-error").children.join("")).toBe("new.draft_attachments_change_project");
});
