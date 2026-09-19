import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppProvider } from "@/state/AppContext";
import { colors } from "@/theme";
import { RootErrorBoundary } from "@/components/root-error-boundary";
import { hydrateAppPreferences } from "@/storage/app-preferences";
import "@/web-styles";

export default function RootLayout() {
  useEffect(() => { void hydrateAppPreferences(); }, []);
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
