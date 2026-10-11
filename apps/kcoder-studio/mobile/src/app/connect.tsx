import { useEffect, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { ChevronLeft, Link2, RotateCcw } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui";
import { useApp } from "@/state/AppContext";
import { useTheme, useThemedStyles, type ThemeColors, radius, spacing } from "@/theme";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

type ConnectError =
  | {
      kind: "translation";
      key: "connect.missing_pairing_details" | "connect.superseded";
    }
  | { kind: "message"; message: string };

export default function ConnectRoute() {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const params = useLocalSearchParams<{ gateway?: string | string[]; token?: string | string[] }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { hydrated, connectGateway } = useApp();
  const incomingGateway = firstParam(params.gateway).trim();
  // Web QR credentials stay in the fragment, which is never sent in HTTP.
  // The legacy query-token deep link remains compatible.
  const webLocation = Platform.OS === "web"
    ? (globalThis as { location?: { hash?: string; pathname?: string; search?: string }; history?: { state: unknown; replaceState: (state: unknown, unused: string, url: string) => void } })
    : undefined;
  const fragmentToken = webLocation?.location?.hash?.startsWith("#token=")
    ? new URLSearchParams(webLocation.location.hash.slice(1)).get("token") ?? ""
    : "";
  const incomingToken = firstParam(params.token) || fragmentToken;
  const pairingRef = useRef<{ gateway: string; token: string } | null>(null);
  if (!pairingRef.current && (incomingGateway || incomingToken)) {
    pairingRef.current = { gateway: incomingGateway, token: incomingToken };
  }
  const gateway = pairingRef.current?.gateway ?? incomingGateway;
  const token = pairingRef.current?.token ?? incomingToken;
  const attemptRef = useRef(0);
  const connectionControllerRef = useRef<AbortController | null>(null);
  const connectGatewayRef = useRef(connectGateway);
  connectGatewayRef.current = connectGateway;
  const [clientReady, setClientReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<ConnectError | null>(null);
  const errorMessage =
    error?.kind === "translation"
      ? t(error.key)
      : error?.kind === "message"
        ? error.message
        : null;

  useEffect(() => setClientReady(true), []);

  useEffect(() => {
    if (!clientReady || Platform.OS !== "web" || !incomingToken) return;
    if (fragmentToken && webLocation?.location && webLocation.history) {
      webLocation.history.replaceState(webLocation.history.state, "", `${webLocation.location.pathname ?? ""}${webLocation.location.search ?? ""}`);
    }
    if (firstParam(params.token)) router.setParams({ token: undefined });
  }, [clientReady, incomingToken, fragmentToken, params.token, router]);

  useEffect(() => {
    if (!clientReady || !hydrated) return;
    if (!gateway || !token) {
      setError({ kind: "translation", key: "connect.missing_pairing_details" });
      return;
    }
    const generation = ++attemptRef.current;
    connectionControllerRef.current?.abort();
    const controller = new AbortController();
    connectionControllerRef.current = controller;
    setError(null);
    void connectGatewayRef.current({ baseUrl: gateway, token, signal: controller.signal })
      .then((profile) => {
        if (attemptRef.current !== generation) return;
        if (!profile) {
          setError({ kind: "translation", key: "connect.superseded" });
          return;
        }
        router.replace({ pathname: "/h/[profileId]", params: { profileId: profile.id } });
      })
      .catch((value) => {
        if (attemptRef.current === generation) {
          setError({
            kind: "message",
            message: value instanceof Error ? value.message : String(value),
          });
        }
      })
      .finally(() => {
        if (connectionControllerRef.current === controller)
          connectionControllerRef.current = null;
      });
    return () => {
      attemptRef.current += 1;
      if (connectionControllerRef.current === controller) {
        controller.abort();
        connectionControllerRef.current = null;
      }
    };
  }, [attempt, clientReady, gateway, hydrated, router, token]);

  const leaveConnect = () => {
    attemptRef.current += 1;
    connectionControllerRef.current?.abort();
    connectionControllerRef.current = null;
    router.replace("/welcome");
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}> 
      <View style={styles.header}>
        <Pressable accessibilityLabel={t("common.back")} onPress={leaveConnect} style={styles.headerButton}><ChevronLeft size={23} color={colors.text} /></Pressable>
        <Text style={styles.headerTitle}>{t("connect.title")}</Text>
        <View style={styles.headerButton} />
      </View>
      <View style={styles.content}>
        <View style={styles.icon}><Link2 size={28} color={colors.green} /></View>
        <Text style={styles.title}>{error ? t("connect.connection_failed") : t("connect.establishing_secure_connection")}</Text>
        <Text selectable style={styles.gateway} numberOfLines={2}>{clientReady && gateway ? gateway : t("connect.invalid_pairing_link")}</Text>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{errorMessage}</Text> : <ActivityIndicator color={colors.green} />}
        {error ? <Button testID="pairing-retry" variant="primary" onPress={() => setAttempt((value) => value + 1)}><RotateCcw size={17} color={colors.accentText} />{t("connect.reconnect")}</Button> : null}
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { height: 60, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingHorizontal: spacing.sm },
  headerButton: { width: 46, height: 46, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, color: colors.text, textAlign: "center", fontSize: 16, fontWeight: "700" },
  content: { flex: 1, width: "100%", maxWidth: 420, alignSelf: "center", alignItems: "center", justifyContent: "center", gap: spacing.lg, padding: spacing.xl },
  icon: { width: 64, height: 64, borderRadius: radius.lg, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  title: { color: colors.text, fontSize: 20, fontWeight: "700", textAlign: "center" },
  gateway: { color: colors.textMuted, fontSize: 13, lineHeight: 19, textAlign: "center" },
  error: { color: colors.red, fontSize: 13, lineHeight: 19, textAlign: "center" },
});
