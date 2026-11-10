import { useEffect, useRef, useState } from "react";
import { useLocalSearchParams, usePathname, useRouter } from "expo-router";
import Constants from "expo-constants";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { ChevronLeft, Link2, RotateCcw } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui";
import { useApp } from "@/state/AppContext";
import { useTheme, useThemedStyles, type ThemeColors, radius, spacing } from "@/theme";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { getMobileClientVersion } from "@/runtime/mobile-client-version";
import { parsePairingLink } from "@/gateway/pairing";
import { gatewayHttpErrorPresentation, gatewayRouteErrorPresentation, type GatewayHttpErrorPresentation } from "@/gateway/http-errors";
import { canonicalGatewayConnectionUrl } from "../../../shared/gatewayConnectionRoutes.js";
import appJson from "../../app.json";
import {
  clearWebPairingBootstrapState,
  getWebPairingBootstrapState,
} from "@/gateway/web-pairing-bootstrap";

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

type PairingConnectionRoutes = ReturnType<typeof parsePairingLink>["connectionRoutes"];

function sameConnectionRoutes(
  left: PairingConnectionRoutes | undefined,
  right: PairingConnectionRoutes | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.version === right.version &&
    left.gatewayId === right.gatewayId &&
    left.publicKey === right.publicKey &&
    left.endpoints.length === right.endpoints.length &&
    left.endpoints.every((endpoint, index) => {
      const other = right.endpoints[index];
      return endpoint.kind === other?.kind && endpoint.url === other?.url;
    });
}

type ConnectError =
  | {
      kind: "translation";
      key: "connect.missing_pairing_details" | "connect.superseded";
    }
  | { kind: "http"; presentation: GatewayHttpErrorPresentation }
  | { kind: "route"; presentation: NonNullable<ReturnType<typeof gatewayRouteErrorPresentation>> }
  | { kind: "message"; message: string };

function connectErrorFrom(value: unknown): ConnectError {
  const presentation = gatewayHttpErrorPresentation(value);
  const routePresentation = gatewayRouteErrorPresentation(value);
  return presentation
    ? { kind: "http", presentation }
    : routePresentation ? { kind: "route", presentation: routePresentation }
    : { kind: "message", message: value instanceof Error ? value.message : String(value) };
}

export default function ConnectRoute() {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const params = useLocalSearchParams<{
    gateway?: string | string[];
    gatewayId?: string | string[];
    token?: string | string[];
    routes?: string | string[];
  }>();
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { hydrated, connectGateway, profiles = [], setActiveProfile } = useApp();
  const pairingRef = useRef<{
    gateway: string;
    gatewayId?: string;
    token: string;
    pathname: string;
    browserPathname: string;
    connectionRoutes?: PairingConnectionRoutes;
  } | null>(null);
  const incomingGateway = firstParam(params.gateway).trim();
  const rawRoutes = firstParam(params.routes);
  const routesProvided = params.routes !== undefined;
  const duplicateRoutes = Array.isArray(params.routes) && params.routes.length !== 1;
  const duplicateGateway = Array.isArray(params.gateway) && params.gateway.length !== 1;
  const duplicateToken = Array.isArray(params.token) && params.token.length !== 1;
  const duplicateGatewayId = Array.isArray(params.gatewayId) && params.gatewayId.length !== 1;
  // Web QR credentials stay in the fragment, which is never sent in HTTP.
  // The legacy query-token deep link remains compatible.
  const webLocation = Platform.OS === "web"
    ? (globalThis as { location?: { pathname?: string } })
    : undefined;
  const browserPathname = webLocation?.location?.pathname ?? "";
  const webPairingState = Platform.OS === "web"
    ? getWebPairingBootstrapState(pathname, browserPathname)
    : null;
  const webPairingIntent = webPairingState?.kind === "intent" && webPairingState.gateway === incomingGateway
    ? webPairingState
    : null;
  const hasTokenParam = params.token !== undefined;
  const suppliedToken = hasTokenParam ? firstParam(params.token) : webPairingIntent?.token ?? "";
  const gatewayId = firstParam(params.gatewayId) || undefined;
  const retainedPairing = pairingRef.current;
  // A scrubbed connect URL can survive a full page/module reload. Resume only
  // its exact saved Gateway; an explicit or malformed new grant must still pair.
  const matchingProfiles = Platform.OS === "web" && !hasTokenParam && !webPairingState && !retainedPairing
    ? profiles.filter(profile => canonicalGatewayConnectionUrl(profile.baseUrl) === canonicalGatewayConnectionUrl(incomingGateway) &&
      Boolean(profile.accessToken || profile.refreshToken))
    : [];
  const savedProfile = matchingProfiles.length === 1 ? matchingProfiles[0] : undefined;
  const retainedBasicScopeMatches = Boolean(
    !hasTokenParam &&
    !duplicateGateway &&
    !duplicateToken &&
    !duplicateGatewayId &&
    webPairingState?.kind !== "invalid" &&
    !(webPairingState?.kind === "intent" && !webPairingIntent) &&
    incomingGateway &&
    retainedPairing &&
    retainedPairing.gateway === incomingGateway &&
    retainedPairing.gatewayId === gatewayId &&
    retainedPairing.pathname === pathname &&
    retainedPairing.browserPathname === browserPathname,
  );
  // A retained token is used only to validate a still-matching route descriptor.
  // It is not accepted as the new pairing token until the full scope matches below.
  const routeValidationToken = suppliedToken ||
    (retainedBasicScopeMatches ? retainedPairing?.token ?? "" : "") ||
    (savedProfile ? "saved-profile-route-validation-only" : "");
  let queryConnectionRoutes: ReturnType<typeof parsePairingLink>["connectionRoutes"];
  let invalidConnectionRoutes = duplicateRoutes || duplicateGateway || duplicateToken || duplicateGatewayId;
  if (routesProvided) {
    if (!rawRoutes || invalidConnectionRoutes || !incomingGateway || !routeValidationToken) {
      invalidConnectionRoutes = true;
    } else {
      try {
        const pairingUrl = new URL("kcoder-studio://connect");
        pairingUrl.searchParams.set("gateway", incomingGateway);
        pairingUrl.searchParams.set("token", routeValidationToken);
        if (gatewayId) pairingUrl.searchParams.set("gatewayId", gatewayId);
        pairingUrl.searchParams.set("routes", rawRoutes);
        queryConnectionRoutes = parsePairingLink(pairingUrl.toString()).connectionRoutes;
        if (!queryConnectionRoutes) invalidConnectionRoutes = true;
      } catch {
        invalidConnectionRoutes = true;
      }
    }
  }
  const routesContradictBootstrap = Boolean(
    routesProvided && webPairingIntent && (
      (webPairingIntent.connectionRoutes &&
        JSON.stringify(webPairingIntent.connectionRoutes) !== JSON.stringify(queryConnectionRoutes)) ||
      (!webPairingIntent.connectionRoutes && queryConnectionRoutes)
    ),
  );
  const invalidWebPairing = webPairingState?.kind === "invalid" || routesContradictBootstrap ||
    (webPairingState?.kind === "intent" && !webPairingIntent);
  const invalidPairingParams = invalidConnectionRoutes || duplicateGateway || duplicateToken || duplicateGatewayId;
  const candidateConnectionRoutes = queryConnectionRoutes ?? webPairingIntent?.connectionRoutes;
  const retainedScopeMatches = Boolean(
    retainedBasicScopeMatches &&
    sameConnectionRoutes(candidateConnectionRoutes, retainedPairing?.connectionRoutes),
  );
  const incomingToken = suppliedToken || (retainedScopeMatches ? retainedPairing?.token ?? "" : "");
  const connectionToken = invalidWebPairing || invalidPairingParams ? "" : incomingToken;
  if (
    invalidWebPairing || invalidPairingParams || !incomingGateway ||
    (pairingRef.current && (
      pairingRef.current.gateway !== incomingGateway ||
      pairingRef.current.gatewayId !== gatewayId ||
      pairingRef.current.pathname !== pathname ||
      pairingRef.current.browserPathname !== browserPathname ||
      !sameConnectionRoutes(candidateConnectionRoutes, pairingRef.current.connectionRoutes)
    ))
  ) {
    pairingRef.current = null;
  }
  if (
    incomingGateway && connectionToken &&
    (!pairingRef.current || pairingRef.current.gateway !== incomingGateway || pairingRef.current.token !== connectionToken)
  ) {
    pairingRef.current = {
      gateway: incomingGateway,
      ...(gatewayId ? { gatewayId } : {}),
      token: connectionToken,
      pathname,
      browserPathname,
      ...(candidateConnectionRoutes ? { connectionRoutes: candidateConnectionRoutes } : {}),
    };
  }
  const gateway = pairingRef.current?.gateway ?? incomingGateway;
  const token = pairingRef.current?.token ?? connectionToken;
  const connectionRoutes = candidateConnectionRoutes ?? pairingRef.current?.connectionRoutes;
  const resumableProfile = savedProfile && !invalidWebPairing && !invalidPairingParams &&
    (!gatewayId || gatewayId === savedProfile.connectionRoutes?.gatewayId) &&
    (!routesProvided || sameConnectionRoutes(queryConnectionRoutes, savedProfile.connectionRoutes))
    ? savedProfile : undefined;
  const attemptRef = useRef(0);
  const connectionControllerRef = useRef<AbortController | null>(null);
  const connectGatewayRef = useRef(connectGateway);
  connectGatewayRef.current = connectGateway;
  const activateProfileRef = useRef(setActiveProfile);
  activateProfileRef.current = setActiveProfile;
  const [clientReady, setClientReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<ConnectError | null>(null);
  const [httpDetailsExpanded, setHttpDetailsExpanded] = useState(false);
  const errorMessage =
    error?.kind === "translation"
      ? t(error.key)
      : error?.kind === "http"
        ? error.presentation.detail ?? t(error.presentation.categoryKey)
      : error?.kind === "route"
        ? t(error.presentation.messageKey)
      : error?.kind === "message"
        ? error.message
        : null;

  useEffect(() => setClientReady(true), []);

  useEffect(() => {
    if (webPairingIntent && token === webPairingIntent.token) {
      clearWebPairingBootstrapState(webPairingIntent);
    }
  }, [token, webPairingIntent]);

  useEffect(() => {
    if (!clientReady || Platform.OS !== "web") return;
    if (firstParam(params.token)) router.setParams({ token: undefined });
  }, [clientReady, params.token, router]);

  useEffect(() => {
    if (!clientReady || !hydrated) return;
    if (!token && resumableProfile) {
      const generation = ++attemptRef.current;
      setError(null);
      setHttpDetailsExpanded(false);
      void activateProfileRef.current(resumableProfile.id).then(() => {
        if (attemptRef.current === generation)
          router.replace({ pathname: "/h/[profileId]", params: { profileId: resumableProfile.id } });
      }).catch(value => {
        if (attemptRef.current === generation)
          setError(connectErrorFrom(value));
      });
      return () => { attemptRef.current += 1; };
    }
    if (invalidWebPairing || invalidPairingParams || !gateway || !token) {
      setError({ kind: "translation", key: "connect.missing_pairing_details" });
      return;
    }
    const generation = ++attemptRef.current;
    connectionControllerRef.current?.abort();
    const controller = new AbortController();
    connectionControllerRef.current = controller;
    setError(null);
    setHttpDetailsExpanded(false);
    void connectGatewayRef.current({ baseUrl: gateway, token, connectionRoutes, signal: controller.signal })
      .then((profile) => {
        if (attemptRef.current !== generation) return;
        if (!profile) {
          setError({ kind: "translation", key: "connect.superseded" });
          return;
        }
        if (webPairingIntent) clearWebPairingBootstrapState(webPairingIntent);
        // The committed profile owns activation now; navigation must not abort it.
        if (connectionControllerRef.current === controller)
          connectionControllerRef.current = null;
        router.replace({ pathname: "/h/[profileId]", params: { profileId: profile.id } });
      })
      .catch((value) => {
        if (attemptRef.current === generation) {
          setError(connectErrorFrom(value));
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
  }, [attempt, clientReady, gateway, hydrated, invalidPairingParams, invalidWebPairing, rawRoutes, router, token, webPairingIntent, resumableProfile?.id]);

  const leaveConnect = () => {
    if (webPairingState) clearWebPairingBootstrapState(webPairingState);
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
        {error?.kind === "http" ? <View testID="gateway-http-error" style={styles.errorBlock}>
          <Text accessibilityRole="alert" style={styles.error}>{error.presentation.detail ?? t(error.presentation.categoryKey)}</Text>
          {error.presentation.detail ? <Text style={styles.errorGuidance}>{t(error.presentation.categoryKey)}</Text> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: httpDetailsExpanded }}
            testID="gateway-http-details-toggle"
            onPress={() => setHttpDetailsExpanded(value => !value)}
            style={styles.errorDetailsToggle}
          ><Text style={styles.errorDetailsLabel}>{t(httpDetailsExpanded ? "connect.http_hide_details" : "connect.http_show_details")}</Text></Pressable>
          {httpDetailsExpanded ? <Text testID="gateway-http-status" selectable style={styles.errorStatus}>{t("connect.http_status_detail", { status: error.presentation.status })}</Text> : null}
        </View> : error?.kind === "route" ? <View testID="gateway-route-error" style={styles.errorBlock}>
          <Text accessibilityRole="alert" style={styles.error}>{errorMessage}</Text>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: httpDetailsExpanded }}
            testID="gateway-route-details-toggle" onPress={() => setHttpDetailsExpanded(value => !value)}
            style={styles.errorDetailsToggle}>
            <Text style={styles.errorDetailsLabel}>{t(httpDetailsExpanded ? "connect.http_hide_details" : "connect.http_show_details")}</Text>
          </Pressable>
          {httpDetailsExpanded ? <Text testID="gateway-route-details" selectable style={styles.errorStatus}>
            {error.presentation.detail}{"\n"}
            {t("connect.route_app_build", { version: getMobileClientVersion().value ?? t("settings.version_unavailable"),
              build: Constants.android?.versionCode ?? appJson.expo.android.versionCode })}
          </Text> : null}
        </View> : error ? <Text accessibilityRole="alert" style={styles.error}>{errorMessage}</Text> : <ActivityIndicator color={colors.green} />}
        {error ? <Button testID="pairing-retry" variant="primary" onPress={() => setAttempt((value) => value + 1)}><RotateCcw size={17} color={colors.accentText} /><Text style={{ color: colors.accentText }}>{t("connect.reconnect")}</Text></Button> : null}
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
  errorBlock: { alignItems: "center", gap: spacing.xs, width: "100%" },
  errorGuidance: { color: colors.textMuted, fontSize: 13, lineHeight: 19, textAlign: "center" },
  errorDetailsToggle: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.sm },
  errorDetailsLabel: { color: colors.green, fontSize: 12, lineHeight: 18, fontWeight: "600" },
  errorStatus: { color: colors.textMuted, fontSize: 11, lineHeight: 16, textAlign: "center" },
});
