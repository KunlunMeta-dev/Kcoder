import { useRef, useState } from "react";
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
import { useApp } from "@/state/AppContext";
import { colors, radius, spacing } from "@/theme";
import { backOrReplace } from "@/navigation/back-or-replace";

export default function PairScanRoute() {
  if (Platform.OS === "web") return <WebPairingFallback />;
  return <NativePairScanRoute />;
}

function WebPairingFallback() {
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
          accessibilityLabel="返回"
          onPress={() => backOrReplace(router, "/welcome")}
          style={styles.headerButton}
        >
          <ChevronLeft size={23} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>扫描配对码</Text>
        <View style={styles.headerButton} />
      </View>
      <View style={styles.center}>
        <View style={styles.permissionIcon}>
          <QrCode size={54} color={colors.textMuted} />
        </View>
        <Text style={styles.title}>浏览器暂不支持扫码</Text>
        <Text style={styles.body}>
          请返回连接页粘贴 KCoder Studio 配对链接；手机原生 App
          可直接使用相机扫描二维码。
        </Text>
        <Button
          testID="pairing-web-paste-link"
          variant="primary"
          onPress={() => router.replace("/welcome")}
        >
          粘贴配对链接
        </Button>
      </View>
    </View>
  );
}

function NativePairScanRoute() {
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

  const handleBarcode = async (result: BarcodeScanningResult) => {
    if (processingRef.current || scanned || connecting) return;
    processingRef.current = true;
    setScanned(true);
    setConnecting(true);
    setError(null);
    try {
      const pairing = parsePairingLink(result.data);
      const profile = await connectGateway({
        baseUrl: pairing.gateway,
        token: pairing.token,
      });
      router.replace({
        pathname: "/h/[profileId]",
        params: { profileId: profile.id },
      });
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setConnecting(false);
      processingRef.current = false;
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
          accessibilityLabel="返回"
          onPress={() => backOrReplace(router, "/welcome")}
          style={styles.headerButton}
        >
          <ChevronLeft size={23} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>扫描配对码</Text>
        <Pressable
          accessibilityLabel={torch ? "关闭闪光灯" : "打开闪光灯"}
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
          <Text style={styles.body}>正在读取相机权限…</Text>
        </View>
      ) : !permission.granted ? (
        <View style={styles.center}>
          <View style={styles.permissionIcon}>
            <QrCode size={54} color={colors.textMuted} />
          </View>
          <Text style={styles.title}>允许使用相机</Text>
          <Text style={styles.body}>
            相机仅用于读取 KCoder Studio
            配对二维码；二维码内容不会上传到其他服务。
          </Text>
          <Button
            testID="request-camera-permission"
            variant="primary"
            onPress={() => void requestPermission()}
          >
            授权相机
          </Button>
          {!permission.canAskAgain ? (
            <Text style={styles.error}>
              系统已禁止再次询问，请在手机设置中为 KCoder Studio 开启相机权限。
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
                ? "正在安全连接 Gateway…"
                : scanned
                  ? "未能连接，可重新扫描"
                  : "将 KCoder Studio 配对二维码放入框内"}
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
                重新扫描
              </Button>
            ) : null}
            {error ? <Text style={styles.scanError}>{error}</Text> : null}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
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
