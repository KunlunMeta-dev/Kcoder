import { Stack } from "expo-router";
import { useTheme } from "@/theme";
import { ScreenFocusBoundary } from "@/navigation/screen-focus-boundary";
import type { PropsWithChildren } from "react";

const screenLayout = ({ children }: PropsWithChildren) => <ScreenFocusBoundary>{children}</ScreenFocusBoundary>;

export default function HostLayout() {
  const { colors } = useTheme();
  return (
    <Stack screenLayout={screenLayout} screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="inbox" />
      <Stack.Screen name="task/[serverId]/[threadId]" />
    </Stack>
  );
}
