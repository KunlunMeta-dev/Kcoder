import { Folder, Server } from "lucide-react-native";
import { StyleSheet, View } from "react-native";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { useTheme } from "@/theme";
import { workspaceTargetColor } from "./thread-list-presentation";

export function WorkspaceFolderBadge({ profile, server, testID }: {
  profile: GatewayProfile;
  server: KCoderServer;
  testID: string;
}) {
  const { colors } = useTheme();
  return <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.folder, { pointerEvents: "none" }]}>
    <Folder size={16} color={colors.textDim} />
    <View testID={testID} style={[styles.badge, { backgroundColor: workspaceTargetColor(profile, server) }]}>
      <Server size={7} color="#FFFFFF" strokeWidth={2} />
    </View>
  </View>;
}

const styles = StyleSheet.create({
  folder: { width: 16, height: 16, flexShrink: 0 },
  badge: { position: "absolute", right: -3, bottom: -2, width: 9, height: 9, borderRadius: 2, alignItems: "center", justifyContent: "center" },
});
