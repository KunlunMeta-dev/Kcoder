import { useId } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop, Text as SvgText } from "react-native-svg";
import { CornerUpLeft, MoreHorizontal, Plus, Server } from "lucide-react-native";
import { t } from "@/i18n";
import { useTheme } from "@/theme";
import { useInterfaceVersion } from "@/storage/interface-version";

/** A vector background shared by Web and native; it owns no application state. */
export function ConversationV3Background() {
  const version = useInterfaceVersion();
  const { mode } = useTheme();
  const id = useId().replace(/:/g, "");
  if (version !== "v3") return null;
  const dark = mode === "dark";
  return <View testID="conversation-v3-background" accessible={false} style={[StyleSheet.absoluteFill, { pointerEvents: "none" }]}>
    <Svg width="100%" height="100%" viewBox="0 0 390 844" preserveAspectRatio="none">
      <Defs>
        <LinearGradient id={`${id}-base`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={dark ? "#1D2030" : "#FAFBFF"} />
          <Stop offset="0.42" stopColor={dark ? "#151822" : "#FEFFFF"} />
          <Stop offset="1" stopColor={dark ? "#211F35" : "#F6F6FF"} />
        </LinearGradient>
        <RadialGradient id={`${id}-violet`} cx="30" cy="0" rx="240" ry="240" r="240" gradientUnits="userSpaceOnUse" gradientTransform="translate(30 0) scale(1.3 0.85) translate(-30 0)">
          <Stop offset="0" stopColor={dark ? "#514775" : "#D8D7FF"} stopOpacity="0.95" />
          <Stop offset="1" stopColor={dark ? "#514775" : "#D8D7FF"} stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id={`${id}-blue`} cx="225" cy="0" rx="160" ry="160" r="160" gradientUnits="userSpaceOnUse" gradientTransform="translate(225 0) scale(0.9 1.2) translate(-225 0)">
          <Stop offset="0" stopColor={dark ? "#35405F" : "#B6D0F7"} stopOpacity="0.82" />
          <Stop offset="1" stopColor={dark ? "#35405F" : "#B6D0F7"} stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id={`${id}-cyan`} cx="315" cy="10" rx="160" ry="160" r="160" gradientUnits="userSpaceOnUse" gradientTransform="translate(315 10) scale(0.85 1.1) translate(-315 -10)">
          <Stop offset="0" stopColor={dark ? "#27545C" : "#B7F1F0"} stopOpacity="0.8" />
          <Stop offset="1" stopColor={dark ? "#27545C" : "#B7F1F0"} stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Rect width="390" height="844" fill={`url(#${id}-base)`} />
      <Rect width="390" height="844" fill={`url(#${id}-violet)`} />
      <Rect width="390" height="844" fill={`url(#${id}-blue)`} />
      <Rect width="390" height="844" fill={`url(#${id}-cyan)`} />
    </Svg>
  </View>;
}

export function ConversationV3WelcomeMark() {
  return <View testID="conversation-v3-welcome-mark" accessible={false} style={{ width: 154, height: 100, alignItems: "center", justifyContent: "center" }}>
    <Svg width="154" height="100" viewBox="0 0 154 100">
      {[0, 1, 2].map(index => <Rect key={index} x={(154 - (78 + index * 18)) / 2} y={(100 - (56 + index * 12)) / 2} width={78 + index * 18} height={56 + index * 12}
        rx="24" fill="none" stroke="#A7E3EF" strokeOpacity={0.3 - index * 0.07} transform="translate(77 50) scale(1 0.68) rotate(45) translate(-77 -50)" />)}
      <Rect x="48" y="18" width="58" height="58" rx="18" fill="#DCD7FF" transform="rotate(45 77 47)" />
      <SvgText x="77" y="64" textAnchor="middle" fontFamily="serif" fontSize="36" fontStyle="italic" fill="#4943B0">Ai</SvgText>
    </Svg>
  </View>;
}

export interface ConversationV3Navigation {
  projects?(): void;
  history?(): void;
  inbox?(): void;
  settings?(): void;
}

export function ConversationV3Header({ title, subtitle, statusLabel, onBack, onNew, onMore, navigation }: {
  title?: string; subtitle?: string; statusLabel?: string; onBack(): void; onNew?(): void; onMore?(): void;
  navigation?: ConversationV3Navigation;
}) {
  const { colors } = useTheme();
  return (
    <View testID="task-header" style={styles.header}>
      <View style={styles.leading}><Pressable testID="v3-conversation-menu" accessibilityRole="button" accessibilityLabel={t("v3.conversations")}
        onPress={navigation?.projects ?? onBack} style={styles.icon}>
        <CornerUpLeft size={21} color={colors.textMuted} />
      </Pressable></View>
      <View style={styles.title}><Text testID="task-header-title" numberOfLines={1} style={{ color: colors.text, fontSize: 16, fontWeight: "600", textAlign: "center" }}>{title ?? ""}</Text>
        {subtitle ? <View style={styles.subtitle}><Server size={13} color={colors.textDim} style={{ flexShrink: 0 }} /><Text testID="task-header-status" accessibilityLabel={statusLabel ?? subtitle} numberOfLines={1} style={{ color: colors.textDim, fontSize: 13, flexShrink: 1 }}>{subtitle}</Text></View> : null}
      </View>
      <Pressable testID="task-new" accessibilityRole="button" accessibilityLabel={t("task.new_task")} disabled={!onNew}
        accessibilityState={{ disabled: !onNew }} onPress={onNew} style={styles.icon}><Plus size={22} color={!onNew ? colors.textDim : colors.textMuted} /></Pressable>
      <Pressable testID="task-more" accessibilityRole="button" accessibilityLabel={t("task.more")} disabled={!onMore}
        accessibilityState={{ disabled: !onMore }} onPress={onMore} style={styles.icon}><MoreHorizontal size={22} color={!onMore ? colors.textDim : colors.textMuted} /></Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { height: 72, paddingHorizontal: 8, flexDirection: "row", alignItems: "center" },
  leading: { width: 88 },
  icon: { width: 44, height: 44, borderRadius: 12, flexDirection: "row", gap: 2, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, minWidth: 0, paddingHorizontal: 8 },
  subtitle: { marginTop: 4, minWidth: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
});
