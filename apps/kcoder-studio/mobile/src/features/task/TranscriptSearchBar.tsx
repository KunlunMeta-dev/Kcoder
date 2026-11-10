import { ChevronDown, ChevronUp, X } from "lucide-react-native";
import { Pressable, Text, TextInput, View } from "react-native";
import { t } from "@/i18n";
import { spacing, radius } from "@/theme";
import { useTaskAppearance } from "./taskStyles";
import type { TranscriptMatch } from "./transcript-search";

export function TranscriptSearchBar({ query, onQuery, matches, total, index, onStep, onClose }: {
  query: string; onQuery(value: string): void; matches: TranscriptMatch[]; total: number; index: number;
  onStep(delta: number): void; onClose(): void;
}) {
  const { colors, styles } = useTaskAppearance();
  const disabled = matches.length === 0;
  return <View testID="transcript-search" style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    backgroundColor: colors.surface, gap: spacing.xs }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
      <TextInput testID="transcript-search-input" autoFocus value={query} onChangeText={onQuery}
        accessibilityLabel={t("task.search_loaded_body")} placeholder={t("task.search_loaded_body")}
        placeholderTextColor={colors.textDim} maxLength={200} returnKeyType="search"
        onSubmitEditing={() => onStep(1)} style={{ flex: 1, minWidth: 0, color: colors.text, fontSize: 14,
          borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.sm }} />
      <Text accessibilityLiveRegion="polite" testID="transcript-search-count" style={{ color: colors.textMuted, fontSize: 12 }}>
        {matches.length ? index + 1 : 0}/{matches.length}
      </Text>
      {([-1, 1] as const).map((delta) => <Pressable key={delta} accessibilityRole="button"
        testID={delta < 0 ? "transcript-search-previous" : "transcript-search-next"}
        accessibilityLabel={t(delta < 0 ? "task.previous_match" : "task.next_match")}
        disabled={disabled} accessibilityState={{ disabled }} onPress={() => onStep(delta)} style={styles.messageAction}>
        {delta < 0 ? <ChevronUp size={18} color={disabled ? colors.textDim : colors.textMuted} />
          : <ChevronDown size={18} color={disabled ? colors.textDim : colors.textMuted} />}
      </Pressable>)}
      <Pressable testID="transcript-search-close" accessibilityRole="button" accessibilityLabel={t("task.close")}
        onPress={onClose} style={styles.messageAction}><X size={18} color={colors.textMuted} /></Pressable>
    </View>
    <Text style={{ color: colors.textDim, fontSize: 11 }}>{total > matches.length ? t("task.loaded_body_limited", { total, count: matches.length }) : t("task.loaded_body_only")}</Text>
    {matches[index] ? <Text testID="transcript-search-excerpt" numberOfLines={2}
      style={{ color: colors.text, fontSize: 12 }}>{matches[index].excerpt}</Text> : query.trim()
      ? <Text style={{ color: colors.textMuted, fontSize: 12 }}>{t("task.no_body_match")}</Text> : null}
  </View>;
}
