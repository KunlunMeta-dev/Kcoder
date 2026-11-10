import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { useIsFocused } from "expo-router";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { ChevronRight, Cloud, Laptop, Plus, RefreshCw, Server } from "lucide-react-native";
import { Button, StatusDot } from "@/components/ui";
import { SettingsGroup, SettingsPage } from "@/components/settings/settings-layout";
import { getGatewayDisplayState } from "@/components/settings/gateway-display-state";
import { useApp } from "@/state/AppContext";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { listMobileDevices, revokeMobileDevice } from "@/gateway/http";
import { requestConfirmation } from "@/platform/confirmation";
import { profileHomeHref } from "@/navigation/back-or-replace";
import { useLocale } from "@/i18n/use-locale";
import { t } from "@/i18n";
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

export default function SettingsConnectionsRoute() {
  const router = useRouter();
  const locale = useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { profiles, activeProfile, runtime, setActiveProfile, removeGateway, refresh, demo, markGatewayReauthorizationRequired } = useApp();
  const isFocused = useIsFocused();
  const mountedRef = useRef(true);
  const isFocusedRef = useRef(isFocused);
  const profilesRef = useRef(profiles);
  const profileActionIntentRef = useRef(0);
  const focusEpochRef = useRef(0);
  const removingIntentRef = useRef<number | null>(null);
  isFocusedRef.current = isFocused;
  profilesRef.current = profiles;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      profileActionIntentRef.current += 1;
    };
  }, []);
  useEffect(() => {
    focusEpochRef.current += 1;
    if (!isFocused) {
      profileActionIntentRef.current += 1;
      deviceRequestIntentRef.current += 1;
      deviceActionIntentRef.current += 1;
      setRevokingDevice(null);
    }
  }, [isFocused]);

  const isCurrentProfileAction = (intent: number, focusEpoch: number) =>
    mountedRef.current && isFocusedRef.current && profileActionIntentRef.current === intent && focusEpochRef.current === focusEpoch;

  const [devicesOpen, setDevicesOpen] = useState(false);
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof listMobileDevices>>>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [devicesOwnerScope, setDevicesOwnerScope] = useState<string | null>(null);
  const [revokingDevice, setRevokingDevice] = useState<string | null>(null);
  const [deviceRevision, setDeviceRevision] = useState(0);
  const devicesOpenRef = useRef(false);
  const deviceRequestIntentRef = useRef(0);
  const deviceActionIntentRef = useRef(0);
  const activeProfileScope = activeProfile ? profileAuthorizationScopeKey(activeProfile) : null;
  const activeProfileScopeRef = useRef(activeProfileScope);
  activeProfileScopeRef.current = activeProfileScope;

  const isCurrentDeviceOwner = (scope: string, intent: number, focusEpoch: number) =>
    mountedRef.current && isFocusedRef.current && devicesOpenRef.current &&
    activeProfileScopeRef.current === scope && deviceActionIntentRef.current === intent && focusEpochRef.current === focusEpoch;

  useEffect(() => {
    if (!devicesOpen || !activeProfile || !activeProfileScope || !isFocused || activeProfile.authMode !== "device") return;
    const scope = activeProfileScope;
    const requestIntent = ++deviceRequestIntentRef.current;
    const controller = new AbortController();
    setDevicesOwnerScope(scope);
    setDevices([]);
    setDevicesLoading(true);
    setDeviceError(null);
    const isCurrentRequest = () => !controller.signal.aborted && mountedRef.current && isFocusedRef.current &&
      devicesOpenRef.current && activeProfileScopeRef.current === scope && deviceRequestIntentRef.current === requestIntent;
    void listMobileDevices(activeProfile, controller.signal)
      .then(value => { if (isCurrentRequest()) setDevices(value); })
      .catch(error => { if (isCurrentRequest()) setDeviceError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (isCurrentRequest()) setDevicesLoading(false); });
    return () => controller.abort();
  }, [devicesOpen, activeProfile, activeProfileScope, isFocused, deviceRevision]);

  const setDeviceListOpen = (open: boolean) => {
    devicesOpenRef.current = open;
    setDevicesOpen(open);
    if (!open) {
      deviceRequestIntentRef.current += 1;
      deviceActionIntentRef.current += 1;
      setDevices([]);
      setDevicesOwnerScope(null);
      setDevicesLoading(false);
      setDeviceError(null);
      setRevokingDevice(null);
    }
  };

  const revokeDevice = async (profile: NonNullable<typeof activeProfile>, scope: string, deviceId: string, intent: number, focusEpoch: number) => {
    if (!isCurrentDeviceOwner(scope, intent, focusEpoch) || revokingDevice) return;
    setRevokingDevice(deviceId);
    setDeviceError(null);
    try {
      await revokeMobileDevice(profile, deviceId);
      if (profile.deviceId === deviceId) markGatewayReauthorizationRequired(profile.id, scope);
      if (!isCurrentDeviceOwner(scope, intent, focusEpoch)) return;
      if (profile.deviceId === deviceId) setDeviceListOpen(false);
      else setDeviceRevision(value => value + 1);
    } catch (error) {
      if (isCurrentDeviceOwner(scope, intent, focusEpoch)) setDeviceError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current && isFocusedRef.current && activeProfileScopeRef.current === scope && deviceActionIntentRef.current === intent && focusEpochRef.current === focusEpoch)
        setRevokingDevice(null);
    }
  };

  const [switchError, setSwitchError] = useState<string | null>(null);
  const switchProfile = async (id: string) => {
    const intent = ++profileActionIntentRef.current;
    const focusEpoch = focusEpochRef.current;
    setSwitchError(null);
    try {
      await setActiveProfile(id);
    } catch (error) {
      if (isCurrentProfileAction(intent, focusEpoch)) setSwitchError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (isCurrentProfileAction(intent, focusEpoch)) router.replace(profileHomeHref(id));
  };

  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const statusById = useMemo(() => new Map(runtime.statuses.map(status => [status.id, status.status])), [runtime.statuses]);

  const remove = async (profile: (typeof profiles)[number]) => {
    const intent = ++profileActionIntentRef.current;
    const focusEpoch = focusEpochRef.current;
    removingIntentRef.current = intent;
    setRemoving(profile.id);
    setRemoveError(null);
    try {
      const stillSaved = profilesRef.current.some(item => item.id === profile.id && profileAuthorizationScopeKey(item) === profileAuthorizationScopeKey(profile));
      if (!stillSaved) throw new Error(t("settings.gateway_changed"));
      await removeGateway(profile.id);
      if (isCurrentProfileAction(intent, focusEpoch) && profilesRef.current.length === 0) router.replace("/welcome");
    } catch (error) {
      if (isCurrentProfileAction(intent, focusEpoch)) setRemoveError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current && removingIntentRef.current === intent) {
        removingIntentRef.current = null;
        setRemoving(null);
      }
    }
  };

  const confirmRemove = (profile: (typeof profiles)[number]) => requestConfirmation({
    title: t("settings.remove_gateway_title"),
    message: t("settings.remove_gateway_message", { label: profile.label || t("settings.remove_gateway_fallback_label"), url: profile.baseUrl }),
    confirmLabel: t("common.remove"),
    destructive: true,
    onConfirm: () => void remove(profile),
  });

  const reauthorize = (profile: (typeof profiles)[number]) => {
    router.push({ pathname: "/welcome", params: { gateway: profile.baseUrl, reauth: profile.id } });
  };

  const setProfileStatus = (profile: (typeof profiles)[number]) => {
    if (activeProfile?.id !== profile.id) return "checking";
    const state = getGatewayDisplayState(activeProfile, runtime);
    return state === "connected" ? "online" : state === "offline" ? "offline" : "checking";
  };
  const profileStatusLabel = (profile: (typeof profiles)[number]) => {
    if (activeProfile?.id !== profile.id) return t("settings.gateway_not_checked");
    if ((profile.expiresAt <= Date.now() && !profile.refreshToken) || runtime.reauthorizationRequired) return t("settings.session_expired");
    const state = getGatewayDisplayState(activeProfile, runtime);
    return state === "connected" ? t("settings.gateway_connected") : state === "checking" ? t("settings.gateway_checking") : t("settings.gateway_not_connected");
  };

  return (
    <SettingsPage title={t("settings.connections")} testID="settings-connections-screen" titleTestID="settings-connections-title">
      <SettingsGroup title={t("settings.saved_gateways")} testID="settings-saved-gateways">
        {profiles.map((profile, index) => {
          const current = activeProfile?.id === profile.id;
          const expired = (profile.expiresAt <= Date.now() && !profile.refreshToken) || (current && runtime.reauthorizationRequired);
          const status = setProfileStatus(profile);
          return (
            <View key={profile.id}>
              <Pressable
                testID={`settings-gateway-${profile.id}`}
                accessibilityRole="button"
                accessibilityLabel={current ? t("settings.current_gateway_label", { label: profile.label }) : expired ? t("settings.reauthorize_label", { label: profile.label }) : t("settings.switch_to_label", { label: profile.label })}
                accessibilityState={{ disabled: current }}
                disabled={current}
                onPress={() => expired ? reauthorize(profile) : void switchProfile(profile.id)}
                style={({ pressed }) => [styles.profileButton, index > 0 && styles.divider, pressed && !current && styles.pressed]}
              >
                <View style={styles.profileTitleRow}>
                  {current ? <StatusDot status={status} /> : null}
                  <Text numberOfLines={1} style={styles.profileTitle}>{profile.label}</Text>
                  {current ? <Text style={styles.currentBadge}>{t("settings.gateway_in_use")}</Text> : null}
                </View>
                <Text numberOfLines={1} style={styles.profileUrl}>{profile.baseUrl}</Text>
                <Text style={[styles.profileSession, expired && styles.expired]}>{expired ? t("settings.session_expired_reauth") : profileStatusLabel(profile)}</Text>
                <Text style={styles.profileAuth}>{profile.authMode === "device" ? t("settings.device_auth_saved") : t("settings.temporary_auth")}</Text>
              </Pressable>
              <View style={styles.profileActions}>
                {expired ? <Pressable testID={`reauthorize-profile-${profile.id}`} accessibilityRole="button" accessibilityLabel={t("settings.reauthorize_label", { label: profile.label })} onPress={() => reauthorize(profile)} style={styles.reauthorize}><RefreshCw size={16} color={colors.text} /><Text style={styles.actionText}>{t("settings.authorize")}</Text></Pressable> : null}
                <Button testID={`remove-profile-${profile.id}`} variant="ghost" loading={removing === profile.id} onPress={() => confirmRemove(profile)}><Text style={styles.remove}>{t("common.remove")}</Text></Button>
              </View>
            </View>
          );
        })}
        {profiles.length === 0 ? <Text style={styles.empty}>{t("settings.no_gateways")}</Text> : null}
      </SettingsGroup>
      {switchError ? <Text accessibilityRole="alert" style={styles.error}>{t("settings.switch_gateway_error", { error: switchError })}</Text> : null}
      {removeError ? <Text accessibilityRole="alert" style={styles.error}>{removeError}</Text> : null}

      {activeProfile ? <>
        <SettingsGroup title={t("settings.hosts")} testID="settings-servers">
          {runtime.servers.map((server, index) => {
            const status = statusById.get(server.id) ?? "checking";
            return (
              <Pressable key={server.id} testID={`settings-host-${server.id}`} accessibilityRole="button" onPress={() => router.push({ pathname: "/host-details", params: { profileId: activeProfile.id, serverId: server.id } } as never)} style={({ pressed }) => [styles.hostRow, index > 0 && styles.divider, pressed && styles.pressed]}>
                <View style={styles.iconBox}>{server.transport === "ssh" ? <Server size={20} color={colors.text} /> : <Laptop size={20} color={colors.text} />}</View>
                <View style={styles.hostCopy}><Text style={styles.hostTitle}>{server.label}</Text><Text numberOfLines={2} style={styles.hostMeta}>{server.description || server.workspacePath || t(server.transport === "ssh" ? "settings.transport_ssh" : "settings.transport_local")}</Text></View>
                <StatusDot status={status} />
                <ChevronRight size={20} color={colors.textDim} />
                {index < runtime.servers.length - 1 ? <View style={styles.rowDivider} /> : null}
              </Pressable>
            );
          })}
          {runtime.servers.length === 0 ? <Text style={styles.empty}>{t("settings.no_hosts")}</Text> : null}
        </SettingsGroup>
        <Pressable testID="settings-add-connection" accessibilityRole="button" onPress={() => router.push("/server-editor" as never)} style={({ pressed }) => [styles.actionRow, pressed && styles.pressed]}>
          <Plus size={20} color={colors.textMuted} /><Text style={styles.actionRowText}>{t("settings.add_connection")}</Text><ChevronRight size={20} color={colors.textDim} />
        </Pressable>

        {activeProfile.authMode === "device" ? <SettingsGroup title={t("settings.device_authorizations")} testID="settings-device-authorizations">
          <Pressable testID="mobile-devices-toggle" accessibilityRole="button" accessibilityState={{ expanded: devicesOpen }} onPress={() => setDeviceListOpen(!devicesOpen)} style={({ pressed }) => [styles.deviceToggle, pressed && styles.pressed]}>
            <View style={styles.iconBox}><Cloud size={20} color={colors.text} /></View>
            <Text style={styles.deviceToggleText}>{devicesOpen ? t("settings.collapse_devices") : t("settings.manage_devices")}</Text>
            <ChevronRight size={20} color={colors.textDim} />
          </Pressable>
          {devicesOpen && devicesOwnerScope === activeProfileScope && devicesLoading ? <ActivityIndicator color={colors.textMuted} style={styles.loader} /> : null}
          {devicesOpen && devicesOwnerScope === activeProfileScope ? devices.map(device => {
            const capturedProfile = activeProfile;
            const capturedScope = profileAuthorizationScopeKey(activeProfile);
            const capturedFocusEpoch = focusEpochRef.current;
            return (
              <View key={device.id} style={styles.deviceRow}>
                <View style={styles.hostCopy}><Text style={styles.hostTitle}>{device.label}{device.id === capturedProfile.deviceId ? t("settings.current_device") : ""}</Text><Text style={styles.hostMeta}>{t("settings.last_used", { date: new Date(device.lastUsedAt).toLocaleString(locale) })}</Text></View>
                <Button testID={`revoke-mobile-device-${device.id}`} variant="ghost" loading={revokingDevice === device.id && devicesOwnerScope === activeProfileScope} disabled={Boolean(revokingDevice && devicesOwnerScope === activeProfileScope)} onPress={() => {
                  const intent = ++deviceActionIntentRef.current;
                  requestConfirmation({ title: t("settings.revoke_device_title"), message: t("settings.revoke_device_message"), confirmLabel: t("settings.revoke"), destructive: true, onConfirm: () => void revokeDevice(capturedProfile, capturedScope, device.id, intent, capturedFocusEpoch) });
                }}><Text style={styles.remove}>{t("settings.revoke")}</Text></Button>
              </View>
            );
          }) : null}
          {devicesOpen && devicesOwnerScope === activeProfileScope && deviceError ? <Text accessibilityRole="alert" style={styles.error}>{deviceError}</Text> : null}
        </SettingsGroup> : null}
      </> : null}
      <Pressable testID="settings-add-gateway" accessibilityRole="button" onPress={() => router.push({ pathname: "/welcome", params: { connectMode: "direct" } })} style={({ pressed }) => [styles.actionRow, pressed && styles.pressed]}>
        <Plus size={20} color={colors.textMuted} /><Text style={styles.actionRowText}>{t("settings.add_gateway")}</Text><ChevronRight size={20} color={colors.textDim} />
      </Pressable>
      {demo ? <Text style={styles.demo}>{t("settings.demo_note")}</Text> : null}
    </SettingsPage>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  profileButton: { minHeight: 88, justifyContent: "center", paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.xs },
  profileTitleRow: { minHeight: 24, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  profileTitle: { flexShrink: 1, color: colors.text, fontSize: 16, fontWeight: "600" },
  currentBadge: { color: colors.accentText, backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, fontSize: 11, fontWeight: "600", overflow: "hidden" },
  profileUrl: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
  profileSession: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  profileAuth: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
  profileActions: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.xs },
  reauthorize: { minWidth: 80, minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs, borderRadius: radius.pill, backgroundColor: colors.surfaceHover },
  actionText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  remove: { color: colors.red, fontSize: 13, fontWeight: "600" },
  hostRow: { position: "relative", minHeight: 68, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  iconBox: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  hostCopy: { flex: 1, minWidth: 0 },
  hostTitle: { color: colors.text, fontSize: 15, fontWeight: "500" },
  hostMeta: { color: colors.textDim, fontSize: 12, lineHeight: 17, marginTop: 2 },
  rowDivider: { position: "absolute", left: 56, right: spacing.lg, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  actionRow: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, borderRadius: radius.settingsGroup, backgroundColor: colors.settingsGroupBackground },
  actionRowText: { flex: 1, color: colors.text, fontSize: 16 },
  deviceToggle: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg },
  deviceToggleText: { flex: 1, color: colors.text, fontSize: 15 },
  deviceRow: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  loader: { padding: spacing.lg },
  error: { color: colors.red, fontSize: 13, lineHeight: 19, marginHorizontal: spacing.sm },
  empty: { color: colors.textMuted, fontSize: 14, textAlign: "center", padding: spacing.xl },
  expired: { color: colors.red },
  pressed: { opacity: 0.72 },
  demo: { color: colors.yellow, fontSize: 12, lineHeight: 18, textAlign: "center" },
});
