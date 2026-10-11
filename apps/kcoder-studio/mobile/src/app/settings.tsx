import { listMobileDevices, revokeMobileDevice } from "@/gateway/http";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Keyboard,
  Laptop,
  Mic,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Server,
  Stethoscope,
  Sun,
  TerminalSquare,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, StatusDot } from "@/components/ui";
import { useApp } from "@/state/AppContext";
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { requestConfirmation } from "@/platform/confirmation";
import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { getAppPreferencesSnapshot, subscribeAppPreferences, updateAppPreferences } from "@/storage/app-preferences";
import { backOrReplace, profileHomeHref } from "@/navigation/back-or-replace";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";

export default function SettingsRoute() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
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
    if (!isFocused) profileActionIntentRef.current += 1;
  }, [isFocused]);

  const isCurrentProfileAction = (intent: number, focusEpoch: number) =>
    mountedRef.current &&
    isFocusedRef.current &&
    profileActionIntentRef.current === intent &&
    focusEpochRef.current === focusEpoch;

  const [devicesOpen, setDevicesOpen] = useState(false);
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof listMobileDevices>>>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [revokingDevice, setRevokingDevice] = useState<string | null>(null);
  const [deviceRevision, setDeviceRevision] = useState(0);
  useEffect(() => {
    if (!devicesOpen || !activeProfile || !isFocused || activeProfile.authMode !== "device") return;
    const controller = new AbortController(); setDevicesLoading(true); setDeviceError(null);
    void listMobileDevices(activeProfile, controller.signal).then(value => { if (!controller.signal.aborted) setDevices(value); }).catch(error => { if (!controller.signal.aborted) setDeviceError(error instanceof Error ? error.message : String(error)); }).finally(() => { if (!controller.signal.aborted) setDevicesLoading(false); });
    return () => controller.abort();
  }, [devicesOpen, activeProfile?.id, activeProfile?.authorizationGeneration, isFocused, deviceRevision]);
  const revokeDevice = async (deviceId: string) => {
    const profile = activeProfile; if (!profile || revokingDevice) return;
    setRevokingDevice(deviceId); setDeviceError(null);
    try {
      await revokeMobileDevice(profile, deviceId);
      if (profile.deviceId === deviceId) { markGatewayReauthorizationRequired(profile.id); setDevicesOpen(false); }
      else setDeviceRevision(value => value + 1);
    } catch (error) { setDeviceError(error instanceof Error ? error.message : String(error)); }
    finally { setRevokingDevice(null); }
  };

  const [switchError, setSwitchError] = useState<string | null>(null);
  const switchProfile = async (id: string) => {
    const intent = ++profileActionIntentRef.current;
    const focusEpoch = focusEpochRef.current;
    setSwitchError(null);
    try {
      await setActiveProfile(id);
    } catch (value) {
      if (isCurrentProfileAction(intent, focusEpoch))
        setSwitchError(value instanceof Error ? value.message : String(value));
      return;
    }
    if (!isCurrentProfileAction(intent, focusEpoch)) return;
    router.replace(profileHomeHref(id));
  };
  const appPreferences = useSyncExternalStore(subscribeAppPreferences, getAppPreferencesSnapshot, getAppPreferencesSnapshot);
  const [detail, setDetail] = useState<"terminal" | "diagnostics" | null>(null);
  const closeDetail = () => setDetail(null);
  const detailRef = useModalFocusTrap(Boolean(detail), closeDetail);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const statusById = useMemo(
    () => new Map(runtime.statuses.map((status) => [status.id, status.status])),
    [runtime.statuses],
  );

  const remove = async (id: string) => {
    const intent = ++profileActionIntentRef.current;
    const focusEpoch = focusEpochRef.current;
    removingIntentRef.current = intent;
    setRemoving(id);
    setRemoveError(null);
    try {
      await removeGateway(id);
      if (
        isCurrentProfileAction(intent, focusEpoch) &&
        profilesRef.current.length === 0
      )
        router.replace("/welcome");
    } catch (value) {
      if (isCurrentProfileAction(intent, focusEpoch))
        setRemoveError(value instanceof Error ? value.message : String(value));
    } finally {
      if (mountedRef.current && removingIntentRef.current === intent) {
        removingIntentRef.current = null;
        setRemoving(null);
      }
    }
  };

  const confirmRemove = (id: string) => {
    const profile = profiles.find((item) => item.id === id);
    requestConfirmation({
      title: t("settings.remove_gateway_title"),
      message: t("settings.remove_gateway_message", {
        label: profile?.label ?? t("settings.remove_gateway_fallback_label"),
        url: profile?.baseUrl ?? "",
      }),
      confirmLabel: t("common.remove"),
      destructive: true,
      onConfirm: () => void remove(id),
    });
  };

  const reauthorize = (profile: (typeof profiles)[number]) => {
    router.push({ pathname: "/welcome", params: { gateway: profile.baseUrl, reauth: profile.id } });
  };

  const profileStatus = (id: string, expiresAt: number): "online" | "offline" | "checking" => {
    if (expiresAt <= Date.now() || activeProfile?.id !== id) return "offline";
    if (runtime.loading) return "checking";
    if (runtime.error) return "offline";
    return runtime.statuses.some((status) => status.status === "online") ? "online" : "offline";
  };

  const sessionLabel = (id: string, expiresAt: number): string => {
    if (expiresAt <= Date.now()) return t("settings.session_expired");
    if (activeProfile?.id !== id) return t("settings.tap_to_switch");
    const minutes = Math.max(1, Math.ceil((expiresAt - Date.now()) / 60_000));
    return minutes < 60
      ? t("settings.session_active_minutes", { minutes })
      : t("settings.session_active_hours", { hours: Math.ceil(minutes / 60) });
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable accessibilityLabel={t("common.back")} onPress={() => backOrReplace(router, profileHomeHref(activeProfile?.id))} style={styles.headerButton}><ChevronLeft size={21} color={colors.textMuted} /></Pressable>
        <Text style={styles.headerTitle}>{t("common.settings")}</Text>
        <View style={styles.headerButton} />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}>
        <SectionHeader title={t("settings.hosts")} />
        <View style={styles.hostList}>
          {runtime.servers.map((server) => {
            const status = statusById.get(server.id) ?? "checking";
            return (
              <Pressable key={server.id} testID={`settings-host-${server.id}`} accessibilityRole="button" onPress={() => router.push({ pathname: "/host-details", params: { serverId: server.id } } as never)} style={({ pressed }) => [styles.hostCard, pressed && styles.pressed]}>
                <View style={styles.hostIcon}>{server.transport === "ssh" ? <Server size={18} color={colors.textMuted} /> : <Laptop size={18} color={colors.textMuted} />}</View>
                <View style={styles.hostCopy}><Text style={styles.hostTitle}>{server.label}</Text><Text numberOfLines={1} style={styles.hostMeta}>{server.description || server.workspacePath || t(server.transport === "ssh" ? "settings.transport_ssh" : "settings.transport_local")}</Text></View>
                <StatusDot status={status} />
                <Text style={styles.hostKind}>{t(server.transport === "ssh" ? "settings.transport_ssh" : "settings.transport_local")}</Text>
                <ChevronRight size={16} color={colors.textDim} />
              </Pressable>
            );
          })}
          {runtime.servers.length === 0 ? <View style={styles.hostCard}><Text style={styles.empty}>{t("settings.no_hosts")}</Text></View> : null}
        </View>
        <Pressable accessibilityRole="button" onPress={() => router.push("/server-editor" as never)} style={styles.addConnection}><Plus size={17} color={colors.textMuted} /><Text style={styles.addConnectionText}>{t("settings.add_connection")}</Text></Pressable>

        <SectionHeader title={t("settings.appearance")} />
        <View style={styles.settingsCard}>
          <View style={[styles.appearanceRow, styles.appearanceRowBorder]}>
            <View style={styles.appearanceCopy}><Text style={styles.rowLabel}>{t("settings.language")}</Text><Text style={styles.note}>{t("settings.language_note")}</Text></View>
            <View style={styles.segmented}>
              <AppearanceButton testID="settings-language-system" label={t("settings.language_system")} selected={appPreferences.language === "system"} textual onPress={() => updateAppPreferences({ language: "system" })}><Text style={[styles.segmentText, appPreferences.language === "system" && styles.segmentTextSelected]}>{t("settings.language_system")}</Text></AppearanceButton>
              <AppearanceButton testID="settings-language-en" label={t("settings.language_english")} selected={appPreferences.language === "en"} textual onPress={() => updateAppPreferences({ language: "en" })}><Text style={[styles.segmentText, appPreferences.language === "en" && styles.segmentTextSelected]}>{t("settings.language_english")}</Text></AppearanceButton>
              <AppearanceButton testID="settings-language-zh-cn" label={t("settings.language_simplified_chinese")} selected={appPreferences.language === "zh-CN"} textual onPress={() => updateAppPreferences({ language: "zh-CN" })}><Text style={[styles.segmentText, appPreferences.language === "zh-CN" && styles.segmentTextSelected]}>{t("settings.language_simplified_chinese")}</Text></AppearanceButton>
            </View>
          </View>
          <View style={styles.appearanceRow}>
            <View style={styles.appearanceCopy}><Text style={styles.rowLabel}>{t("settings.theme")}</Text><Text style={styles.note}>{t("settings.theme_note")}</Text></View>
            <View style={styles.segmented}>
              <AppearanceButton testID="settings-theme-light" label={t("settings.theme_light")} selected={appPreferences.theme === "light"} onPress={() => updateAppPreferences({ theme: "light" })}><Sun size={15} color={appPreferences.theme === "light" ? colors.text : colors.textDim} /></AppearanceButton>
              <AppearanceButton testID="settings-theme-dark" label={t("settings.theme_dark")} selected={appPreferences.theme === "dark"} onPress={() => updateAppPreferences({ theme: "dark" })}><Moon size={15} color={appPreferences.theme === "dark" ? colors.text : colors.textDim} /></AppearanceButton>
              <AppearanceButton testID="settings-theme-system" label={t("settings.theme_system")} selected={appPreferences.theme === "system"} onPress={() => updateAppPreferences({ theme: "system" })}><Monitor size={15} color={appPreferences.theme === "system" ? colors.text : colors.textDim} /></AppearanceButton>
            </View>
          </View>
        </View>

        <SectionHeader title={t("settings.gateway")} />
        <View style={styles.settingsCard}>
          {profiles.map((profile, index) => {
            const expired = (profile.expiresAt <= Date.now() && !profile.refreshToken) || (activeProfile?.id === profile.id && runtime.reauthorizationRequired);
            return <View key={profile.id} style={[styles.profile, index > 0 && styles.divider]}>
              <Pressable accessibilityRole="button" accessibilityLabel={expired ? t("settings.reauthorize_label", { label: profile.label }) : t("settings.switch_to_label", { label: profile.label })} style={styles.profileCopy} onPress={() => expired ? reauthorize(profile) : void switchProfile(profile.id)}>
                <View style={styles.profileTitleRow}><StatusDot status={profileStatus(profile.id, profile.expiresAt)} /><Text style={styles.profileTitle}>{profile.label}</Text></View>
                <Text style={styles.profileUrl}>{profile.baseUrl}</Text>
                <Text style={[styles.profileSession, expired && styles.expired]}>{expired ? t("settings.session_expired_reauth") : profile.authMode === "device" ? t("settings.device_auth_saved") : t("settings.temporary_auth")}</Text>
              </Pressable>
              {expired ? <Pressable testID={`reauthorize-profile-${profile.id}`} accessibilityRole="button" accessibilityLabel={t("settings.reauthorize_label", { label: profile.label })} onPress={() => reauthorize(profile)} style={styles.reauthorize}><RefreshCw size={15} color={colors.text} /><Text style={styles.reauthorizeText}>{t("settings.authorize")}</Text></Pressable> : null}
              <Button variant="ghost" loading={removing === profile.id} onPress={() => confirmRemove(profile.id)}><Text style={styles.remove}>{t("common.remove")}</Text></Button>
            </View>;
          })}
          {profiles.length === 0 ? <Text style={styles.empty}>{t("settings.no_gateways")}</Text> : null}
        </View>
        {activeProfile?.authMode === "device" ? <View style={styles.settingsCard}>
          <Button testID="mobile-devices-toggle" variant="ghost" onPress={() => setDevicesOpen(value => !value)}><Text style={styles.rowLabel}>{devicesOpen ? t("settings.collapse_devices") : t("settings.manage_devices")}</Text></Button>
          {devicesOpen && devicesLoading ? <ActivityIndicator color={colors.textMuted} /> : null}
          {devicesOpen ? devices.map(device => <View key={device.id} style={styles.profile}>
            <View style={styles.profileCopy}><Text style={styles.profileTitle}>{device.label}{device.id === activeProfile.deviceId ? t("settings.current_device") : ""}</Text><Text style={styles.note}>{t("settings.last_used", { date: new Date(device.lastUsedAt).toLocaleString(locale) })}</Text></View>
            <Button testID={`revoke-mobile-device-${device.id}`} variant="ghost" loading={revokingDevice === device.id} disabled={Boolean(revokingDevice)} onPress={() => requestConfirmation({ title: t("settings.revoke_device_title"), message: t("settings.revoke_device_message"), confirmLabel: t("settings.revoke"), destructive: true, onConfirm: () => void revokeDevice(device.id) })}><Text style={styles.remove}>{t("settings.revoke")}</Text></Button>
          </View>) : null}
          {deviceError ? <Text accessibilityRole="alert" style={styles.removeError}>{deviceError}</Text> : null}
        </View> : null}
        {switchError ? <Text accessibilityRole="alert" style={styles.switchError}>{t("settings.switch_gateway_error", { error: switchError })}</Text> : null}
        {removeError ? <Text style={styles.removeError}>{removeError}</Text> : null}
        <Pressable accessibilityRole="button" onPress={() => router.push("/welcome")} style={styles.addConnection}><Plus size={17} color={colors.textMuted} /><Text style={styles.addConnectionText}>{t("settings.add_gateway")}</Text></Pressable>

        <SectionHeader title={t("settings.application")} />
        <View style={styles.settingsCard}>
          <SettingsRow testID="terminal-settings" icon={<TerminalSquare size={18} color={colors.textMuted} />} label={t("settings.terminal")} value={t("settings.scrollback_lines", { count: appPreferences.terminalScrollbackLines.toLocaleString() })} onPress={() => setDetail("terminal")} />
          <SettingsRow icon={<Keyboard size={18} color={colors.textMuted} />} label={t("settings.shortcuts")} note={t("settings.shortcuts_note")} />
          <SettingsRow icon={<Bell size={18} color={colors.textMuted} />} label={t("settings.notifications")} note={t("settings.notifications_note")} />
          <SettingsRow icon={<Mic size={18} color={colors.textMuted} />} label={t("settings.voice_dictation")} note={t("settings.voice_note")} />
          <SettingsRow icon={<Cloud size={18} color={colors.textMuted} />} label={t("settings.schedules")} note={t("settings.schedules_note")} />
          <SettingsRow testID="diagnostics-settings" icon={<Stethoscope size={18} color={colors.textMuted} />} label={t("settings.diagnostics")} value={runtime.error ? t("settings.diagnostics_has_error") : t("settings.diagnostics_ok")} onPress={() => setDetail("diagnostics")} last />
        </View>
        {demo ? <Text style={styles.demo}>{t("settings.demo_note")}</Text> : null}
        <Text style={styles.version}>{t("settings.version_footer")}</Text>
      </ScrollView>
      <Modal visible={Boolean(detail)} transparent animationType={Platform.OS === "web" ? "none" : "slide"} accessibilityLabel={detail === "terminal" ? t("settings.terminal_settings") : t("settings.connection_diagnostics")} onRequestClose={closeDetail}>
        <Pressable accessibilityLabel={t("settings.close_settings_detail")} style={styles.sheetOverlay} onPress={closeDetail} />
        <View ref={detailRef} role="dialog" accessibilityViewIsModal style={[styles.detailSheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
          <View style={styles.detailHeader}><Text style={styles.detailTitle}>{detail === "terminal" ? t("settings.terminal_settings") : t("settings.connection_diagnostics")}</Text><Pressable accessibilityLabel={t("common.close")} onPress={closeDetail} style={styles.detailClose}><X size={20} color={colors.textMuted} /></Pressable></View>
          <ScrollView showsVerticalScrollIndicator style={styles.detailScroller} contentContainerStyle={styles.detailScroll}>{detail === "terminal" ? <>
            <Text style={styles.detailDescription}>{t("settings.terminal_settings_description")}</Text>
            <Text style={styles.detailLabel}>{t("settings.scrollback_buffer")}</Text>
            <View style={styles.optionGrid}>{[1_000, 5_000, 10_000, 50_000, 100_000].map((lines) => {
              const checked = appPreferences.terminalScrollbackLines === lines;
              const webRadioProps = Platform.OS === "web" ? ({ "aria-checked": checked } as const) : {};
              return <Pressable {...webRadioProps} key={lines} accessibilityRole="radio" accessibilityState={{ checked }} onPress={() => updateAppPreferences({ terminalScrollbackLines: lines })} style={[styles.optionButton, checked && styles.optionSelected]}><Text style={[styles.optionText, checked && styles.optionTextSelected]}>{lines.toLocaleString()}</Text></Pressable>;
            })}</View>
            <Text style={styles.detailFootnote}>{t("settings.scrollback_footnote")}</Text>
          </> : <>
            <View style={styles.diagnosticSummary}><View style={[styles.diagnosticLight, runtime.error ? styles.diagnosticBad : styles.diagnosticGood]} /><View style={styles.diagnosticCopy}><Text style={styles.diagnosticTitle}>{runtime.error ? t("settings.diagnostics_bad") : runtime.loading ? t("settings.diagnostics_checking") : t("settings.diagnostics_good")}</Text><Text selectable style={styles.diagnosticEndpoint}>{activeProfile?.baseUrl ?? t("settings.no_gateways")}</Text></View><Pressable accessibilityLabel={t("settings.rerun_diagnostics")} disabled={runtime.loading} onPress={() => void refresh()} style={styles.detailClose}>{runtime.loading ? <ActivityIndicator size="small" color={colors.textMuted} /> : <RefreshCw size={18} color={colors.textMuted} />}</Pressable></View>
            {runtime.error ? <Text accessibilityRole="alert" selectable style={styles.diagnosticError}>{runtime.error}</Text> : null}
            <View style={styles.diagnosticList}>{runtime.servers.map((server, index) => { const status = statusById.get(server.id) ?? "checking"; const latency = runtime.statuses.find((item) => item.id === server.id)?.latencyMs; return <View key={server.id} style={[styles.diagnosticRow, index > 0 && styles.divider]}><StatusDot status={status} /><View style={styles.diagnosticCopy}><Text style={styles.rowLabel}>{server.label}</Text><Text style={styles.note}>{server.transport === "ssh" ? t("settings.ssh_app_server") : t("settings.local_app_server")}{latency !== undefined ? ` · ${latency} ms` : ""}</Text></View><Text style={styles.rowValue}>{status === "online" ? t("settings.status_online") : status === "offline" ? t("settings.status_offline") : t("settings.status_checking")}</Text></View>; })}{runtime.servers.length === 0 ? <Text style={styles.empty}>{t("settings.no_hosts_returned")}</Text> : null}</View>
            <Text style={styles.detailFootnote}>{t("settings.diagnostics_footnote")}</Text>
          </>}</ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function SectionHeader({ title }: { title: string }) {
  const styles = useThemedStyles(makeStyles);
  return <Text style={styles.sectionTitle}>{title}</Text>;
}

function AppearanceButton({ testID, children, label, selected = false, textual = false, onPress }: { testID: string; children: React.ReactNode; label: string; selected?: boolean; textual?: boolean; onPress(): void }) {
  const styles = useThemedStyles(makeStyles);
  const webToggleProps = Platform.OS === "web" ? ({ "aria-pressed": selected } as const) : {};
  return <Pressable {...webToggleProps} testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled: false }} onPress={onPress} style={[styles.segmentButton, textual && styles.segmentTextButton, selected && styles.segmentSelected]}>{children}</Pressable>;
}

function SettingsRow({ testID, icon, label, value, note, last, onPress }: { testID?: string; icon: React.ReactNode; label: string; value?: string; note?: string; last?: boolean; onPress?(): void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const content = <>{icon}<View style={styles.rowCopy}><Text style={styles.rowLabel}>{label}</Text>{note ? <Text style={styles.note}>{note}</Text> : null}</View>{value ? <Text style={styles.rowValue}>{value}</Text> : null}{onPress ? <ChevronRight size={16} color={colors.textDim} /> : null}</>;
  return onPress ? <Pressable testID={testID} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, !last && styles.rowBorder, pressed && styles.pressed]}>{content}</Pressable> : <View testID={testID} style={[styles.row, !last && styles.rowBorder]}>{content}</View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { height: 56, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingHorizontal: spacing.sm },
  headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, color: colors.text, fontSize: 17, fontWeight: "600", textAlign: "center" },
  content: { width: "100%", maxWidth: 720, alignSelf: "center", paddingHorizontal: spacing.md, gap: spacing.md },
  sectionTitle: { color: colors.textMuted, fontSize: 12, fontWeight: "500", marginTop: spacing.lg },
  hostList: { gap: spacing.sm },
  hostCard: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg, backgroundColor: colors.surface },
  pressed: { backgroundColor: colors.surfaceHover },
  hostIcon: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.surfaceRaised },
  hostCopy: { flex: 1 },
  hostTitle: { color: colors.text, fontSize: 14, fontWeight: "500" },
  hostMeta: { color: colors.textDim, fontSize: 11, marginTop: 4 },
  hostKind: { color: colors.textDim, fontSize: 9, fontWeight: "700" },
  addConnection: { minHeight: 46, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, borderWidth: 1, borderStyle: "dashed", borderColor: colors.borderAccent, borderRadius: radius.lg },
  addConnectionText: { color: colors.textMuted, fontSize: 13, fontWeight: "500" },
  settingsCard: { borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg, backgroundColor: colors.surface, overflow: "hidden" },
  appearanceRow: { minHeight: 76, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md, paddingHorizontal: spacing.md },
  appearanceRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  appearanceCopy: { flex: 1, minWidth: 0 },
  segmented: { flexDirection: "row", padding: 3, borderRadius: radius.md, backgroundColor: colors.background },
  segmentButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: "transparent" },
  segmentTextButton: { width: "auto", minWidth: 52, height: 38, paddingHorizontal: 7 },
  segmentText: { color: colors.textMuted, fontSize: 10, fontWeight: "600" },
  segmentTextSelected: { color: colors.text },
  segmentSelected: { backgroundColor: colors.surfaceHover, borderColor: colors.borderAccent },
  profile: { minHeight: 82, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.md, gap: spacing.sm },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  profileCopy: { flex: 1, minHeight: 68, justifyContent: "center" },
  profileTitleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  profileTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
  profileUrl: { color: colors.textDim, fontSize: 11, marginTop: 4 },
  profileSession: { color: colors.textMuted, fontSize: 10, marginTop: 4 },
  expired: { color: colors.red },
  reauthorize: { minWidth: 58, minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, borderRadius: radius.md, backgroundColor: colors.surfaceRaised },
  reauthorizeText: { color: colors.text, fontSize: 11, fontWeight: "700" },
  remove: { color: colors.red, fontSize: 12, fontWeight: "600" },
  removeError: { color: colors.red, fontSize: 12, lineHeight: 18 },
  switchError: { color: colors.red, fontSize: 12, lineHeight: 18 },
  empty: { flex: 1, color: colors.textMuted, textAlign: "center", padding: spacing.xl },
  row: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.md },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowCopy: { flex: 1 },
  rowLabel: { color: colors.text, fontSize: 14, fontWeight: "500" },
  rowValue: { color: colors.textMuted, fontSize: 12 },
  note: { color: colors.textDim, fontSize: 10, marginTop: 3 },
  demo: { color: colors.yellow, fontSize: 12, lineHeight: 18, textAlign: "center" },
  version: { color: colors.textDim, fontSize: 11, textAlign: "center", marginVertical: spacing.lg },
  sheetOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.overlay },
  detailSheet: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "82%", padding: spacing.lg, gap: spacing.md, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.borderAccent, backgroundColor: colors.surface },
  detailScroller: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
  detailScroll: { gap: spacing.md, paddingBottom: spacing.sm },
  detailHeader: { minHeight: 44, flexDirection: "row", alignItems: "center" }, detailTitle: { flex: 1, color: colors.text, fontSize: 18, fontWeight: "700" }, detailClose: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md }, detailDescription: { color: colors.textMuted, fontSize: 13, lineHeight: 20 }, detailLabel: { color: colors.text, fontSize: 12, fontWeight: "700", marginTop: spacing.sm }, detailFootnote: { color: colors.textDim, fontSize: 11, lineHeight: 17 },
  optionGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }, optionButton: { minWidth: 96, minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg, backgroundColor: colors.background }, optionSelected: { borderColor: colors.accentBright, backgroundColor: colors.accent }, optionText: { color: colors.textMuted, fontSize: 13, fontWeight: "600" }, optionTextSelected: { color: colors.accentText },
  diagnosticSummary: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.background }, diagnosticLight: { width: 10, height: 10, borderRadius: 10 }, diagnosticGood: { backgroundColor: colors.green }, diagnosticBad: { backgroundColor: colors.red }, diagnosticCopy: { flex: 1 }, diagnosticTitle: { color: colors.text, fontSize: 13, fontWeight: "600" }, diagnosticEndpoint: { color: colors.textDim, fontSize: 10, fontFamily: "monospace", marginTop: 4 }, diagnosticError: { color: colors.red, fontSize: 12, lineHeight: 18 }, diagnosticList: { borderWidth: 1, borderColor: colors.borderAccent, borderRadius: radius.lg, overflow: "hidden" }, diagnosticRow: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.md },
});
