import { useEffect, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  ClipboardPaste,
  Link2,
  QrCode,
  Settings,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Field } from "@/components/ui";
import { useApp } from "@/state/AppContext";
import { colors, radius, spacing } from "@/theme";
import { parsePairingLink } from "@/gateway/pairing";
import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { t } from "@/i18n";

export default function WelcomeRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ gateway?: string; reauth?: string }>();
  const insets = useSafeAreaInsets();
  const { connectGateway } = useApp();
  const [directOpen, setDirectOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:4173");
  const [token, setToken] = useState("");
  const linkRef = useRef("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const requestedGateway = params.gateway?.trim();
    const currentOrigin =
      Platform.OS === "web"
        ? (globalThis as { location?: { origin?: string } }).location?.origin
        : undefined;
    if (requestedGateway || currentOrigin)
      setEndpoint(requestedGateway || currentOrigin || endpoint);
    if (params.reauth) setDirectOpen(true);
    // endpoint is only the current value when no deep-link parameter exists; user input must not retrigger this initialization effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.gateway, params.reauth]);

  const connect = async (baseUrl: string, token: string) => {
    setLoading(true);
    setError(null);
    try {
      const profile = await connectGateway({ baseUrl, token });
      setDirectOpen(false);
      setLinkOpen(false);
      router.replace({
        pathname: "/h/[profileId]",
        params: { profileId: profile.id },
      });
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  };

  const connectLink = () => {
    try {
      const pairing = parsePairingLink(linkRef.current);
      void connect(pairing.gateway, pairing.token);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.content}>
          <View style={styles.logo}>
            <Text style={styles.logoText}>K</Text>
          </View>
          <View style={styles.copy}>
            <Text style={styles.title}>{t("welcome.title")}</Text>
            <Text style={styles.subtitle}>{t("welcome.subtitle")}</Text>
          </View>
          <View style={styles.actions}>
            <Button
              testID="welcome-direct-connection"
              variant="primary"
              onPress={() => {
                setError(null);
                setDirectOpen(true);
              }}
            >
              <Link2 size={19} color={colors.accentText} />
              <Text style={styles.primaryText}>{t("welcome.direct_connect")}</Text>
            </Button>
            <Button
              testID="welcome-paste-pairing-link"
              variant="ghost"
              onPress={() => {
                setError(null);
                setLinkOpen(true);
              }}
            >
              <ClipboardPaste size={19} color={colors.textMuted} />
              <Text style={styles.mutedActionText}>{t("welcome.paste_pairing_link")}</Text>
            </Button>
            <Button
              testID="welcome-scan-qr"
              variant="ghost"
              onPress={() => router.push("/pair-scan")}
            >
              <QrCode size={19} color={colors.textMuted} />
              <Text style={styles.mutedActionText}>{t("welcome.scan_qr")}</Text>
            </Button>
          </View>
          <Text style={styles.setup}>{t("welcome.setup_hint")}</Text>
        </View>
        <View style={styles.footer}>
          <Text style={styles.version}>{t("welcome.version_line")}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("welcome.open_settings")}
            onPress={() => router.push("/settings")}
            style={styles.settings}
          >
            <Settings size={17} color={colors.textMuted} />
            <Text style={styles.settingsText}>{t("common.settings")}</Text>
          </Pressable>
        </View>
      </ScrollView>

      <ConnectModal
        title={t("welcome.direct_connect")}
        initialFocus='[data-testid="gateway-endpoint"]'
        visible={directOpen}
        onClose={() => setDirectOpen(false)}
      >
        <Field
          testID="gateway-endpoint"
          label={t("welcome.gateway_endpoint_label")}
          value={endpoint}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setEndpoint}
          hint={t("welcome.gateway_endpoint_hint")}
        />
        <Field
          testID="gateway-token"
          label={t("welcome.gateway_token_label")}
          value={token}
          secureTextEntry
          autoCapitalize="none"
          onChangeText={setToken}
          hint={t("welcome.gateway_token_hint")}
        />
        {error ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            style={styles.error}
          >
            {error}
          </Text>
        ) : null}
        <Button
          testID="gateway-connect"
          variant="primary"
          loading={loading}
          onPress={() => void connect(endpoint, token)}
        >
          {t("common.connect")}
        </Button>
      </ConnectModal>

      <ConnectModal
        title={t("welcome.paste_pairing_link")}
        initialFocus='[data-testid="pair-link-input"]'
        visible={linkOpen}
        onClose={() => setLinkOpen(false)}
      >
        <Field
          testID="pair-link-input"
          label={t("welcome.pair_link_label")}
          multiline
          defaultValue=""
          autoCapitalize="none"
          onChangeText={(value) => {
            linkRef.current = value;
          }}
          hint={t("welcome.pair_link_hint")}
        />
        {error ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            style={styles.error}
          >
            {error}
          </Text>
        ) : null}
        <Button variant="primary" loading={loading} onPress={connectLink}>
          {t("common.connect")}
        </Button>
      </ConnectModal>
    </View>
  );
}

function ConnectModal({
  title,
  initialFocus,
  visible,
  onClose,
  children,
}: {
  title: string;
  initialFocus: string;
  visible: boolean;
  onClose(): void;
  children: React.ReactNode;
}) {
  const modalRef = useModalFocusTrap(visible, onClose, initialFocus);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      accessibilityLabel={title}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.modalOverlay}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View ref={modalRef} style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{title}</Text>
            <Pressable accessibilityLabel={t("common.close")} onPress={onClose}>
              <X size={20} color={colors.textMuted} />
            </Pressable>
          </View>
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  container: { flexGrow: 1, padding: spacing.xl, alignItems: "center" },
  content: {
    flex: 1,
    width: "100%",
    maxWidth: 420,
    alignItems: "center",
    justifyContent: "center",
  },
  logo: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xl,
  },
  logoText: { color: colors.background, fontSize: 29, fontWeight: "800" },
  copy: { alignItems: "center", gap: spacing.sm, marginBottom: 44 },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "700",
    textAlign: "center",
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
    maxWidth: 350,
  },
  actions: { width: "100%", gap: spacing.md },
  actionText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  mutedActionText: { color: colors.textMuted, fontSize: 14, fontWeight: "600" },
  disabledActionText: {
    color: colors.textDim,
    fontSize: 14,
    fontWeight: "600",
  },
  primaryText: { color: colors.accentText, fontSize: 15, fontWeight: "700" },
  setup: {
    color: colors.textDim,
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
    marginTop: spacing.xl,
  },
  footer: {
    width: "100%",
    maxWidth: 420,
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  settings: {
    minWidth: 76,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  settingsText: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },
  version: { color: colors.textMuted, fontSize: 12 },
  error: { color: colors.red, fontSize: 13, lineHeight: 19 },
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  modalCard: {
    width: "100%",
    maxWidth: 440,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: spacing.lg,
    gap: spacing.lg,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  modalTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
});
