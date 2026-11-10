import { useEffect, useRef, useState } from "react";
import { loadLastSessionTranscript } from "@/storage/session-transcript-cache";
import { profileAuthorizationScopeKey } from "@/state/profile-coordinator";
import { useCacheProfileReadable } from "@/features/task/useCacheProfileReadable";
import { cacheProfileReadable, type CachedSession } from "@/features/task/session-cache-coordinator";
import { Redirect } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useApp } from "@/state/AppContext";
import { useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { useInterfaceVersion } from "@/storage/interface-version";

export default function IndexRoute() {
  const version = useInterfaceVersion();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { hydrated, activeProfile, runtime, demo } = useApp();
  const key = activeProfile ? profileAuthorizationScopeKey(activeProfile) : null;
  const owner = useRef<{ key: string | null; mounted: boolean } | null>(null);
  if (owner.current?.key !== key) owner.current = { key, mounted: true };
  const captured = owner.current;
  const latestAuthorization = useRef({ profile: activeProfile, reauthorizationRequired: runtime.reauthorizationRequired });
  latestAuthorization.current = { profile: activeProfile, reauthorizationRequired: runtime.reauthorizationRequired };
  const profileReadable = useCacheProfileReadable(activeProfile, runtime.reauthorizationRequired);
  const readable = hydrated && !demo && profileReadable;
  const allowed = useRef(readable); allowed.current = readable;
  const [restored, setRestored] = useState<{ owner: typeof captured; value: CachedSession | null } | null>(null);
  useEffect(() => {
    captured.mounted = true;
    const current = () => {
      const latest = latestAuthorization.current;
      return owner.current === captured && captured.mounted && allowed.current && Boolean(latest.profile &&
        cacheProfileReadable(latest.profile, latest.reauthorizationRequired) && profileAuthorizationScopeKey(latest.profile) === key);
    };
    if (readable && activeProfile) void loadLastSessionTranscript(activeProfile, current)
      .then(value => { if (current()) setRestored({ owner: captured, value }); })
      .catch(() => { if (current()) setRestored({ owner: captured, value: null }); });
    return () => { captured.mounted = false; };
  }, [captured, readable]);
  if (!hydrated) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.text} />
      </View>
    );
  }
  if (!activeProfile) return <Redirect href="/welcome" />;
  if (activeProfile.expiresAt <= Date.now() && !activeProfile.refreshToken) {
    return <Redirect href={{ pathname: "/welcome", params: { gateway: activeProfile.baseUrl, reauth: activeProfile.id } }} />;
  }
  if (readable && restored?.owner !== captured) return <View style={styles.center}><ActivityIndicator color={colors.text} /></View>;
  if (readable && restored?.owner === captured && restored.value) {
    const scope = restored.value.record.scope;
    return <Redirect href={{ pathname: "/h/[profileId]/task/[serverId]/[threadId]",
      params: { profileId: activeProfile.id, serverId: scope.target.id, threadId: scope.threadId, cwd: scope.cwd } }} />;
  }
  return <Redirect href={{ pathname: version === "v3" ? "/new" : "/h/[profileId]", params: { profileId: activeProfile.id } }} />;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({ center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background } });
