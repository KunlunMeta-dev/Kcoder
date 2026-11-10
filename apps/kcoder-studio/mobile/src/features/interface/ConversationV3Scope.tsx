import { Pressable, Text, View } from "react-native";
import { ChevronDown, Folder, Server } from "lucide-react-native";
import { useTheme, useThemedStyles } from "@/theme";
import { StatusDot } from "@/components/ui";
import { t } from "@/i18n";
import { v3ContextStyles } from "./v3-styles";

/** Frozen draft specimens retain target context without mounting the live picker. */
export function ConversationV3Scope({ server, cwd, connected, onNavigate }: {
  server?: string; cwd: string; connected: boolean; onNavigate?(): void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(v3ContextStyles);
  const project = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
  return <View testID="v3-conversation-context" style={styles.contextGroup}><View style={styles.bar}>
    <Pressable testID="v3-context-server" accessibilityRole="button" accessibilityLabel={`${server ?? ""} · ${t("task.open_task_list")}`}
      disabled={!onNavigate} onPress={onNavigate} hitSlop={{ top: 7, bottom: 7 }} style={styles.serverButton}>
      <StatusDot status={connected ? "online" : "offline"} decorative /><Server size={14} color={colors.textMuted} />
      <Text numberOfLines={1} style={styles.projectValue}>{server ?? t("v2.server")}</Text><ChevronDown size={12} color={colors.textDim} />
    </Pressable>
    <Pressable testID="v3-context-project" accessibilityRole="button" accessibilityLabel={`${project} · ${cwd} · ${t("task.open_task_list")}`}
      disabled={!onNavigate} onPress={onNavigate} hitSlop={{ top: 7, bottom: 7 }} style={styles.projectButton}>
      <Folder size={14} color={colors.textMuted} /><Text numberOfLines={1} style={styles.projectValue}>{project}</Text><ChevronDown size={12} color={colors.textDim} />
    </Pressable>
  </View></View>;
}
