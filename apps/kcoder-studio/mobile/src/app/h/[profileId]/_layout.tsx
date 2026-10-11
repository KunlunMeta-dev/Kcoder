import { Stack } from "expo-router";
import { useTheme } from "@/theme";

export default function HostLayout() {
  const { colors } = useTheme();
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="task/[serverId]/[threadId]" />
    </Stack>
  );
}
