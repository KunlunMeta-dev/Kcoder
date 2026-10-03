import { Stack } from "expo-router";
import { colors } from "@/theme";

export default function HostLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="task/[serverId]/[threadId]" />
    </Stack>
  );
}
