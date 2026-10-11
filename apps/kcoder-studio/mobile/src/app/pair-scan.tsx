import { useEffect, useRef, useState } from "react";
import { useRouter } from "expo-router";
import type { BarcodeScanningResult } from "expo-camera";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  ChevronLeft,
  Flashlight,
  QrCode,
  RotateCcw,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui";
import { parsePairingLink } from "@/gateway/pairing";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useApp } from "@/state/AppContext";
import { useTheme, useThemedStyles, type ThemeColors, radius, spacing } from "@/theme";
import { backOrReplace } from "@/navigation/back-or-replace";

export default function PairScanRoute() {
  if (Platform.OS === "web") return <WebPairingFallback />;
  return <NativePairScanRoute />;
}

function WebPairingFallback() {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <View style={styles.header}>
        <Pressable
          accessibilityLabel={t("common.back")}
          onPress={() => backOrReplace(router, "/welcome")}
          style={styles.headerButton}
        >
          <ChevronLeft size={23} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>{t("welcome.scan_qr")}</Text>
        <View style={styles.headerButton} />
      </View>
      <View style={styles.center}>
        <View style={styles.permissionIcon}>
          <QrCode size={54} color={colors.textMuted} />
        </View>
        <Text style={styles.title}>{t("pair_scan.web_unavailable_title")}</Text>
        <Text style={styles.body}>{t("pair_scan.web_unavailable_body")}</Text>
        <Button
          testID="pairing-web-paste-link"
          variant="primary"
          onPress={() => router.replace("/welcome")}
        >
          {t("welcome.paste_pairing_link")}
        </Button>
      </View>
    </View>
  );
}

function NativePairScanRoute() {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  // The expo-camera Web QR worker accesses an external CDN at module load. Load it only
  // on the scanner page; Web uses a separate fallback component so offline deployments
  // do not create an external worker or raise a global pageerror.
  const { CameraView, useCameraPermissions } =
    require("expo-camera") as typeof import("expo-camera");
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { connectGateway } = useApp();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [torch, setTorch] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const processingRef = useRef(false);
  const mountedRef = useRef(true);
  const connectionAttemptRef = useRef(0);
  const connectionControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      connectionAttemptRef.current += 1;
      connectionControllerRef.current?.abort();
      connectionControllerRef.current = null;
    };
  }, []);

  const leaveScanner = () => {
    connectionAttemptRef.current += 1;
    connectionControllerRef.current?.abort();
    connectionControllerRef.current = null;
    backOrReplace(router, "/welcome");
  };

  const handleBarcode = async (result: BarcodeScanningResult) => {
    if (processingRef.current || scanned || connecting) return;
    processingRef.current = true;
    const attempt = ++connectionAttemptRef.current;
    const controller = new AbortController();
    connectionControllerRef.current = controller;
    setScanned(true);
    setConnecting(true);
    setError(null);
    try {
      const pairing = parsePairingLink(result.data);
      const profile = await connectGateway({
        baseUrl: pairing.gateway,
        token: pairing.token,
        signal: controller.signal,
      });
      if (!mountedRef.current || attempt !== connectionAttemptRef.current) return;
      if (!profile) {
        setConnecting(false);
        setScanned(false);
        processingRef.current = false;
        return;
      }
      router.replace({
        pathname: "/h/[profileId]",
        params: { profileId: profile.id },
      });
    } catch (value) {
      if (!mountedRef.current || attempt !== connectionAttemptRef.current) return;
      setError(value instanceof Error ? value.message : String(value));
      setConnecting(false);
      processingRef.current = false;
    } finally {
      if (connectionControllerRef.current === controller)
        connectionControllerRef.current = null;
    }
  };

  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <View style={styles.header}>
        <Pressable
          accessibilityLabel={t("common.back")}
          onPress={leaveScanner}
          style={styles.headerButton}
        >
          <ChevronLeft size={23} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>{t("welcome.scan_qr")}</Text>
        <Pressable
          accessibilityLabel={torch ? t("pair_scan.turn_flashlight_off") : t("pair_scan.turn_flashlight_on")}
          onPress={() => setTorch((value) => !value)}
          style={styles.headerButton}
        >
          <Flashlight
            size={20}
            color={torch ? colors.yellow : colors.textMuted}
          />
        </Pressable>
      </View>
      {!permission ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.text} />
          <Text style={styles.body}>{t("pair_scan.camera_permission_loading")}</Text>
        </View>
      ) : !permission.granted ? (
        <View style={styles.center}>
          <View style={styles.permissionIcon}>
            <QrCode size={54} color={colors.textMuted} />
          </View>
          <Text style={styles.title}>{t("pair_scan.camera_permission_title")}</Text>
          <Text style={styles.body}>{t("pair_scan.camera_permission_body")}</Text>
          <Button
            testID="request-camera-permission"
            variant="primary"
            onPress={() => void requestPermission()}
          >
            {t("pair_scan.grant_camera_permission")}
          </Button>
          {!permission.canAskAgain ? (
            <Text style={styles.error}>
              {t("pair_scan.camera_permission_settings")}
            </Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.cameraWrap}>
          <CameraView
            testID="pairing-camera"
            style={StyleSheet.absoluteFill}
            facing="back"
            enableTorch={torch}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={
              scanned ? undefined : (result) => void handleBarcode(result)
            }
          />
          <View pointerEvents="none" style={styles.cameraShade}>
            <View style={styles.scanFrame}>
              <View style={[styles.corner, styles.cornerTopLeft]} />
              <View style={[styles.corner, styles.cornerTopRight]} />
              <View style={[styles.corner, styles.cornerBottomLeft]} />
              <View style={[styles.corner, styles.cornerBottomRight]} />
            </View>
          </View>
          <View style={styles.cameraFooter}>
            <Text style={styles.scanHint}>
              {connecting
                ? t("pair_scan.connecting_gateway")
                : scanned
                  ? t("pair_scan.scan_failed")
                  : t("pair_scan.scan_prompt")}
            </Text>
            {connecting ? (
              <ActivityIndicator color="#fff" />
            ) : scanned ? (
              <Button
                testID="scan-again"
                onPress={() => {
                  processingRef.current = false;
                  setScanned(false);
                  setError(null);
                }}
              >
                <RotateCcw size={17} color={colors.text} />
                {t("pair_scan.scan_again")}
              </Button>
            ) : null}
            {error ? <Text style={styles.scanError}>{error}</Text> : null}
          </View>
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    height: 60,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerButton: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.lg,
  },
  permissionIcon: {
    width: 96,
    height: 96,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceRaised,
  },
  title: { color: colors.text, fontSize: 21, fontWeight: "700" },
  body: {
    maxWidth: 420,
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 22,
    textAlign: "center",
  },
  error: {
    maxWidth: 420,
    color: colors.red,
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
  },
  cameraWrap: { flex: 1, overflow: "hidden", backgroundColor: "#000" },
  cameraShade: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.24)",
    paddingBottom: 80,
  },
  scanFrame: {
    width: "70%",
    maxWidth: 300,
    aspectRatio: 1,
    position: "relative",
  },
  corner: { position: "absolute", width: 42, height: 42, borderColor: "#fff" },
  cornerTopLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: radius.md,
  },
  cornerTopRight: {
    top: 0,
    right: 0,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: radius.md,
  },
  cornerBottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: radius.md,
  },
  cornerBottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: radius.md,
  },
  cameraFooter: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xl,
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: "rgba(0,0,0,0.72)",
  },
  scanHint: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
  },
  scanError: {
    color: "#fda4af",
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
  },
});
