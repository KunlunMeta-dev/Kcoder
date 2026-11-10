import { sessionTranscriptCache } from "@/storage/session-transcript-cache";
import { workspaceStateAuthorizationScope } from "@/storage/workspace-preferences";
import { retryThreadDeletionCleanup, installThreadDeletionCleanupAuthorityResolver } from "@/storage/thread-deletion-cleanup";
import { withLocalMetadata } from "@/storage/context-lock";
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
  installGatewayAuthorizationDenialRecorder,
  installGatewayAuthorizationResolver,
  GatewaySessionExpiredError,
  listServers,
  getServerStatusSnapshot,
  revokeMobileSession,
} from "@/gateway/http";
import type {
  GatewayAuthorizationDenialWitness,
  GatewayProfile,
  KCoderServer,
  ServerStatus,
} from "@/gateway/types";
import { clearModelCache } from "@/runtime/task-runtime/modelCatalog";
import { clearWorkspaceOptionsCache } from "@/runtime/task-runtime/workspaces";
import { taskRuntimeRegistry } from "@/runtime/task-runtime";
import { interactionServerIdentity } from "@/runtime/task-runtime/threadDirectory";
import type { InteractionAuthorizationOwner } from "@/runtime/task-runtime/types";
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
import { useGatewayRuntimeRecovery } from "./useGatewayRuntimeRecovery";
import type { GatewayConnectionRoutes } from "../../../shared/gatewayConnectionRoutes.js";

export interface ProfileRuntime {
  servers: KCoderServer[];
  statuses: ServerStatus[];
  gatewayRuntimeVersion?: string | null;
  loading: boolean;
  serversReady: boolean;
  serversRevision: number;
  statusRefreshing: boolean;
  statusError: string | null;
  serversUpdatedAt: number | null;
  statusesUpdatedAt: number | null;
  error: string | null;
  reauthorizationRequired: boolean;
}

export interface AppContextValue {
  hydrated: boolean;
  profileHydrationError: string | null;
  profileHydrationRetrying: boolean;
  retryStoredProfiles(): Promise<string | null>;
  demo: boolean;
  profiles: GatewayProfile[];
  activeProfile: GatewayProfile | null;
  runtime: ProfileRuntime;
  runtimeActivationEpoch: number;
  isCurrentInteractionOwner(owner: InteractionAuthorizationOwner): boolean;
  setActiveProfile(id: string): Promise<void>;
  connectGateway(input: {
    baseUrl: string;
    token: string;
    label?: string;
    signal?: AbortSignal;
    connectionRoutes?: GatewayConnectionRoutes;
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
  gatewayRuntimeVersion: null,
  loading: false,
  serversReady: false,
  serversRevision: 0,
  statusRefreshing: false,
  statusError: null,
  serversUpdatedAt: null,
  statusesUpdatedAt: null,
  error: null,
  reauthorizationRequired: false,
};
const REAUTHORIZATION_REQUIRED_MESSAGE = "Gateway 会话已失效，请重新授权";

export const AppContext = createContext<AppContextValue | null>(null);

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
  const [refreshActivationRevision, setRefreshActivationRevision] = useState(0);
  const runtimeAuthority = useRef(runtime);
  runtimeAuthority.current = runtime;
  const refreshGeneration = useRef(0);
  const refreshActivationEpoch = useRef(0);
  const advanceRuntimeActivation = useCallback(() => {
    refreshActivationEpoch.current += 1;
    refreshGeneration.current += 1;
    // A batched A -> B -> A commit can leave every other effect dependency unchanged.
    setRefreshActivationRevision(refreshActivationEpoch.current);
  }, []);
  const initialServerBootstrap = useRef<{
    scope: string; servers: KCoderServer[]; generation: number;
    intent: number; signal?: AbortSignal;
  } | null>(null);
  const profileCoordinator = useRef(new ProfileCoordinator({ reload: loadProfiles, serialize: operation => withLocalMetadata("gateway-profile-index", operation) })).current;
  const isCurrentInteractionOwner = useCallback((owner: InteractionAuthorizationOwner): boolean => {
    const snapshot = profileCoordinator.getSnapshot();
    const current = snapshot.profiles.find(profile => profile.id === owner.profileId);
    const authority = runtimeAuthority.current;
    const server = authority.servers.find(candidate => candidate.id === owner.serverId);
    return !demo && refreshActivationEpoch.current === owner.profileActivationEpoch &&
      snapshot.activeId === owner.profileId && Boolean(current) &&
      profileCoordinator.isCurrentGrant(current!) &&
      profileAuthorizationScopeKey(current!) === owner.profileAuthorizationScopeKey &&
      !profileCoordinator.isAuthorizationDenied(current!) &&
      authority.serversReady && !authority.reauthorizationRequired && Boolean(server) &&
      interactionServerIdentity(server!) === owner.serverConfigIdentity;
  }, [demo, profileCoordinator]);
  useEffect(() => installThreadDeletionCleanupAuthorityResolver((profileId, serverId) => {
    const current = profileCoordinator.getSnapshot().profiles.find(profile => profile.id === profileId);
    const server = runtimeAuthority.current.servers.find(server => server.id === serverId);
    if (!current || !server || !profileCoordinator.isActive(profileId) || runtimeAuthority.current.reauthorizationRequired) return null;
    return workspaceStateAuthorizationScope(current, server);
  }), [profileCoordinator]);
  const profileActivationGate = useRef(new ProfileOperationGate()).current;
  const profileRefreshGate = useRef(new ProfileOperationGate()).current;
  const activationIntentSerial = useRef(0);
  const activationFlight = useRef<{ id: string; serial: number; promise: Promise<void> } | null>(null);

  const authorizationManager = useMemo(() => new DeviceAuthorizationManager(
    id => profileCoordinator.getSnapshot().profiles.find(profile => profile.id === id),
    (expected, next, intent) => profileCoordinator.updateCredentials(expected, next, persistProfiles, intent),
    (profileId) => {
      const snapshot = profileCoordinator.getSnapshot();
      setProfiles(snapshot.profiles);
      if (profileId && snapshot.activeId === profileId) {
        const current = snapshot.profiles.find(profile => profile.id === profileId);
        if (current && !profileCoordinator.isAuthorizationDenied(current)) {
          setRuntime(value => value.error === REAUTHORIZATION_REQUIRED_MESSAGE
            ? { ...value, error: null, reauthorizationRequired: false }
            : value.reauthorizationRequired ? { ...value, reauthorizationRequired: false } : value);
        }
      }
    },
    undefined, undefined,
    async () => { await profileCoordinator.synchronize(); },
  ), [profileCoordinator]);
  useEffect(() => installGatewayAuthorizationResolver((profile, force) => authorizationManager.authorize(profile, force)), [authorizationManager]);
  useEffect(() => installGatewayAuthorizationDenialRecorder((witness: GatewayAuthorizationDenialWitness) => {
    if (demo) return Promise.resolve(false);
    const operation = profileCoordinator.recordAuthorizationDenial(witness, persistProfiles);
    const publish = () => {
      const snapshot = profileCoordinator.getSnapshot();
      setProfiles(snapshot.profiles);
      const current = snapshot.profiles.find(profile => profile.id === witness.profileId);
      if (snapshot.activeId !== witness.profileId || !current) return;
      const denied = profileCoordinator.isAuthorizationDenied(current);
      if (denied) {
        initialServerBootstrap.current = null;
        refreshGeneration.current += 1;
        setRuntime(value => ({
          ...value,
          loading: false,
          statusRefreshing: false,
          error: REAUTHORIZATION_REQUIRED_MESSAGE,
          reauthorizationRequired: true,
        }));
      } else {
        setRuntime(value => value.error === REAUTHORIZATION_REQUIRED_MESSAGE
          ? { ...value, error: null, reauthorizationRequired: false }
          : value);
      }
    };
    publish();
    return operation.then(denied => {
      if (denied && profileCoordinator.isCurrentAuthorizationDenial(witness)) {
        const current = profileCoordinator.getSnapshot().profiles.find(profile => profile.id === witness.profileId);
        if (current) {
          // The profile-index transaction has settled before this continuation.
          // Cache invalidation takes that same short lock, so it must start here,
          // outside the denial write, and retain the exact grant witness while queued.
          void sessionTranscriptCache.invalidateProfile(
            current,
            () => profileCoordinator.isCurrentAuthorizationDenial(witness),
          ).catch(() => {});
        }
      }
      publish();
      return denied;
    });
  }, witness => profileCoordinator.isCurrentAuthorizationDenial(witness)), [demo, profileCoordinator]);
  useEffect(() => {
    if (demo || !hydrated) return;
    const tick = () => {
      if (AppState.currentState && AppState.currentState !== "active") return;
      // Saved inactive Gateways renew on use, not through the foreground timer.
      const snapshot = profileCoordinator.getSnapshot();
      const profile = snapshot.profiles.find(profile => profile.id === snapshot.activeId);
      if (profile?.authMode !== "device" || !profile.refreshToken) return;
      const authorizationScope = profileAuthorizationScopeKey(profile);
      if (authorizationManager.nextAttemptAt(profile) <= Date.now() && (profile.pendingRotationId || profile.expiresAt <= Date.now() + deviceRefreshLead(profile))) {
        void authorizationManager.authorize(profile).catch(error => {
          const current = profileCoordinator.getSnapshot().profiles.find(current => current.id === profile.id);
          if (!current || profileAuthorizationScopeKey(current) !== authorizationScope || !profileCoordinator.isCurrentGrant(profile) || !profileCoordinator.isActive(profile.id)) return;
          setAuthorizationRetryRevision(value => value + 1);
          const denied = error instanceof GatewaySessionExpiredError && profileCoordinator.isAuthorizationDenied(current);
          setRuntime(value => ({ ...value, error: error instanceof Error ? error.message : String(error), reauthorizationRequired: denied }));
        });
      }
    };
    tick();
    const profile = profiles.find(profile => profile.id === activeId && profile.authMode === "device" && profile.refreshToken);
    if (!profile) return;
    const nextRefresh = Math.min(10_000, Math.max(25, authorizationManager.nextAttemptAt(profile) - Date.now(), profile.expiresAt - Date.now() - deviceRefreshLead(profile)));
    const timer = setInterval(tick, nextRefresh); return () => clearInterval(timer);
  }, [demo, hydrated, profiles, activeId, authorizationRetryRevision, authorizationManager, profileCoordinator]);

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
        const previous = profileCoordinator.getSnapshot();
        const previousActive = previous.profiles.find(profile => profile.id === previous.activeId);
        const restoredActive = restored.profiles.find(profile => profile.id === restored.activeId);
        const activationChanged = previous.activeId !== restored.activeId ||
          (previousActive ? profileAuthorizationScopeKey(previousActive) : null) !==
          (restoredActive ? profileAuthorizationScopeKey(restoredActive) : null);
        profileCoordinator.hydrate(restored);
        if (activationChanged) { advanceRuntimeActivation(); setRuntime(EMPTY_RUNTIME); }
        setProfiles(restored.profiles);
        setActiveId(restored.activeId);
        if (restoredActive && profileCoordinator.isAuthorizationDenied(restoredActive))
          setRuntime(value => ({ ...value, error: REAUTHORIZATION_REQUIRED_MESSAGE, reauthorizationRequired: true }));
        else
          setRuntime(value => value.error === REAUTHORIZATION_REQUIRED_MESSAGE
            ? { ...value, error: null, reauthorizationRequired: false } : value);
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
  }, [profileCoordinator, advanceRuntimeActivation]);

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
        gatewayRuntimeVersion: null,
        loading: false,
        serversReady: true,
        serversRevision: 0,
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
    const activationEpoch = refreshActivationEpoch.current;
    const scopeCurrent = () => {
      const current = profileCoordinator.getSnapshot().profiles.find(current => current.id === profile.id);
      return Boolean(activationEpoch === refreshActivationEpoch.current && current &&
        profileCoordinator.isActive(profile.id) && profileAuthorizationScopeKey(current) === authorizationScope);
    };
    if (!scopeCurrent()) return Promise.resolve();
    clearModelCache(profile.id);
    if (forceWorkspaceOptions) clearWorkspaceOptionsCache(profile.id);
    if (!profileCoordinator.isCurrentGrant(profile)) return Promise.resolve();
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
    // Request generations settle one refresh; activation epochs distinguish A -> B -> A owners.
    return profileRefreshGate.run(JSON.stringify([authorizationScope, activationEpoch]), async () => {
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
      // A pairing seed skips the servers GET, so authorize it before publication.
      // Ordinary GETs authorize inside gatewayRequest and share its in-flight check.
      if (bootstrap) {
        try { await ensureGatewayAuthorization(profile); } catch (error) {
          if (authorizationCurrent()) setRuntime(value => authorizationCurrent() ? ({ ...value, loading: false, statusRefreshing: false,
            error: error instanceof Error ? error.message : String(error),
            reauthorizationRequired: error instanceof GatewaySessionExpiredError && profileCoordinator.isCurrentGrant(profile) && profileCoordinator.isAuthorizationDenied(profile) }) : value);
          return;
        }
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
        const expired = error instanceof GatewaySessionExpiredError && profileCoordinator.isCurrentGrant(profile) &&
          profileCoordinator.isAuthorizationDenied(profile);
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
            setRuntime((value) => current() ? ({ ...value, servers, serversReady: true, serversRevision: value.serversRevision + 1, serversUpdatedAt: Date.now(), loading: false, error: null }) : value);
            void retryThreadDeletionCleanup(profile, servers).catch(() => {});
          }
        }).catch((error) => failure(error, "servers")),
        getServerStatusSnapshot(profile).then((snapshot) => {
          if (current()) setRuntime((value) => current() ? ({ ...value, statuses: snapshot.statuses,
            gatewayRuntimeVersion: snapshot.gatewayRuntimeVersion, statusesUpdatedAt: Date.now(),
            statusRefreshing: false, statusError: null }) : value);
        }).catch((error) => failure(error, "statuses")),
      ]);
    });
  }, [activeProfile, demo, profileCoordinator, profileRefreshGate]);

  const refresh = useCallback(() => refreshRuntime(false, true), [refreshRuntime]);

  useEffect(() => {
    if (!hydrated || !activeProfile) return;
    void refreshRuntime(true);
  }, [activeProfile?.id, hydrated, refreshRuntime, refreshActivationRevision]);

  useGatewayRuntimeRecovery({
    owner: JSON.stringify([activeProfile ? profileAuthorizationScopeKey(activeProfile) : null, refreshActivationRevision]),
    enabled: hydrated && !demo && Boolean(activeProfile),
    failed: Boolean(runtime.error || runtime.statusError),
    refreshing: runtime.loading || runtime.statusRefreshing,
    blocked: runtime.reauthorizationRequired,
    refresh: () => refreshRuntime(false),
  });

  useEffect(() => {
    if (!hydrated || demo || Platform.OS !== "web" || typeof window === "undefined") return;
    let disposed = false;
    const changed = (event: StorageEvent) => {
      if (event.key !== PROFILE_INDEX_KEY && event.key !== null) return;
      invalidateProfileHydration();
      initialServerBootstrap.current = null;
      const revision = profileMutationRevision.current;
      const previous = profileCoordinator.getSnapshot();
      const previousScopes = new Map(previous.profiles.map(profile => [profile.id, profileAuthorizationScopeKey(profile)]));
      void profileCoordinator.synchronize().then(next => {
        if (disposed) return;
        const publish = revision === profileMutationRevision.current;
        invalidateProfileHydration();
        if (!publish) return;
        const active = next.profiles.find(profile => profile.id === next.activeId);
        let invalidateActive = previous.activeId !== next.activeId ||
          (previous.activeId ? previousScopes.get(previous.activeId) : undefined) !==
          (active ? profileAuthorizationScopeKey(active) : undefined);
        for (const old of previous.profiles) {
          const current = next.profiles.find(profile => profile.id === old.id);
          if (!current || profileAuthorizationScopeKey(current) !== previousScopes.get(old.id)) {
            clearModelCache(old.id); clearWorkspaceOptionsCache(old.id); taskRuntimeRegistry.removeProfile(old.id);
            if (old.id === previous.activeId) invalidateActive = true;
          }
        }
        if (invalidateActive) { advanceRuntimeActivation(); setRuntime(EMPTY_RUNTIME); }
        setProfiles(next.profiles); setActiveId(next.activeId);
        if (active && profileCoordinator.isAuthorizationDenied(active))
          setRuntime(value => ({ ...value, error: REAUTHORIZATION_REQUIRED_MESSAGE, reauthorizationRequired: true }));
        else
          setRuntime(value => value.error === REAUTHORIZATION_REQUIRED_MESSAGE
            ? { ...value, error: null, reauthorizationRequired: false } : value);
        setProfileHydrationError(null);
      }).catch(error => { if (!disposed && revision === profileMutationRevision.current) setRuntime(current => ({ ...current, error: error instanceof Error ? error.message : String(error) })); });
    };
    window.addEventListener("storage", changed);
    return () => { disposed = true; window.removeEventListener("storage", changed); };
  }, [demo, hydrated, profileCoordinator, invalidateProfileHydration, advanceRuntimeActivation]);

  useEffect(() => {
    if (!activeProfile || !runtime.reauthorizationRequired || demo) return;
    const capturedProfile = { ...activeProfile };
    const denialWitness: GatewayAuthorizationDenialWitness = {
      profileId: capturedProfile.id,
      baseUrl: capturedProfile.baseUrl,
      authMode: capturedProfile.authMode,
      authorizationGeneration: capturedProfile.authorizationGeneration,
      deviceId: capturedProfile.deviceId,
      accessToken: capturedProfile.accessToken,
      refreshToken: capturedProfile.refreshToken,
    };
    let cancelled = false;
    const current = () => !cancelled && profileCoordinator.isActive(capturedProfile.id) &&
      profileCoordinator.isCurrentAuthorizationDenial(denialWitness);
    void sessionTranscriptCache.invalidateProfile(capturedProfile, current).catch(() => {});
    return () => { cancelled = true; };
  }, [activeProfile, runtime.reauthorizationRequired, demo, profileCoordinator]);

  const connectGateway = useCallback(
    async (input: { baseUrl: string; token: string; label?: string; signal?: AbortSignal; connectionRoutes?: GatewayConnectionRoutes }) => {
      if (input.signal?.aborted) return null;
      invalidateProfileHydration();
      const intent = profileCoordinator.beginConnection();
      initialServerBootstrap.current = null;
      let initialServers: KCoderServer[] | undefined;
      let previousCommitOwner: string | undefined;
      const cancelIntent = () => {
        profileCoordinator.cancelConnectionIntent(intent);
        if (initialServerBootstrap.current?.intent === intent) initialServerBootstrap.current = null;
      };
      input.signal?.addEventListener("abort", cancelIntent, { once: true });
      try {
        return await connectGatewayProfile({
          signal: input.signal,
          exchange: async () => {
            const exchanged = await exchangeMobileSessionWithBootstrap(input.baseUrl, input.token, input.label, input.signal, input.connectionRoutes);
            initialServers = exchanged.initialServers;
            return exchanged.profile;
          },
          commit: (profile, onCommit) => profileCoordinator.commitConnection(
            intent,
            profile,
            (profiles, activeId, authority) => {
              // This runs inside the queued commit after its shared-index reload.
              const previous = profileCoordinator.getSnapshot();
              const active = previous.profiles.find(profile => profile.id === previous.activeId);
              previousCommitOwner = JSON.stringify([previous.activeId, active ? profileAuthorizationScopeKey(active) : null]);
              return persistProfiles(profiles, activeId, authority);
            },
            input.signal,
            onCommit,
          ),
          applyCommit: (profile, commit) => {
            if (commit.committed) invalidateProfileHydration();
            let runtimeCleared = false;
            const clearRuntime = () => {
              runtimeCleared = true;
              initialServerBootstrap.current = null;
              advanceRuntimeActivation();
              setRuntime(EMPTY_RUNTIME);
            };
            const appliedProfile = applyProfileConnectionEffects(commit, profile, () => profileCoordinator.isLatestConnectionIntent(intent), {
              setProfiles,
              setActiveId,
              removeProfileRuntimes: (profileId) =>
                taskRuntimeRegistry.removeProfile(profileId),
              clearRuntime,
            });
            if (commit.committed && !runtimeCleared && previousCommitOwner !== undefined) {
              const active = commit.snapshot.profiles.find(profile => profile.id === commit.snapshot.activeId);
              const committedOwner = JSON.stringify([commit.snapshot.activeId, active ? profileAuthorizationScopeKey(active) : null]);
              if (committedOwner !== previousCommitOwner) {
                // An unactivated connection can still replace the active same-host grant.
                setActiveId(commit.snapshot.activeId);
                clearRuntime();
              }
            }
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
    [profileCoordinator, invalidateProfileHydration, advanceRuntimeActivation],
  );

  const markGatewayReauthorizationRequired = useCallback(
    (id: string, capturedAuthorizationScope?: string) => {
      const stillAuthorized = () => {
        const snapshot = profileCoordinator.getSnapshot();
        const profile = snapshot.profiles.find((candidate) => candidate.id === id);
        return snapshot.activeId === id && Boolean(profile && profileCoordinator.isAuthorizationDenied(profile) &&
          (capturedAuthorizationScope === undefined || profileAuthorizationScopeKey(profile) === capturedAuthorizationScope));
      };
      if (!stillAuthorized()) return;
      initialServerBootstrap.current = null;
      refreshGeneration.current += 1;
      setRuntime((current) => stillAuthorized() ? ({
        ...current,
        loading: false,
        statusRefreshing: false,
        error: REAUTHORIZATION_REQUIRED_MESSAGE,
        reauthorizationRequired: true,
      }) : current);
    },
    [profileCoordinator],
  );

  const setActiveProfile = useCallback(
    (id: string) => {
      const pending = activationFlight.current;
      if (pending?.id === id) return pending.promise;
      // A route may request the same activation after connectGateway commits the
      // coordinator but before React state renders. Do not queue another activation,
      // unless another selection is already queued ahead of this request.
      if (!pending && profileCoordinator.isActive(id))
        return Promise.resolve();
      const serial = ++activationIntentSerial.current;
      initialServerBootstrap.current = null;
      invalidateProfileHydration();
      const promise = profileActivationGate.run(JSON.stringify([id, serial]), async () => {
        const next = await profileCoordinator.activate(
          id,
          demo ? async () => {} : persistProfiles,
        );
        if (next.activeId !== id) return;
        invalidateProfileHydration();
        advanceRuntimeActivation();
        setProfiles(next.profiles);
        setActiveId(next.activeId);
        const active = next.profiles.find(profile => profile.id === id);
        setRuntime(active && profileCoordinator.isAuthorizationDenied(active)
          ? { ...EMPTY_RUNTIME, error: REAUTHORIZATION_REQUIRED_MESSAGE, reauthorizationRequired: true }
          : EMPTY_RUNTIME);
      });
      const flight = { id, serial, promise };
      activationFlight.current = flight;
      const clear = () => {
        if (activationFlight.current === flight) activationFlight.current = null;
      };
      void promise.then(clear, clear);
      return promise;
    },
    [demo, profileActivationGate, profileCoordinator, invalidateProfileHydration, advanceRuntimeActivation],
  );

  const removeGateway = useCallback(
    async (id: string) => {
      initialServerBootstrap.current = null;
      invalidateProfileHydration();
      clearModelCache(id);
      clearWorkspaceOptionsCache(id);
      const removedProfile = profileCoordinator.getSnapshot().profiles.find(profile => profile.id === id);
      const removal = await removeGatewayProfile(id, {
        coordinator: profileCoordinator,
        persist: demo ? async () => {} : persistProfiles,
        cleanupProfileState: async (profileId, generation) => {
          if (!demo && removedProfile && generation !== undefined)
            await sessionTranscriptCache.clearRemovedProfile(removedProfile, generation, () => true);
          await removeWorkspaceStatesForProfile(profileId, generation);
        },
        revokeSession: demo ? undefined : revokeMobileSession,
        effects: {
          setProfiles: next => { invalidateProfileHydration(); setProfiles(next); },
          setActiveId,
          removeProfileRuntimes: (profileId) =>
            taskRuntimeRegistry.removeProfile(profileId),
          clearRuntime: () => {
            advanceRuntimeActivation();
            setRuntime(EMPTY_RUNTIME);
          },
          markProfileStateRemoval: markWorkspaceStateRemoval,
        },
      });
      if (removal.remoteRevocation === "unconfirmed") setRuntime(current => ({ ...current, error: "已移除本机连接；远端设备授权未确认撤销，请在目标端设备管理中撤销。" }));
    },
    [demo, profileCoordinator, invalidateProfileHydration, advanceRuntimeActivation],
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
      runtimeActivationEpoch: refreshActivationEpoch.current,
      isCurrentInteractionOwner,
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
      refreshActivationRevision,
      setActiveProfile,
      isCurrentInteractionOwner,
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
