import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import type { SettingsTargetValue } from "./SettingsTargetContext";

type EffectSlot = {
  callback: () => void | (() => void);
  deps: readonly unknown[];
  pending: boolean;
  cleanup?: () => void;
};

const fixture = vi.hoisted(() => ({
  states: [] as unknown[],
  setters: [] as Array<((value: unknown) => void) | undefined>,
  refs: [] as Array<{ current: unknown } | undefined>,
  memos: [] as Array<{ deps: readonly unknown[]; value: unknown } | undefined>,
  effects: [] as Array<EffectSlot | undefined>,
  stateIndex: 0,
  refIndex: 0,
  memoIndex: 0,
  effectIndex: 0,
  app: {} as Record<string, unknown>,
  providedValue: null as unknown,
  sessions: [] as Array<{
    connect(): Promise<void>;
    resolveInitialize(): void;
    emitClose(channel: "runtime" | "browser"): void;
    updateProfile: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    getCapabilities(): unknown;
    request: ReturnType<typeof vi.fn>;
  }>,
  loadChoice: vi.fn<() => Promise<string | null>>(),
  saveChoice: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const same = (left: readonly unknown[], right: readonly unknown[]) => (
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  );
  const memo = (factory: () => unknown, deps: readonly unknown[]) => {
    const index = fixture.memoIndex++;
    const previous = fixture.memos[index];
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory();
    fixture.memos[index] = { deps, value };
    return value;
  };
  return {
    ...actual,
    useState(initial: unknown) {
      const index = fixture.stateIndex++;
      if (!(index in fixture.states)) fixture.states[index] = typeof initial === "function"
        ? (initial as () => unknown)()
        : initial;
      fixture.setters[index] ??= (update) => {
        fixture.states[index] = typeof update === "function"
          ? (update as (previous: unknown) => unknown)(fixture.states[index])
          : update;
      };
      return [fixture.states[index], fixture.setters[index]];
    },
    useRef(initial: unknown) {
      const index = fixture.refIndex++;
      return fixture.refs[index] ??= { current: initial };
    },
    useMemo: memo,
    useCallback: (callback: unknown, deps: readonly unknown[]) => memo(() => callback, deps),
    useContext: () => fixture.providedValue,
    useEffect(callback: EffectSlot["callback"], deps: readonly unknown[] = []) {
      const index = fixture.effectIndex++;
      const previous = fixture.effects[index];
      if (!previous || !same(previous.deps, deps)) {
        previous?.cleanup?.();
        fixture.effects[index] = { callback, deps, pending: true };
      } else {
        previous.callback = callback;
      }
    },
  };
});

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  StyleSheet: { create: (value: unknown) => value },
  Text: "Text",
  View: "View",
}));
vi.mock("lucide-react-native", () => ({ RefreshCw: "RefreshCw", Server: "Server" }));
vi.mock("@/components/settings/settings-choice-sheet", () => ({ SettingsChoiceSheet: "SettingsChoiceSheet" }));
vi.mock("@/components/settings/settings-layout", () => ({ SettingsGroup: "SettingsGroup", SettingsRow: "SettingsRow" }));
vi.mock("@/i18n/use-locale", () => ({ useLocale: () => "en" }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/gateway/http", () => ({ GatewaySessionExpiredError: class extends Error {} }));
vi.mock("@/state/AppContext", () => ({ useApp: () => fixture.app }));
vi.mock("@/theme", () => ({
  spacing: { xs: 4, sm: 8, md: 12, lg: 16 },
  useTheme: () => ({ colors: { text: "text", textMuted: "muted", textDim: "dim", red: "red" } }),
  useThemedStyles: (factory: (colors: Record<string, string>) => unknown) => factory({ text: "text", textMuted: "muted", textDim: "dim", red: "red" }),
}));

vi.mock("@/runtime/settings-target", () => {
  class SettingsTargetChangedError extends Error {
    readonly code = "SETTINGS_TARGET_CHANGED";
    constructor(readonly delivery: "not-sent" | "unknown") { super("SETTINGS_TARGET_CHANGED"); }
  }
  class SettingsTargetUnavailableError extends Error {
    readonly code = "SETTINGS_TARGET_UNAVAILABLE";
    constructor() { super("SETTINGS_TARGET_UNAVAILABLE"); }
  }
  class SettingsTargetSession {
    private connection: Promise<void> | null = null;
    private resolveConnection: (() => void) | null = null;
    private initialized = false;
    private readonly closeListeners = new Set<(event: { channel: "runtime" | "browser" }) => void>();
    readonly updateProfile = vi.fn((profile: GatewayProfile) => { this.profile = profile; });
    readonly close = vi.fn(() => {});
    readonly subscribeClose = vi.fn((listener: (event: { channel: "runtime" | "browser" }) => void) => {
      this.closeListeners.add(listener);
      return () => this.closeListeners.delete(listener);
    });
    readonly request = vi.fn(async <T,>() => {
      await this.connect();
      return { delivered: true } as T;
    });

    constructor(
      private profile: GatewayProfile,
      readonly server: KCoderServer,
      private readonly isCurrent: () => boolean,
    ) {
      const session = this;
      fixture.sessions.push({
        connect: () => session.connect(),
        resolveInitialize: () => { session.initialized = true; session.resolveConnection?.(); },
        emitClose: (channel) => {
          if (channel === "runtime") session.initialized = false;
          for (const listener of [...session.closeListeners]) listener({ channel });
        },
        updateProfile: this.updateProfile,
        close: this.close,
        getCapabilities: () => this.getCapabilities(),
        request: this.request,
      });
    }

    connect(): Promise<void> {
      if (!this.connection) {
        this.connection = new Promise<void>((resolve) => { this.resolveConnection = resolve; });
      }
      if (!this.isCurrent()) return Promise.reject(new SettingsTargetChangedError("not-sent"));
      return this.connection;
    }

    getCapabilities() {
      return this.initialized
        ? { gateway: this.server.capabilities ?? {}, appServer: { approvals: true, experimental: { providerConfiguration: true } } }
        : { gateway: this.server.capabilities ?? {}, appServer: null };
    }
  }

  return {
    loadSettingsServerChoice: fixture.loadChoice,
    resolveSettingsServerId: (servers: KCoderServer[], saved: string | null) => (
      saved && servers.some((server) => server.id === saved) ? saved : servers.length === 1 ? servers[0]?.id ?? null : null
    ),
    saveSettingsServerChoice: fixture.saveChoice,
    SettingsTargetChangedError,
    SettingsTargetSession,
    SettingsTargetUnavailableError,
    settingsTargetIdentity: (profile: GatewayProfile, server: KCoderServer, workspacePath?: string) => JSON.stringify([
      profile.id, profile.authorizationGeneration, server.id, workspacePath === undefined ? "absent" : workspacePath,
    ]),
    settingsTargetSelectionStorageKey: (profile: GatewayProfile) => `${profile.id}:${profile.authorizationGeneration}`,
  };
});

import { SettingsTargetProvider, useSettingsTarget } from "./SettingsTargetContext";

const profile: GatewayProfile = {
  id: "gateway-test",
  label: "Test Gateway",
  baseUrl: "https://gateway.example",
  accessToken: "access",
  expiresAt: Number.MAX_SAFE_INTEGER,
  rpcToken: "rpc",
  authorizationGeneration: "generation-a",
};
const server: KCoderServer = {
  id: "server-test",
  label: "Test server",
  description: "Test server",
  runtime: "kcoder",
  transport: "local",
  workspacePath: "/workspace/test",
  capabilities: { browserSessions: true },
};
const peerServer: KCoderServer = {
  ...server,
  id: "server-peer",
  label: "Peer server",
  workspacePath: "/workspace/peer",
};

function renderProvider(): SettingsTargetValue {
  fixture.stateIndex = fixture.refIndex = fixture.memoIndex = fixture.effectIndex = 0;
  const element = SettingsTargetProvider({ children: null }) as ReactElement<{ value: SettingsTargetValue }>;
  fixture.providedValue = element.props.value;
  return element.props.value;
}

function commitEffects(): void {
  for (const effect of fixture.effects) {
    if (!effect?.pending) continue;
    effect.pending = false;
    const cleanup = effect.callback();
    effect.cleanup = typeof cleanup === "function" ? cleanup : undefined;
  }
}

function replayEffects(): void {
  for (const effect of fixture.effects) effect?.cleanup?.();
  for (const effect of fixture.effects) if (effect) effect.pending = true;
  commitEffects();
}

async function selectedTarget(): Promise<SettingsTargetValue> {
  renderProvider();
  commitEffects();
  await vi.waitFor(() => {
    const target = renderProvider();
    expect(target.serverId).toBe(server.id);
  });
  return renderProvider();
}

beforeEach(() => {
  fixture.states = [];
  fixture.setters = [];
  fixture.refs = [];
  fixture.memos = [];
  fixture.effects = [];
  fixture.stateIndex = fixture.refIndex = fixture.memoIndex = fixture.effectIndex = 0;
  fixture.sessions = [];
  fixture.providedValue = null;
  fixture.loadChoice.mockReset().mockResolvedValue(server.id);
  fixture.saveChoice.mockReset().mockResolvedValue(undefined);
  fixture.app = {
    demo: false,
    hydrated: true,
    activeProfile: profile,
    refresh: vi.fn(async () => {}),
    runtime: {
      servers: [server],
      serversReady: true,
      loading: false,
      error: null,
      reauthorizationRequired: false,
    },
  };
});

afterEach(() => {
  for (const effect of fixture.effects) effect?.cleanup?.();
});

describe("SettingsTargetProvider ownership", () => {
  it("reuses a child-created session before the provider effect and refreshes initialize capabilities", async () => {
    let target = await selectedTarget();
    const childEffectRequest = useSettingsTarget().request<{ delivered: boolean }>("settings/read");

    commitEffects();
    expect(fixture.sessions).toHaveLength(1);
    expect(fixture.sessions[0]?.close).not.toHaveBeenCalled();

    fixture.sessions[0]?.resolveInitialize();
    await childEffectRequest;
    await vi.waitFor(() => {
      target = renderProvider();
      expect(target.ready).toBe(true);
    });
    expect(target.capabilities.appServer?.experimental?.providerConfiguration).toBe(true);
  });

  it("survives StrictMode effect cleanup/setup replay without losing the current target", async () => {
    const initial = await selectedTarget();
    commitEffects();
    fixture.sessions[0]?.resolveInitialize();
    await vi.waitFor(() => expect(renderProvider().ready).toBe(true));

    replayEffects();
    expect(fixture.sessions).toHaveLength(2);
    expect(fixture.sessions[0]?.close).toHaveBeenCalledTimes(1);
    fixture.sessions[1]?.resolveInitialize();
    await vi.waitFor(() => expect(renderProvider().ready).toBe(true));
    expect(initial.targetIdentity).toBe(renderProvider().targetIdentity);
  });

  it("shows runtime disconnect, retries with fresh capabilities, and ignores a late old-owner close", async () => {
    let target = await selectedTarget();
    commitEffects();
    fixture.sessions[0]?.resolveInitialize();
    await vi.waitFor(() => expect(renderProvider().ready).toBe(true));

    const oldOwner = fixture.sessions[0]!;
    oldOwner.emitClose("runtime");
    target = renderProvider();
    expect(target.ready).toBe(false);
    expect(target.error).toBe("settings_runtime.connection_error");
    expect(target.capabilities.appServer).toBeNull();

    target.retry();
    renderProvider();
    commitEffects();
    expect(fixture.sessions).toHaveLength(2);
    expect(renderProvider().loading).toBe(true);
    fixture.sessions[1]?.resolveInitialize();
    await vi.waitFor(() => expect(renderProvider().ready).toBe(true));

    oldOwner.emitClose("runtime");
    target = renderProvider();
    expect(target.ready).toBe(true);
    expect(target.error).toBeNull();
    expect(target.capabilities.appServer?.experimental?.providerConfiguration).toBe(true);
  });

  it("does not report runtime disconnected when only the browser channel closes", async () => {
    let target = await selectedTarget();
    commitEffects();
    fixture.sessions[0]?.resolveInitialize();
    await vi.waitFor(() => expect(renderProvider().ready).toBe(true));

    fixture.sessions[0]?.emitClose("browser");
    target = renderProvider();

    expect(target.ready).toBe(true);
    expect(target.error).toBeNull();
    expect(fixture.sessions).toHaveLength(1);
  });

  it("closes the old target session on switch and the current owner on provider unmount", async () => {
    (fixture.app.runtime as { servers: KCoderServer[] }).servers = [server, peerServer];
    let target = await selectedTarget();
    commitEffects();
    fixture.sessions[0]?.resolveInitialize();
    await vi.waitFor(() => expect(renderProvider().ready).toBe(true));

    await target.selectServer(peerServer.id);
    target = renderProvider();
    commitEffects();
    expect(target.serverId).toBe(peerServer.id);
    expect(fixture.sessions).toHaveLength(2);
    expect(fixture.sessions[0]?.close).toHaveBeenCalledTimes(1);
    fixture.sessions[1]?.resolveInitialize();
    await vi.waitFor(() => expect(renderProvider().ready).toBe(true));

    fixture.sessions[0]?.emitClose("runtime");
    expect(renderProvider().ready).toBe(true);
    expect(renderProvider().error).toBeNull();

    for (const effect of fixture.effects) effect?.cleanup?.();
    expect(fixture.sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(fixture.sessions[1]?.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the ready session through routine token rotation and closes it on authorization revocation", async () => {
    let target = await selectedTarget();
    commitEffects();
    fixture.sessions[0]?.resolveInitialize();
    await vi.waitFor(() => expect(renderProvider().ready).toBe(true));

    const rotatedProfile = { ...profile, accessToken: "access-rotated", rpcToken: "rpc-rotated" };
    fixture.app.activeProfile = rotatedProfile;
    target = renderProvider();
    expect(target.ready).toBe(true);
    expect(fixture.sessions).toHaveLength(1);
    expect(fixture.sessions[0]?.updateProfile).toHaveBeenLastCalledWith(rotatedProfile);
    expect(fixture.sessions[0]?.close).not.toHaveBeenCalled();

    const runtime = fixture.app.runtime as { reauthorizationRequired: boolean };
    runtime.reauthorizationRequired = true;
    target = renderProvider();
    expect(target.ready).toBe(false);
    await expect(target.request("settings/read")).rejects.toMatchObject({
      code: "SETTINGS_TARGET_CHANGED",
      delivery: "not-sent",
    });
    commitEffects();
    expect(fixture.sessions[0]?.close).toHaveBeenCalledTimes(1);
  });
  it("isolates target and setting snapshots and unsubscribes the exact listener", async () => {
    const target = await selectedTarget();
    const listener = vi.fn();
    const peerListener = vi.fn();
    const unsubscribe = target.subscribeDraft(listener);
    const unsubscribePeer = target.subscribeDraft(peerListener);
    const first = { instructions: "A draft", pendingWrite: { inFlight: false } };
    const second = { choice: "auto" };
    target.writeDraft("gateway-a/account-a/workspace-a", "instructions", first);
    target.writeDraft("gateway-b/account-a/workspace-a", "instructions", { instructions: "B draft" });
    target.writeDraft("gateway-a/account-a/workspace-a", "permissions", second);
    expect(target.readDraft("gateway-a/account-a/workspace-a", "instructions")).toBe(first);
    expect(target.readDraft("gateway-a/account-a/workspace-a", "permissions")).toBe(second);
    expect(target.readDraft("gateway-a/account-b/workspace-a", "instructions")).toBeNull();
    expect(target.readDraft("gateway-a/account-a/workspace-b", "instructions")).toBeNull();
    expect(target.readDraft<{ instructions: string }>("gateway-b/account-a/workspace-a", "instructions")?.instructions).toBe("B draft");
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    target.writeDraft("gateway-a/account-a/workspace-a", "instructions", null);
    expect(target.readDraft("gateway-a/account-a/workspace-a", "instructions")).toBeNull();
    expect(target.readDraft("gateway-a/account-a/workspace-a", "permissions")).toBe(second);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(peerListener).toHaveBeenCalledTimes(4);
    unsubscribePeer();
  });

  it("drops draft snapshots when the provider hook owner is torn down", async () => {
    const previous = await selectedTarget();
    previous.writeDraft("target-a", "instructions", { instructions: "temporary draft" });
    for (const effect of fixture.effects) effect?.cleanup?.();
    fixture.states = [];
    fixture.setters = [];
    fixture.refs = [];
    fixture.memos = [];
    fixture.effects = [];
    const next = await selectedTarget();
    expect(next.readDraft("target-a", "instructions")).toBeNull();
  });

});
