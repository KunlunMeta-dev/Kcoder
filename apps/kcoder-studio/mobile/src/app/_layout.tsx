import { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppProvider } from "@/state/AppContext";
import { colors } from "@/theme";
import { RootErrorBoundary } from "@/components/root-error-boundary";
import { hydrateAppPreferences } from "@/storage/app-preferences";
import "@/web-styles";
import { initLocale } from "@/i18n";

export default function RootLayout() {
  // Static Web export and the first hydration render must agree. Resolve the
  // device language before mounting translated routes, after hydration begins.
  const [localeReady, setLocaleReady] = useState(false);
  useEffect(() => {
    initLocale();
    setLocaleReady(true);
    void hydrateAppPreferences();
  }, []);
  if (!localeReady) return null;
  return (
    <SafeAreaProvider>
      <RootErrorBoundary>
        <AppProvider>
          <StatusBar style="light" backgroundColor={colors.background} />
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
