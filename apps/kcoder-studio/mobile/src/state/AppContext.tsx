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
  exchangeMobileSession,
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
import { taskRuntimeRegistry } from "@/runtime/task-runtime";
import { removeWorkspaceStatesForProfile } from "@/storage/workspace-preferences";
import {
  loadProfiles,
  migrateLegacyWebProfiles,
  persistProfiles,
} from "@/storage/profile-store";
import {
  ProfileCoordinator,
  ProfileOperationGate,
} from "./profile-coordinator";

interface ProfileRuntime {
  servers: KCoderServer[];
  statuses: ServerStatus[];
  loading: boolean;
  error: string | null;
  reauthorizationRequired: boolean;
}

interface AppContextValue {
  hydrated: boolean;
  demo: boolean;
  profiles: GatewayProfile[];
  activeProfile: GatewayProfile | null;
  runtime: ProfileRuntime;
  setActiveProfile(id: string): Promise<void>;
  connectGateway(input: {
    baseUrl: string;
    token: string;
    label?: string;
  }): Promise<GatewayProfile>;
  markGatewayReauthorizationRequired(id: string): void;
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
  const [profiles, setProfiles] = useState<GatewayProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<ProfileRuntime>(EMPTY_RUNTIME);
  const refreshGeneration = useRef(0);
  const profileCoordinator = useRef(new ProfileCoordinator()).current;
  const profileActivationGate = useRef(new ProfileOperationGate()).current;
  const profileRefreshGate = useRef(new ProfileOperationGate()).current;

  useEffect(() => {
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
        error: null,
        reauthorizationRequired: false,
      });
      setHydrated(true);
      return;
    }
    void loadProfiles()
      .then(async (stored) => {
        const restored =
          stored.profiles.length > 0
            ? stored
            : Platform.OS === "web"
              ? ((await migrateLegacyWebProfiles()) ?? stored)
              : stored;
        profileCoordinator.hydrate(restored);
        setProfiles(restored.profiles);
        setActiveId(restored.activeId);
      })
      .catch(() => {
        profileCoordinator.hydrate({ profiles: [], activeId: null });
        setProfiles([]);
        setActiveId(null);
      })
      .finally(() => setHydrated(true));
  }, [profileCoordinator]);

  const activeProfile = useMemo(
    () =>
      profiles.find((profile) => profile.id === activeId) ??
      profiles[0] ??
      null,
    [activeId, profiles],
  );

  const refresh = useCallback((): Promise<void> => {
    if (demo || !activeProfile) return Promise.resolve();
    if (activeProfile.expiresAt <= Date.now()) {
      refreshGeneration.current += 1;
      setRuntime((current) => ({
        ...current,
        loading: false,
        error: "Gateway 会话已失效，请重新授权",
        reauthorizationRequired: true,
      }));
      return Promise.resolve();
    }
    const profile = activeProfile;
    return profileRefreshGate.run(profile.id, async () => {
      const generation = ++refreshGeneration.current;
      setRuntime((current) => ({
        ...current,
        loading: true,
        error: null,
        reauthorizationRequired: false,
      }));
      try {
        const [servers, statuses] = await Promise.all([
          listServers(profile),
          listServerStatuses(profile),
        ]);
        if (generation === refreshGeneration.current) {
          setRuntime({
            servers,
            statuses,
            loading: false,
            error: null,
            reauthorizationRequired: false,
          });
        }
      } catch (error) {
        if (generation === refreshGeneration.current) {
          setRuntime((current) => ({
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
            reauthorizationRequired:
              error instanceof GatewaySessionExpiredError,
          }));
        }
      }
    });
  }, [activeProfile, demo, profileRefreshGate]);

  useEffect(() => {
    if (!hydrated || !activeProfile) return;
    void refresh();
  }, [activeProfile?.id, hydrated, refresh]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const connectGateway = useCallback(
    async (input: { baseUrl: string; token: string; label?: string }) => {
      const intent = profileCoordinator.beginConnection();
      const profile = await exchangeMobileSession(
        input.baseUrl,
        input.token,
        input.label,
      );
      const next = await profileCoordinator.commitConnection(
        intent,
        profile,
        persistProfiles,
      );
      const committedProfile =
        next.profiles.find((item) => item.baseUrl === profile.baseUrl) ??
        profile;
      if (committedProfile.id !== profile.id)
        taskRuntimeRegistry.removeProfile(committedProfile.id);
      setProfiles(next.profiles);
      setActiveId(next.activeId);
      if (next.activeId === committedProfile.id) {
        refreshGeneration.current += 1;
        setRuntime(EMPTY_RUNTIME);
      }
      return committedProfile;
    },
    [profileCoordinator],
  );

  const markGatewayReauthorizationRequired = useCallback(
    (id: string) => {
      if (activeId !== id) return;
      refreshGeneration.current += 1;
      setRuntime((current) => ({
        ...current,
        loading: false,
        error: "Gateway 会话已失效，请重新授权",
        reauthorizationRequired: true,
      }));
    },
    [activeId],
  );

  const setActiveProfile = useCallback(
    (id: string) => {
      // A route may request the same activation after connectGateway commits the
      // coordinator but before React state renders. Do not queue another activation,
      // which would later clear the runtime that just loaded.
      if (activeId === id || profileCoordinator.isActive(id))
        return Promise.resolve();
      return profileActivationGate.run(id, async () => {
        const next = await profileCoordinator.activate(
          id,
          demo ? async () => {} : persistProfiles,
        );
        if (next.activeId !== id) return;
        refreshGeneration.current += 1;
        setProfiles(next.profiles);
        setActiveId(next.activeId);
        setRuntime(EMPTY_RUNTIME);
      });
    },
    [activeId, demo, profileActivationGate, profileCoordinator],
  );

  const removeGateway = useCallback(
    async (id: string) => {
      const removed = profiles.find((profile) => profile.id === id);
      // Close the local runtime first so a removed gateway cannot reconnect or retain PTY/browser RPCs.
      taskRuntimeRegistry.removeProfile(id);
      await removeWorkspaceStatesForProfile(id);
      if (removed && !demo) {
        try {
          await revokeMobileSession(removed);
        } catch {
          // A stale remote session cannot block local deletion.
        }
      }
      const next = await profileCoordinator.remove(
        id,
        demo ? async () => {} : persistProfiles,
      );
      refreshGeneration.current += 1;
      setProfiles(next.profiles);
      setActiveId(next.activeId);
      setRuntime(EMPTY_RUNTIME);
    },
    [demo, profileCoordinator, profiles],
  );

  const value = useMemo<AppContextValue>(
    () => ({
      hydrated,
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
