// Route-scope review using the real route functions and JSX handlers with a
// deterministic hook host. This is deliberately not a mounted React test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { t } from "@/i18n";
import NewWorkspaceRoute from "../new";
import OpenProjectRoute from "../open-project";
import { WorkspaceOperationBookkeeping } from "@/features/forms/WorkspaceOperationBookkeeping";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import type {
  ManagedWorktree,
  ManagedWorktreeArchivePreview,
  WorkspaceOption,
} from "@/runtime/task-runtime";
import type { ModelOption } from "@/runtime/task-runtime";
import { threadListScopeKey } from "@/runtime/thread-list-projection";
import { TaskRuntimeRegistry } from "@/runtime/task-runtime/registry";
import { pendingThreadCreationKey } from "@/storage/pending-thread-creation";
import { pendingWorkspaceOperationPrefixV2, workspaceOperationOwnerV2 } from "@/storage/pending-workspace-operation-v2";
import {
  WORKSPACE_READ_V2,
  WORKSPACE_RECEIPTS_V2,
  WORKSPACE_SCOPE_V2,
  workspaceParamsDigestV2,
  type WorkspaceMutationMethodV2,
} from "@/protocol/workspace-operation-receipts-v2";
import { PROFILE_INDEX_KEY } from "@/storage/profile-store";
import * as workspaceOperationApi from "@/storage/pending-workspace-operation";
import * as newWorkspacePreferenceApi from "@/storage/new-workspace-preferences";
import { workspaceStateAuthorizationScope } from "@/storage/workspace-preferences";
import * as workspacePreferencesApi from "@/storage/workspace-preferences";
import { profileStateRemovalTestHelpers } from "@/storage/profile-state-removal";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";

const localStorage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  setItemAttempts: [] as Array<{ key: string; value: string }>,
  getItemAttempts: [] as string[],
  failConsumedWrites: 0,
  holdConsumedWrite: null as any,
  holdGetItem: null as any,
  failGetItemKeys: [] as string[],
  holdPreferenceWrites: null as any,
  pendingGateReleases: new Set<() => void>(),
}));
const secureStore = vi.hoisted(() => ({
  values: new Map<string, string>(),
  profiles: new Map<string, Record<string, unknown>>(),
}));
const networkGuard = vi.hoisted(() => ({ authorization: vi.fn() }));

const host = vi.hoisted(() => ({
  app: {} as any,
  params: {} as Record<string, unknown>,
  route: null as null | (() => unknown),
  router: { push: (_value: unknown) => {}, replace: (_value: unknown) => {}, back: () => {} },
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
}));

const api = vi.hoisted(() => {
  const reads = {
    directories: [] as any[],
    models: [] as any[],
    worktrees: [] as any[],
    previews: [] as any[],
  };
  const archives: any[] = [];
  const creates: any[] = [];
  const opens: any[] = [];
  const registryPuts: any[] = [];
  const acknowledgements: any[] = [];
  const receiptAcknowledgements: any[] = [];
  const receiptLoads: any[] = [];
  const pendingCreateResults: any[] = [];
  const createPromises: Promise<any>[] = [];
  const workspaceMutations: any[] = [];
  const workspaceReadbacks: any[] = [];
  const workspaceRpcRequests: any[] = [];
  const unexpectedWorkspaceRpc: any[] = [];
  const workspaceRpcClients: any[] = [];
  const workspaceCapabilities: any[] = [];
  const workspaceReceipts = new Map<string, any>();
  const remoteWorkspaceReceipts = new Map<string, any>();
  const createOperations = new Map<string, { intent: string; promise: Promise<any> }>();
  let createKeyForInput: ((options: any) => string) | null = null;
  let registryTarget: any = null;
  let runWorkspaceOperation: ((input: any) => Promise<string>) | null = null;
  let openWorkspaceReceipt: ((profile: any, server: any, path: string, create?: boolean) => Promise<any>) | null = null;
  let prepareWorktreeReceipt: ((profile: any, server: any, path: string, gitRef?: string) => Promise<any>) | null = null;
  let acknowledgeReceipt: ((receipt: any, context?: any) => Promise<string>) | null = null;
  const makeOperationInput = (profile: any, server: any, path: string, kind: "open" | "create" | "worktree", intent: string, resultPath: string) => ({
    profile,
    server,
    path,
    kind,
    intent,
    newIntent: true,
    mutate: async (id: string) => {
      workspaceMutations.push({ profile, server, path, kind, id });
      return resultPath;
    },
    readback: async (id: string) => {
      workspaceReadbacks.push({ profile, server, path, kind, id });
      return null;
    },
  });
  const deferred = () => {
    let resolve!: (value: any) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<any>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };
  const hold = (collection: any[], profile: any, server: any, extra: Record<string, unknown> = {}) => {
    const gate = deferred();
    const entry = { profile, server, ...extra, ...gate };
    collection.push(entry);
    return entry.promise;
  };
  const reset = () => {
    Object.values(reads).forEach((collection) => { collection.length = 0; });
    archives.length = 0;
    creates.length = 0;
    opens.length = 0;
    registryPuts.length = 0;
    acknowledgements.length = 0;
    receiptAcknowledgements.length = 0;
    receiptLoads.length = 0;
    pendingCreateResults.length = 0;
    createPromises.length = 0;
    workspaceMutations.length = 0;
    workspaceReadbacks.length = 0;
    workspaceRpcRequests.length = 0;
    unexpectedWorkspaceRpc.length = 0;
    workspaceRpcClients.length = 0;
    workspaceCapabilities.length = 0;
    workspaceReceipts.clear();
    remoteWorkspaceReceipts.clear();
    createOperations.clear();
    registryTarget = null;
  };
  return {
    reads,
    archives,
    creates,
    opens,
    registryPuts,
    acknowledgements,
    receiptAcknowledgements,
    receiptLoads,
    createPromises,
    workspaceMutations,
    workspaceReadbacks,
    workspaceRpcRequests,
    unexpectedWorkspaceRpc,
    workspaceRpcClients,
    workspaceCapabilities,
    reset,
    setCreateKey: (keyForInput: (options: any) => string) => { createKeyForInput = keyForInput; },
    setRegistryTarget: (target: any) => { registryTarget = target; },
    getRegistryTarget: () => registryTarget,
    setWorkspaceOperationRunner: (runner: (input: any) => Promise<string>) => { runWorkspaceOperation = runner; },
    setWorkspaceReceiptHelpers: (
      open: (profile: any, server: any, path: string, create?: boolean) => Promise<any>,
      prepareWorktree: (profile: any, server: any, path: string, gitRef?: string) => Promise<any>,
    ) => {
      openWorkspaceReceipt = open;
      prepareWorktreeReceipt = prepareWorktree;
    },
    setReceiptAcknowledger: (acknowledge: (receipt: any, context?: any) => Promise<string>) => {
      acknowledgeReceipt = acknowledge;
    },
    acknowledgeReceipt: async (receipt: any, context?: any) => {
      receiptAcknowledgements.push(receipt);
      const metadata = workspaceReceipts.get(receipt.id);
      if (metadata) acknowledgements.push([metadata.profile, metadata.server, metadata.path, metadata.kind]);
      if (!acknowledgeReceipt) throw new Error("real workspace receipt acknowledger not installed");
      return acknowledgeReceipt(receipt, context);
    },
    openWorkspaceWithReceipt: async (profile: any, server: any, path: string, create = false) => {
      opens.push([profile, server, path, create, "receipt"]);
      if (!openWorkspaceReceipt) throw new Error("real V2 workspace receipt helper not installed");
      const kind = create ? "create" : "open";
      const operation = await openWorkspaceReceipt(profile, server, path, create);
      workspaceReceipts.set(operation.receipt.id, { profile, server, path, kind });
      workspaceMutations.push({ profile, server, path, kind, id: operation.receipt.id });
      return operation;
    },
    prepareManagedWorktreeWithReceipt: async (profile: any, server: any, path: string, gitRef = "") => {
      opens.push([profile, server, path, gitRef, "receipt"]);
      if (!prepareWorktreeReceipt) throw new Error("real V2 workspace receipt helper not installed");
      const operation = await prepareWorktreeReceipt(profile, server, path, gitRef);
      workspaceReceipts.set(operation.receipt.id, { profile, server, path, kind: "worktree" });
      workspaceMutations.push({ profile, server, path, kind: "worktree", id: operation.receipt.id });
      return operation;
    },
    taskClientConnector: async (profile: any, server: any, workspacePath?: string) => {
      const stableHex = (seed: string) => {
        const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c];
        return seeds.map((initial, position) => {
          let value = initial >>> 0;
          const input = `${position}:${seed}`;
          for (let index = 0; index < input.length; index += 1) {
            value ^= input.charCodeAt(index);
            value = Math.imul(value, 0x01000193) >>> 0;
          }
          return value.toString(16).padStart(8, "0");
        }).join("");
      };
      const scope = {
        version: 2,
        rootId: stableHex(JSON.stringify([server.basePath ?? null, server.workspacePath ?? null])),
        scopeId: stableHex(JSON.stringify([
          profile.deviceId ?? null,
          profile.authorizationGeneration ?? null,
          profile.authMode ?? null,
          server.id,
          server.settingsFile ?? null,
          server.accountIdentity?.principalId ?? null,
          server.accountIdentity?.role ?? null,
        ])),
        familyId: stableHex(JSON.stringify([profile.baseUrl, "review-v2-gateway-installation"])),
      };
      const client: any = {
        closed: false,
        supportsExperimental: (capability: string) => {
          workspaceCapabilities.push({ profile, server, capability });
          return capability === WORKSPACE_RECEIPTS_V2;
        },
        request: async (method: string, params: Record<string, unknown> = {}) => {
          const entry = { profile, server, workspacePath, method, params: { ...params } };
          workspaceRpcRequests.push(entry);
          if (method === WORKSPACE_SCOPE_V2) return { ...scope };
          if (method === WORKSPACE_READ_V2) {
            const id = String(params.clientRequestId ?? "");
            workspaceReadbacks.push({ profile, server, path: workspacePath, kind: "read", id });
            const prior = remoteWorkspaceReceipts.get(id);
            return { scope: { ...scope }, receipt: prior?.scope.scopeId === scope.scopeId ? prior.receipt : null };
          }
          if (method === "runtime.workspaces.openV2" || method === "runtime.workspaces.prepareV2" || method === "runtime.worktrees.prepareV2") {
            const mutation = method as WorkspaceMutationMethodV2;
            const id = String(params.clientRequestId ?? "");
            const sourcePath = String(mutation === "runtime.worktrees.prepareV2" ? params.sourcePath : params.workspacePath ?? "/");
            const resultPath = mutation === "runtime.worktrees.prepareV2" ? `${sourcePath}/prepared` : sourcePath;
            const receipt = {
              clientRequestId: id,
              method: mutation,
              paramsDigest: workspaceParamsDigestV2(mutation, params),
              status: "ready",
              workspacePath: resultPath,
            };
            remoteWorkspaceReceipts.set(id, { scope: { ...scope }, receipt });
            const result = mutation === "runtime.worktrees.prepareV2"
              ? { success: true, path: resultPath }
              : mutation === "runtime.workspaces.prepareV2"
                ? { mapping: { workspacePath: resultPath } }
                : { workspacePath: resultPath };
            return { scope: { ...scope }, receipt, result };
          }
          unexpectedWorkspaceRpc.push(entry);
          throw new Error(`unexpected workspace RPC in route-scope fixture: ${method}`);
        },
        close: () => { client.closed = true; },
      };
      workspaceRpcClients.push(client);
      return client;
    },
    reserveCreation: (facade: any) => {
      const reservation = registryTarget.reserveCreation();
      return {
        registry: facade,
        release: () => reservation.release(),
        put: (...args: any[]) => {
          registryPuts.push(args);
          reservation.put(...args);
        },
      };
    },
    holdNextCreateResult: () => {
      const gate = deferred();
      pendingCreateResults.push(gate);
      return gate;
    },
    listWorkspaceOptions: (profile: any, server: any) => hold(reads.directories, profile, server),
    listModels: (profile: any, server: any) => hold(reads.models, profile, server),
    listManagedWorktrees: (profile: any, server: any) => hold(reads.worktrees, profile, server),
    previewManagedWorktreeArchive: (profile: any, server: any, path: string) => hold(reads.previews, profile, server, { path }),
    archiveManagedWorktree: async (profile: any, server: any, preview: any, confirmed: boolean) => {
      archives.push({ profile, server, preview, confirmed });
    },
    create: (options: any) => {
      creates.push(options);
      const key = createKeyForInput!(options);
      const intent = JSON.stringify([options.prompt, options.model, options.reasoningEffort, options.sessionMode, options.turnMode, options.managedWorktreeSourcePath]);
      const previous = createOperations.get(key);
      if (previous) {
        const result = previous.intent === intent
          ? previous.promise
          : Promise.reject(new Error("creation key is already held by another intent"));
        createPromises.push(result);
        return result;
      }
      const pending = pendingCreateResults.shift();
      const promise = pending?.promise ?? Promise.resolve({
        disposed: false,
        getSnapshot: () => ({ threadId: "created-thread", title: "Created" }),
        isDisposed() { return this.disposed; },
        hasLiveTerminalSessions: () => false,
        close() { this.disposed = true; },
      });
      createOperations.set(key, { intent, promise });
      createPromises.push(promise);
      void promise.then(
        () => { if (createOperations.get(key)?.promise === promise) createOperations.delete(key); },
        () => { if (createOperations.get(key)?.promise === promise) createOperations.delete(key); },
      );
      return promise;
    },
    put: (...args: any[]) => {
      registryPuts.push(args);
      registryTarget.put(...args);
    },
    openWorkspace: async (profile: any, server: any, path: string, create = false) => {
      opens.push([profile, server, path, create]);
      if (!runWorkspaceOperation) throw new Error("real workspace operation helper not installed");
      return runWorkspaceOperation(makeOperationInput(profile, server, path, create ? "create" : "open", path, path));
    },
    prepareManagedWorktree: async (profile: any, server: any, path: string, gitRef = "") => {
      opens.push([profile, server, path, gitRef]);
      if (!runWorkspaceOperation) throw new Error("real workspace operation helper not installed");
      return runWorkspaceOperation(makeOperationInput(profile, server, path, "worktree", JSON.stringify([path, gitRef.trim()]), `${path}/prepared`));
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initialValue: unknown) => {
      const index = host.stateIndex++;
      if (!(index in host.states)) {
        host.states[index] = typeof initialValue === "function"
          ? (initialValue as () => unknown)()
          : initialValue;
      }
      if (!host.setters[index]) {
        host.setters[index] = (update: unknown) => {
          host.states[index] = typeof update === "function"
            ? (update as (previous: unknown) => unknown)(host.states[index])
            : update;
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
      if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) {
        return previous.value;
      }
      const value = factory();
      host.memos[index] = { value, deps };
      return value;
    },
    useCallback: (callback: (...args: any[]) => unknown, deps: unknown[]) => {
      const index = host.memoIndex++;
      const previous = host.memos[index];
      if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) {
        return previous.value;
      }
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

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => host.params,
  useRouter: () => host.router,
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => host.insets }));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Dimensions: {
    get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
    addEventListener: () => ({ remove: () => {} }),
  },
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
  "Archive", "Check", "ChevronDown", "ChevronLeft", "FolderGit2", "FolderOpen",
  "FolderPlus", "Github", "RotateCcw", "Search", "Server", "Sparkles", "Trash2", "X",
].map((name) => [name, name])));
vi.mock("@/components/ui", () => ({ Button: "Button", EmptyState: "EmptyState", Field: "Field", StatusDot: "StatusDot" }));
vi.mock("@/components/use-modal-focus-trap", () => ({ useModalFocusTrap: () => null }));
vi.mock("@/state/AppContext", () => ({ useApp: () => host.app }));
vi.mock("@/state/route-profile-activation", () => ({ shouldActivateRouteProfile: () => false }));
vi.mock("@/navigation/back-or-replace", () => ({ backOrReplace: () => {}, profileHomeHref: (id: string) => `/h/${id}` }));
vi.mock("@/gateway/http", () => ({
  ensureGatewayAuthorization: async () => {
    networkGuard.authorization();
    throw new Error("authorization/network request forbidden in route-scope review test");
  },
}));
// The V2 route/storage path uses a deterministic app-server RPC client below.
// This exercises capability and scopeV2/readV2/mutation contracts without a
// socket, Provider, mounted React tree, or external Gateway request.
vi.mock("@/runtime/task-runtime/connectionFactory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/runtime/task-runtime/connectionFactory")>();
  return { ...actual, taskClientConnector: api.taskClientConnector };
});
vi.mock("@/storage/new-workspace-preferences", async (importOriginal) => {
  // Route consumers use the real scoped persistence against the deterministic AsyncStorage map below.
  return await importOriginal<typeof import("@/storage/new-workspace-preferences")>();
});
vi.mock("@/storage/secure", () => ({
  getSecureValue: async (key: string) => secureStore.values.get(key) ?? null,
  setSecureValue: async (key: string, value: string) => { secureStore.values.set(key, value); },
  deleteSecureValue: async (key: string) => { secureStore.values.delete(key); },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => {
    localStorage.getItemAttempts.push(key);
    const failedAt = localStorage.failGetItemKeys.indexOf(key);
    if (failedAt >= 0) {
      localStorage.failGetItemKeys.splice(failedAt, 1);
      throw new Error("injected scoped workspace preference read failure");
    }
    const gate = localStorage.holdGetItem;
    if (gate && gate.key === key) {
      localStorage.holdGetItem = null;
      gate.started = true;
      const snapshot = localStorage.values.get(key) ?? null;
      return new Promise<string | null>((resolve) => {
        let settled = false;
        const release = () => {
          if (settled) return;
          settled = true;
          localStorage.pendingGateReleases.delete(release);
          resolve(gate.snapshotOnStart ? snapshot : localStorage.values.get(key) ?? null);
        };
        gate.release = release;
        localStorage.pendingGateReleases.add(release);
      });
    }
    return localStorage.values.get(key) ?? null;
  },
  setItem: async (key: string, value: string) => {
    localStorage.setItemAttempts.push({ key, value });
    let record: any = null;
    try { record = JSON.parse(value); } catch {}
    if (record?.consumed === true && localStorage.failConsumedWrites > 0) {
      localStorage.failConsumedWrites -= 1;
      throw new Error("injected durable workspace receipt acknowledgement failure");
    }
    if (record?.consumed === true && localStorage.holdConsumedWrite) {
      const gate = localStorage.holdConsumedWrite;
      localStorage.holdConsumedWrite = null;
      gate.started = true;
      gate.key = key;
      gate.value = value;
      await new Promise<void>((resolve) => {
        let settled = false;
        const release = () => {
          if (settled) return;
          settled = true;
          localStorage.pendingGateReleases.delete(release);
          resolve();
        };
        gate.release = release;
        localStorage.pendingGateReleases.add(release);
      });
    }
    const preferenceWriteGate = localStorage.holdPreferenceWrites;
    if (preferenceWriteGate && key.startsWith("kcoder-studio:mobile-new-workspace:v1:")) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let release = () => {};
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          localStorage.pendingGateReleases.delete(release);
          callback();
        };
        release = () => finish(resolve);
        localStorage.pendingGateReleases.add(release);
        preferenceWriteGate.requests.push({
          key,
          value,
          resolve: release,
          reject: (error = new Error("injected scoped workspace preference write failure")) => finish(() => reject(error)),
        });
      });
    }
    localStorage.values.set(key, value);
  },
  removeItem: async (key: string) => { localStorage.values.delete(key); },
  getAllKeys: async () => [...localStorage.values.keys()],
  multiRemove: async (keys: string[]) => { keys.forEach((key) => localStorage.values.delete(key)); },
} }));
vi.mock("@/storage/workspace-preferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/storage/workspace-preferences")>();
  // Keep the production scope function; only persistence is a no-op here.
  return { ...actual, saveWorkspaceState: async () => {} };
});
vi.mock("@/storage/pending-workspace-operation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/storage/pending-workspace-operation")>();
  const actualApi = actual as any;
  api.setWorkspaceOperationRunner(actual.recoverableWorkspaceOperation);
  if (actualApi.acknowledgeConfirmedWorkspaceOperation) api.setReceiptAcknowledger(actualApi.acknowledgeConfirmedWorkspaceOperation);
  return {
    ...actual,
    ...(actualApi.loadConfirmedWorkspaceOperationReceipt ? {
      loadConfirmedWorkspaceOperationReceipt: async (...args: any[]) => {
        const result = await actualApi.loadConfirmedWorkspaceOperationReceipt(...args);
        api.receiptLoads.push({ args, result });
        return result;
      },
    } : {}),
    acknowledgeWorkspaceOperation: async (...args: any[]) => {
      api.acknowledgements.push(args);
      return actual.acknowledgeWorkspaceOperation(args[0], args[1], args[2], args[3]);
    },
    ...(actualApi.acknowledgeConfirmedWorkspaceOperation ? {
      acknowledgeConfirmedWorkspaceOperation: async (receipt: any, context?: any) => api.acknowledgeReceipt(receipt, context),
    } : {}),
  };
});
vi.mock("@/runtime/task-runtime", async () => {
  const catalog = await import("@/runtime/task-runtime/modelCatalog");
  const factories = await import("@/runtime/task-runtime/factories");
  const workspaces = await import("@/runtime/task-runtime/workspaces");
  api.setWorkspaceReceiptHelpers(
    workspaces.openWorkspaceWithReceipt,
    workspaces.prepareManagedWorktreeWithReceipt,
  );
  const registryFacade = {
    reserveCreation: () => api.reserveCreation(registryFacade),
    put: (...args: any[]) => api.put(...args),
  };
  return {
    defaultModelOption: catalog.defaultModelOption,
    modelOptionSelector: catalog.modelOptionSelector,
    selectedModelOption: catalog.selectedModelOption,
    listWorkspaceOptions: api.listWorkspaceOptions,
    listModels: api.listModels,
    listManagedWorktrees: api.listManagedWorktrees,
    previewManagedWorktreeArchive: api.previewManagedWorktreeArchive,
    archiveManagedWorktree: api.archiveManagedWorktree,
    restoreManagedWorktree: async () => {},
    forgetManagedWorktree: async () => {},
    openWorkspace: api.openWorkspace,
    prepareManagedWorktree: api.prepareManagedWorktree,
    openWorkspaceWithReceipt: api.openWorkspaceWithReceipt,
    prepareManagedWorktreeWithReceipt: api.prepareManagedWorktreeWithReceipt,
    TaskRuntime: {
      create: api.create,
      // Exercise the production claimant and its actual registry reservation; api.create supplies a shared result Promise.
      claimCreation: (input: any, registry: any) => {
        const registration = registry.reserveCreation();
        try {
          return factories.claimCreationResult(api.create(input), registration);
        } catch (error) {
          registration.release();
          throw error;
        }
      },
      demo: () => ({}),
    },
    taskRuntimeRegistry: registryFacade,
  };
});
vi.mock("@/theme", () => ({
  colors: new Proxy({}, { get: (_target, key) => String(key) }),
  useTheme: () => ({ colors: new Proxy({}, { get: (_target, key) => String(key) }), mode: "dark" }),
  useThemedStyles: (factory: (value: any) => unknown) => factory(new Proxy({}, { get: (_target, key) => String(key) })),
  radius: { sm: 6, md: 10, lg: 14 },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
}));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));

const profile = (generation: string, accessToken: string, id = "profile-1"): GatewayProfile => ({
  id,
  label: "Same Gateway",
  baseUrl: "https://gateway.invalid",
  accessToken,
  expiresAt: Date.now() + 60_000,
  rpcToken: "rpc-token",
  authorizationGeneration: generation,
  authMode: "device",
  deviceId: "device-1",
});

const server = (workspacePath: string, principalId: string, role = "member"): KCoderServer => ({
  id: "server-1",
  label: "Same server ID",
  description: "same visible target label",
  runtime: "kcoder",
  transport: "local",
  workspacePath,
  settingsFile: `/config/${principalId}/settings.json`,
  accountIdentity: { principalId, username: principalId, role },
});

function seedSecureProfileMetadata(activeProfile: GatewayProfile) {
  const metadata = Object.fromEntries(Object.entries(activeProfile).filter(([key]) =>
    !["accessToken", "rpcToken", "refreshToken", "pendingRotationId"].includes(key),
  ));
  secureStore.profiles.set(activeProfile.id, metadata);
  secureStore.values.set(PROFILE_INDEX_KEY, JSON.stringify({
    profiles: [...secureStore.profiles.values()],
    activeId: activeProfile.id,
  }));
}

function appFor(activeProfile: GatewayProfile, activeServer: KCoderServer) {
  seedSecureProfileMetadata(activeProfile);
  return {
    hydrated: true,
    activeProfile,
    profiles: [activeProfile],
    runtime: { servers: [activeServer], statuses: [{ id: activeServer.id, status: "online" }], loading: false, serversReady: true },
    setActiveProfile: () => {},
    markGatewayReauthorizationRequired: () => {},
    demo: false,
  };
}

function renderRoute() {
  if (!host.route) throw new Error("route test host has no route");
  host.stateIndex = 0;
  host.refIndex = 0;
  host.memoIndex = 0;
  host.effectIndex = 0;
  host.pendingEffects = [];
  return host.route();
}

function flushEffects() {
  const effects = host.pendingEffects;
  host.pendingEffects = [];
  for (const pending of effects) {
    if (!pending.changed) continue;
    host.effects[pending.index]?.cleanup?.();
    const cleanup = pending.effect();
    host.effects[pending.index] = {
      deps: pending.deps,
      cleanup: typeof cleanup === "function" ? cleanup : undefined,
    };
  }
}

function commitRoute() {
  // State setters from effects take effect on the next deterministic render.
  for (let pass = 0; pass < 5; pass += 1) {
    renderRoute();
    flushEffects();
  }
  return renderRoute();
}

async function drainPromises() {
  for (let pass = 0; pass < 12; pass += 1) await Promise.resolve();
}

function elements(node: unknown): Array<ReactElement<Record<string, any>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children as ReactNode)];
}

function byTestId(tree: unknown, testID: string) {
  return elements(tree).find((element) => element.props.testID === testID);
}

function buttonWithText(tree: unknown, label: string) {
  return elements(tree).find((element) =>
    element.type === "Button" && textContent(element.props.children).trim() === label,
  );
}

function pressableWithText(tree: unknown, label: string) {
  return elements(tree).find((element) =>
    element.type === "Pressable" && textContent(element.props.children).includes(label),
  );
}

function workspaceOperationRecord(
  profile: GatewayProfile,
  server: KCoderServer,
  path: string,
  kind: "open" | "create" | "worktree",
): { key: string; record: Record<string, any> } | null {
  const rows = JSON.parse(localStorage.values.get("kcoder-studio:mobile-workspace-operation:v2-index") ?? "[]") as Array<{ profileId?: string; key?: string }>;
  const owner = workspaceOperationOwnerV2(profile, server);
  for (const row of rows) {
    if (row.profileId !== profile.id || typeof row.key !== "string" || !row.key.startsWith(pendingWorkspaceOperationPrefixV2(profile.id))) continue;
    const raw = localStorage.values.get(row.key);
    if (!raw) continue;
    const record = JSON.parse(raw) as Record<string, any>;
    if (record.profileId === profile.id && record.owner === owner && record.kind === kind && record.path === path) return { key: row.key, record };
  }
  return null;
}

function newWorkspaceScope(profile: GatewayProfile, server: KCoderServer) {
  return JSON.stringify([workspaceStateAuthorizationScope(profile, server), profile.deviceId]);
}

function requestsFor(collection: any[], profile: GatewayProfile, server: KCoderServer) {
  const expectedScope = threadListScopeKey(profile, server);
  return collection.filter((entry) => threadListScopeKey(entry.profile, entry.server) === expectedScope);
}

function tap(element: ReactElement<Record<string, any>> | undefined) {
  if (!element || element.props.disabled) return;
  (element.props.onPress as (() => void) | undefined)?.();
}

async function waitForEnabledButton(
  findButton: (tree: unknown) => ReactElement<Record<string, any>> | undefined,
): Promise<unknown> {
  let tree: unknown;
  await vi.waitFor(() => {
    tree = commitRoute();
    const button = findButton(tree);
    expect(button).toBeDefined();
    expect(button?.props.disabled).toBe(false);
  });
  return tree;
}

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (isValidElement(node)) return textContent((node.props as { children?: ReactNode }).children);
  return "";
}

function resetHost() {
  for (const effect of host.effects) effect?.cleanup?.();
  host.app = {};
  host.params = {};
  host.route = null;
  host.router = { push: () => {}, replace: () => {}, back: () => {} };
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

function renderBookkeepingConsumer(
  profile: GatewayProfile,
  server: KCoderServer,
  expectedResult: string,
  params: Record<string, unknown>,
) {
  resetHost();
  host.params = params;
  host.route = () => WorkspaceOperationBookkeeping({ profile, server, expectedResult, enabled: true });
  return commitRoute();
}

function newRouteBookkeepingProps(
  profile: GatewayProfile,
  server: KCoderServer,
  params: Record<string, unknown>,
): Record<string, unknown> {
  resetHost();
  host.app = appFor(profile, server);
  host.params = params;
  host.route = NewWorkspaceRoute;
  const tree = commitRoute();
  const consumer = elements(tree).find((element) => element.type === WorkspaceOperationBookkeeping);
  if (!consumer) throw new Error("/new route did not render its workspace receipt consumer");
  return consumer.props;
}

function workspace(path: string, label: string): WorkspaceOption {
  return { path, label, kind: "workspace" };
}

function model(id: string, displayName: string): ModelOption {
  return {
    id,
    model: id.split("::").at(-1) ?? id,
    displayName,
    providerId: id.split("::")[0],
    providerName: `provider-${id.split("::")[0]}`,
    isDefault: true,
  };
}

function activeWorktree(id: string, path: string): ManagedWorktree {
  return {
    deviceId: "server-1",
    worktreeId: id,
    path,
    repositoryName: `private-${id}`,
    permanent: false,
    revision: 3,
    state: "active",
    conversations: [],
  };
}

function archivePreview(path: string): ManagedWorktreeArchivePreview {
  return {
    path,
    state: "active",
    revision: 3,
    contentToken: `token:${path}`,
    dirty: true,
    untrackedFileCount: 1,
    ignoredEntryCount: 0,
    dirtySubmoduleCount: 0,
    nestedRepositoryCount: 0,
    baselineKnown: true,
    commitsSinceCreation: 0,
    requiresConfirmation: true,
    archiveAllowed: true,
    blockingReasons: [],
    archivedConversations: [],
  };
}

beforeEach(() => {
  resetHost();
  api.reset();
  secureStore.values.clear();
  secureStore.profiles.clear();
  api.setRegistryTarget(new TaskRuntimeRegistry());
  api.setCreateKey((options: any) => pendingThreadCreationKey(options.profile, options.server, options.cwd));
  localStorage.values.clear();
  localStorage.setItemAttempts.length = 0;
  localStorage.getItemAttempts.length = 0;
  localStorage.failConsumedWrites = 0;
  localStorage.holdConsumedWrite = null;
  localStorage.holdGetItem = null;
  localStorage.failGetItemKeys.length = 0;
  localStorage.holdPreferenceWrites = null;
  (newWorkspacePreferenceApi as any).newWorkspacePreferencesTestHelpers?.reset();
  (workspacePreferencesApi as any).workspacePreferencesTestHelpers?.reset();
  profileStateRemovalTestHelpers.reset();
  networkGuard.authorization.mockClear();
});

afterEach(async () => {
  localStorage.holdConsumedWrite = null;
  localStorage.holdGetItem = null;
  localStorage.holdPreferenceWrites = null;
  for (const release of [...localStorage.pendingGateReleases]) release();
  await drainPromises();
  expect(networkGuard.authorization).not.toHaveBeenCalled();
  expect(api.unexpectedWorkspaceRpc).toEqual([]);
  expect(api.workspaceRpcClients.filter((client: any) => !client.closed)).toEqual([]);
  resetHost();
  (newWorkspacePreferenceApi as any).newWorkspacePreferencesTestHelpers?.reset();
  (workspacePreferencesApi as any).workspacePreferencesTestHelpers?.reset();
  profileStateRemovalTestHelpers.reset();
});

describe("new workspace route scope", () => {
  beforeEach(() => {
    host.route = NewWorkspaceRoute;
    host.params = { profileId: "profile-1", serverId: "server-1" };
  });

  it("loads and saves real new-workspace preferences under the current same-ID authorization scope", async () => {
    const profileA = profile("authorization-A", "token-A");
    const serverA = server("/srv/principal-A", "principal-A");
    const savedA = { cwd: "/srv/principal-A/saved-A", isolation: "worktree" as const };
    const scopeA = newWorkspaceScope(profileA, serverA);
    const keyA = (newWorkspacePreferenceApi as any).newWorkspacePreferenceKey(profileA.id, serverA.id, scopeA) as string;
    const savePreference = (newWorkspacePreferenceApi as any).saveNewWorkspacePreference as (
      profileId: string, serverId: string, scope: string, value: { cwd: string; isolation: "local" | "worktree" },
    ) => Promise<void>;
    const loadPreference = (newWorkspacePreferenceApi as any).loadNewWorkspacePreference as (
      profileId: string, serverId: string, scope: string,
    ) => Promise<{ cwd: string; isolation: "local" | "worktree" } | null>;
    seedSecureProfileMetadata(profileA);
    await savePreference(profileA.id, serverA.id, scopeA, savedA);

    host.app = appFor(profileA, serverA);
    let tree = commitRoute();
    const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
    const aModels = requestsFor(api.reads.models, profileA, serverA)[0];
    expect(aDirectories).toBeDefined();
    expect(aModels).toBeDefined();
    aDirectories.resolve([
      workspace(savedA.cwd, "A saved project"),
      workspace(serverA.workspacePath!, "A root"),
    ]);
    aModels.resolve([model("provider-a::model-a", "A model")]);
    await drainPromises();
    tree = commitRoute();
    expect(byTestId(tree, "workspace-path")?.props.value).toBe(savedA.cwd);
    expect(byTestId(tree, "workspace-git-ref")).toBeDefined();
    expect(await loadPreference(profileA.id, serverA.id, newWorkspaceScope(profileA, serverA))).toEqual(savedA);

    const profileB = profile("authorization-B", "token-B");
    const serverB = server("/srv/principal-B", "principal-B", "admin");
    const savedB = { cwd: "/srv/principal-B/saved-B", isolation: "local" as const };
    const scopeB = newWorkspaceScope(profileB, serverB);
    const keyB = (newWorkspacePreferenceApi as any).newWorkspacePreferenceKey(profileB.id, serverB.id, scopeB) as string;
    seedSecureProfileMetadata(profileB);
    await savePreference(profileB.id, serverB.id, scopeB, savedB);
    host.app = appFor(profileB, serverB);

    // The first B render clears A's value before B's catalogs or preference load can resolve.
    tree = renderRoute();
    expect(byTestId(tree, "workspace-path")?.props.value).not.toBe(savedA.cwd);
    flushEffects();
    tree = commitRoute();
    const bDirectories = requestsFor(api.reads.directories, profileB, serverB)[0];
    const bModels = requestsFor(api.reads.models, profileB, serverB)[0];
    expect(bDirectories).toBeDefined();
    expect(bModels).toBeDefined();
    bDirectories.resolve([
      workspace(savedB.cwd, "B saved project"),
      workspace(serverB.workspacePath!, "B root"),
    ]);
    bModels.resolve([model("provider-b::model-b", "B model")]);
    await drainPromises();
    tree = commitRoute();
    expect(byTestId(tree, "workspace-path")?.props.value).toBe(savedB.cwd);
    expect(byTestId(tree, "workspace-git-ref")).toBeUndefined();

    const editedBPath = "/srv/principal-B/edited-B";
    (byTestId(tree, "workspace-path")?.props.onChangeText as (value: string) => void)(editedBPath);
    tree = renderRoute();
    flushEffects();
    await vi.waitFor(() => expect(localStorage.values.get(keyB)).toBe(JSON.stringify({ cwd: editedBPath, isolation: "local" })));
    tree = commitRoute();
    expect(byTestId(tree, "workspace-path")?.props.value).toBe(editedBPath);
    expect(localStorage.values.get(keyA)).toBe(JSON.stringify(savedA));
    await vi.waitFor(async () => {
      await expect(loadPreference(profileB.id, serverB.id, newWorkspaceScope(profileB, serverB)))
        .resolves.toEqual({ cwd: editedBPath, isolation: "local" });
    });
    expect(localStorage.values.get(keyB)).toBe(JSON.stringify({ cwd: editedBPath, isolation: "local" }));
  });

  it.each([
    { read: "rejected", fail: true },
    { read: "held", fail: false },
  ])("keeps catalog readiness and explicit creation independent of a $read preference read", async ({ fail }) => {
    const profileA = profile("authorization-A", "token-A");
    const serverA = server("/srv/principal-A", "principal-A");
    const preferenceKey = (newWorkspacePreferenceApi as any).newWorkspacePreferenceKey(
      profileA.id, serverA.id, newWorkspaceScope(profileA, serverA),
    ) as string;
    const savePreference = (newWorkspacePreferenceApi as any).saveNewWorkspacePreference as (
      profileId: string, serverId: string, scope: string, value: { cwd: string; isolation: "local" | "worktree" },
    ) => Promise<void>;
    seedSecureProfileMetadata(profileA);
    await savePreference(profileA.id, serverA.id, newWorkspaceScope(profileA, serverA), {
      cwd: "/srv/principal-A/persisted-before-read",
      isolation: "worktree",
    });
    localStorage.setItemAttempts.length = 0;
    const readGate = { key: preferenceKey, snapshotOnStart: true, started: false, release: undefined as undefined | (() => void) };
    if (fail) localStorage.failGetItemKeys.push(preferenceKey);
    else localStorage.holdGetItem = readGate;

    const replacements: unknown[] = [];
    host.router = { push: () => {}, replace: (value: unknown) => replacements.push(value), back: () => {} };
    host.app = appFor(profileA, serverA);
    let tree = commitRoute();
    const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
    const aModels = requestsFor(api.reads.models, profileA, serverA)[0];
    expect(aDirectories).toBeDefined();
    expect(aModels).toBeDefined();
    aDirectories.resolve([workspace(serverA.workspacePath!, "A root")]);
    aModels.resolve([model("provider-a::model-a", "A model")]);
    await drainPromises();
    tree = commitRoute();

    const prompt = byTestId(tree, "new-workspace-prompt");
    (prompt?.props.onChangeText as (value: string) => void)("create while the local preference read is unavailable");
    tree = await waitForEnabledButton((current) => byTestId(current, "create-workspace"));
    const create = byTestId(tree, "create-workspace");
    expect(create?.props.disabled).toBe(false);
    tap(create);
    await vi.waitFor(() => expect(api.creates).toHaveLength(1));
    await vi.waitFor(() => expect(replacements).toHaveLength(1));
    tree = commitRoute();
    expect(api.creates).toHaveLength(1);
    expect(api.creates[0]).toMatchObject({ cwd: serverA.workspacePath, prompt: "create while the local preference read is unavailable" });
    expect(replacements).toHaveLength(1);
    expect(byTestId(tree, "new-workspace-error")).toBeUndefined();
    if (fail) {
      expect(byTestId(tree, "new-workspace-preference-read-error")).toBeDefined();
      expect(localStorage.getItemAttempts.filter((key) => key === preferenceKey)).toHaveLength(1);
    } else {
      expect(readGate.started).toBe(true);
      readGate.release?.();
      await drainPromises();
      tree = renderRoute();
      expect(localStorage.getItemAttempts.filter((key) => key === preferenceKey)).toHaveLength(1);
      // The explicit Create intent also fences a preference that returns after navigation began.
      expect(byTestId(tree, "workspace-path")?.props.value).toBe(serverA.workspacePath);
    }
  });

  it("does not save the fallback options before preference hydration or replace a dirty selection with late data", async () => {
    const profileA = profile("authorization-A", "token-A");
    const serverA = server("/srv/principal-A", "principal-A");
    const preferenceKey = (newWorkspacePreferenceApi as any).newWorkspacePreferenceKey(
      profileA.id, serverA.id, newWorkspaceScope(profileA, serverA),
    ) as string;
    const savePreference = (newWorkspacePreferenceApi as any).saveNewWorkspacePreference as (
      profileId: string, serverId: string, scope: string, value: { cwd: string; isolation: "local" | "worktree" },
    ) => Promise<void>;
    seedSecureProfileMetadata(profileA);
    await savePreference(profileA.id, serverA.id, newWorkspaceScope(profileA, serverA), {
      cwd: "/srv/principal-A/saved-before-hydration",
      isolation: "worktree",
    });
    localStorage.setItemAttempts.length = 0;
    const readGate = { key: preferenceKey, snapshotOnStart: true, started: false, release: undefined as undefined | (() => void) };
    localStorage.holdGetItem = readGate;

    host.app = appFor(profileA, serverA);
    let tree = commitRoute();
    const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
    const aModels = requestsFor(api.reads.models, profileA, serverA)[0];
    aDirectories.resolve([
      workspace(serverA.workspacePath!, "A root"),
      workspace("/srv/principal-A/saved-before-hydration", "saved path"),
    ]);
    aModels.resolve([model("provider-a::model-a", "A model")]);
    await drainPromises();
    tree = commitRoute();

    expect(readGate.started).toBe(true);
    expect(byTestId(tree, "workspace-path")?.props.value).toBe(serverA.workspacePath);
    expect(byTestId(tree, "workspace-git-ref")).toBeUndefined();
    expect(localStorage.values.get(preferenceKey)).toContain("saved-before-hydration");
    expect(localStorage.setItemAttempts.filter((entry) => entry.key === preferenceKey)).toHaveLength(0);

    const dirtyPath = "/srv/principal-A/dirty-before-hydration";
    (byTestId(tree, "workspace-path")?.props.onChangeText as (value: string) => void)(dirtyPath);
    tree = renderRoute();
    tap(byTestId(tree, "workspace-isolation-worktree"));
    tree = renderRoute();
    expect(byTestId(tree, "workspace-path")?.props.value).toBe(dirtyPath);

    readGate.release?.();
    await drainPromises();
    tree = commitRoute();
    expect(byTestId(tree, "workspace-path")?.props.value).toBe(dirtyPath);
    expect(byTestId(tree, "workspace-git-ref")).toBeDefined();
  });

  it("keeps cwd and isolation dirty while an explicit preference-read retry is held", async () => {
    const profileA = profile("authorization-A", "token-A");
    const serverA = server("/srv/principal-A", "principal-A");
    const preferenceKey = (newWorkspacePreferenceApi as any).newWorkspacePreferenceKey(
      profileA.id, serverA.id, newWorkspaceScope(profileA, serverA),
    ) as string;
    const savePreference = (newWorkspacePreferenceApi as any).saveNewWorkspacePreference as (
      profileId: string, serverId: string, scope: string, value: { cwd: string; isolation: "local" | "worktree" },
    ) => Promise<void>;
    seedSecureProfileMetadata(profileA);
    await savePreference(profileA.id, serverA.id, newWorkspaceScope(profileA, serverA), {
      cwd: "/srv/principal-A/retry-snapshot",
      isolation: "local",
    });
    localStorage.setItemAttempts.length = 0;
    localStorage.failGetItemKeys.push(preferenceKey);
    host.app = appFor(profileA, serverA);
    let tree = commitRoute();
    const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
    const aModels = requestsFor(api.reads.models, profileA, serverA)[0];
    aDirectories.resolve([workspace(serverA.workspacePath!, "A root")]);
    aModels.resolve([model("provider-a::model-a", "A model")]);
    await drainPromises();
    tree = commitRoute();
    expect(byTestId(tree, "new-workspace-preference-read-error")).toBeDefined();
    expect(byTestId(tree, "workspace-path")?.props.value).toBe(serverA.workspacePath);
    expect(localStorage.setItemAttempts.filter((entry) => entry.key === preferenceKey)).toHaveLength(0);

    const catalogCounts = [api.reads.directories.length, api.reads.models.length];
    const retryGate = { key: preferenceKey, snapshotOnStart: true, started: false, release: undefined as undefined | (() => void) };
    localStorage.holdGetItem = retryGate;
    tap(byTestId(tree, "retry-new-workspace-preference-read"));
    tree = renderRoute();
    flushEffects();
    await vi.waitFor(() => expect(retryGate.started).toBe(true));

    const dirtyPath = "/srv/principal-A/dirty-during-retry";
    (byTestId(tree, "workspace-path")?.props.onChangeText as (value: string) => void)(dirtyPath);
    tree = renderRoute();
    tap(byTestId(tree, "workspace-isolation-worktree"));
    tree = renderRoute();
    expect(byTestId(tree, "workspace-path")?.props.value).toBe(dirtyPath);
    expect([api.reads.directories.length, api.reads.models.length]).toEqual(catalogCounts);

    retryGate.release?.();
    await drainPromises();
    tree = commitRoute();
    expect(byTestId(tree, "workspace-path")?.props.value).toBe(dirtyPath);
    expect(byTestId(tree, "workspace-git-ref")).toBeDefined();
    expect(byTestId(tree, "new-workspace-preference-read-error")).toBeUndefined();
    expect([api.reads.directories.length, api.reads.models.length]).toEqual(catalogCounts);
  });

  it("does not let an older same-owner preference save failure replace a newer successful value", async () => {
    const profileA = profile("authorization-A", "token-A");
    const serverA = server("/srv/principal-A", "principal-A");
    const preferenceScope = newWorkspaceScope(profileA, serverA);
    const preferenceKey = (newWorkspacePreferenceApi as any).newWorkspacePreferenceKey(profileA.id, serverA.id, preferenceScope) as string;
    const savePreference = (newWorkspacePreferenceApi as any).saveNewWorkspacePreference as (
      profileId: string, serverId: string, scope: string, value: { cwd: string; isolation: "local" | "worktree" },
    ) => Promise<void>;
    const loadPreference = (newWorkspacePreferenceApi as any).loadNewWorkspacePreference as (
      profileId: string, serverId: string, scope: string,
    ) => Promise<{ cwd: string; isolation: "local" | "worktree" } | null>;
    const waitForPreferenceWrites = (newWorkspacePreferenceApi as any).waitForNewWorkspacePreferenceWrites as (
      profileId: string,
    ) => Promise<void>;
    seedSecureProfileMetadata(profileA);
    await savePreference(profileA.id, serverA.id, preferenceScope, { cwd: "/srv/principal-A/initial", isolation: "local" });
    localStorage.setItemAttempts.length = 0;
    host.app = appFor(profileA, serverA);
    let tree = commitRoute();
    const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
    const aModels = requestsFor(api.reads.models, profileA, serverA)[0];
    aDirectories.resolve([workspace("/srv/principal-A/initial", "initial"), workspace(serverA.workspacePath!, "root")]);
    aModels.resolve([model("provider-a::model-a", "A model")]);
    await drainPromises();
    tree = commitRoute();
    await drainPromises();
    expect(byTestId(tree, "workspace-path")?.props.value).toBe("/srv/principal-A/initial");
    // Let hydration's own default/restore save settle before the test holds a later user edit.
    await waitForPreferenceWrites(profileA.id);
    localStorage.setItemAttempts.length = 0;

    const writeGate = { requests: [] as Array<{ key: string; value: string; resolve: () => void; reject: (error?: Error) => void }> };
    localStorage.holdPreferenceWrites = writeGate;
    const olderPath = "/srv/principal-A/older-selection";
    (byTestId(tree, "workspace-path")?.props.onChangeText as (value: string) => void)(olderPath);
    tree = renderRoute();
    flushEffects();
    await vi.waitFor(() => expect(writeGate.requests).toHaveLength(1));
    expect(writeGate.requests[0]).toMatchObject({ key: preferenceKey });
    expect(JSON.parse(writeGate.requests[0].value)).toEqual({ cwd: olderPath, isolation: "local" });

    const newerPath = "/srv/principal-A/newer-selection";
    (byTestId(tree, "workspace-path")?.props.onChangeText as (value: string) => void)(newerPath);
    tree = renderRoute();
    flushEffects();
    await drainPromises();
    expect(writeGate.requests).toHaveLength(1);

    writeGate.requests[0].reject();
    await vi.waitFor(() => expect(writeGate.requests).toHaveLength(2));
    expect(JSON.parse(writeGate.requests[1].value)).toEqual({ cwd: newerPath, isolation: "local" });
    tree = commitRoute();
    expect(byTestId(tree, "new-workspace-preference-error")).toBeUndefined();
    writeGate.requests[1].resolve();
    await drainPromises();
    tree = commitRoute();
    expect(byTestId(tree, "workspace-path")?.props.value).toBe(newerPath);
    expect(byTestId(tree, "new-workspace-preference-error")).toBeUndefined();
    await expect(loadPreference(profileA.id, serverA.id, preferenceScope)).resolves.toEqual({ cwd: newerPath, isolation: "local" });
  });

  it("hides completed A catalog state on a same-ID B first render and submits only after B reads", async () => {
    const profileA = profile("authorization-A", "token-A");
    const serverA = server("/srv/principal-A", "principal-A");
    host.app = appFor(profileA, serverA);
    let tree = commitRoute();
    const readA = requestsFor(api.reads.directories, profileA, serverA)[0];
    const modelA = requestsFor(api.reads.models, profileA, serverA)[0];
    expect(readA).toBeDefined();
    expect(modelA).toBeDefined();
    readA.resolve([workspace("/srv/principal-A/private-project", "A private project")]);
    modelA.resolve([model("provider-a::private-model-a", "A private model")]);
    await drainPromises();
    tree = commitRoute();

    const prompt = byTestId(tree, "new-workspace-prompt");
    (prompt?.props.onChangeText as (value: string) => void)("inspect this project");
    tree = renderRoute();
    const projectA = byTestId(tree, "workspace-option-%2Fsrv%2Fprincipal-A%2Fprivate-project");
    expect(projectA).toBeDefined();
    tap(projectA);
    tree = renderRoute();
    expect(byTestId(tree, "workspace-path")?.props.value).toBe("/srv/principal-A/private-project");
    expect(textContent(tree)).toContain("A private model");

    const profileB = profile("authorization-B", "token-B");
    const serverB = server("/srv/principal-B", "principal-B", "admin");
    expect(threadListScopeKey(profileA, serverA)).not.toBe(threadListScopeKey(profileB, serverB));
    expect(workspaceStateAuthorizationScope(profileA, serverA)).not.toBe(workspaceStateAuthorizationScope(profileB, serverB));
    host.app = appFor(profileB, serverB);
    tree = renderRoute();

    // Same IDs can still denote another device authorization, principal, or target config.
    expect.soft(byTestId(tree, "workspace-option-%2Fsrv%2Fprincipal-A%2Fprivate-project")).toBeUndefined();
    expect.soft(byTestId(tree, "workspace-path")?.props.value).not.toBe("/srv/principal-A/private-project");
    expect.soft(textContent(tree)).not.toContain("A private model");
    expect.soft(byTestId(tree, "new-workspace-prompt")?.props.value).not.toBe("inspect this project");
    expect.soft(byTestId(tree, "create-workspace")?.props.disabled).toBe(true);
    tap(byTestId(tree, "create-workspace"));
    await drainPromises();
    expect.soft(api.creates).toHaveLength(0);
    expect.soft(api.creates.every((options: any) =>
      options.cwd !== "/srv/principal-A/private-project" && options.model !== "provider-a::private-model-a",
    )).toBe(true);

    flushEffects();
    tree = renderRoute();
    expect.soft(requestsFor(api.reads.directories, profileB, serverB).length).toBeGreaterThan(0);
    expect.soft(requestsFor(api.reads.models, profileB, serverB).length).toBeGreaterThan(0);
    expect.soft(byTestId(tree, "create-workspace")?.props.disabled).toBe(true);

    const readB = requestsFor(api.reads.directories, profileB, serverB)[0];
    const modelB = requestsFor(api.reads.models, profileB, serverB)[0];
    if (readB && modelB) {
      readB.resolve([workspace("/srv/principal-B/private-project", "B private project")]);
      modelB.resolve([model("provider-b::private-model-b", "B private model")]);
      await drainPromises();
      tree = commitRoute();
      expect(byTestId(tree, "workspace-path")?.props.value).toBe("/srv/principal-B");
      expect(byTestId(tree, "workspace-option-%2Fsrv%2Fprincipal-B%2Fprivate-project")).toBeDefined();
      expect(textContent(tree)).toContain("B private model");
      expect(byTestId(tree, "new-workspace-prompt")?.props.value).not.toBe("inspect this project");
      expect(byTestId(tree, "create-workspace")?.props.disabled).toBe(true);

      const promptB = byTestId(tree, "new-workspace-prompt");
      (promptB?.props.onChangeText as (value: string) => void)("inspect B project");
      tree = await waitForEnabledButton((current) => byTestId(current, "create-workspace"));
      expect(byTestId(tree, "create-workspace")?.props.disabled).toBe(false);

      (byTestId(tree, "create-workspace")?.props.onPress as () => void)();
      await vi.waitFor(() => expect(api.creates).toHaveLength(1));
      expect(api.creates).toHaveLength(1);
      expect(api.creates[0].profile).toBe(profileB);
      expect(api.creates[0].server).toBe(serverB);
      expect(api.creates[0].cwd).toBe("/srv/principal-B");
      expect(api.creates[0].model).toBe("provider-b::private-model-b");
      expect(api.creates[0].prompt).toBe("inspect B project");
    }
  });

  it("recovers from rejected current-scope catalogs only after explicit retry", async () => {
    const profileB = profile("authorization-B", "token-B");
    const serverB = server("/srv/principal-B", "principal-B", "admin");
    host.app = appFor(profileB, serverB);
    let tree = commitRoute();
    const firstDirectory = requestsFor(api.reads.directories, profileB, serverB)[0];
    const firstModel = requestsFor(api.reads.models, profileB, serverB)[0];
    expect(firstDirectory).toBeDefined();
    expect(firstModel).toBeDefined();

    firstDirectory.reject(new Error("directory catalog unavailable"));
    firstModel.reject(new Error("model catalog unavailable"));
    await drainPromises();
    tree = commitRoute();
    expect(byTestId(tree, "new-workspace-error")).toBeDefined();
    expect(byTestId(tree, "create-workspace")?.props.disabled).toBe(true);

    tap(byTestId(tree, "retry-new-workspace-catalogs"));
    tree = commitRoute();
    const retriedDirectory = requestsFor(api.reads.directories, profileB, serverB).at(-1);
    const retriedModel = requestsFor(api.reads.models, profileB, serverB).at(-1);
    expect(retriedDirectory).toBeDefined();
    expect(retriedModel).toBeDefined();
    expect(retriedDirectory).not.toBe(firstDirectory);
    expect(retriedModel).not.toBe(firstModel);

    retriedDirectory.resolve([workspace("/srv/principal-B/retry-project", "B retry project")]);
    retriedModel.resolve([model("provider-b::retry-model", "B retry model")]);
    await drainPromises();
    tree = commitRoute();
    expect(byTestId(tree, "new-workspace-error")).toBeUndefined();
    expect(byTestId(tree, "workspace-path")?.props.value).toBe("/srv/principal-B");
    expect(textContent(tree)).toContain("B retry model");

    const prompt = byTestId(tree, "new-workspace-prompt");
    (prompt?.props.onChangeText as (value: string) => void)("create after B retry");
    tree = await waitForEnabledButton((current) => byTestId(current, "create-workspace"));
    expect(byTestId(tree, "create-workspace")?.props.disabled).toBe(false);
    tap(byTestId(tree, "create-workspace"));
    await vi.waitFor(() => expect(api.creates).toHaveLength(1));
    expect(api.creates).toHaveLength(1);
    expect(api.creates[0].profile).toBe(profileB);
    expect(api.creates[0].server).toBe(serverB);
    expect(api.creates[0].cwd).toBe("/srv/principal-B");
    expect(api.creates[0].model).toBe("provider-b::retry-model");
    expect(api.creates[0].prompt).toBe("create after B retry");
  });

  it.each(["principal only", "authorization generation only"] as const)(
    "fences the same-ID form when only %s changes",
    async (changedIdentity) => {
      const profileA = profile("authorization-stable", "token-stable");
      const serverA = server("/srv/shared-root", "principal-A");
      const profileB = changedIdentity === "authorization generation only"
        ? { ...profileA, authorizationGeneration: "authorization-B" }
        : profileA;
      const serverB = changedIdentity === "principal only"
        ? { ...serverA, accountIdentity: { ...serverA.accountIdentity!, principalId: "principal-B" } }
        : serverA;

      if (changedIdentity === "principal only") {
        expect(profileB).toEqual(profileA);
        expect({ ...serverB, accountIdentity: serverA.accountIdentity }).toEqual(serverA);
      } else {
        expect(serverB).toBe(serverA);
        expect({ ...profileB, authorizationGeneration: profileA.authorizationGeneration }).toEqual(profileA);
      }
      expect(threadListScopeKey(profileA, serverA)).not.toBe(threadListScopeKey(profileB, serverB));
      expect(workspaceStateAuthorizationScope(profileA, serverA)).not.toBe(workspaceStateAuthorizationScope(profileB, serverB));

      host.app = appFor(profileA, serverA);
      let tree = commitRoute();
      const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
      const aModels = requestsFor(api.reads.models, profileA, serverA)[0];
      expect(aDirectories).toBeDefined();
      expect(aModels).toBeDefined();
      aDirectories.resolve([workspace("/srv/shared-root/private-A", "A only project")]);
      aModels.resolve([model("provider-a::only-A", "A only model")]);
      await drainPromises();
      tree = commitRoute();
      const promptA = byTestId(tree, "new-workspace-prompt");
      (promptA?.props.onChangeText as (value: string) => void)("A-only unsent intent");
      tap(byTestId(tree, "workspace-option-%2Fsrv%2Fshared-root%2Fprivate-A"));
      tree = renderRoute();
      expect(byTestId(tree, "workspace-path")?.props.value).toBe("/srv/shared-root/private-A");

      host.app = appFor(profileB, serverB);
      tree = renderRoute();
      expect.soft(byTestId(tree, "workspace-option-%2Fsrv%2Fshared-root%2Fprivate-A")).toBeUndefined();
      expect.soft(byTestId(tree, "workspace-path")?.props.value).not.toBe("/srv/shared-root/private-A");
      expect.soft(byTestId(tree, "new-workspace-prompt")?.props.value).not.toBe("A-only unsent intent");
      expect.soft(byTestId(tree, "create-workspace")?.props.disabled).toBe(true);
      tap(byTestId(tree, "create-workspace"));
      await drainPromises();
      expect.soft(api.creates).toHaveLength(0);

      flushEffects();
      const bDirectories = requestsFor(api.reads.directories, profileB, serverB);
      const bModels = requestsFor(api.reads.models, profileB, serverB);
      expect.soft(bDirectories.length).toBeGreaterThan(0);
      expect.soft(bModels.length).toBeGreaterThan(0);
      if (bDirectories[0] && bModels[0]) {
        bDirectories[0].resolve([workspace("/srv/shared-root/private-B", "B only project")]);
        bModels[0].resolve([model("provider-b::only-B", "B only model")]);
        await drainPromises();
        tree = commitRoute();
        expect(byTestId(tree, "workspace-option-%2Fsrv%2Fshared-root%2Fprivate-B")).toBeDefined();
        expect(textContent(tree)).toContain("B only model");
        expect(byTestId(tree, "new-workspace-prompt")?.props.value).not.toBe("A-only unsent intent");
        expect(byTestId(tree, "create-workspace")?.props.disabled).toBe(true);
      }
    },
  );

  it("keeps a shared A create runtime alive for a new A owner after A-to-B-to-A", async () => {
    const profileA = profile("authorization-A", "token-A");
    const serverA = server("/srv/principal-A", "principal-A");
    const replacements: unknown[] = [];
    host.router = { push: () => {}, replace: (value: unknown) => replacements.push(value), back: () => {} };
    host.app = appFor(profileA, serverA);
    let tree = commitRoute();
    const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
    const aModels = requestsFor(api.reads.models, profileA, serverA)[0];
    expect(aDirectories).toBeDefined();
    expect(aModels).toBeDefined();
    aDirectories.resolve([workspace("/srv/principal-A/project", "A project")]);
    aModels.resolve([model("provider-a::shared", "A shared model")]);
    await drainPromises();
    tree = commitRoute();

    (byTestId(tree, "new-workspace-prompt")?.props.onChangeText as (value: string) => void)("same A creation intent");
    tap(byTestId(tree, "workspace-isolation-worktree"));
    tree = await waitForEnabledButton((current) => byTestId(current, "create-workspace"));
    const pendingCreate = api.holdNextCreateResult();
    tap(byTestId(tree, "create-workspace"));
    // Worktree preparation uses scoped storage and profile-fence awaits before
    // the actual TaskRuntime producer is reached. Wait for that observable call.
    await vi.waitFor(() => expect(api.creates).toHaveLength(1));
    expect(api.creates).toHaveLength(1);
    expect(api.creates[0]).toMatchObject({
      profile: profileA,
      server: serverA,
      cwd: "/srv/principal-A/prepared",
      prompt: "same A creation intent",
      model: "provider-a::shared",
      managedWorktreeSourcePath: "/srv/principal-A",
    });

    const profileB = profile("authorization-B", "token-B");
    const serverB = server("/srv/principal-B", "principal-B", "admin");
    host.app = appFor(profileB, serverB);
    tree = renderRoute();
    flushEffects();

    // Returning to A creates a fresh form owner. The durable handoff exposes recovery;
    // it must reuse the pending same-intent TaskRuntime creation rather than dispatch again.
    host.app = appFor(profileA, serverA);
    tree = renderRoute();
    flushEffects();
    tree = renderRoute();
    const a2Directories = requestsFor(api.reads.directories, profileA, serverA).at(-1);
    const a2Models = requestsFor(api.reads.models, profileA, serverA).at(-1);
    expect(a2Directories).toBeDefined();
    expect(a2Models).toBeDefined();
    expect(a2Directories).not.toBe(aDirectories);
    expect(a2Models).not.toBe(aModels);
    a2Directories.resolve([workspace("/srv/principal-A/project", "A project")]);
    a2Models.resolve([model("provider-a::shared", "A shared model")]);
    await drainPromises();
    tree = await waitForEnabledButton((current) => byTestId(current, "recover-created-workspace-task"));
    expect(byTestId(tree, "create-workspace")?.props.disabled).toBe(true);
    tap(byTestId(tree, "recover-created-workspace-task"));
    await vi.waitFor(() => expect(api.creates).toHaveLength(2));

    expect(api.creates).toHaveLength(2);
    expect(api.createPromises).toHaveLength(2);
    expect(api.createPromises[1]).toBe(api.createPromises[0]);
    expect(api.creates[1]).toMatchObject({
      profile: profileA,
      server: serverA,
      cwd: "/srv/principal-A/prepared",
      prompt: "same A creation intent",
      model: "provider-a::shared",
      managedWorktreeSourcePath: "/srv/principal-A",
    });

    const sharedRuntime = {
      disposed: false,
      closeCount: 0,
      getSnapshot: () => ({ threadId: "shared-A-thread", title: "Shared A task" }),
      isDisposed() { return this.disposed; },
      close() {
        this.disposed = true;
        this.closeCount += 1;
      },
    };
    pendingCreate.resolve(sharedRuntime);
    await vi.waitFor(() => expect(replacements).toHaveLength(1));

    expect(api.registryPuts).toHaveLength(1);
    expect(api.registryPuts[0][2]).toBe(sharedRuntime);
    expect(sharedRuntime.disposed).toBe(false);
    expect(sharedRuntime.closeCount).toBe(0);
    expect(api.acknowledgements).toHaveLength(1);
    expect(api.acknowledgements[0]).toEqual([profileA, serverA, "/srv/principal-A", "worktree"]);
    expect(replacements).toHaveLength(1);
    expect(replacements[0]).toMatchObject({
      pathname: "/h/[profileId]/task/[serverId]/[threadId]",
      params: { profileId: profileA.id, serverId: serverA.id, threadId: "shared-A-thread" },
    });
  });

  it("closes a held creation result after every form owner goes stale", async () => {
    const profileA = profile("authorization-A", "token-A");
    const serverA = server("/srv/principal-A", "principal-A");
    const replacements: unknown[] = [];
    host.router = { push: () => {}, replace: (value: unknown) => replacements.push(value), back: () => {} };
    host.app = appFor(profileA, serverA);
    let tree = commitRoute();
    const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
    const aModels = requestsFor(api.reads.models, profileA, serverA)[0];
    aDirectories.resolve([workspace("/srv/principal-A/project", "A project")]);
    aModels.resolve([model("provider-a::model-a", "A model")]);
    await drainPromises();
    tree = commitRoute();
    (byTestId(tree, "new-workspace-prompt")?.props.onChangeText as (value: string) => void)("A pending creation");
    tree = await waitForEnabledButton((current) => byTestId(current, "create-workspace"));

    const pendingCreate = api.holdNextCreateResult();
    tap(byTestId(tree, "create-workspace"));
    await vi.waitFor(() => expect(api.creates).toHaveLength(1));

    const profileB = profile("authorization-B", "token-B");
    const serverB = server("/srv/principal-B", "principal-B", "admin");
    host.app = appFor(profileB, serverB);
    renderRoute();
    flushEffects();

    const staleRuntime = {
      disposed: false,
      closeCount: 0,
      getSnapshot: () => ({ threadId: "stale-A-thread", title: "Stale A task" }),
      isDisposed() { return this.disposed; },
      close() {
        this.disposed = true;
        this.closeCount += 1;
      },
    };
    pendingCreate.resolve(staleRuntime);
    await drainPromises();

    expect(staleRuntime.disposed).toBe(true);
    expect(staleRuntime.closeCount).toBe(1);
    expect(api.registryPuts).toHaveLength(0);
    expect(api.acknowledgements).toHaveLength(0);
    expect(replacements).toHaveLength(0);
  });

  it("keeps the captured authorization-expiry callback usable after route unmount", async () => {
    const profileA = profile("authorization-A", "token-A");
    const serverA = server("/srv/principal-A", "principal-A");
    const markReauthorization = vi.fn();
    const replacements: unknown[] = [];
    host.router = { push: () => {}, replace: (value: unknown) => replacements.push(value), back: () => {} };
    host.app = {
      ...appFor(profileA, serverA),
      markGatewayReauthorizationRequired: markReauthorization,
    };
    let tree = commitRoute();
    const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
    const aModels = requestsFor(api.reads.models, profileA, serverA)[0];
    aDirectories.resolve([workspace("/srv/principal-A/project", "A project")]);
    aModels.resolve([model("provider-a::model-a", "A model")]);
    await drainPromises();
    tree = commitRoute();
    (byTestId(tree, "new-workspace-prompt")?.props.onChangeText as (value: string) => void)("create before route exit");
    tree = await waitForEnabledButton((current) => byTestId(current, "create-workspace"));
    tap(byTestId(tree, "create-workspace"));
    await vi.waitFor(() => expect(api.creates).toHaveLength(1));
    await vi.waitFor(() => expect(replacements).toHaveLength(1));
    expect(api.creates).toHaveLength(1);
    expect(replacements).toHaveLength(1);
    expect(markReauthorization).not.toHaveBeenCalled();

    // Unmount all route effects before delivering the TaskRuntime callback.
    resetHost();
    (api.creates[0].onSessionExpired as () => void)();

    expect(markReauthorization).toHaveBeenCalledTimes(1);
    expect(markReauthorization).toHaveBeenCalledWith(profileA.id, profileAuthorizationScopeKey(profileA));
  });

  it("acknowledges and navigates after real registry commit despite previous-runtime cleanup failure", async () => {
    const profileA = profile("authorization-A", "token-A");
    const serverA = server("/srv/principal-A", "principal-A");
    const registry = new TaskRuntimeRegistry();
    let previousCloseCalls = 0;
    const previousRuntime = {
      disposed: false,
      getSnapshot: () => ({ threadId: "created-thread", running: false, interaction: null }),
      isDisposed() { return this.disposed; },
      hasLiveTerminalSessions: () => false,
      close() {
        previousCloseCalls += 1;
        if (previousCloseCalls === 1) throw new Error("previous runtime cleanup failed");
        this.disposed = true;
      },
    };
    registry.put(profileA.id, serverA.id, previousRuntime as never);
    api.setRegistryTarget(registry);

    const replacements: unknown[] = [];
    host.router = { push: () => {}, replace: (value: unknown) => replacements.push(value), back: () => {} };
    host.app = appFor(profileA, serverA);
    let tree = commitRoute();
    const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
    const aModels = requestsFor(api.reads.models, profileA, serverA)[0];
    aDirectories.resolve([workspace("/srv/principal-A/project", "A project")]);
    aModels.resolve([model("provider-a::model-a", "A model")]);
    await drainPromises();
    tree = commitRoute();
    (byTestId(tree, "new-workspace-prompt")?.props.onChangeText as (value: string) => void)("create with pending cleanup");
    tap(byTestId(tree, "workspace-isolation-worktree"));
    tree = await waitForEnabledButton((current) => byTestId(current, "create-workspace"));
    tap(byTestId(tree, "create-workspace"));
    await vi.waitFor(() => expect(api.creates).toHaveLength(1));

    const createdRuntime = await api.createPromises[0];
    await vi.waitFor(() => expect(replacements).toHaveLength(1));
    tree = renderRoute();
    expect(api.creates).toHaveLength(1);
    expect(registry.get(profileA.id, serverA.id, "created-thread")).toBe(createdRuntime);
    expect((createdRuntime as any).isDisposed()).toBe(false);
    expect(registry.getPendingCleanupCount()).toBe(1);
    expect(previousCloseCalls).toBe(1);
    expect(byTestId(tree, "new-workspace-error")).toBeUndefined();
    expect(api.acknowledgements).toHaveLength(1);
    expect(api.acknowledgements[0]).toEqual([profileA, serverA, "/srv/principal-A", "worktree"]);
    expect(replacements).toHaveLength(1);
    expect(replacements[0]).toMatchObject({
      pathname: "/h/[profileId]/task/[serverId]/[threadId]",
      params: { profileId: profileA.id, serverId: serverA.id, threadId: "created-thread" },
    });

    registry.retryCleanup();
    expect(previousCloseCalls).toBe(2);
    expect(previousRuntime.disposed).toBe(true);
    expect(registry.getPendingCleanupCount()).toBe(0);
    registry.remove(profileA.id, serverA.id, "created-thread");
  });

  it("keeps the adopted task and lets the bookkeeping consumer retry the exact receipt after two ACK write failures", async () => {
    const profileA = profile("authorization-A", "token-A");
    const serverA = server("/srv/principal-A", "principal-A");
    const replacements: unknown[] = [];
    host.router = { push: () => {}, replace: (value: unknown) => replacements.push(value), back: () => {} };
    host.app = appFor(profileA, serverA);
    let tree = commitRoute();
    const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
    const aModels = requestsFor(api.reads.models, profileA, serverA)[0];
    aDirectories.resolve([workspace("/srv/principal-A/project", "A project")]);
    aModels.resolve([model("provider-a::model-a", "A model")]);
    await drainPromises();
    tree = commitRoute();

    (byTestId(tree, "new-workspace-prompt")?.props.onChangeText as (value: string) => void)("create despite receipt ACK storage failure");
    tap(byTestId(tree, "workspace-isolation-worktree"));
    tree = await waitForEnabledButton((current) => byTestId(current, "create-workspace"));
    // Only consumed-record writes fail; the actual pending operation still persists its ID and result.
    localStorage.failConsumedWrites = 2;
    tap(byTestId(tree, "create-workspace"));
    await vi.waitFor(() => expect(api.receiptAcknowledgements).toHaveLength(1));
    const persisted = workspaceOperationRecord(profileA, serverA, "/srv/principal-A", "worktree");
    expect(persisted).not.toBeNull();
    if (!persisted) throw new Error("V2 workspace operation record was not persisted");
    const { key: receiptKey, record: retainedReceipt } = persisted;
    await vi.waitFor(() => expect(localStorage.setItemAttempts.filter((entry) =>
      entry.key === receiptKey && JSON.parse(entry.value).consumed === true,
    )).toHaveLength(2));
    await vi.waitFor(() => expect(replacements).toHaveLength(1));
    tree = commitRoute();

    expect(retainedReceipt).toMatchObject({ version: 2, kind: "worktree", path: "/srv/principal-A", result: "/srv/principal-A/prepared" });
    expect(retainedReceipt.phases.map((phase: any) => [phase.method, phase.id, phase.result, phase.dispatched])).toEqual([
      ["runtime.workspaces.openV2", `${retainedReceipt.id}:source`, "/srv/principal-A", true],
      ["runtime.worktrees.prepareV2", retainedReceipt.id, "/srv/principal-A/prepared", true],
    ]);
    expect(retainedReceipt.consumed).not.toBe(true);
    expect(api.workspaceMutations).toHaveLength(1);
    expect(api.workspaceMutations[0]).toMatchObject({
      profile: profileA,
      server: serverA,
      path: "/srv/principal-A",
      kind: "worktree",
      id: retainedReceipt.id,
    });
    expect(api.workspaceCapabilities.some((entry: any) => entry.capability === WORKSPACE_RECEIPTS_V2)).toBe(true);
    expect(api.workspaceRpcRequests.filter((entry: any) => entry.method === WORKSPACE_SCOPE_V2).length).toBeGreaterThanOrEqual(2);
    expect(api.workspaceRpcRequests.filter((request: any) => request.method === "runtime.workspaces.openV2" || request.method === "runtime.worktrees.prepareV2").map((request: any) => [request.method, request.params.clientRequestId])).toEqual([
      ["runtime.workspaces.openV2", `${retainedReceipt.id}:source`],
      ["runtime.worktrees.prepareV2", retainedReceipt.id],
    ]);
    expect(api.creates).toHaveLength(1);
    expect(api.createPromises).toHaveLength(1);
    expect(api.registryPuts).toHaveLength(1);
    expect(api.getRegistryTarget().get(profileA.id, serverA.id, "created-thread")).toBe(await api.createPromises[0]);
    expect(byTestId(tree, "new-workspace-error")).toBeUndefined();
    expect(replacements).toHaveLength(1);
    expect(replacements[0]).toMatchObject({
      pathname: "/h/[profileId]/task/[serverId]/[threadId]",
      params: {
        profileId: profileA.id,
        serverId: serverA.id,
        threadId: "created-thread",
        cwd: `${serverA.workspacePath}/prepared`,
        workspaceBookkeeping: "pending",
        operationReceiptId: retainedReceipt.id,
        operationKind: "worktree",
        operationSourcePath: serverA.workspacePath,
      },
    });

    // The real local-only consumer loads the exact receipt passed by the route.
    const taskRoute = replacements[0] as { params: Record<string, unknown> };
    const firstReceiptLoad = api.receiptLoads.length;
    tree = renderBookkeepingConsumer(profileA, serverA, `${serverA.workspacePath}/prepared`, taskRoute.params);
    await vi.waitFor(() => expect(api.receiptLoads.slice(firstReceiptLoad).some(({ result }: any) =>
      result?.id === retainedReceipt.id && result.consumed !== true,
    )).toBe(true));
    tree = commitRoute();
    expect(byTestId(tree, "workspace-bookkeeping")).toBeDefined();
    expect(textContent(tree)).toContain(t("workspace_bookkeeping.ready_retry"));
    localStorage.failConsumedWrites = 0;
    tap(byTestId(tree, "retry-workspace-bookkeeping"));
    await vi.waitFor(() => expect(localStorage.setItemAttempts.filter((entry) =>
      entry.key === receiptKey && JSON.parse(entry.value).consumed === true,
    )).toHaveLength(3));
    await vi.waitFor(() => {
      tree = commitRoute();
      expect(byTestId(tree, "workspace-bookkeeping")).toBeUndefined();
    });
    expect(api.workspaceMutations).toHaveLength(1);
    expect(JSON.parse(localStorage.values.get(receiptKey)!).id).toBe(retainedReceipt.id);
    expect(JSON.parse(localStorage.values.get(receiptKey)!)).toMatchObject({ id: retainedReceipt.id, consumed: true });
    expect(api.receiptAcknowledgements).toHaveLength(2);
    expect(api.receiptAcknowledgements.map((receipt: any) => receipt.id)).toEqual(Array(2).fill(retainedReceipt.id));
    expect(api.creates).toHaveLength(1);
    expect(replacements).toHaveLength(1);

    // Reloading the same locator for a consumed receipt hides the pending prompt.
    const consumedReceiptLoad = api.receiptLoads.length;
    tree = renderBookkeepingConsumer(profileA, serverA, `${serverA.workspacePath}/prepared`, taskRoute.params);
    await vi.waitFor(() => expect(api.receiptLoads.slice(consumedReceiptLoad).some(({ result }: any) =>
      result?.id === retainedReceipt.id && result.consumed === true,
    )).toBe(true));
    tree = commitRoute();
    expect(byTestId(tree, "workspace-bookkeeping")).toBeUndefined();
  });

  it("rejects the route creation claim before calling the producer when cleanup reservations are full", async () => {
    const profileA = profile("authorization-A", "token-A");
    const serverA = server("/srv/principal-A", "principal-A");
    const registry = new TaskRuntimeRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    api.setRegistryTarget(registry);

    try {
      for (let index = 0; index < 32; index += 1) {
        const threadId = `pending-cleanup-${index}`;
        const previousRuntime = {
          disposed: false,
          getSnapshot: () => ({ threadId, running: true, interaction: null }),
          isDisposed() { return this.disposed; },
          hasLiveTerminalSessions: () => false,
          close() { throw new Error("pending cleanup remains unavailable"); },
        };
        const replacementRuntime = {
          disposed: false,
          getSnapshot: () => ({ threadId, running: true, interaction: null }),
          isDisposed() { return this.disposed; },
          hasLiveTerminalSessions: () => false,
          close() { this.disposed = true; },
        };
        registry.put(profileA.id, serverA.id, previousRuntime as never);
        registry.put(profileA.id, serverA.id, replacementRuntime as never, () => {});
      }
      expect(registry.getPendingCleanupCount()).toBe(32);

      const replacements: unknown[] = [];
      host.router = { push: () => {}, replace: (value: unknown) => replacements.push(value), back: () => {} };
      host.app = appFor(profileA, serverA);
      let tree = commitRoute();
      const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
      const aModels = requestsFor(api.reads.models, profileA, serverA)[0];
      aDirectories.resolve([workspace("/srv/principal-A/project", "A project")]);
      aModels.resolve([model("provider-a::model-a", "A model")]);
      await drainPromises();
      tree = commitRoute();
      (byTestId(tree, "new-workspace-prompt")?.props.onChangeText as (value: string) => void)("blocked before creation");
      tree = await waitForEnabledButton((current) => byTestId(current, "create-workspace"));
      tap(byTestId(tree, "create-workspace"));
      await vi.waitFor(() => expect(byTestId(commitRoute(), "new-workspace-error")).toBeDefined());
      tree = renderRoute();

      expect(registry.getPendingCleanupCount()).toBe(32);
      expect(api.creates).toHaveLength(0);
      expect(api.createPromises).toHaveLength(0);
      expect(api.registryPuts).toHaveLength(0);
      expect(api.acknowledgements).toHaveLength(0);
      expect(replacements).toHaveLength(0);
      expect(byTestId(tree, "new-workspace-error")).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("ignores an A TextInput handler captured before B became current", async () => {
    const profileA = profile("authorization-A", "token-A");
    const serverA = server("/srv/principal-A", "principal-A");
    host.app = appFor(profileA, serverA);
    let tree = commitRoute();
    const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
    const aModels = requestsFor(api.reads.models, profileA, serverA)[0];
    aDirectories.resolve([workspace("/srv/principal-A/project", "A project")]);
    aModels.resolve([model("provider-a::model-a", "A model")]);
    await drainPromises();
    tree = commitRoute();
    const aPrompt = byTestId(tree, "new-workspace-prompt");
    const capturedAInput = aPrompt?.props.onChangeText as (value: string) => void;
    capturedAInput("A private draft");
    tree = renderRoute();

    const profileB = profile("authorization-B", "token-B");
    const serverB = server("/srv/principal-B", "principal-B", "admin");
    host.app = appFor(profileB, serverB);
    tree = renderRoute();
    flushEffects();
    const bDirectories = requestsFor(api.reads.directories, profileB, serverB)[0];
    const bModels = requestsFor(api.reads.models, profileB, serverB)[0];
    expect(bDirectories).toBeDefined();
    expect(bModels).toBeDefined();
    bDirectories.resolve([workspace("/srv/principal-B/project", "B project")]);
    bModels.resolve([model("provider-b::model-b", "B model")]);
    await drainPromises();
    tree = commitRoute();

    const bPrompt = byTestId(tree, "new-workspace-prompt");
    expect(bPrompt?.props.value).toBe("");
    (bPrompt?.props.onChangeText as (value: string) => void)("B private draft");
    tree = renderRoute();
    capturedAInput("late A input event");
    tree = renderRoute();
    expect(byTestId(tree, "new-workspace-prompt")?.props.value).toBe("B private draft");
  });

  it("binds routed cwd only after its profile is active and never reuses it in another target scope", async () => {
    const profileA = profile("authorization-A", "token-A", "profile-A");
    const profileWaiting = profile("authorization-wait", "token-wait", "profile-wait");
    const serverA = server("/srv/principal-A", "principal-A");
    const serverWaiting = server("/srv/waiting-profile", "waiting-principal");
    host.params = { profileId: profileWaiting.id, serverId: serverWaiting.id };
    host.app = { ...appFor(profileWaiting, serverWaiting), profiles: [profileWaiting, profileA] };
    commitRoute();

    // Change the real route params while AppContext still exposes the other profile.
    host.params = { profileId: profileA.id, serverId: serverA.id, cwd: "/srv/principal-A/from-route" };
    let tree = renderRoute();
    expect(byTestId(tree, "workspace-path")?.props.value).not.toBe("/srv/principal-A/from-route");
    flushEffects();
    tree = renderRoute();
    expect(byTestId(tree, "workspace-path")?.props.value).not.toBe("/srv/principal-A/from-route");

    host.app = { ...appFor(profileA, serverA), profiles: [profileA, profileWaiting] };
    tree = commitRoute();
    const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
    const aModels = requestsFor(api.reads.models, profileA, serverA)[0];
    expect(aDirectories).toBeDefined();
    expect(aModels).toBeDefined();
    aDirectories.resolve([workspace("/srv/principal-A/from-route", "A routed project")]);
    aModels.resolve([model("provider-a::route-model", "A route model")]);
    await drainPromises();
    tree = commitRoute();
    expect(byTestId(tree, "workspace-path")?.props.value).toBe("/srv/principal-A/from-route");

    // Keep the route params identical while the same profile ID now has B authorization and target scope.
    const profileB = profile("authorization-B", "token-B", profileA.id);
    const serverB = server("/srv/principal-B", "principal-B", "admin");
    host.app = { ...appFor(profileB, serverB), profiles: [profileB, profileWaiting] };
    tree = renderRoute();
    expect(byTestId(tree, "workspace-path")?.props.value).not.toBe("/srv/principal-A/from-route");
    flushEffects();
    tree = renderRoute();
    const bDirectories = requestsFor(api.reads.directories, profileB, serverB)[0];
    const bModels = requestsFor(api.reads.models, profileB, serverB)[0];
    expect(bDirectories).toBeDefined();
    expect(bModels).toBeDefined();
    bDirectories.resolve([workspace("/srv/principal-B/project", "B project")]);
    bModels.resolve([model("provider-b::route-model", "B route model")]);
    await drainPromises();
    tree = commitRoute();
    expect(byTestId(tree, "workspace-path")?.props.value).toBe("/srv/principal-B");
    expect(byTestId(tree, "workspace-path")?.props.value).not.toBe("/srv/principal-A/from-route");
  });

  it("does not publish late A or B catalogs across A to B to A; token renewal keeps A scope", async () => {
    const profileA = profile("authorization-A", "token-A1");
    const serverA = server("/srv/principal-A", "principal-A");
    host.app = appFor(profileA, serverA);
    commitRoute();
    const a1Directories = requestsFor(api.reads.directories, profileA, serverA)[0];
    const a1Models = requestsFor(api.reads.models, profileA, serverA)[0];
    expect(a1Directories).toBeDefined();
    expect(a1Models).toBeDefined();

    const profileB = profile("authorization-B", "token-B");
    const serverB = server("/srv/principal-B", "principal-B", "admin");
    host.app = appFor(profileB, serverB);
    let tree = renderRoute();
    expect.soft(byTestId(tree, "workspace-option-%2Fsrv%2Fprincipal-A%2Fprivate-project")).toBeUndefined();
    flushEffects();
    const bDirectories = requestsFor(api.reads.directories, profileB, serverB);
    const bModels = requestsFor(api.reads.models, profileB, serverB);
    expect.soft(bDirectories.length).toBeGreaterThan(0);
    expect.soft(bModels.length).toBeGreaterThan(0);

    // Complete A after the route has already rendered B. The old cleanup must fence publication.
    a1Directories.resolve([workspace("/srv/principal-A/late", "late A project")]);
    a1Models.resolve([model("provider-a::late-model", "late A model")]);
    await drainPromises();
    tree = renderRoute();
    expect.soft(byTestId(tree, "workspace-option-%2Fsrv%2Fprincipal-A%2Flate")).toBeUndefined();
    expect.soft(textContent(tree)).not.toContain("late A model");

    // Return to A while B's requests are still held, then deliver B late.
    const profileA2 = profile("authorization-A", "token-A2");
    expect(threadListScopeKey(profileA, serverA)).toBe(threadListScopeKey(profileA2, serverA));
    expect(workspaceStateAuthorizationScope(profileA, serverA)).toBe(workspaceStateAuthorizationScope(profileA2, serverA));
    host.app = appFor(profileA2, serverA);
    tree = renderRoute();
    flushEffects();
    const a2Directories = requestsFor(api.reads.directories, profileA2, serverA).at(-1);
    const a2Models = requestsFor(api.reads.models, profileA2, serverA).at(-1);
    expect.soft(a2Directories).toBeDefined();
    expect.soft(a2Models).toBeDefined();
    for (const entry of bDirectories) entry.resolve([workspace("/srv/principal-B/late", "late B project")]);
    for (const entry of bModels) entry.resolve([model("provider-b::late-model", "late B model")]);
    await drainPromises();
    tree = renderRoute();
    expect.soft(byTestId(tree, "workspace-option-%2Fsrv%2Fprincipal-B%2Flate")).toBeUndefined();
    expect.soft(textContent(tree)).not.toContain("late B model");

    if (a2Directories && a2Models) {
      a2Directories.resolve([workspace("/srv/principal-A/current", "current A project")]);
      a2Models.resolve([model("provider-a::current-model", "current A model")]);
      await drainPromises();
      tree = commitRoute();
      expect(byTestId(tree, "workspace-option-%2Fsrv%2Fprincipal-A%2Fcurrent")).toBeDefined();
      expect(textContent(tree)).toContain("current A model");
    }

    const countsBeforeRenewal = [api.reads.directories.length, api.reads.models.length];
    const renewedProfileA = profile("authorization-A", "token-A3");
    expect(threadListScopeKey(profileA, serverA)).toBe(threadListScopeKey(renewedProfileA, serverA));
    expect(workspaceStateAuthorizationScope(profileA, serverA)).toBe(workspaceStateAuthorizationScope(renewedProfileA, serverA));
    host.app = appFor(renewedProfileA, serverA);
    tree = renderRoute();
    flushEffects();
    tree = renderRoute();
    expect([api.reads.directories.length, api.reads.models.length]).toEqual(countsBeforeRenewal);
    expect(textContent(tree)).toContain("current A model");
  });
});

describe("open project route scope", () => {
  beforeEach(() => {
    host.route = OpenProjectRoute;
    host.params = { profileId: "profile-1" };
  });

  it("a late A archive preview cannot become a B confirmation or dispatch through B", async () => {
    const profileA = profile("authorization-A", "token-A");
    const serverA = server("/srv/principal-A", "principal-A");
    host.app = appFor(profileA, serverA);
    let tree = commitRoute();
    const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
    const aWorktrees = requestsFor(api.reads.worktrees, profileA, serverA)[0];
    expect(aDirectories).toBeDefined();
    expect(aWorktrees).toBeDefined();
    const worktreeA = activeWorktree("worktree-A", "/srv/principal-A/wt");
    aDirectories.resolve([workspace("/srv/principal-A/project", "A project")]);
    aWorktrees.resolve([worktreeA]);
    await drainPromises();
    tree = commitRoute();

    const archiveButton = byTestId(tree, "archive-worktree-worktree-A");
    expect(archiveButton).toBeDefined();
    (archiveButton?.props.onPress as () => void)();
    const previewARequest = requestsFor(api.reads.previews, profileA, serverA)[0];
    expect(previewARequest).toBeDefined();

    const profileB = profile("authorization-B", "token-B");
    const serverB = server("/srv/principal-B", "principal-B", "admin");
    host.app = appFor(profileB, serverB);
    tree = renderRoute();
    expect.soft(byTestId(tree, "managed-worktree-worktree-A")).toBeUndefined();
    expect.soft(byTestId(tree, "archive-worktree-confirmation")).toBeUndefined();
    flushEffects();

    // The A preview resolves after the form has switched to B.
    previewARequest.resolve(archivePreview(worktreeA.path));
    await drainPromises();
    tree = renderRoute();
    expect.soft(byTestId(tree, "archive-worktree-confirmation")).toBeUndefined();
    const leakedBConfirmation = byTestId(tree, "confirm-archive-worktree");
    if (leakedBConfirmation) (leakedBConfirmation.props.onPress as () => void)();
    await drainPromises();
    expect(requestsFor(api.archives, profileB, serverB)).toHaveLength(0);
  });

  it("a captured confirmation for A cannot be reused after the same IDs move to B", async () => {
    const profileA = profile("authorization-A", "token-A");
    const serverA = server("/srv/principal-A", "principal-A");
    host.app = appFor(profileA, serverA);
    let tree = commitRoute();
    const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
    const aWorktrees = requestsFor(api.reads.worktrees, profileA, serverA)[0];
    expect(aDirectories).toBeDefined();
    expect(aWorktrees).toBeDefined();
    const worktreeA = activeWorktree("captured-A", "/srv/principal-A/captured");
    aDirectories.resolve([workspace("/srv/principal-A/project", "A project")]);
    aWorktrees.resolve([worktreeA]);
    await drainPromises();
    tree = commitRoute();

    (byTestId(tree, "archive-worktree-captured-A")?.props.onPress as () => void)();
    const preview = requestsFor(api.reads.previews, profileA, serverA)[0];
    expect(preview).toBeDefined();
    preview.resolve(archivePreview(worktreeA.path));
    await drainPromises();
    tree = renderRoute();
    const capturedConfirm = byTestId(tree, "confirm-archive-worktree");
    expect(capturedConfirm).toBeDefined();
    const capturedHandler = capturedConfirm?.props.onPress as () => void;

    const profileB = profile("authorization-B", "token-B");
    const serverB = server("/srv/principal-B", "principal-B", "admin");
    host.app = appFor(profileB, serverB);
    tree = renderRoute();
    expect.soft(byTestId(tree, "archive-worktree-confirmation")).toBeUndefined();
    flushEffects();

    // Invoke the handler captured from the old real JSX after B is current.
    capturedHandler();
    await drainPromises();
    expect(requestsFor(api.archives, profileB, serverB)).toHaveLength(0);
    expect(api.archives).toHaveLength(0);
  });

  it.each([
    { mode: "open", label: "open_project.select_existing_directory", receiptKind: "open" as const, actionLabel: "open_project.open_project" },
    { mode: "create", label: "open_project.create_directory", receiptKind: "create" as const, actionLabel: "open_project.create_and_open" },
    { mode: "worktree", label: "open_project.create_git_worktree", receiptKind: "worktree" as const, actionLabel: "open_project.create_worktree_action" },
  ])("continues to /new after $mode receipt ACK write failures and retries only the exact local receipt", async ({ mode, label, receiptKind, actionLabel }) => {
    const profileA = profile("authorization-A", "token-A");
    const serverA = server("/srv/principal-A", "principal-A");
    const replacements: unknown[] = [];
    host.router = { push: () => {}, replace: (value: unknown) => replacements.push(value), back: () => {} };
    host.app = appFor(profileA, serverA);
    let tree = commitRoute();
    const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
    const aWorktrees = requestsFor(api.reads.worktrees, profileA, serverA)[0];
    expect(aDirectories).toBeDefined();
    expect(aWorktrees).toBeDefined();
    aDirectories.resolve([workspace("/srv/principal-A/project", "A project")]);
    aWorktrees.resolve([]);
    await drainPromises();
    tree = commitRoute();
    if (mode !== "open") {
      tap(pressableWithText(tree, t(label)));
      tree = renderRoute();
    }

    const path = "/srv/principal-A";
    tree = await waitForEnabledButton((current) => buttonWithText(current, t(actionLabel)));
    localStorage.failConsumedWrites = 2;
    tap(buttonWithText(tree, t(actionLabel)));
    await vi.waitFor(() => expect(api.receiptAcknowledgements).toHaveLength(1));
    const persisted = workspaceOperationRecord(profileA, serverA, path, receiptKind);
    expect(persisted).not.toBeNull();
    if (!persisted) throw new Error("V2 workspace operation record was not persisted");
    const { key: receiptKey, record: retainedReceipt } = persisted;
    await vi.waitFor(() => expect(localStorage.setItemAttempts.filter((entry) =>
      entry.key === receiptKey && JSON.parse(entry.value).consumed === true,
    )).toHaveLength(2));
    await vi.waitFor(() => expect(replacements).toHaveLength(1));
    tree = commitRoute();

    expect(retainedReceipt).toMatchObject({
      version: 2,
      kind: receiptKind,
      path,
      result: receiptKind === "worktree" ? path + "/prepared" : path,
    });
    expect(retainedReceipt.phases.every((phase: any) => phase.dispatched)).toBe(true);
    expect(retainedReceipt.consumed).not.toBe(true);
    expect(api.workspaceMutations).toHaveLength(1);
    expect(api.workspaceMutations[0]).toMatchObject({ profile: profileA, server: serverA, path, kind: receiptKind, id: retainedReceipt.id });
    expect(api.workspaceMutations.map((entry: any) => entry.kind)).toEqual([receiptKind]);
    expect(api.workspaceCapabilities.some((entry: any) => entry.capability === WORKSPACE_RECEIPTS_V2)).toBe(true);
    expect(api.workspaceRpcRequests.filter((entry: any) => entry.method === WORKSPACE_SCOPE_V2).length).toBeGreaterThanOrEqual(2);
    const operationFrames = api.workspaceRpcRequests.filter((request: any) =>
      ["runtime.workspaces.openV2", "runtime.workspaces.prepareV2", "runtime.worktrees.prepareV2"].includes(request.method),
    );
    expect(operationFrames.map((request: any) => [request.method, request.params.clientRequestId])).toEqual(
      receiptKind === "worktree"
        ? [["runtime.workspaces.openV2", retainedReceipt.id + ":source"], ["runtime.worktrees.prepareV2", retainedReceipt.id]]
        : [[receiptKind === "create" ? "runtime.workspaces.prepareV2" : "runtime.workspaces.openV2", retainedReceipt.id]],
    );
    expect(replacements).toHaveLength(1);
    expect(replacements[0]).toMatchObject({
      pathname: "/new",
      params: {
        profileId: profileA.id,
        serverId: serverA.id,
        cwd: receiptKind === "worktree" ? `${path}/prepared` : path,
        workspaceBookkeeping: "pending",
        operationReceiptId: retainedReceipt.id,
        operationKind: receiptKind,
        operationSourcePath: path,
      },
    });
    expect(byTestId(tree, "open-project-error")).toBeUndefined();

    // The actual local bookkeeping JSX retries only the receipt passed by /new.
    const newRoute = replacements[0] as { params: Record<string, unknown> };
    const resultPath = receiptKind === "worktree" ? `${path}/prepared` : path;
    const consumerProps = newRouteBookkeepingProps(profileA, serverA, newRoute.params);
    expect(consumerProps).toMatchObject({ expectedResult: resultPath, enabled: true });
    const firstReceiptLoad = api.receiptLoads.length;
    tree = renderBookkeepingConsumer(profileA, serverA, consumerProps.expectedResult as string, newRoute.params);
    await vi.waitFor(() => expect(api.receiptLoads.slice(firstReceiptLoad).some(({ result }: any) =>
      result?.id === retainedReceipt.id && result.consumed !== true,
    )).toBe(true));
    tree = commitRoute();
    expect(byTestId(tree, "workspace-bookkeeping")).toBeDefined();
    expect(textContent(tree)).toContain(t("workspace_bookkeeping.ready_retry"));
    localStorage.failConsumedWrites = 0;
    tap(byTestId(tree, "retry-workspace-bookkeeping"));
    await vi.waitFor(() => expect(localStorage.setItemAttempts.filter((entry) =>
      entry.key === receiptKey && JSON.parse(entry.value).consumed === true,
    )).toHaveLength(3));
    await vi.waitFor(() => {
      tree = commitRoute();
      expect(byTestId(tree, "workspace-bookkeeping")).toBeUndefined();
    });
    expect(api.workspaceMutations).toHaveLength(1);
    expect(JSON.parse(localStorage.values.get(receiptKey)!).id).toBe(retainedReceipt.id);
    expect(JSON.parse(localStorage.values.get(receiptKey)!)).toMatchObject({ id: retainedReceipt.id, consumed: true });
    expect(api.receiptAcknowledgements).toHaveLength(2);
    expect(api.receiptAcknowledgements.map((receipt: any) => receipt.id)).toEqual(Array(2).fill(retainedReceipt.id));
    expect(replacements).toHaveLength(1);

    // A reloaded consumed locator is no longer presented as pending bookkeeping.
    const consumedReceiptLoad = api.receiptLoads.length;
    tree = renderBookkeepingConsumer(profileA, serverA, resultPath, newRoute.params);
    await vi.waitFor(() => expect(api.receiptLoads.slice(consumedReceiptLoad).some(({ result }: any) =>
      result?.id === retainedReceipt.id && result.consumed === true,
    )).toBe(true));
    tree = commitRoute();
    expect(byTestId(tree, "workspace-bookkeeping")).toBeUndefined();
  });

  it("does not navigate B when A's successful receipt ACK finishes after the form owner changes", async () => {
    const profileA = profile("authorization-A", "token-A");
    const serverA = server("/srv/principal-A", "principal-A");
    const replacements: unknown[] = [];
    host.router = { push: () => {}, replace: (value: unknown) => replacements.push(value), back: () => {} };
    host.app = appFor(profileA, serverA);
    let tree = commitRoute();
    const aDirectories = requestsFor(api.reads.directories, profileA, serverA)[0];
    const aWorktrees = requestsFor(api.reads.worktrees, profileA, serverA)[0];
    aDirectories.resolve([workspace("/srv/principal-A/project", "A project")]);
    aWorktrees.resolve([]);
    await drainPromises();
    tree = commitRoute();

    const acknowledgementGate: { started: boolean; key?: string; value?: string; release?: () => void } = { started: false };
    localStorage.holdConsumedWrite = acknowledgementGate;
    tree = await waitForEnabledButton((current) => buttonWithText(current, t("open_project.open_project")));
    tap(buttonWithText(tree, t("open_project.open_project")));
    await vi.waitFor(() => expect(acknowledgementGate.started).toBe(true));
    expect(replacements).toHaveLength(0);

    const profileB = profile("authorization-B", "token-B");
    const serverB = server("/srv/principal-B", "principal-B", "admin");
    host.app = appFor(profileB, serverB);
    renderRoute();
    flushEffects();
    renderRoute();
    const bPath = serverB.workspacePath!;
    expect(workspaceOperationRecord(profileB, serverB, bPath, "open")).toBeNull();
    expect(api.workspaceMutations.filter((entry: any) => entry.profile === profileB)).toHaveLength(0);
    expect(replacements).toHaveLength(0);

    acknowledgementGate.release?.();
    await vi.waitFor(() => expect(localStorage.values.get(acknowledgementGate.key!)).toContain('"consumed":true'));
    const bOperationPromise = api.openWorkspaceWithReceipt(profileB, serverB, bPath, false);
    await vi.waitFor(() => {
      const record = workspaceOperationRecord(profileB, serverB, bPath, "open")?.record;
      expect(record).toMatchObject({ kind: "open", path: bPath, result: bPath });
    });
    const bOperation = await bOperationPromise;
    const bOperationRecord = workspaceOperationRecord(profileB, serverB, bPath, "open");
    expect(bOperationRecord).not.toBeNull();
    if (!bOperationRecord) throw new Error("B V2 workspace operation record was not persisted");
    const bReceiptKey = bOperationRecord.key;
    expect(api.acknowledgements).toEqual([[profileA, serverA, "/srv/principal-A", "open"]]);
    expect(api.workspaceMutations).toHaveLength(2);
    expect(api.workspaceMutations[0]).toMatchObject({ profile: profileA, server: serverA, kind: "open", id: expect.any(String) });
    expect(api.workspaceMutations[1]).toMatchObject({ profile: profileB, server: serverB, path: bPath, kind: "open", id: bOperation.receipt.id });
    expect(localStorage.values.get(acknowledgementGate.key!)).toBe(acknowledgementGate.value);
    expect(JSON.parse(localStorage.values.get(acknowledgementGate.key!)!).consumed).toBe(true);
    const bRecord = JSON.parse(localStorage.values.get(bReceiptKey)!);
    expect(bRecord).toMatchObject({ id: bOperation.receipt.id, result: bPath, kind: "open" });
    expect(bRecord.consumed).not.toBe(true);
    expect(replacements).toHaveLength(0);
  });
});
