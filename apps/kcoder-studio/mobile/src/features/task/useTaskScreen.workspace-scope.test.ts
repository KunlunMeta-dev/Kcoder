// Actual screen hook, scoped storage and Runtime; deterministic hook host, not a browser.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { useTaskScreen } from "./useTaskScreen";
import { TaskScreen } from "./TaskScreen";
import { isValidElement, type ReactNode, type ReactElement } from "react";
// Validation may point only this import at the preserved dirty before source.
vi.mock("./useTaskScreen", async importOriginal => {
  const before = process.env.KCODER_SCOPE_HOOK_BEFORE;
  return before ? await import(/* @vite-ignore */ before) : await importOriginal();
});
import { TaskRuntime, taskRuntimeRegistry, taskRuntimeTestHelpers } from "@/runtime/task-runtime";
import { threadListScopeKey } from "@/runtime/thread-list-projection";
import { FakeClient, profile, server } from "@/runtime/task-runtime/fixture.test-support";
import { loadWorkspaceState, saveWorkspaceState, workspaceStateAuthorizationScope, workspaceStateStorageKey, workspacePreferencesTestHelpers } from "@/storage/workspace-preferences";

const host = vi.hoisted(() => ({
  metadata: "", handoff: false,
  callbacks: [] as Array<{ value: unknown; deps: unknown[] }>, callbackIndex: 0,
  confirm: null as null | (() => void),
  states: [] as unknown[], refs: [] as Array<{ current: unknown }>, stateIndex: 0, refIndex: 0,
  effects: [] as Array<{ effect: () => void | (() => void); deps: unknown[] }>, app: {} as Record<string, unknown>,
  values: new Map<string, string>(),
  read: null as null | ((key: string) => Promise<string | null>),
  write: null as null | ((key: string, value: string) => Promise<void>),
}));
// This direct-call host tests workspace ownership, not React subscriptions.
// Mounted language updates are covered by the Mobile Web preference E2E.
vi.mock("@/i18n/use-locale", async () => {
  const { getLocale } = await import("@/i18n");
  return { useLocale: getLocale };
});
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useCallback: (callback: unknown, deps: unknown[]) => {
    const i = host.callbackIndex++;
    const previous = host.callbacks[i];
    if (previous && deps.length === previous.deps.length && deps.every((value, j) => Object.is(value, previous.deps[j]))) return previous.value;
    host.callbacks[i] = { value: callback, deps };
    return callback;
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[] = []) => host.effects.push({ effect, deps }),
  useRef: (value: unknown) => { const i = host.refIndex++; return host.refs[i] ??= { current: value }; },
  useState: (value: unknown) => {
    const i = host.stateIndex++;
    if (!(i in host.states)) host.states[i] = typeof value === "function" ? (value as () => unknown)() : value;
    return [host.states[i], (update: unknown) => { host.states[i] = typeof update === "function" ? (update as (old: unknown) => unknown)(host.states[i]) : update; }];
  },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => host.read ? host.read(key) : host.values.get(key) ?? null,
  setItem: async (key: string, value: string) => { if (host.write) await host.write(key, value); else host.values.set(key, value); },
  removeItem: async (key: string) => { host.values.delete(key); },
  getAllKeys: async () => [...host.values.keys()],
  multiRemove: async (keys: string[]) => { keys.forEach(key => host.values.delete(key)); },
} }));
vi.mock("@/storage/secure", () => ({
  getSecureValue: async (key: string) => key === "kcoder-studio-mobile.gateway-profiles.v2" ? host.metadata : null,
  setSecureValue: async () => {}, removeSecureValue: async () => {},
}));
vi.mock("@/platform/confirmation", () => ({ requestConfirmation: (request: { onConfirm: () => void }) => { host.confirm = request.onConfirm; } }));
vi.mock("react-native", () => ({ Appearance: { getColorScheme: () => "dark", addChangeListener: () => ({ remove() {} }) }, Alert: {}, Keyboard: { dismiss() {} }, Platform: { OS: "web" },
  View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator", KeyboardAvoidingView: "KeyboardAvoidingView",
}));
vi.mock("@/components/changes-panel", () => ({ ChangesPanel: "ChangesPanel" }));
vi.mock("@/components/mobile-drawer", () => ({ MobileDrawer: "MobileDrawer" }));
vi.mock("@/components/ui", () => ({ EmptyState: "EmptyState" }));
vi.mock("@/components/workspace-panels", () => ({ BrowserPanel: "BrowserPanel", FilesPanel: "FilesPanel", TerminalPanel: "TerminalPanel" }));
vi.mock("@/components/workspace-tab-switcher", () => ({ WorkspaceTabSwitcher: "WorkspaceTabSwitcher" }));
vi.mock("lucide-react-native", () => ({ Bot: "Bot" }));
vi.mock("./TaskAgent", () => ({ AgentPanel: "AgentPanel" }));
vi.mock("./TaskHeader", () => ({ TaskHeader: "TaskHeader" }));
vi.mock("./TaskMenu", () => ({ TaskMenu: "TaskMenu" }));
vi.mock("./TaskPanels", () => ({ PanelMenu: "PanelMenu", RetainedPanel: "RetainedPanel" }));
vi.mock("./taskStyles", () => ({
  useTaskAppearance: () => ({ styles: {}, colors: {} }),
}));
vi.mock("expo-router", () => ({ useLocalSearchParams: () => ({ profileId: "gateway-a", serverId: "local", threadId: "thread-1", cwd: "/workspace" }), useRouter: () => ({}) }));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({}) }));
vi.mock("@/state/AppContext", () => ({ useApp: () => host.app }));
// Only the handoff locator is controlled here; the actual screen effect builds both callbacks.
vi.mock("@/storage/pending-workspace-operation-v2", async importOriginal => {
  const original = await importOriginal<typeof import("@/storage/pending-workspace-operation-v2")>();
  return { ...original, loadWorkspaceTaskHandoff: (...args: Parameters<typeof original.loadWorkspaceTaskHandoff>) => host.handoff
    ? Promise.resolve({ handle: { key: "controlled-handoff", clientRequestId: "request", receiptId: "receipt" },
      value: { threadId: "thread-1", linked: { input: { cwd: "/workspace", prompt: "controlled callback selection" } } } })
    : original.loadWorkspaceTaskHandoff(...args) };
});
vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: async () => {}, gatewaySessionExpired: async () => false }));

const targetA = { ...server, accountIdentity: { principalId: "a", username: "account-a", role: "member" } };
const targetB = { ...server, accountIdentity: { principalId: "b", username: "account-b", role: "member" } };
const scopedProfile = { ...profile, authorizationGeneration: "same-device-family" };
const scopeA = workspaceStateAuthorizationScope(scopedProfile, targetA);
const scopeB = workspaceStateAuthorizationScope(scopedProfile, targetB);
const keyA = workspaceStateStorageKey(profile.id, server.id, "thread-1", scopeA);
const keyB = workspaceStateStorageKey(profile.id, server.id, "thread-1", scopeB);
const markExpired = vi.fn();
const queueA = [{ id: "queued-a", content: "private-a", attachments: [], createdAt: 1 }];
const failureA = [{ id: "failed-a", content: "private-failed-a", attachments: [], createdAt: 1, outcome: "unknown" as const, error: "unknown", retrying: false }];

function useAuthority(target: typeof targetA) {
  host.app = { hydrated: true, activeProfile: scopedProfile, profiles: [scopedProfile], runtime: { servers: [target], loading: false, serversReady: true }, demo: false, markGatewayReauthorizationRequired: markExpired };
}
function renderHook() { host.stateIndex = 0; host.refIndex = 0; host.callbackIndex = 0; host.effects = []; return useTaskScreen(); }
function screenElements() {
  host.stateIndex = 0; host.refIndex = 0; host.callbackIndex = 0; host.effects = [];
  const visit = (node: ReactNode): Array<ReactElement<Record<string, unknown>>> => {
    if (Array.isArray(node)) return node.flatMap(visit);
    if (!isValidElement<Record<string, unknown>>(node)) return [];
    return [node, ...visit(node.props.children as ReactNode)];
  };
  return visit(TaskScreen());
}
function hydration(hook: ReturnType<typeof useTaskScreen>) {
  return host.effects.find(entry => entry.deps[0] === profile.id && entry.deps[1] === server.id && entry.deps[2] === "thread-1" && entry.deps[3] === hook.workspaceStorageScope)!.effect();
}
function invalidateOldRuntime() { host.effects.find(entry => entry.deps.length === 7 && entry.deps[4] === profile.id && entry.deps[6] === "thread-1")!.effect(); }
function resumeEffect() { host.effects.find(entry => entry.deps[0] === scopedProfile && entry.deps.includes(markExpired))!.effect(); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function hydratedA() {
  await saveWorkspaceState(profile.id, server.id, "thread-1", { composerDraft: "private-draft-a", queuedMessages: queueA, failedSubmissions: failureA }, scopeA);
  const runtime = await TaskRuntime.resume({ profile: scopedProfile, server: targetA, threadId: "thread-1" });
  taskRuntimeRegistry.put(profile.id, server.id, runtime);
  expect((await loadWorkspaceState(profile.id, server.id, "thread-1", scopeA)).queuedMessages).toEqual(queueA);
  useAuthority(targetA);
  const cleanup = hydration(renderHook());
  await vi.waitFor(() => expect(renderHook().workspaceStateHydrated).toBe(true));
  return cleanup;
}
beforeEach(() => {
  setLocale("zh-CN");
  host.handoff = false;
  host.metadata = JSON.stringify({ profiles: [{ id: scopedProfile.id, baseUrl: scopedProfile.baseUrl, authorizationGeneration: scopedProfile.authorizationGeneration }] });
  const tails = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", { locks: { request: async (name: string, _options: unknown, callback: () => unknown) => {
    const operation = (tails.get(name) ?? Promise.resolve()).catch(() => {}).then(callback);
    tails.set(name, operation); try { return await operation; } finally { if (tails.get(name) === operation) tails.delete(name); }
  } } });
  host.states = []; host.refs = []; host.callbacks = []; host.confirm = null; host.values.clear(); host.read = null; host.write = null;
  workspacePreferencesTestHelpers.reset();
  taskRuntimeTestHelpers.setConnector(async () => new FakeClient([]) as never);
  useAuthority(targetA);
});
afterEach(() => { vi.unstubAllGlobals(); taskRuntimeRegistry.removeProfile(profile.id); taskRuntimeTestHelpers.resetConnector(); });

it("failed hydration for a new principal cannot expose old draft/queue/failed records to its runtime", async () => {
  const cleanupA = await hydratedA();
  host.read = async key => { if (key === keyB) throw new Error("synthetic new-scope storage failure"); return host.values.get(key) ?? null; };
  useAuthority(targetB);
  let hook = renderHook();
  invalidateOldRuntime();
  if (typeof cleanupA === "function") cleanupA();
  hydration(hook);
  // Old source becomes incorrectly ready; fixed source reports an explicit recovery error.
  await vi.waitFor(() => { const state = renderHook(); expect(state.workspaceStateHydrated || Boolean(state.workspaceStateError)).toBe(true); });
  hook = renderHook(); resumeEffect();
  await Promise.resolve(); await Promise.resolve();
  hook = renderHook();
  expect.soft(hook.workspaceStateHydrated).toBe(false);
  expect.soft(hook.workspaceStateError).toContain("synthetic new-scope storage failure");
  expect(hook.task).toBeNull();
  // These are the exact three initial props passed by TaskScreen to AgentPanel.
  expect.soft(hook.workspaceState.composerDraft).not.toBe("private-draft-a");
  expect.soft(hook.workspaceState.queuedMessages).toBeUndefined();
  expect.soft(hook.workspaceState.failedSubmissions).toBeUndefined();
  expect(JSON.parse(host.values.get(keyA)!).queuedMessages).toEqual(queueA);
});

it("a late old queue commit may persist its captured key but cannot publish into the new principal UI", async () => {
  const cleanupA = await hydratedA();
  await saveWorkspaceState(profile.id, server.id, "thread-1", { composerDraft: "private-draft-b" }, scopeB);
  const gate = deferred(); let held = false;
  host.write = async (key, value) => { if (key === keyA) { held = true; await gate.promise; } host.values.set(key, value); };
  const oldCommit = renderHook().persistQueueCommit({ queuedMessages: queueA, failedSubmissions: failureA });
  await vi.waitFor(() => expect(held).toBe(true));
  useAuthority(targetB); let hook = renderHook(); invalidateOldRuntime();
  if (typeof cleanupA === "function") cleanupA();
  hydration(hook);
  await vi.waitFor(() => expect(renderHook().workspaceState.composerDraft).toBe("private-draft-b"));
  gate.resolve(); await oldCommit;
  hook = renderHook();
  expect(hook.workspaceState.queuedMessages).toBeUndefined();
  expect(hook.workspaceState.failedSubmissions).toBeUndefined();
  expect((await loadWorkspaceState(profile.id, server.id, "thread-1", scopeA)).queuedMessages).toEqual(queueA);
  expect((await loadWorkspaceState(profile.id, server.id, "thread-1", scopeB)).queuedMessages).toBeUndefined();
});

it("a delayed old hydration response cannot overwrite a successfully loaded new scope", async () => {
  await saveWorkspaceState(profile.id, server.id, "thread-1", { composerDraft: "private-draft-a" }, scopeA);
  await saveWorkspaceState(profile.id, server.id, "thread-1", { composerDraft: "private-draft-b" }, scopeB);
  const gate = deferred(); let held = false;
  host.read = async key => { if (key === keyA) { held = true; await gate.promise; } return host.values.get(key) ?? null; };
  const cleanupA = hydration(renderHook());
  await vi.waitFor(() => expect(held).toBe(true));
  useAuthority(targetB); const hook = renderHook();
  if (typeof cleanupA === "function") cleanupA();
  hydration(hook);
  await vi.waitFor(() => expect(renderHook().workspaceState.composerDraft).toBe("private-draft-b"));
  gate.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(renderHook().workspaceState.composerDraft).toBe("private-draft-b");
});


it("manual retry recovers only the current scope after a local read failure", async () => {
  const cleanupA = await hydratedA();
  await saveWorkspaceState(profile.id, server.id, "thread-1", { composerDraft: "private-draft-b" }, scopeB);
  host.read = async key => { if (key === keyB) throw new Error("local read failed"); return host.values.get(key) ?? null; };
  useAuthority(targetB); let hook = renderHook(); invalidateOldRuntime();
  if (typeof cleanupA === "function") cleanupA();
  hydration(hook);
  await vi.waitFor(() => expect(renderHook().workspaceStateError).toContain("local read failed"));
  expect(renderHook().workspaceStateHydrated).toBe(false);
  host.read = null;
  const errorScreen = screenElements();
  expect(errorScreen.find(element => element.type === "EmptyState")?.props.body).toContain("local read failed");
  expect(errorScreen.some(element => element.type === "AgentPanel")).toBe(false);
  const retry = errorScreen.find(element => {
    const child = element.props.children as ReactNode;
    return element.type === "Pressable" && isValidElement<Record<string, unknown>>(child) && child.props.children === "重试恢复";
  });
  expect(retry).toBeDefined();
  (retry!.props.onPress as () => void)(); hook = renderHook(); hydration(hook);
  await vi.waitFor(() => expect(renderHook().workspaceStateHydrated).toBe(true));
  hook = renderHook(); expect(hook.workspaceStateError).toBeNull();
  expect(hook.workspaceState.composerDraft).toBe("private-draft-b");
  resumeEffect();
  await vi.waitFor(() => expect(renderHook().task?.reconnectContext?.server.accountIdentity?.principalId).toBe("b"));
  const readyScreen = screenElements();
  const agent = readyScreen.find(element => element.type === "AgentPanel")!;
  expect(agent.props.initialDraft).toBe("private-draft-b");
  expect(agent.props.initialQueuedMessages).toBeUndefined();
  expect(agent.props.initialFailedSubmissions).toBeUndefined();
  expect((await loadWorkspaceState(profile.id, server.id, "thread-1", scopeA)).queuedMessages).toEqual(queueA);
});

it("old memoized callbacks and a delayed close confirmation cannot change the new scope", async () => {
  await hydratedA();
  let old = renderHook();
  expect(old.openWorkspaceFile("/workspace/old.txt")).toBe(true);
  old = renderHook();
  const panel = old.panels.find(value => value.kind === "files")!;
  old.setDirtyFilePanelIds(new Set([panel.id])); old = renderHook(); old.closePanel(panel.id);
  const closeOld = host.confirm!;
  expect(closeOld).toBeTypeOf("function");
  await saveWorkspaceState(profile.id, server.id, "thread-1", { composerDraft: "private-draft-b" }, scopeB);
  useAuthority(targetB); let current = renderHook();
  // Synchronous render fencing precedes every effect.
  const fencedBeforeEffects = !current.workspaceStateHydrated && current.workspaceState.composerDraft === undefined;
  hydration(current);
  await vi.waitFor(() => expect(renderHook().workspaceStateHydrated).toBe(true));
  current = renderHook();
  const panels = current.panels;
  expect(current.openWorkspaceFile).not.toBe(old.openWorkspaceFile);
  expect(old.openWorkspaceFile("/workspace/stale.txt")).toBe(false);
  expect(fencedBeforeEffects).toBe(true);
  old.selectPanel(panel); old.addPanel("terminal"); old.updatePanel(panel.id, { title: "stale-title" });
  old.setDirtyFilePanelIds(new Set(["old"])); old.reportFilePanelSavePending("old", true);
  closeOld();
  await expect(old.persistComposerDraft("stale-a")).rejects.toThrow("已经切换");
  current = renderHook();
  expect(current.panels).toEqual(panels);
  expect(current.activePanelId).toBe("agent");
  expect(current.savingFilePanelIds.size).toBe(0);
  expect(current.workspaceState.composerDraft).toBe("private-draft-b");
  expect((await loadWorkspaceState(profile.id, server.id, "thread-1", scopeA)).composerDraft).toBe("private-draft-a");
});

it("a late A commit stays fenced after A to B to A uses the same persisted scope key", async () => {
  await hydratedA(); const old = renderHook(); const gate = deferred(); let held = false;
  host.write = async (key, value) => { if (key === keyA) { held = true; await gate.promise; } host.values.set(key, value); };
  const commit = old.persistQueueCommit({ queuedMessages: [{ ...queueA[0], id: "queued-late-a" }], failedSubmissions: failureA });
  await vi.waitFor(() => expect(held).toBe(true));
  useAuthority(targetB); hydration(renderHook());
  await vi.waitFor(() => expect(renderHook().workspaceStateHydrated).toBe(true));
  useAuthority(targetA); hydration(renderHook());
  await vi.waitFor(() => expect(renderHook().workspaceStateHydrated).toBe(true));
  gate.resolve(); await commit;
  expect(renderHook().workspaceState.queuedMessages).toEqual(queueA);
  expect((await loadWorkspaceState(profile.id, server.id, "thread-1", scopeA)).queuedMessages?.[0].id).toBe("queued-late-a");
});


it("same-ID principal change hides completed A drawer props before B catalog RPCs settle", async () => {
  const cleanupA = await hydratedA();
  const gate = deferred(); let holdB = false; let enteredB = false;
  const aClients: FakeClient[] = [];
  taskRuntimeTestHelpers.setConnector(async (_profile, target) => {
    const client = new FakeClient([]); const original = client.request.bind(client);
    if (target.accountIdentity?.principalId === "a") aClients.push(client);
    client.request = (async (method: string, params = {}) => {
      const principal = target.accountIdentity?.principalId ?? "a";
      if (method === "thread/list") {
        if (principal === "b" && holdB) { enteredB = true; await gate.promise; }
        return { threads: [{ id: `drawer-${principal}`, title: `private-${principal}`, cwd: target.workspacePath, updatedAt: 1, status: "idle" }], ...(principal === "a" ? { nextCursor: "a-next" } : {}) };
      }
      if (method === "runtime.workspaces.list") return { items: [{ workspacePath: `/private-${principal}`, label: `project-${principal}` }] };
      if (method === "runtime.worktrees.list") return { items: [] };
      return original(method, params);
    }) as typeof client.request;
    return client as never;
  });
  let hook = renderHook(); hook.openDrawer(); hook = renderHook();
  const drawerEffect = () => host.effects.find(entry => entry.deps.includes(rendered.loadDrawerServer))!.effect();
  let rendered = hook; const cleanupDrawerA = drawerEffect();
  await hook.loadDrawerServer(server.id); await hook.loadDrawerProjects(server.id);
  hook = renderHook();
  expect(hook.drawerThreads[server.id].some(row => row.id === "drawer-a")).toBe(true);
  expect(hook.drawerWorkspaceOptions[server.id][0].path).toBe("/private-a");
  expect(screenElements().find(element => element.type === "MobileDrawer")!.props.visible).toBe(true);
  expect(aClients.some(client => !client.closed)).toBe(true);
  useAuthority(targetB); rendered = renderHook();
  // Current owner is B even before any B effect runs.
  expect.soft(rendered.drawerOpen).toBe(false);
  expect.soft(rendered.drawerThreads).toEqual({});
  expect.soft(rendered.drawerWorkspaceOptions).toEqual({});
  expect(rendered.drawerThreadErrors).toEqual({});
  expect(rendered.drawerWorkspaceErrors).toEqual({});
  expect(rendered.drawerLoading).toEqual({});
  expect(rendered.drawerHasMore).toEqual({});
  invalidateOldRuntime(); if (typeof cleanupA === "function") cleanupA();
  hydration(rendered);
  await vi.waitFor(() => expect(renderHook().workspaceStateHydrated).toBe(true));
  expect(aClients.every(client => client.closed)).toBe(true);
  expect(renderHook().drawerProjection.current.get(threadListScopeKey(scopedProfile, targetA, { archived: false }))).toBeUndefined();
  resumeEffect();
  await vi.waitFor(() => expect(renderHook().task?.reconnectContext?.server.accountIdentity?.principalId).toBe("b"));
  const beforeCatalog = screenElements().find(element => element.type === "MobileDrawer")!;
  expect.soft(beforeCatalog.props.visible).toBe(false);
  expect.soft(beforeCatalog.props.threads).toEqual({});
  expect.soft(beforeCatalog.props.workspaceOptions).toEqual({});
  if (typeof cleanupDrawerA === "function") cleanupDrawerA();
  holdB = true; hook = renderHook(); hook.openDrawer(); rendered = renderHook(); drawerEffect();
  const loading = rendered.loadDrawerServer(server.id);
  await vi.waitFor(() => expect(enteredB).toBe(true));
  const pending = screenElements().find(element => element.type === "MobileDrawer")!;
  expect.soft(pending.props.threads).toEqual({});
  expect.soft(pending.props.workspaceOptions).toEqual({});
  gate.resolve(); await loading;
  hook = renderHook(); await hook.loadDrawerProjects(server.id); hook = renderHook();
  expect(hook.drawerThreads[server.id].every(row => row.id === "drawer-b")).toBe(true);
  expect(hook.drawerWorkspaceOptions[server.id].map(option => option.path)).toEqual(["/private-b"]);
  expect((await loadWorkspaceState(profile.id, server.id, "thread-1", scopeA)).queuedMessages).toEqual(queueA);
  hook.dismissDrawerWork();
});


it.each(["resume", "claim"] as const)("%s expiry callback retains the captured authorization scope after same-id replacement", async path => {
  markExpired.mockClear();
  host.handoff = path === "claim";
  let expired: (() => void) | undefined;
  const resume = vi.spyOn(TaskRuntime, "resume").mockImplementation(async input => {
    expired = input.onSessionExpired;
    throw new Error("controlled stop after callback capture");
  });
  const claim = vi.spyOn(TaskRuntime, "claimCreation").mockImplementation(input => {
    expired = input.onSessionExpired;
    throw new Error("controlled stop after callback capture");
  });
  try {
    hydration(renderHook());
    await vi.waitFor(() => expect(renderHook().workspaceStateHydrated).toBe(true));
    resumeEffect();
    await vi.waitFor(() => expect(expired).toBeTypeOf("function"));
    expect(path === "claim" ? claim : resume).toHaveBeenCalledTimes(1);
    expect(path === "claim" ? resume : claim).not.toHaveBeenCalled();
    const replacement = { ...scopedProfile, authorizationGeneration: "replacement-family" };
    host.app = { ...host.app, activeProfile: replacement, profiles: [replacement] };
    renderHook(); // Same hook slot now belongs to the replacement authorization.
    expired!();
    expect(markExpired).toHaveBeenCalledTimes(1);
    expect(markExpired).toHaveBeenCalledWith(scopedProfile.id, profileAuthorizationScopeKey(scopedProfile));
    expect(markExpired).not.toHaveBeenCalledWith(replacement.id, profileAuthorizationScopeKey(replacement));
  } finally {
    resume.mockRestore(); claim.mockRestore();
  }
});
