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
  version: "modern",
  metadata: "", handoff: false, handoffLoads: 0,
  params: { profileId: "gateway-a", serverId: "local", threadId: "thread-1", cwd: "/workspace" } as { profileId: string; serverId: string; threadId: string; cwd?: string; creationRequestId?: string },
  callbacks: [] as Array<{ value: unknown; deps: unknown[] }>, callbackIndex: 0,
  confirm: null as null | (() => void),
  states: [] as unknown[], refs: [] as Array<{ current: unknown }>, stateIndex: 0, refIndex: 0,
  effects: [] as Array<{ effect: () => void | (() => void); deps: unknown[] }>, app: {} as Record<string, unknown>,
  values: new Map<string, string>(),
  read: null as null | ((key: string) => Promise<string | null>),
  write: null as null | ((key: string, value: string) => Promise<void>),
  secureReads: 0,
  workspaceObservation: null as unknown,
  router: {} as { replace: (value: unknown) => void; push: (value: unknown) => void; back: () => void; canGoBack: () => boolean },
  transcriptCache: { cached: null as null, absenceConfirmed: false, workspaceAbsenceConfirmed: false, displayOwner: {}, readAnchor: undefined, initialAnchor: undefined },
}));
vi.mock("@/storage/interface-version", () => ({ useInterfaceVersion: () => host.version }));
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
  useMemo: (factory: () => unknown) => factory(),
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
  getSecureValue: async (key: string) => {
    if (key !== "kcoder-studio-mobile.gateway-profiles.v2") return null;
    host.secureReads++;
    return host.metadata;
  },
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
vi.mock("./CachedSessionView", () => ({ CachedSessionView: "CachedSessionView" }));
vi.mock("./useSessionTranscriptCache", () => ({ useSessionTranscriptCache: () => host.transcriptCache }));
vi.mock("./TaskHeader", () => ({ TaskHeader: "TaskHeader" }));
vi.mock("./TaskMenu", () => ({ TaskMenu: "TaskMenu" }));
vi.mock("./TaskPanels", () => ({ PanelMenu: "PanelMenu", RetainedPanel: "RetainedPanel" }));
vi.mock("./taskStyles", () => ({
  useTaskAppearance: () => ({ styles: {}, colors: {} }),
}));
vi.mock("expo-router", () => ({ useLocalSearchParams: () => host.params, useRouter: () => host.router, useIsFocused: () => true }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({}) }));
vi.mock("@/state/AppContext", () => ({ useApp: () => host.app }));
// Only the handoff locator is controlled here; the actual screen effect builds both callbacks.
vi.mock("@/storage/pending-workspace-operation-v2", async importOriginal => {
  const original = await importOriginal<typeof import("@/storage/pending-workspace-operation-v2")>();
  return { ...original, loadWorkspaceTaskHandoff: (...args: Parameters<typeof original.loadWorkspaceTaskHandoff>) => { host.handoffLoads += 1; return host.handoff
    ? Promise.resolve({ handle: { key: "controlled-handoff", clientRequestId: "request", receiptId: "receipt" },
      value: { threadId: "thread-1", linked: { input: { cwd: "/workspace", prompt: "controlled callback selection" } } } })
    : original.loadWorkspaceTaskHandoff(...args); } };
});
vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: async () => {}, gatewaySessionExpired: async () => false,
  gatewayRequest: async () => host.workspaceObservation,
}));

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

function useAuthority(target: typeof targetA, demo = false) {
  host.app = { hydrated: true, activeProfile: scopedProfile, profiles: [scopedProfile], runtime: {
    servers: [target], statuses: [{ id: target.id, status: "online" }], loading: false, serversReady: true,
    serversUpdatedAt: 1, error: null, reauthorizationRequired: false, statusRefreshing: false, statusError: null,
  }, demo, markGatewayReauthorizationRequired: markExpired };
}
function useDemoWithoutWorkspaceScope() {
  host.app = { hydrated: true, activeProfile: scopedProfile, profiles: [scopedProfile], runtime: {
    servers: [], statuses: [], loading: false, serversReady: true, serversUpdatedAt: 1,
    error: null, reauthorizationRequired: false, statusRefreshing: false, statusError: null,
  }, demo: true, markGatewayReauthorizationRequired: markExpired };
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
function resumeEffect() { return host.effects.find(entry => entry.deps[0] === scopedProfile && entry.deps.includes(markExpired))!.effect(); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function deferredValue<Value>() { let resolve!: (value: Value) => void; const promise = new Promise<Value>(done => { resolve = done; }); return { promise, resolve }; }
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
  host.version = "modern";
  setLocale("zh-CN");
  host.handoff = false; host.handoffLoads = 0;
  host.workspaceObservation = null;
  host.params = { profileId: "gateway-a", serverId: "local", threadId: "thread-1", cwd: "/workspace" };
  host.router = { replace: vi.fn(), push: vi.fn(), back: vi.fn(), canGoBack: () => true };
  host.transcriptCache = { cached: null, absenceConfirmed: false, workspaceAbsenceConfirmed: false, displayOwner: {}, readAnchor: undefined, initialAnchor: undefined };
  host.metadata = JSON.stringify({ profiles: [{ id: scopedProfile.id, baseUrl: scopedProfile.baseUrl, authorizationGeneration: scopedProfile.authorizationGeneration }] });
  const tails = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", { locks: { request: async (name: string, _options: unknown, callback: () => unknown) => {
    const operation = (tails.get(name) ?? Promise.resolve()).catch(() => {}).then(callback);
    tails.set(name, operation); try { return await operation; } finally { if (tails.get(name) === operation) tails.delete(name); }
  } } });
  host.states = []; host.refs = []; host.callbacks = []; host.confirm = null; host.values.clear(); host.read = null; host.write = null; host.secureReads = 0;
  workspacePreferencesTestHelpers.reset();
  taskRuntimeTestHelpers.setConnector(async () => new FakeClient([]) as never);
  useAuthority(targetA);
});
afterEach(() => { vi.unstubAllGlobals(); taskRuntimeRegistry.removeProfile(profile.id); taskRuntimeTestHelpers.resetConnector(); });

it("demo send-state persistence stays in memory when no workspace scope exists", async () => {
  useDemoWithoutWorkspaceScope();
  const read = vi.fn(async () => null);
  const write = vi.fn(async () => {});
  host.read = read;
  host.write = write;

  let hook = renderHook();
  expect(hook.workspaceStorageScope).toBeUndefined();
  const cleanup = hydration(hook);
  await vi.waitFor(() => expect(renderHook().workspaceStateHydrated).toBe(true));

  hook = renderHook();
  await hook.persistComposerDraft("demo prompt");
  hook = renderHook();
  await hook.persistQueuedMessages(queueA);
  hook = renderHook();
  await hook.persistFailedSubmissions(failureA);
  hook = renderHook();
  await hook.persistQueueCommit({ queuedMessages: queueA, failedSubmissions: failureA });
  hook = renderHook();

  expect(hook.workspaceState.composerDraft).toBe("demo prompt");
  expect(hook.workspaceState.queuedMessages).toEqual(queueA);
  expect(hook.workspaceState.failedSubmissions).toEqual(failureA);
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(host.secureReads).toBe(0);
  if (typeof cleanup === "function") cleanup();
});

it("publishes a recent-file state only after its workspace write succeeds", async () => {
  const cleanup = await hydratedA();
  const path = "/workspace/src/current.ts";
  host.write = async () => {
    throw new Error("recent-file storage unavailable");
  };

  let hook = renderHook();
  await expect(hook.persistWorkspaceRecentFile("/workspace", path)).rejects.toThrow(
    "recent-file storage unavailable",
  );
  expect(renderHook().workspaceState.recentFiles).toBeUndefined();

  host.write = null;
  hook = renderHook();
  await hook.persistWorkspaceRecentFile("/workspace", path);
  expect(renderHook().workspaceState.recentFiles).toEqual([path]);
  if (typeof cleanup === "function") cleanup();
});

it("keeps remote-delete cleanup failure visible in the task menu", async () => {
  const cleanup = await hydratedA();
  host.write = async (key, value) => {
    if (key === `${keyA}:removed:v1`) throw new Error("injected tombstone write failure");
    host.values.set(key, value);
  };

  const menu = screenElements().find(element => element.type === "TaskMenu");
  expect(menu).toBeDefined();
  await expect((menu!.props.onDeleted as () => Promise<void>)()).rejects.toThrow(
    "远端已确认删除任务，但此设备未能保存本机工作区清理状态；此设备上的部分本机工作区数据可能仍会保留。",
  );
  expect(host.router.replace).not.toHaveBeenCalled();
  expect(host.values.has(`${keyA}:removed:v1`)).toBe(false);

  if (typeof cleanup === "function") cleanup();
});

it("demo with a workspace scope stays in memory and real writes still require the profile index", async () => {
  useAuthority(targetA, true);
  host.metadata = "";
  const read = vi.fn(async (key: string) => host.values.get(key) ?? null);
  const write = vi.fn(async (key: string, value: string) => { host.values.set(key, value); });
  host.read = read;
  host.write = write;

  let demoHook = renderHook();
  expect(demoHook.workspaceStorageScope).toBe(scopeA);
  const demoCleanup = hydration(demoHook);
  await vi.waitFor(() => expect(renderHook().workspaceStateHydrated).toBe(true));
  demoHook = renderHook();
  await demoHook.persistComposerDraft("temporary demo draft");
  demoHook = renderHook();
  await demoHook.persistFailedSubmissions(failureA);
  demoHook = renderHook();
  await demoHook.persistQueueCommit({ queuedMessages: queueA, failedSubmissions: failureA });
  demoHook = renderHook();
  const oldDemoSave = demoHook.persistComposerDraft;
  expect(demoHook.workspaceState.composerDraft).toBe("temporary demo draft");
  expect(demoHook.workspaceState.queuedMessages).toEqual(queueA);
  expect(demoHook.workspaceState.failedSubmissions).toEqual(failureA);
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(host.secureReads).toBe(0);

  if (typeof demoCleanup === "function") demoCleanup();
  useAuthority(targetA);
  let realHook = renderHook();
  await expect(oldDemoSave("stale demo draft")).rejects.toThrow();
  const realCleanup = hydration(realHook);
  await vi.waitFor(() => expect(renderHook().workspaceStateHydrated).toBe(true));

  realHook = renderHook();
  await expect(realHook.persistQueueCommit({ queuedMessages: queueA, failedSubmissions: failureA })).rejects.toThrow("Gateway 授权归属");
  expect(write).not.toHaveBeenCalled();
  expect(host.secureReads).toBeGreaterThan(0);
  if (typeof realCleanup === "function") realCleanup();
});

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
  await vi.waitFor(() => expect(renderHook().task?.reconnectContext?.server.accountIdentity?.principalId).toBe("b"));
  hook = renderHook();
  const readOnlyAgent = screenElements().find(element => element.type === "AgentPanel")!;
  expect(readOnlyAgent.props.workspaceReady).toBe(false);
  expect(readOnlyAgent.props.task).toBe(hook.task);
  // History for B is readable even after preference failure, but A's private state is never exposed.
  // These are the exact three initial props passed by TaskScreen to AgentPanel.
  expect.soft(hook.workspaceState.composerDraft).not.toBe("private-draft-a");
  expect.soft(hook.workspaceState.queuedMessages).toBeUndefined();
  expect.soft(hook.workspaceState.failedSubmissions).toBeUndefined();
  expect(JSON.parse(host.values.get(keyA)!).queuedMessages).toEqual(queueA);
});

it("confirmed absence automatically replaces the task with its exact session-list scope and notice", () => {
  const hook = renderHook();
  host.transcriptCache.absenceConfirmed = true;
  screenElements();
  const navigationEffect = host.effects.find(entry => entry.deps[0] === hook.workspaceOwnerKey &&
    entry.deps[1] === hook.exitToConfirmedAbsence && entry.deps[3] === true);
  expect(navigationEffect).toBeDefined();
  navigationEffect!.effect();
  expect(host.router.replace).toHaveBeenCalledWith({ pathname: "/sessions", params: {
    profileId: "gateway-a", serverId: "local", cwd: "/workspace", notice: "confirmed-thread-absent",
  } });
});

it("V3 confirmed missing history goes to a scoped draft instead of a failed task", () => {
  host.version = "v3";
  const hook = renderHook();
  expect(hook.exitToConfirmedAbsence()).toBe(true);
  expect(host.router.replace).toHaveBeenCalledWith({ pathname: "/new", params: {
    profileId: "gateway-a", serverId: "local", cwd: "/workspace", notice: "confirmed-thread-absent",
  } });
});

it("a late absence exit callback from owner A cannot navigate the current owner B", () => {
  const old = renderHook();
  useAuthority(targetB);
  renderHook();
  expect(old.exitToConfirmedAbsence()).toBe(false);
  expect(host.router.replace).not.toHaveBeenCalled();
});

it("confirmed workspace absence navigates to Gateway home even when the deleted cwd cannot serve its session list", () => {
  const hook = renderHook();
  host.transcriptCache.workspaceAbsenceConfirmed = true;
  host.transcriptCache.absenceConfirmed = true;
  screenElements();
  const workspaceExit = host.effects.find(entry => entry.deps[0] === hook.workspaceOwnerKey &&
    entry.deps[1] === hook.exitToConfirmedWorkspaceAbsence && entry.deps[3] === true);
  expect(workspaceExit).toBeDefined(); workspaceExit!.effect();
  const threadExit = host.effects.find(entry => entry.deps[1] === hook.exitToConfirmedAbsence && entry.deps[3] === true);
  threadExit?.effect();
  expect(host.router.replace).toHaveBeenCalledTimes(1);
  expect(host.router.replace).toHaveBeenCalledWith({ pathname: "/h/[profileId]", params: {
    profileId: "gateway-a", notice: "confirmed-workspace-absent",
  } });
});

it("a real bound workspace absence carries a scoped recovery handoff to the new-workspace entry", async () => {
  const target = { ...targetA, observationTargetIdentity: "a".repeat(64) };
  useAuthority(target);
  host.params.cwd = "/workspace/deleted";
  host.workspaceObservation = { authorized: true, version: 1, status: "absent", targetId: target.id,
    targetSignature: target.observationTargetIdentity, workspacePath: host.params.cwd, loginGeneration: 1, observedAt: Date.now() };
  taskRuntimeTestHelpers.setConnector(async () => { throw new Error("fixture missing workspace"); });
  renderHook(); resumeEffect();
  await vi.waitFor(() => expect(renderHook().workspacePresence?.result.status).toBe("absent"));
  const hook = renderHook();
  expect(hook.exitToConfirmedWorkspaceAbsence()).toBe(true);
  expect(host.router.replace).toHaveBeenCalledWith({ pathname: "/h/[profileId]", params: {
    profileId: scopedProfile.id, notice: "confirmed-workspace-absent", workspaceAbsenceHandoff: expect.any(String),
  } });
});

it("a stale workspace absence callback cannot navigate after opaque target authority changes", () => {
  useAuthority({ ...targetA, observationTargetIdentity: "a".repeat(64) });
  const old = renderHook();
  useAuthority({ ...targetA, observationTargetIdentity: "b".repeat(64) }); renderHook();
  expect(old.exitToConfirmedWorkspaceAbsence()).toBe(false);
  expect(host.router.replace).not.toHaveBeenCalled();
});

it("workspace absence cannot replace a live retained Runtime", async () => {
  await hydratedA();
  expect(renderHook().exitToConfirmedWorkspaceAbsence()).toBe(false);
  expect(host.router.replace).not.toHaveBeenCalled();
});

it("retry synchronously prevents an old workspace absence callback from replacing the pending recovery", () => {
  const old = renderHook(); old.retryTaskRecovery();
  expect(old.exitToConfirmedWorkspaceAbsence()).toBe(false);
  expect(host.router.replace).not.toHaveBeenCalled();
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

it("routes Windows model file links to the active Files panel with the parsed location", async () => {
  const windowsRoot = "C:\\Work";
  const windowsServer = { ...targetA, workspacePath: windowsRoot };
  const runtime = TaskRuntime.demo("thread-1");
  runtime.patch({ cwd: windowsRoot });
  taskRuntimeRegistry.put(profile.id, server.id, runtime);
  host.params = { ...host.params, cwd: windowsRoot };
  useAuthority(windowsServer, true);

  const cleanup = hydration(renderHook());
  await vi.waitFor(() => expect(renderHook().workspaceStateHydrated).toBe(true));
  const hook = renderHook();
  expect(hook.openWorkspaceFile("src\\App.tsx:12:4")).toBe(true);
  const opened = renderHook();
  const filePanel = opened.panels.find(value => value.kind === "files");
  expect(filePanel).toMatchObject({ title: "App.tsx" });
  expect(opened.fileOpenRequests[filePanel!.id]).toMatchObject({
    path: "C:\\Work\\src\\App.tsx",
    line: 12,
    column: 4,
  });
  if (typeof cleanup === "function") cleanup();
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
  expect.soft(pending.props.workspaceOptions).toEqual({ [server.id]: [{ path: "/private-b", label: "project-b", kind: "workspace" }] });
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

it("a hot task exposes history and older-page reads while preferences are held, with all workspace actions absent", async () => {
  const client = new FakeClient([{ id: "history-a", role: "user", content: "readable history", timestampMs: 1 }], [], { hasMoreBefore: true, beforeCursor: "older-a" });
  const originalRequest = client.request.bind(client);
  // This case exercises lawful older paging; proofless recovery has its own bounded-rebase tests.
  vi.spyOn(client, "supportsExperimental").mockImplementation(capability => ["agentSteering", "threadTranscriptSnapshotV1"].includes(capability));
  const request = vi.spyOn(client, "request").mockImplementation(async (method, params) => {
    const response = await originalRequest<Record<string, unknown>>(method, params);
    return (method === "thread/read" ? { ...response, transcriptSnapshotV1: { status: "available", snapshotId: "a".repeat(64), viewKey: "b".repeat(64) } } : response) as never;
  });
  taskRuntimeTestHelpers.setConnector(async () => client as never);
  const runtime = await TaskRuntime.resume({ profile: scopedProfile, server: targetA, threadId: "thread-1" });
  taskRuntimeRegistry.put(profile.id, server.id, runtime);
  const gate = deferred(); let held = false;
  host.read = async key => { if (key === keyA) { held = true; await gate.promise; } return host.values.get(key) ?? null; };
  hydration(renderHook());
  await vi.waitFor(() => expect(held).toBe(true));
  const elements = screenElements();
  const agent = elements.find(element => element.type === "AgentPanel")!;
  const header = elements.find(element => element.type === "TaskHeader")!;
  expect(agent.props.task).toBe(runtime);
  expect(agent.props.workspaceReady).toBe(false);
  expect(header.props.onMenu).toBeUndefined(); expect(header.props.onMore).toBeUndefined();
  expect(elements.some(element => ["TaskMenu", "PanelMenu", "WorkspaceTabSwitcher", "MobileDrawer", "FilesPanel", "TerminalPanel"].includes(String(element.type)))).toBe(false);
  await runtime.loadOlderMessages();
  expect(request.mock.calls.some(([method, params]) => method === "thread/read" && (params as Record<string, unknown>)?.beforeCursor === "older-a")).toBe(true);
  const ownerKey = agent.key;
  gate.resolve(); await vi.waitFor(() => expect(renderHook().workspaceStateHydrated).toBe(true));
  const restored = screenElements().find(element => element.type === "AgentPanel")!;
  expect(restored.key).toBe(ownerKey); expect(restored.props.task).toBe(runtime); expect(restored.props.workspaceReady).toBe(true);
});

it("cold unlinked resume is single-flight when preferences settle before its held connector", async () => {
  const connectorGate = deferred(), preferencesGate = deferred(); let connectorEntered = false;
  const client = new FakeClient([{ id: "cold-history", role: "user", content: "cold history", timestampMs: 1 }]);
  const connector = vi.fn(async () => { connectorEntered = true; await connectorGate.promise; return client as never; });
  taskRuntimeTestHelpers.setConnector(connector);
  host.read = async key => { if (key === keyA) await preferencesGate.promise; return host.values.get(key) ?? null; };
  hydration(renderHook()); renderHook();
  const initialResume = host.effects.find(entry => entry.deps[0] === scopedProfile && entry.deps.includes(markExpired))!;
  const cancelResume = initialResume.effect();
  await vi.waitFor(() => expect(connectorEntered).toBe(true));
  expect(renderHook().workspaceStateHydrated).toBe(false);
  preferencesGate.resolve(); await vi.waitFor(() => expect(renderHook().workspaceStateHydrated).toBe(true));
  const afterPreferences = host.effects.find(entry => entry.deps[0] === scopedProfile && entry.deps.includes(markExpired))!;
  // These are the actual React dependency arrays: a preference completion cannot cancel/restart the resume.
  expect(afterPreferences.deps).toEqual(initialResume.deps);
  connectorGate.resolve(); await vi.waitFor(() => expect(renderHook().task).not.toBeNull());
  const task = renderHook().task!;
  expect(task.getSnapshot().configurationReady).toBe(false);
  const configurationEffect = host.effects.find(entry => entry.deps.length === 5 && entry.deps[1] === task)!;
  configurationEffect.effect(); await vi.waitFor(() => expect(task.getSnapshot().configurationReady).toBe(true));
  expect(connector).toHaveBeenCalledTimes(1);
  if (typeof cancelResume === "function") cancelResume();
});

it("does not dispatch thread/resume after the route owner expires during connection setup", async () => {
  const connectorGate = deferred(), connectorEntered = deferred();
  const client = new FakeClient([]);
  const request = vi.spyOn(client, "request");
  const connector = vi.fn(async () => {
    connectorEntered.resolve();
    await connectorGate.promise;
    return client as never;
  });
  taskRuntimeTestHelpers.setConnector(connector as never);

  renderHook();
  const cancelResume = resumeEffect();
  await connectorEntered.promise;

  // A new activation epoch fences the old screen owner before its socket finishes connecting.
  host.app.runtimeActivationEpoch = 1;
  renderHook();
  if (typeof cancelResume === "function") cancelResume();
  connectorGate.resolve();

  await vi.waitFor(() => expect(client.closed).toBe(true));
  expect(request).not.toHaveBeenCalledWith("thread/resume", expect.anything());
});

it("closes an in-flight resume when its owner expires and skips late history requests", async () => {
  const resumeEntered = deferred();
  const resumeResponse = deferredValue<{ thread: { id: string; cwd: string; status: string } }>();
  const client = new FakeClient([]);
  const calls: string[] = [];
  client.request = vi.fn(async (method: string) => {
    calls.push(method);
    if (method === "thread/resume") {
      resumeEntered.resolve();
      return resumeResponse.promise as never;
    }
    return {} as never;
  }) as never;
  taskRuntimeTestHelpers.setConnector(async () => client as never);

  renderHook();
  const cancelResume = resumeEffect();
  await resumeEntered.promise;

  host.app.runtimeActivationEpoch = 1;
  renderHook();
  if (typeof cancelResume === "function") cancelResume();
  expect(client.closed).toBe(true);

  resumeResponse.resolve({ thread: { id: "thread-1", cwd: "/workspace", status: "idle" } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(calls).toEqual(["thread/resume"]);
  expect(renderHook().task).toBeNull();
});

it("closes an in-flight history read and does not start stale agent/list work", async () => {
  const historyEntered = deferred();
  const historyResponse = deferredValue<{ thread: { id: string; cwd: string; status: string }; messages: [] }>();
  const client = new FakeClient([]);
  const calls: string[] = [];
  client.request = vi.fn(async (method: string) => {
    calls.push(method);
    if (method === "thread/resume")
      return { thread: { id: "thread-1", cwd: "/workspace", status: "idle" } } as never;
    if (method === "thread/read") {
      historyEntered.resolve();
      return historyResponse.promise as never;
    }
    return {} as never;
  }) as never;
  taskRuntimeTestHelpers.setConnector(async () => client as never);

  renderHook();
  const cancelResume = resumeEffect();
  await historyEntered.promise;

  host.app.runtimeActivationEpoch = 1;
  renderHook();
  if (typeof cancelResume === "function") cancelResume();
  expect(client.closed).toBe(true);

  historyResponse.resolve({ thread: { id: "thread-1", cwd: "/workspace", status: "idle" }, messages: [] });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(calls).toEqual(["thread/resume", "thread/read"]);
  expect(renderHook().task).toBeNull();
});

it("keeps an adopted Runtime connected when loader-effect cleanup follows success", async () => {
  const client = new FakeClient([]);
  taskRuntimeTestHelpers.setConnector(async () => client as never);

  renderHook();
  const cancelResume = resumeEffect();
  await vi.waitFor(() => expect(renderHook().task).not.toBeNull());
  const runtime = renderHook().task!;
  expect(taskRuntimeRegistry.get(profile.id, server.id, "thread-1")).toBe(runtime);

  if (typeof cancelResume === "function") cancelResume();
  expect(client.closed).toBe(false);
  expect(runtime.getSnapshot().connected).toBe(true);
  runtime.close();
});

it("linked handoff still waits for successful preferences and survives same-owner effect cleanup/setup", async () => {
  host.handoff = true;
  const gate = deferred(); let readEntered = false;
  host.read = async key => { if (key === keyA) { readEntered = true; await gate.promise; } return host.values.get(key) ?? null; };
  const runtime = TaskRuntime.demo("thread-1");
  runtime.patch({ cwd: "/workspace" });
  runtime.reconnectContext = { profile: scopedProfile, server: targetA };
  const claim = { result: Promise.resolve(runtime), adopt: vi.fn(() => true), release: vi.fn() };
  const claimCreation = vi.spyOn(TaskRuntime, "claimCreation").mockReturnValue(claim);
  renderHook();
  // Simulate the same owner cleanup/setup before the queued unmount check runs.
  const readinessEffect = host.effects.find(entry => entry.deps.length === 1 && typeof entry.deps[0] === "object" && entry.deps[0] !== null && "promise" in entry.deps[0])!;
  const cleanup = readinessEffect.effect(); if (typeof cleanup === "function") cleanup(); readinessEffect.effect();
  hydration(renderHook()); renderHook(); resumeEffect();
  await vi.waitFor(() => expect(readEntered).toBe(true));
  await Promise.resolve(); expect(claimCreation).not.toHaveBeenCalled();
  gate.resolve(); await vi.waitFor(() => expect(claimCreation).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(renderHook().task).toBe(runtime));
  expect(claim.adopt).toHaveBeenCalledTimes(1);
  claimCreation.mockRestore();
});


it("a route cwd or raw default-target change removes old hot history before any new-owner effect", async () => {
  const target = { ...targetA, workspacePath: undefined };
  const runtime = await TaskRuntime.resume({ profile: scopedProfile, server: target, threadId: "thread-1", cwd: "/workspace" });
  taskRuntimeRegistry.put(profile.id, server.id, runtime); useAuthority(target);
  expect(renderHook().task).toBe(runtime);
  host.params = { ...host.params, cwd: "/private-B" };
  expect(renderHook().task).toBeNull();
  expect(screenElements().some(element => element.type === "AgentPanel")).toBe(false);
  host.params = { ...host.params, cwd: "/workspace" }; useAuthority({ ...targetA, workspacePath: "" });
  expect(renderHook().task).toBeNull();
  expect(screenElements().some(element => element.type === "AgentPanel")).toBe(false);
});


it("a cold response for a different cwd is rejected once without publishing or resuming in a loop", async () => {
  host.params = { ...host.params, cwd: "/private-B" };
  const client = new FakeClient([{ id: "private-A", role: "user", content: "private A", timestampMs: 1 }]);
  const connector = vi.fn(async () => client as never); taskRuntimeTestHelpers.setConnector(connector);
  renderHook(); resumeEffect();
  await vi.waitFor(() => expect(renderHook().loadError).toContain("工作区授权范围尚未确认"));
  expect(renderHook().task).toBeNull(); expect(taskRuntimeRegistry.get(profile.id, server.id, "thread-1")).toBeUndefined();
  expect(client.closed).toBe(true); expect(connector).toHaveBeenCalledTimes(1);
});


it("a valid creation request with the wrong cwd is rejected before claim/adopt and cannot loop", async () => {
  host.handoff = true; host.params = { ...host.params, creationRequestId: "request", cwd: "/wrong-workspace" };
  const claimCreation = vi.spyOn(TaskRuntime, "claimCreation");
  renderHook(); resumeEffect();
  await vi.waitFor(() => expect(renderHook().loadError).toContain("工作区授权范围尚未确认"));
  expect(host.handoffLoads).toBe(1); expect(claimCreation).not.toHaveBeenCalled();
  expect(renderHook().task).toBeNull(); expect(taskRuntimeRegistry.get(profile.id, server.id, "thread-1")).toBeUndefined();
  expect(screenElements().some(element => element.type === "AgentPanel")).toBe(false);
  claimCreation.mockRestore();
});

it("an exact linked creation permits the existing normalized trailing-slash cwd alias", async () => {
  host.handoff = true; host.params = { ...host.params, creationRequestId: "request", cwd: "/workspace/" };
  const runtime = TaskRuntime.demo("thread-1"); runtime.patch({ cwd: "/workspace" });
  runtime.reconnectContext = { profile: scopedProfile, server: targetA };
  const claim = { result: Promise.resolve(runtime), adopt: vi.fn(() => true), release: vi.fn() };
  const claimCreation = vi.spyOn(TaskRuntime, "claimCreation").mockReturnValue(claim);
  hydration(renderHook()); await vi.waitFor(() => expect(renderHook().workspaceStateHydrated).toBe(true));
  renderHook(); resumeEffect();
  await vi.waitFor(() => expect(renderHook().task).toBe(runtime));
  expect(host.handoffLoads).toBe(1); expect(claimCreation).toHaveBeenCalledTimes(1); expect(claim.adopt).toHaveBeenCalledTimes(1);
  claimCreation.mockRestore(); runtime.close();
});
vi.mock("@/features/interface/ConversationV3", () => ({ ConversationV3Background: () => null }));
