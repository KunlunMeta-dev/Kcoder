import { useEffect, useRef, useState } from "react";
import { AppState, Linking, StyleSheet, Text, View } from "react-native";
import { Download } from "lucide-react-native";
import { SettingsGroup } from "@/components/settings/settings-layout";
import { Button } from "@/components/ui";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { androidUpdateErrorCode, checkAndroidUpdate, type AndroidUpdate, type AndroidUpdater } from "./android-updates";

type Phase = "idle" | "checking" | "latest" | "available" | "downloading" | "cancelling" |
  "ready" | "permission" | "installing" | "installer" | "error";
type State = { phase: Phase; update?: AndroidUpdate; requestId?: string; progress?: number; error?: string };
type Operation = { requestId: string; cancelled: boolean; abort: AbortController };
let nextRequest = 0;

export function AndroidUpdatePanel({ updater, active = true }: { updater: AndroidUpdater | null; active?: boolean }) {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [state, setState] = useState<State>({ phase: "idle" });
  const operation = useRef<Operation | null>(null);
  const owner = useRef<object | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!active || !updater) return;
    const ticket = {};
    owner.current = ticket;
    setState(previous => !operation.current && ["checking", "downloading", "cancelling", "installing"].includes(previous.phase)
      ? { ...previous, phase: previous.update ? "available" : "idle", progress: undefined } : previous);
    const progress = updater.onProgress(event => {
      if (owner.current !== ticket || event.requestId !== operation.current?.requestId ||
        !Number.isSafeInteger(event.received) || !Number.isSafeInteger(event.total) || event.total <= 0 || event.received < 0 || event.received > event.total) return;
      setState(previous => previous.phase === "downloading"
        ? { ...previous, progress: Math.floor(event.received / event.total * 100) } : previous);
    });
    const appState = AppState.addEventListener("change", status => {
      if (status !== "active" || stateRef.current.phase !== "permission") return;
      void updater.canInstall().then(allowed => {
        if (owner.current === ticket && allowed) setState(previous => previous.phase === "permission" ? { ...previous, phase: "ready" } : previous);
      }).catch(() => {});
    });
    return () => {
      owner.current = null;
      progress.remove();
      appState.remove();
      const pending = operation.current;
      operation.current = null;
      if (pending) { pending.cancelled = true; pending.abort.abort(); updater.cancelDownload(pending.requestId); }
    };
  }, [active, updater]);

  const run = async (phase: Phase, action: (pending: Operation) => Promise<Partial<State>>) => {
    if (!updater || !owner.current || operation.current) return;
    const ticket = owner.current;
    const pending: Operation = { requestId: `android-update-${Date.now()}-${++nextRequest}`, cancelled: false, abort: new AbortController() };
    operation.current = pending;
    setState(previous => ({ ...previous, phase, error: undefined }));
    const timer = phase === "checking" ? setTimeout(() => {
      pending.abort.abort();
      if (owner.current === ticket && operation.current === pending) {
        operation.current = null;
        setState(previous => ({ ...previous, phase: "error", error: "network" }));
      }
    }, 20_000) : undefined;
    try {
      const result = await action(pending);
      if (owner.current === ticket && operation.current === pending) setState(previous => ({ ...previous, ...result }));
    } catch (error) {
      if (owner.current === ticket && operation.current === pending) setState(previous => pending.cancelled
        ? { ...previous, phase: previous.update ? "available" : "idle", progress: undefined }
        : { ...previous, phase: androidUpdateErrorCode(error) === "permission" ? "permission" : "error",
          error: androidUpdateErrorCode(error) });
    } finally {
      clearTimeout(timer);
      if (operation.current === pending) operation.current = null;
    }
  };
  const check = () => void run("checking", async pending => {
    const installed = await updater!.getInstalledInfo();
    const update = await checkAndroidUpdate(installed, pending.abort.signal);
    return { phase: update ? "available" : "latest", update: update ?? undefined, requestId: undefined, progress: undefined };
  });
  const download = () => {
    const update = state.update;
    if (!update) return;
    void run("downloading", async pending => {
      await updater!.download(update, pending.requestId);
      return { phase: "ready", requestId: pending.requestId, progress: 100 };
    });
  };
  const install = () => {
    const requestId = state.requestId;
    if (!requestId) return;
    void run("installing", async () => {
      if (!await updater!.canInstall()) return { phase: "permission" };
      await updater!.installUpdate(requestId);
      return { phase: "installer" };
    });
  };
  const busy = ["checking", "downloading", "cancelling", "installing"].includes(state.phase);
  const update = state.update;
  const retryInstaller = state.phase === "error" && state.error === "installer" && Boolean(state.requestId);
  return <SettingsGroup title={t("android_update.title")} testID="android-update-section">
    <View style={styles.content}>
      <View style={styles.heading}><Download size={20} color={colors.textMuted} />
        <Text style={styles.title}>{t("android_update.heading")}</Text></View>
      <Text testID="android-update-status" accessibilityLiveRegion="polite" style={styles.description}>
        {t(!updater ? "android_update.unavailable" : `android_update.${state.phase}`)}</Text>
      {update ? <>
        <Text testID="android-update-version" style={styles.version}>{t("android_update.version", { version: update.version, build: update.versionCode, size: (update.size / 1024 / 1024).toFixed(1) })}</Text>
        {update.notes ? <Text testID="android-update-notes" numberOfLines={5} style={styles.description}>{update.notes}</Text> : null}
        <Button testID="android-update-release" variant="ghost" onPress={() => {
          const ticket = owner.current;
          void Linking.openURL(update.releaseUrl).catch(() => {
            if (owner.current === ticket) setState(previous => ({ ...previous, phase: "error", error: "network" }));
          });
        }}>{t("android_update.release_notes")}</Button>
      </> : null}
      {state.phase === "downloading" || state.phase === "cancelling" ? <View accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: state.progress ?? 0 }}>
        <Text testID="android-update-progress" style={styles.description}>{state.progress ?? 0}%</Text>
      </View> : null}
      {state.error ? <Text testID="android-update-error" accessibilityRole="alert" style={styles.error}>{t(`android_update.error_${state.error}`)}</Text> : null}
      <View style={styles.actions}>
        {(state.phase === "available" || (state.phase === "error" && update && !retryInstaller)) ? <Button testID="android-update-download" variant="primary" onPress={download}>{t("android_update.download")}</Button> : null}
        {state.phase === "ready" || state.phase === "installer" || retryInstaller ? <Button testID="android-update-install" variant="primary" onPress={install}>{t("android_update.install")}</Button> : null}
        {state.phase === "permission" ? <Button testID="android-update-permission" variant="primary" onPress={() => void run("installing", async () => {
          if (await updater!.canInstall()) return { phase: "ready" };
          await updater!.openInstallPermission(); return { phase: "permission" };
        })}>{t("android_update.allow_install")}</Button> : null}
        {state.phase === "downloading" || state.phase === "cancelling" ? <Button testID="android-update-cancel" disabled={state.phase === "cancelling"} onPress={() => {
          const pending = operation.current;
          if (pending) { pending.cancelled = true; updater?.cancelDownload(pending.requestId); setState(previous => ({ ...previous, phase: "cancelling" })); }
        }}>{t("common.cancel")}</Button> : <Button testID="android-update-check" disabled={!updater || busy} loading={state.phase === "checking"} onPress={check}>{t("android_update.check")}</Button>}
      </View>
    </View>
  </SettingsGroup>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.sm },
  heading: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  title: { color: colors.text, fontSize: 16, fontWeight: "500" },
  version: { color: colors.text, fontSize: 14 },
  description: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  error: { color: colors.red, fontSize: 13, lineHeight: 19 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
});
