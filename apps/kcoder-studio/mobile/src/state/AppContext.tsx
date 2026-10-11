import { workspaceStateAuthorizationScope } from "@/storage/workspace-preferences";
import { retryThreadDeletionCleanup, installThreadDeletionCleanupAuthorityResolver } from "@/storage/thread-deletion-cleanup";
import { canCoordinateDeviceAuthorization, withLocalIdentityLock } from "@/storage/context-lock";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, Platform } from "react-native";
import {
  exchangeMobileSessionWithBootstrap,
  ensureGatewayAuthorization,
  installGatewayAuthorizationResolver,
  GatewaySessionExpiredError,
  listServers,
  listServerStatuses,
  revokeMobileSession,
} from "@/gateway/http";
import type {
  GatewayProfile,
  KCoderServer,
  ServerStatus,
} from "@/gateway/types";
import { clearModelCache } from "@/runtime/task-runtime/modelCatalog";
import { clearWorkspaceOptionsCache } from "@/runtime/task-runtime/workspaces";
import { taskRuntimeRegistry } from "@/runtime/task-runtime";
import {
  markWorkspaceStateRemoval,
  removeWorkspaceStatesForProfile,
} from "@/storage/workspace-preferences";
import {
  PROFILE_INDEX_KEY,
  loadProfiles,
  migrateLegacyWebProfiles,
  persistProfiles,
} from "@/storage/profile-store";
import {
  ProfileCoordinator,
  ProfileOperationGate,
  profileAuthorizationScopeKey,
} from "./profile-coordinator";
import { DeviceAuthorizationManager, deviceRefreshLead } from "./device-authorization";
import { applyProfileConnectionEffects } from "./profile-connection-effects";
import { connectGatewayProfile } from "./connect-gateway-profile";
import { removeGatewayProfile } from "./remove-gateway-profile";

interface ProfileRuntime {
  servers: KCoderServer[];
  statuses: ServerStatus[];
  loading: boolean;
  serversReady: boolean;
  statusRefreshing: boolean;
  statusError: string | null;
  serversUpdatedAt: number | null;
  statusesUpdatedAt: number | null;
  error: string | null;
  reauthorizationRequired: boolean;
}

interface AppContextValue {
  hydrated: boolean;
  profileHydrationError: string | null;
  profileHydrationRetrying: boolean;
  retryStoredProfiles(): Promise<string | null>;
  demo: boolean;
  profiles: GatewayProfile[];
  activeProfile: GatewayProfile | null;
  runtime: ProfileRuntime;
  setActiveProfile(id: string): Promise<void>;
  connectGateway(input: {
    baseUrl: string;
    token: string;
    label?: string;
    signal?: AbortSignal;
  }): Promise<GatewayProfile | null>;
  markGatewayReauthorizationRequired(id: string, capturedAuthorizationScope?: string): void;
  removeGateway(id: string): Promise<void>;
  refresh(): Promise<void>;
}

const DEMO_PROFILE: GatewayProfile = {
  id: "demo-host",
  label: "开发虚拟机",
  baseUrl: "http://127.0.0.1:4173",
  accessToken: "demo",
  expiresAt: Number.MAX_SAFE_INTEGER,
  rpcToken: "demo",
};

const DEMO_SERVERS: KCoderServer[] = [
  {
    id: "local",
    label: "当前虚拟机",
    description: "本机 KCoder app-server",
    runtime: "kcoder",
    transport: "local",
    workspacePath: "/data/projects/kcoder",
    capabilities: {
      browserSessions: true,
      terminalSessions: true,
      workspaceFiles: true,
    },
  },
  {
    id: "ssh-lab",
    label: "本地开发服务器",
    description: "通过 SSH 连接的 KCoder",
    runtime: "kcoder",
    transport: "ssh",
    host: "127.0.0.1",
    workspacePath: "/srv/kcoder",
    capabilities: {
      browserSessions: true,
      terminalSessions: true,
      workspaceFiles: true,
    },
  },
];

const EMPTY_RUNTIME: ProfileRuntime = {
  servers: [],
  statuses: [],
  loading: false,
  serversReady: false,
  statusRefreshing: false,
  statusError: null,
  serversUpdatedAt: null,
  statusesUpdatedAt: null,
  error: null,
  reauthorizationRequired: false,
};

const AppContext = createContext<AppContextValue | null>(null);

function isWebDemo(): boolean {
  return (
    Platform.OS === "web" &&
    typeof globalThis.location !== "undefined" &&
    new URLSearchParams(globalThis.location.search).get("demo") === "1"
  );
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [demo, setDemo] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [profileHydrationError, setProfileHydrationError] = useState<string | null>(null);
  const [profileHydrationRetrying, setProfileHydrationRetrying] = useState(false);
  const hydrationGeneration = useRef(0);
  const profileMutationRevision = useRef(0);
  const hydrationMounted = useRef(true);
  const hydrationPending = useRef<{ generation: number; promise: Promise<string | null> } | null>(null);
  const [profiles, setProfiles] = useState<GatewayProfile[]>([]);
  const [authorizationRetryRevision, setAuthorizationRetryRevision] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<ProfileRuntime>(EMPTY_RUNTIME);
  const runtimeAuthority = useRef(runtime);
  runtimeAuthority.current = runtime;
  const refreshGeneration = useRef(0);
  const initialServerBootstrap = useRef<{
    scope: string; servers: KCoderServer[]; generation: number;
    intent: number; signal?: AbortSignal;
  } | null>(null);
  const profileCoordinator = useRef(new ProfileCoordinator({ reload: loadProfiles, serialize: operation => withLocalIdentityLock("gateway-profile-index", async () => {
    if (!canCoordinateDeviceAuthorization() && (await loadProfiles()).profiles.some(profile => profile.authMode === "device")) throw new Error("此浏览器不支持安全协调设备授权，请使用 APP 或支持 Web Locks 的新版浏览器；临时授权可用于旧浏览器。" );
    return operation();
  }, false) })).current;
  useEffect(() => installThreadDeletionCleanupAuthorityResolver((profileId, serverId) => {
    const current = profileCoordinator.getSnapshot().profiles.find(profile => profile.id === profileId);
    const server = runtimeAuthority.current.servers.find(server => server.id === serverId);
    if (!current || !server || !profileCoordinator.isActive(profileId) || runtimeAuthority.current.reauthorizationRequired) return null;
    return workspaceStateAuthorizationScope(current, server);
  }), [profileCoordinator]);
  const profileActivationGate = useRef(new ProfileOperationGate()).current;
  const profileRefreshGate = useRef(new ProfileOperationGate()).current;

  const authorizationManager = useMemo(() => new DeviceAuthorizationManager(
    id => profileCoordinator.getSnapshot().profiles.find(profile => profile.id === id),
    (expected, next) => profileCoordinator.updateCredentials(expected, next, persistProfiles),
    () => setProfiles(profileCoordinator.getSnapshot().profiles),
    undefined, undefined,
    async () => { await profileCoordinator.synchronize(); },
  ), [profileCoordinator]);
  useEffect(() => installGatewayAuthorizationResolver((profile, force) => authorizationManager.authorize(profile, force)), [authorizationManager]);
  useEffect(() => {
    if (demo || !hydrated) return;
    const tick = () => {
      if (AppState.currentState && AppState.currentState !== "active") return;
      for (const profile of profileCoordinator.getSnapshot().profiles) {
        if (profile.authMode !== "device" || !profile.refreshToken) continue;
        const authorizationScope = profileAuthorizationScopeKey(profile);
        if (authorizationManager.nextAttemptAt(profile) <= Date.now() && (profile.pendingRotationId || profile.expiresAt <= Date.now() + deviceRefreshLead(profile))) {
          void authorizationManager.authorize(profile).catch(error => {
            const current = profileCoordinator.getSnapshot().profiles.find(current => current.id === profile.id);
            if (!current || profileAuthorizationScopeKey(current) !== authorizationScope) return;
            setAuthorizationRetryRevision(value => value + 1);
            if (!profileCoordinator.isActive(profile.id)) return;
            setRuntime(current => ({ ...current, error: error instanceof Error ? error.message : String(error), reauthorizationRequired: error instanceof GatewaySessionExpiredError }));
          });
        }
      }
    };
    tick();
    const nextRefresh = Math.min(10_000, ...profiles.filter(profile => profile.authMode === "device").map(profile => Math.max(25, authorizationManager.nextAttemptAt(profile) - Date.now(), profile.expiresAt - Date.now() - deviceRefreshLead(profile))));
    const timer = setInterval(tick, nextRefresh); return () => clearInterval(timer);
  }, [demo, hydrated, profiles, authorizationRetryRevision, authorizationManager, profileCoordinator]);

  const invalidateProfileHydration = useCallback(() => {
    profileMutationRevision.current += 1;
    const interrupted = hydrationPending.current?.generation === hydrationGeneration.current;
    hydrationGeneration.current += 1;
    if (interrupted) {
      setProfileHydrationRetrying(false);
      setHydrated(true);
      setProfileHydrationError("本机连接恢复已中止，原配置已保留。可重试恢复，或重新配对。");
    }
  }, []);

  const retryStoredProfiles = useCallback((): Promise<string | null> => {
    if (!hydrationMounted.current || isWebDemo()) return Promise.resolve(null);
    const previous = hydrationPending.current;
    if (previous && previous.generation === hydrationGeneration.current) return previous.promise;
    const generation = ++hydrationGeneration.current;
    const current = () => hydrationMounted.current && generation === hydrationGeneration.current;
    setProfileHydrationRetrying(true);
    setProfileHydrationError(null);
    const promise = (async () => {
      try {
        const stored = await loadProfiles();
        if (!current()) return null;
        const restored = stored.profiles.length > 0
          ? stored
          : Platform.OS === "web" ? ((await migrateLegacyWebProfiles()) ?? stored) : stored;
        if (!current()) return null;
        profileCoordinator.hydrate(restored);
        setProfiles(restored.profiles);
        setActiveId(restored.activeId);
        return restored.activeId;
      } catch {
        if (current()) {
          setProfileHydrationError(Platform.OS === "web" && (typeof navigator === "undefined" || typeof navigator.locks?.request !== "function")
            ? "当前浏览器无法安全恢复已存连接，请使用支持 Web Locks 的新版浏览器；原配置已保留。"
            : "本机连接配置暂时无法恢复，原配置已保留。请重试恢复，或重新配对。");
        }
        return null;
      } finally {
        if (current()) {
          setProfileHydrationRetrying(false);
          setHydrated(true);
        }
        if (hydrationPending.current?.generation === generation) hydrationPending.current = null;
      }
    })();
    hydrationPending.current = { generation, promise };
    return promise;
  }, [profileCoordinator]);

  useEffect(() => {
    hydrationMounted.current = true;
    if (isWebDemo()) {
      profileCoordinator.hydrate({
        profiles: [DEMO_PROFILE],
        activeId: DEMO_PROFILE.id,
      });
      setDemo(true);
      setProfiles([DEMO_PROFILE]);
      setActiveId(DEMO_PROFILE.id);
      setRuntime({
        servers: DEMO_SERVERS,
        statuses: DEMO_SERVERS.map((server, index) => ({
          id: server.id,
          status: index === 0 ? "online" : "offline",
          latencyMs: index === 0 ? 12 : undefined,
        })),
        loading: false,
        serversReady: true,
        statusRefreshing: false,
        statusError: null,
        serversUpdatedAt: Date.now(),
        statusesUpdatedAt: Date.now(),
        error: null,
        reauthorizationRequired: false,
      });
      setHydrated(true);
      return;
    }
    void retryStoredProfiles();
    return () => {
      hydrationMounted.current = false;
      initialServerBootstrap.current = null;
      hydrationGeneration.current += 1;
    };
  }, [profileCoordinator, retryStoredProfiles]);

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeId) ?? null,
    [activeId, profiles],
  );

  useEffect(() => {
    if (demo || !hydrated || !activeProfile || !runtime.serversReady || runtime.reauthorizationRequired) return;
    const timer = setInterval(() => {
      if ((AppState.currentState && AppState.currentState !== "active") || !profileCoordinator.isActive(activeProfile.id)) return;
      void retryThreadDeletionCleanup(activeProfile, runtime.servers).catch(() => {});
    }, 30_000);
    return () => clearInterval(timer);
  }, [demo, hydrated, activeProfile, runtime.serversReady, runtime.reauthorizationRequired, runtime.servers, profileCoordinator]);

  const refreshRuntime = useCallback((useInitialServers: boolean, forceWorkspaceOptions = false): Promise<void> => {
    // Manual/lifecycle refreshes never consume the seed: later standalone calls
    // fetch; overlapping calls join the active refresh gate. Only activation
    // may consume a newly committed pairing snapshot, exactly once.
    if (!useInitialServers) initialServerBootstrap.current = null;
    if (demo || !activeProfile) return Promise.resolve();
    const profile = activeProfile;
    const authorizationScope = profileAuthorizationScopeKey(profile);
    const scopeCurrent = () => {
      const current = profileCoordinator.getSnapshot().profiles.find(current => current.id === profile.id);
      return Boolean(current && profileCoordinator.isActive(profile.id) && profileAuthorizationScopeKey(current) === authorizationScope);
    };
    if (!scopeCurrent()) return Promise.resolve();
    clearModelCache(profile.id);
    if (forceWorkspaceOptions) clearWorkspaceOptionsCache(profile.id);
    if (profile.expiresAt <= Date.now() && !profile.refreshToken) {
      initialServerBootstrap.current = null;
      refreshGeneration.current += 1;
      setRuntime((current) => ({
        ...current,
        loading: false,
        statusRefreshing: false,
        error: "Gateway 会话已失效，请重新授权",
        reauthorizationRequired: true,
      }));
      return Promise.resolve();
    }
    return profileRefreshGate.run(authorizationScope, async () => {
      if (!scopeCurrent()) return;
      const pendingBootstrap = initialServerBootstrap.current;
      initialServerBootstrap.current = null;
      const bootstrap = useInitialServers && pendingBootstrap &&
        pendingBootstrap.scope === authorizationScope &&
        pendingBootstrap.generation === refreshGeneration.current &&
        !pendingBootstrap.signal?.aborted && profileCoordinator.isLatestConnectionIntent(pendingBootstrap.intent)
        ? pendingBootstrap : null;
      const bootstrapCurrent = () => !bootstrap || (!bootstrap.signal?.aborted && profileCoordinator.isLatestConnectionIntent(bootstrap.intent));
      const authorizationGeneration = refreshGeneration.current;
      const authorizationCurrent = () => hydrationMounted.current && scopeCurrent() && bootstrapCurrent() && authorizationGeneration === refreshGeneration.current;
      try { await ensureGatewayAuthorization(profile); } catch (error) {
        if (authorizationCurrent()) setRuntime(value => authorizationCurrent() ? ({ ...value, loading: false, statusRefreshing: false, error: error instanceof Error ? error.message : String(error), reauthorizationRequired: error instanceof GatewaySessionExpiredError }) : value);
        return;
      }
      if (!authorizationCurrent()) return;
      const generation = ++refreshGeneration.current;
      const current = () => hydrationMounted.current && scopeCurrent() && generation === refreshGeneration.current &&
        (!bootstrap || (!bootstrap.signal?.aborted && profileCoordinator.isLatestConnectionIntent(bootstrap.intent)));
      if (!current()) return;
      setRuntime((value) => current() ? ({ ...value, loading: !value.serversReady, statusRefreshing: true, error: null, statusError: null }) : value);
      const failure = (error: unknown, kind: "servers" | "statuses") => {
        if (!current()) return;
        const message = error instanceof Error ? error.message : String(error);
        const expired = error instanceof GatewaySessionExpiredError;
        if (expired) refreshGeneration.current += 1;
        const failureGeneration = refreshGeneration.current;
        const failureCurrent = () => hydrationMounted.current && scopeCurrent() && refreshGeneration.current === failureGeneration &&
          (!bootstrap || (!bootstrap.signal?.aborted && profileCoordinator.isLatestConnectionIntent(bootstrap.intent)));
        setRuntime((value) => failureCurrent() ? ({
          ...value,
          ...(kind === "servers" || expired ? { loading: false, error: message } : {}),
          ...(kind === "statuses" || expired ? { statusRefreshing: false, statusError: message } : {}),
          reauthorizationRequired: value.reauthorizationRequired || expired,
        }) : value);
      };
      await Promise.all([
        (bootstrap ? Promise.resolve(bootstrap.servers) : listServers(profile)).then((servers) => {
          if (current()) {
            setRuntime((value) => current() ? ({ ...value, servers, serversReady: true, serversUpdatedAt: Date.now(), loading: false, error: null }) : value);
            void retryThreadDeletionCleanup(profile, servers).catch(() => {});
          }
        }).catch((error) => failure(error, "servers")),
        listServerStatuses(profile).then((statuses) => {
          if (current()) setRuntime((value) => current() ? ({ ...value, statuses, statusesUpdatedAt: Date.now(), statusRefreshing: false, statusError: null }) : value);
        }).catch((error) => failure(error, "statuses")),
      ]);
    });
  }, [activeProfile, demo, profileCoordinator, profileRefreshGate]);

  const refresh = useCallback(() => refreshRuntime(false, true), [refreshRuntime]);

  useEffect(() => {
    if (!hydrated || !activeProfile) return;
    void refreshRuntime(true);
  }, [activeProfile?.id, hydrated, refreshRuntime]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshRuntime(false);
    });
    return () => subscription.remove();
  }, [refreshRuntime]);

  useEffect(() => {
    if (!hydrated || demo || Platform.OS !== "web" || typeof window === "undefined") return;
    let disposed = false;
    const changed = (event: StorageEvent) => {
      if (event.key !== PROFILE_INDEX_KEY && event.key !== null) return;
      invalidateProfileHydration();
      initialServerBootstrap.current = null;
      const revision = profileMutationRevision.current;
      const previous = profileCoordinator.getSnapshot();
      void profileCoordinator.synchronize().then(next => {
        if (disposed) return;
        const publish = revision === profileMutationRevision.current;
        invalidateProfileHydration();
        if (!publish) return;
        let invalidateActive = false;
        for (const old of previous.profiles) {
          const current = next.profiles.find(profile => profile.id === old.id);
          if (!current || current.baseUrl !== old.baseUrl || current.authorizationGeneration !== old.authorizationGeneration) {
            clearModelCache(old.id); clearWorkspaceOptionsCache(old.id); taskRuntimeRegistry.removeProfile(old.id);
            if (old.id === previous.activeId) invalidateActive = true;
          }
        }
        if (invalidateActive) { refreshGeneration.current += 1; setRuntime(EMPTY_RUNTIME); }
        setProfiles(next.profiles); setActiveId(next.activeId);
        setProfileHydrationError(null);
      }).catch(error => { if (!disposed && revision === profileMutationRevision.current) setRuntime(current => ({ ...current, error: error instanceof Error ? error.message : String(error) })); });
    };
    window.addEventListener("storage", changed);
    return () => { disposed = true; window.removeEventListener("storage", changed); };
  }, [demo, hydrated, profileCoordinator, invalidateProfileHydration]);

  const connectGateway = useCallback(
    async (input: { baseUrl: string; token: string; label?: string; signal?: AbortSignal }) => {
      if (input.signal?.aborted) return null;
      invalidateProfileHydration();
      const intent = profileCoordinator.beginConnection();
      initialServerBootstrap.current = null;
      let initialServers: KCoderServer[] | undefined;
      const cancelIntent = () => {
        profileCoordinator.cancelConnectionIntent(intent);
        if (initialServerBootstrap.current?.intent === intent) initialServerBootstrap.current = null;
      };
      input.signal?.addEventListener("abort", cancelIntent, { once: true });
      try {
        return await connectGatewayProfile({
          signal: input.signal,
          exchange: async () => {
            const exchanged = await exchangeMobileSessionWithBootstrap(input.baseUrl, input.token, input.label, input.signal);
            initialServers = exchanged.initialServers;
            return exchanged.profile;
          },
          commit: (profile, onCommit) => profileCoordinator.commitConnection(
            intent,
            profile,
            persistProfiles,
            input.signal,
            onCommit,
          ),
          applyCommit: (profile, commit) => {
            if (commit.committed) invalidateProfileHydration();
            const appliedProfile = applyProfileConnectionEffects(commit, profile, () => profileCoordinator.isLatestConnectionIntent(intent), {
              setProfiles,
              setActiveId,
              removeProfileRuntimes: (profileId) =>
                taskRuntimeRegistry.removeProfile(profileId),
              clearRuntime: () => {
                initialServerBootstrap.current = null;
                refreshGeneration.current += 1;
                setRuntime(EMPTY_RUNTIME);
              },
            });
            if (appliedProfile && initialServers !== undefined && !input.signal?.aborted &&
                hydrationMounted.current && profileCoordinator.isLatestConnectionIntent(intent)) {
              initialServerBootstrap.current = { scope: profileAuthorizationScopeKey(appliedProfile),
                servers: initialServers, generation: refreshGeneration.current, intent, signal: input.signal };
            }
            if (commit.committed && commit.activated && profileCoordinator.isLatestConnectionIntent(intent)) {
              setProfileHydrationError(null);
              setHydrated(true);
            }
            return appliedProfile;
          },
          revoke: revokeMobileSession,
        });
      } finally {
        input.signal?.removeEventListener("abort", cancelIntent);
      }
    },
    [profileCoordinator, invalidateProfileHydration],
  );

  const markGatewayReauthorizationRequired = useCallback(
    (id: string, capturedAuthorizationScope?: string) => {
      const stillAuthorized = () => {
        const snapshot = profileCoordinator.getSnapshot();
        const profile = snapshot.profiles.find((candidate) => candidate.id === id);
        return snapshot.activeId === id && (capturedAuthorizationScope === undefined || Boolean(profile && profileAuthorizationScopeKey(profile) === capturedAuthorizationScope));
      };
      if (!stillAuthorized()) return;
      initialServerBootstrap.current = null;
      refreshGeneration.current += 1;
      setRuntime((current) => stillAuthorized() ? ({
        ...current,
        loading: false,
        statusRefreshing: false,
        error: "Gateway 会话已失效，请重新授权",
        reauthorizationRequired: true,
      }) : current);
    },
    [profileCoordinator],
  );

  const setActiveProfile = useCallback(
    (id: string) => {
      // A route may request the same activation after connectGateway commits the
      // coordinator but before React state renders. Do not queue another activation,
      // which would later clear the runtime that just loaded.
      if (activeId === id || profileCoordinator.isActive(id))
        return Promise.resolve();
      initialServerBootstrap.current = null;
      invalidateProfileHydration();
      return profileActivationGate.run(id, async () => {
        const next = await profileCoordinator.activate(
          id,
          demo ? async () => {} : persistProfiles,
        );
        if (next.activeId !== id) return;
        invalidateProfileHydration();
        refreshGeneration.current += 1;
        setProfiles(next.profiles);
        setActiveId(next.activeId);
        setRuntime(EMPTY_RUNTIME);
      });
    },
    [activeId, demo, profileActivationGate, profileCoordinator, invalidateProfileHydration],
  );

  const removeGateway = useCallback(
    async (id: string) => {
      initialServerBootstrap.current = null;
      invalidateProfileHydration();
      clearModelCache(id);
      clearWorkspaceOptionsCache(id);
      const removal = await removeGatewayProfile(id, {
        coordinator: profileCoordinator,
        persist: demo ? async () => {} : persistProfiles,
        cleanupProfileState: removeWorkspaceStatesForProfile,
        revokeSession: demo ? undefined : revokeMobileSession,
        effects: {
          setProfiles: next => { invalidateProfileHydration(); setProfiles(next); },
          setActiveId,
          removeProfileRuntimes: (profileId) =>
            taskRuntimeRegistry.removeProfile(profileId),
          clearRuntime: () => {
            refreshGeneration.current += 1;
            setRuntime(EMPTY_RUNTIME);
          },
          markProfileStateRemoval: markWorkspaceStateRemoval,
        },
      });
      if (removal.remoteRevocation === "unconfirmed") setRuntime(current => ({ ...current, error: "已移除本机连接；远端设备授权未确认撤销，请在目标端设备管理中撤销。" }));
    },
    [demo, profileCoordinator, invalidateProfileHydration],
  );

  const value = useMemo<AppContextValue>(
    () => ({
      hydrated,
      profileHydrationError,
      profileHydrationRetrying,
      retryStoredProfiles,
      demo,
      profiles,
      activeProfile,
      runtime,
      setActiveProfile,
      connectGateway,
      markGatewayReauthorizationRequired,
      removeGateway,
      refresh,
    }),
    [
      activeProfile,
      connectGateway,
      markGatewayReauthorizationRequired,
      demo,
      hydrated,
      profileHydrationError,
      profileHydrationRetrying,
      retryStoredProfiles,
      profiles,
      refresh,
      removeGateway,
      runtime,
      setActiveProfile,
    ],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp 必须在 AppProvider 中使用");
  return value;
}

export { DEMO_PROFILE, DEMO_SERVERS };
