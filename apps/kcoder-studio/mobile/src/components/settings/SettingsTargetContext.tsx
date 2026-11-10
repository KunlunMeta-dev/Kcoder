import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { RefreshCw, Server } from "lucide-react-native";
import { SettingsChoiceSheet, type SettingsChoiceOption } from "@/components/settings/settings-choice-sheet";
import { SettingsGroup, SettingsRow } from "@/components/settings/settings-layout";
import { useLocale } from "@/i18n/use-locale";
import { t } from "@/i18n";
import { GatewaySessionExpiredError } from "@/gateway/http";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { useApp } from "@/state/AppContext";
import { useTheme, useThemedStyles, type ThemeColors, spacing } from "@/theme";
import {
  loadSettingsServerChoice,
  resolveSettingsServerId,
  saveSettingsServerChoice,
  SettingsTargetChangedError,
  SettingsTargetSession,
  SettingsTargetUnavailableError,
  settingsTargetIdentity,
  settingsTargetSelectionStorageKey,
  type SettingsTargetCapabilities,
  type SettingsTargetRpcChannel,
} from "@/runtime/settings-target";

export { SettingsTargetChangedError, SettingsTargetUnavailableError };

export interface SettingsTargetValue {
  profile: GatewayProfile | null;
  server: KCoderServer | null;
  servers: KCoderServer[];
  serverId: string | null;
  targetIdentity: string | null;
  workspacePath: string | undefined;
  selectServer(serverId: string): Promise<void>;
  retry(): void;
  loading: boolean;
  error: string | null;
  ready: boolean;
  capabilities: SettingsTargetCapabilities;
  request<T>(method: string, params?: unknown): Promise<T>;
  readDraft<T>(identity: string, key: string): T | null;
  writeDraft<T>(identity: string, key: string, value: T | null): void;
  subscribeDraft(listener: () => void): () => void;
}

const EMPTY_CAPABILITIES: SettingsTargetCapabilities = {
  gateway: {},
  appServer: null,
};

const SettingsTargetContext = createContext<SettingsTargetValue | null>(null);

interface LocalChoiceState {
  scopeKey: string | null;
  serverId: string | null;
  loaded: boolean;
  error: string | null;
}

interface ConnectionState {
  targetIdentity: string | null;
  phase: "idle" | "loading" | "ready" | "error";
  error: string | null;
}

interface CurrentTarget {
  profile: GatewayProfile;
  server: KCoderServer;
  identity: string;
  profileScopeKey: string;
}

interface OwnedSession {
  identity: string;
  session: SettingsTargetSession;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SettingsTargetProvider({ children }: { children: React.ReactNode }) {
  const app = useApp();
  const profile = app.demo ? null : app.activeProfile;
  const servers = profile && app.runtime.serversReady ? app.runtime.servers : [];
  const profileScopeKey = profile ? settingsTargetSelectionStorageKey(profile) : null;
  const [localChoice, setLocalChoice] = useState<LocalChoiceState>({
    scopeKey: null,
    serverId: null,
    loaded: false,
    error: null,
  });
  const [connection, setConnection] = useState<ConnectionState>({
    targetIdentity: null,
    phase: "idle",
    error: null,
  });
  const [retryRevision, setRetryRevision] = useState(0);
  const [choiceLoadRevision, setChoiceLoadRevision] = useState(0);
  const localChoiceGeneration = useRef(0);
  const choiceWriteGeneration = useRef(0);
  const latestProfileScope = useRef(profileScopeKey);
  const latestProfile = useRef(profile);
  const latestServers = useRef(servers);
  const latestAuthorizationRevoked = useRef(app.runtime.reauthorizationRequired);
  const latestCurrentTarget = useRef<CurrentTarget | null>(null);
  const ownedSession = useRef<OwnedSession | null>(null);
  const providerActive = useRef(true);
  const draftsByTarget = useRef(new Map<string, Map<string, unknown>>());
  const draftListeners = useRef(new Set<() => void>());
  const subscribeDraft = useCallback((listener: () => void) => {
    draftListeners.current.add(listener);
    return () => { draftListeners.current.delete(listener); };
  }, []);

  const readDraft = useCallback(<T,>(identity: string, key: string): T | null => {
    return (draftsByTarget.current.get(identity)?.get(key) as T | undefined) ?? null;
  }, []);
  const writeDraft = useCallback(<T,>(identity: string, key: string, value: T | null) => {
    const targetDrafts = draftsByTarget.current.get(identity);
    if (value === null) {
      targetDrafts?.delete(key);
      if (targetDrafts?.size === 0) draftsByTarget.current.delete(identity);
    } else {
      const nextTargetDrafts = targetDrafts ?? new Map<string, unknown>();
      nextTargetDrafts.set(key, value);
      if (!targetDrafts) draftsByTarget.current.set(identity, nextTargetDrafts);
    }
    if (providerActive.current) for (const listener of draftListeners.current) listener();
  }, []);

  latestProfile.current = profile;
  latestServers.current = servers;
  latestAuthorizationRevoked.current = app.runtime.reauthorizationRequired;
  if (latestProfileScope.current !== profileScopeKey) {
    latestProfileScope.current = profileScopeKey;
    localChoiceGeneration.current += 1;
    choiceWriteGeneration.current += 1;
  }

  const effectiveServerId = localChoice.scopeKey === profileScopeKey && localChoice.loaded
    ? resolveSettingsServerId(servers, localChoice.serverId)
    : null;
  const server = effectiveServerId
    ? servers.find((candidate) => candidate.id === effectiveServerId) ?? null
    : null;
  const targetIdentity = profile && server
    ? settingsTargetIdentity(profile, server, server.workspacePath)
    : null;
  latestCurrentTarget.current = profile && server && targetIdentity && profileScopeKey
    ? { profile, server, identity: targetIdentity, profileScopeKey }
    : null;
  // Routine token rotation keeps the socket while future channel opens use current credentials.
  if (profile && targetIdentity && ownedSession.current?.identity === targetIdentity)
    ownedSession.current.session.updateProfile(profile);

  useEffect(() => {
    const generation = ++localChoiceGeneration.current;
    const capturedScopeKey = profileScopeKey;
    if (!profile || !capturedScopeKey || app.demo) {
      setLocalChoice({ scopeKey: capturedScopeKey, serverId: null, loaded: true, error: null });
      return;
    }
    setLocalChoice((current) => current.scopeKey === capturedScopeKey && current.loaded
      ? current
      : { scopeKey: capturedScopeKey, serverId: null, loaded: false, error: null });
    let live = true;
    void loadSettingsServerChoice(profile).then(
      (savedServerId) => {
        if (!live || generation !== localChoiceGeneration.current || latestProfileScope.current !== capturedScopeKey) return;
        setLocalChoice({ scopeKey: capturedScopeKey, serverId: savedServerId, loaded: true, error: null });
      },
      (error: unknown) => {
        if (!live || generation !== localChoiceGeneration.current || latestProfileScope.current !== capturedScopeKey) return;
        setLocalChoice({
          scopeKey: capturedScopeKey,
          serverId: null,
          loaded: true,
          error: errorMessage(error),
        });
      },
    );
    return () => {
      live = false;
    };
  }, [app.demo, choiceLoadRevision, profileScopeKey]);

  const isCurrentTarget = useCallback((identity: string) => (
    providerActive.current && !latestAuthorizationRevoked.current && latestCurrentTarget.current?.identity === identity
  ), []);

  useEffect(() => {
    providerActive.current = true;
    return () => {
      providerActive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!profile || !server || !targetIdentity || app.demo || app.runtime.reauthorizationRequired) {
      setConnection({ targetIdentity: null, phase: "idle", error: null });
      return;
    }

    const identity = targetIdentity;
    const existing = ownedSession.current?.identity === identity ? ownedSession.current : null;
    const session = existing?.session ?? new SettingsTargetSession(profile, server, () => isCurrentTarget(identity));
    const owned: OwnedSession = existing ?? { identity, session };
    ownedSession.current = owned;
    setConnection({ targetIdentity: identity, phase: "loading", error: null });

    const unsubscribeClose = session.subscribeClose(({ channel }) => {
      if (channel !== "runtime" || ownedSession.current !== owned || !isCurrentTarget(identity)) return;
      setConnection({
        targetIdentity: identity,
        phase: "error",
        error: t("settings_runtime.connection_error"),
      });
    });

    void session.connect("runtime").then(
      () => {
        if (ownedSession.current !== owned || !isCurrentTarget(identity)) return;
        setConnection({ targetIdentity: identity, phase: "ready", error: null });
      },
      (error: unknown) => {
        if (ownedSession.current !== owned || !isCurrentTarget(identity)) return;
        const message = error instanceof GatewaySessionExpiredError
          ? t("settings_runtime.connection_error")
          : errorMessage(error);
        setConnection({ targetIdentity: identity, phase: "error", error: message });
      },
    );

    return () => {
      unsubscribeClose();
      session.close();
      if (ownedSession.current === owned) ownedSession.current = null;
    };
  }, [
    app.demo,
    app.runtime.reauthorizationRequired,
    isCurrentTarget,
    targetIdentity,
    retryRevision,
  ]);

  const selectServer = useCallback(async (serverId: string) => {
    const selectedProfile = latestProfile.current;
    const selectedScope = latestProfileScope.current;
    const selectedServer = latestServers.current.find((candidate) => candidate.id === serverId);
    if (!selectedProfile || !selectedScope || app.demo || !localChoice.loaded || !selectedServer)
      throw new SettingsTargetUnavailableError();
    const identity = settingsTargetIdentity(selectedProfile, selectedServer, selectedServer.workspacePath);
    const writeGeneration = ++choiceWriteGeneration.current;
    const stillCurrent = () => {
      const currentProfile = latestProfile.current;
      const currentServer = latestServers.current.find((candidate) => candidate.id === serverId);
      return writeGeneration === choiceWriteGeneration.current
        && latestProfileScope.current === selectedScope
        && currentProfile !== null
        && currentServer !== undefined
        && settingsTargetIdentity(currentProfile, currentServer, currentServer.workspacePath) === identity;
    };
    try {
      await saveSettingsServerChoice(selectedProfile, serverId, stillCurrent);
    } catch (error) {
      if (writeGeneration === choiceWriteGeneration.current && latestProfileScope.current === selectedScope) {
        setLocalChoice((current) => current.scopeKey === selectedScope
          ? { ...current, error: errorMessage(error) }
          : current);
      }
      throw error;
    }
    if (!stillCurrent()) throw new SettingsTargetChangedError("not-sent");
    setLocalChoice({ scopeKey: selectedScope, serverId, loaded: true, error: null });
  }, [app.demo, localChoice.loaded]);

  const retry = useCallback(() => {
    setRetryRevision((current) => current + 1);
    if (profile && (!app.runtime.serversReady || app.runtime.error)) void app.refresh();
    if (localChoice.error) {
      setLocalChoice((current) => current.scopeKey === profileScopeKey
        ? { ...current, loaded: false, error: null }
        : current);
      setChoiceLoadRevision((current) => current + 1);
    }
  }, [app.refresh, app.runtime.error, app.runtime.serversReady, localChoice.error, profile, profileScopeKey]);

  const capturedIdentity = targetIdentity;
  const request = useCallback(<T,>(method: string, params?: unknown): Promise<T> => {
    if (!capturedIdentity) return Promise.reject(new SettingsTargetUnavailableError());
    const current = latestCurrentTarget.current;
    if (!current || current.identity !== capturedIdentity)
      return Promise.reject(new SettingsTargetChangedError("not-sent"));

    let owner = ownedSession.current;
    if (!owner || owner.identity !== capturedIdentity) {
      const session = new SettingsTargetSession(
        current.profile,
        current.server,
        () => isCurrentTarget(capturedIdentity),
      );
      owner = { identity: capturedIdentity, session };
      ownedSession.current = owner;
    }
    const channel: SettingsTargetRpcChannel = method.startsWith("browser/") ? "browser" : "runtime";
    return owner.session.request<T>(method, params, channel);
  }, [capturedIdentity, isCurrentTarget]);

  const serverListLoading = !app.hydrated
    || Boolean(profile && !app.runtime.error && (!app.runtime.serversReady || app.runtime.loading));
  const currentConnection = connection.targetIdentity === targetIdentity ? connection : null;
  const currentSession = ownedSession.current?.identity === targetIdentity ? ownedSession.current.session : null;
  const ready = Boolean(targetIdentity && !app.runtime.reauthorizationRequired && currentConnection?.phase === "ready" && currentSession);
  const connectionLoading = Boolean(targetIdentity && (!currentConnection || currentConnection.phase === "loading"));
  const loading = serverListLoading || (Boolean(profile) && !localChoice.loaded) || connectionLoading;
  const error = currentConnection?.phase === "error"
    ? currentConnection.error
    : localChoice.scopeKey === profileScopeKey
      ? localChoice.error
      : null;
  const visibleError = error ?? app.runtime.error;
  const capabilities = useMemo<SettingsTargetCapabilities>(() => {
    if (!server) return EMPTY_CAPABILITIES;
    const base = currentSession?.getCapabilities();
    return base ?? { gateway: server.capabilities ?? {}, appServer: null };
  }, [connection, currentSession, server]);

  const value = useMemo<SettingsTargetValue>(() => ({
    profile,
    server,
    servers,
    serverId: server?.id ?? null,
    targetIdentity,
    workspacePath: server?.workspacePath,
    selectServer,
    retry,
    loading,
    error: visibleError,
    ready,
    capabilities,
    request,
    readDraft,
    writeDraft,
    subscribeDraft,
  }), [
    capabilities,
    visibleError,
    loading,
    profile,
    ready,
    request,
    retry,
    selectServer,
    server,
    servers,
    targetIdentity,
    readDraft,
    writeDraft,
    subscribeDraft,
  ]);

  return <SettingsTargetContext.Provider value={value}>{children}</SettingsTargetContext.Provider>;
}

export function useSettingsTarget(): SettingsTargetValue {
  const value = useContext(SettingsTargetContext);
  if (!value) throw new Error("useSettingsTarget 必须在 SettingsTargetProvider 中使用");
  return value;
}

export function SettingsTargetSelector() {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeSelectorStyles);
  const target = useSettingsTarget();
  const [sheetOpen, setSheetOpen] = useState(false);
  const options = useMemo<SettingsChoiceOption<string>[]>(() => target.servers.map((server) => ({
    value: server.id,
    label: server.workspacePath
      ? server.label + " · " + server.workspacePath
      : server.label + " · " + t("settings_runtime.default_workspace"),
    testID: "settings-runtime-target-option-" + server.id,
  })), [target.servers]);
  const canSelect = options.length > 1 || target.server === null;

  const content = !target.profile
    ? <Text accessibilityRole="alert" style={styles.status}>{target.loading ? t("settings_runtime.loading_targets") : t("settings_runtime.no_gateway")}</Text>
    : target.loading && !target.server
      ? <StatusMessage text={t("settings_runtime.loading_targets")} loading />
      : target.servers.length === 0
        ? (
          <>
            <Text accessibilityRole="alert" style={target.error ? styles.error : styles.status}>
              {target.error ?? t("settings_runtime.no_targets")}
            </Text>
            {target.error ? <RetryButton onPress={target.retry} /> : null}
          </>
        )
        : (
          <>
            <SettingsRow
              testID="settings-runtime-target-selector"
              icon={<Server size={19} color={colors.text} />}
              label={t("settings_runtime.selector_label")}
              value={target.server
                ? target.server.label
                : t("settings_runtime.select_target")}
              accessibilityLabel={t("settings_runtime.selector_label")}
              onPress={() => { if (canSelect) setSheetOpen(true); }}
              last={!target.server}
            />
            {target.server ? (
              <View style={styles.workspace}>
                <Text style={styles.workspaceLabel}>{t("settings_runtime.workspace_label")}</Text>
                <Text selectable numberOfLines={2} style={styles.workspacePath}>
                  {target.workspacePath || t("settings_runtime.default_workspace")}
                </Text>
              </View>
            ) : null}
            {target.error ? <Text accessibilityRole="alert" style={styles.error}>{target.error}</Text> : null}
            {target.ready ? <StatusMessage text={t("settings_runtime.connected")} /> : null}
            {target.loading && target.server ? <StatusMessage text={t("settings_runtime.connecting")} loading /> : null}
            {target.error && target.server ? <RetryButton onPress={target.retry} /> : null}
          </>
        );

  return (
    <>
      <SettingsGroup title={t("settings_runtime.selector_title")}>
        {content}
      </SettingsGroup>
      <SettingsChoiceSheet
        visible={sheetOpen}
        testID="settings-runtime-target-choice"
        title={t("settings_runtime.selector_title")}
        options={options}
        selected={target.serverId ?? ""}
        onSelect={(serverId) => { void target.selectServer(serverId).catch(() => {}); }}
        onClose={() => setSheetOpen(false)}
      />
    </>
  );
}

function StatusMessage({ text, loading = false }: { text: string; loading?: boolean }) {
  const styles = useThemedStyles(makeSelectorStyles);
  return (
    <View style={styles.statusLine}>
      {loading ? <ActivityIndicator size="small" /> : null}
      <Text style={styles.status}>{text}</Text>
    </View>
  );
}

function RetryButton({ onPress }: { onPress(): void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeSelectorStyles);
  return (
    <Pressable
      testID="settings-runtime-retry"
      accessibilityRole="button"
      accessibilityLabel={t("settings_runtime.retry")}
      onPress={onPress}
      style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
    >
      <RefreshCw size={16} color={colors.text} />
      <Text style={styles.retryLabel}>{t("settings_runtime.retry")}</Text>
    </Pressable>
  );
}

const makeSelectorStyles = (colors: ThemeColors) => StyleSheet.create({
  statusLine: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg },
  status: { color: colors.textMuted, fontSize: 13, lineHeight: 19, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  error: { color: colors.red, fontSize: 13, lineHeight: 19, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  workspace: { flexDirection: "row", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  workspaceLabel: { color: colors.textDim, fontSize: 12 },
  workspacePath: { flex: 1, color: colors.textMuted, fontSize: 12, textAlign: "right" },
  retry: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, paddingHorizontal: spacing.lg },
  retryLabel: { color: colors.text, fontSize: 13, fontWeight: "600" },
  pressed: { opacity: 0.72 },
});
