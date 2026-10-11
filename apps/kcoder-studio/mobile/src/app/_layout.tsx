import { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AppState } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppProvider } from "@/state/AppContext";
import { initTheme, refreshSystemTheme, setThemePreference, useTheme } from "@/theme";
import { RootErrorBoundary } from "@/components/root-error-boundary";
import {
  getAppPreferencesSnapshot,
  hydrateAppPreferences,
  subscribeAppPreferences,
} from "@/storage/app-preferences";
import "@/web-styles";
import {
  initLocale,
  refreshSystemLocale,
  setLocalePreference,
  setSystemLocaleReader,
} from "@/i18n";
import { getSystemLocaleTag } from "@/i18n/system-locale";

export default function RootLayout() {
  const [preferencesReady, setPreferencesReady] = useState(false);
  const { colors, mode } = useTheme();

  useEffect(() => {
    let cancelled = false;
    void hydrateAppPreferences()
      .then((loadedPreferences) => {
        if (cancelled) return;
        setSystemLocaleReader(getSystemLocaleTag);
        initLocale(loadedPreferences.language);
        initTheme(loadedPreferences.theme);
        setPreferencesReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setSystemLocaleReader(getSystemLocaleTag);
        initLocale("system");
        initTheme("system");
        setPreferencesReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!preferencesReady) return;
    const applyPreferences = () => {
      const preferences = getAppPreferencesSnapshot();
      setLocalePreference(preferences.language);
      setThemePreference(preferences.theme);
    };
    applyPreferences();
    return subscribeAppPreferences(applyPreferences);
  }, [preferencesReady]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      refreshSystemLocale();
      refreshSystemTheme();
    });
    return () => subscription.remove();
  }, []);

  if (!preferencesReady) return null;
  return (
    <SafeAreaProvider>
      <RootErrorBoundary>
        <AppProvider>
          <StatusBar
            style={mode === "dark" ? "light" : "dark"}
            backgroundColor={colors.background}
          />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
              animation: "fade",
            }}
          >
            <Stack.Screen name="index" />
            <Stack.Screen name="welcome" />
            <Stack.Screen name="connect" />
            <Stack.Screen name="h/[profileId]" />
            <Stack.Screen name="new" />
            <Stack.Screen name="settings" />
            <Stack.Screen name="sessions" />
            <Stack.Screen name="open-project" />
            <Stack.Screen name="pair-scan" />
            <Stack.Screen name="server-editor" />
          </Stack>
        </AppProvider>
      </RootErrorBoundary>
    </SafeAreaProvider>
  );
}
