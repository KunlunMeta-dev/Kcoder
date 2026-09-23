import { useEffect, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { ChevronLeft, Link2, RotateCcw } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui";
import { useApp } from "@/state/AppContext";
import { colors, radius, spacing } from "@/theme";

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default function ConnectRoute() {
  const params = useLocalSearchParams<{ gateway?: string | string[]; token?: string | string[] }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { hydrated, connectGateway } = useApp();
  const incomingGateway = firstParam(params.gateway).trim();
  const incomingToken = firstParam(params.token);
  const pairingRef = useRef<{ gateway: string; token: string } | null>(null);
  if (!pairingRef.current && (incomingGateway || incomingToken)) {
    pairingRef.current = { gateway: incomingGateway, token: incomingToken };
  }
  const gateway = pairingRef.current?.gateway ?? incomingGateway;
  const token = pairingRef.current?.token ?? incomingToken;
  const attemptRef = useRef(0);
  const connectGatewayRef = useRef(connectGateway);
  connectGatewayRef.current = connectGateway;
  const [clientReady, setClientReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setClientReady(true), []);

  useEffect(() => {
    if (!clientReady || Platform.OS !== "web" || !incomingToken) return;
    router.setParams({ token: undefined });
  }, [clientReady, incomingToken, router]);

  useEffect(() => {
    if (!clientReady || !hydrated) return;
    if (!gateway || !token) {
      setError("配对链接缺少 Gateway 地址或 access token。");
      return;
    }
    const generation = ++attemptRef.current;
    setError(null);
    void connectGatewayRef.current({ baseUrl: gateway, token })
      .then((profile) => {
        if (attemptRef.current !== generation) return;
        router.replace({ pathname: "/h/[profileId]", params: { profileId: profile.id } });
      })
      .catch((value) => {
        if (attemptRef.current === generation) {
          setError(value instanceof Error ? value.message : String(value));
        }
      });
    return () => { attemptRef.current += 1; };
  }, [attempt, clientReady, gateway, hydrated, router, token]);

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}> 
      <View style={styles.header}>
        <Pressable accessibilityLabel="返回" onPress={() => router.replace("/welcome")} style={styles.headerButton}><ChevronLeft size={23} color={colors.text} /></Pressable>
        <Text style={styles.headerTitle}>连接 Gateway</Text>
        <View style={styles.headerButton} />
      </View>
      <View style={styles.content}>
        <View style={styles.icon}><Link2 size={28} color={colors.green} /></View>
        <Text style={styles.title}>{error ? "连接失败" : "正在建立安全连接"}</Text>
        <Text selectable style={styles.gateway} numberOfLines={2}>{clientReady && gateway ? gateway : "无效的配对链接"}</Text>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.green} />}
        {error ? <Button testID="pairing-retry" variant="primary" onPress={() => setAttempt((value) => value + 1)}><RotateCcw size={17} color={colors.accentText} />重新连接</Button> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
