import { Check, X } from "lucide-react-native";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useModalFocusTrap } from "@/components/use-modal-focus-trap";
import { t } from "@/i18n";
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from "@/theme";

export interface SettingsChoiceOption<Value extends string> {
  value: Value;
  label: string;
  testID: string;
}

export function SettingsChoiceSheet<Value extends string>({
  visible,
  testID,
  title,
  options,
  selected,
  onSelect,
  onClose,
}: {
  visible: boolean;
  testID: string;
  title: string;
  options: readonly SettingsChoiceOption<Value>[];
  selected: Value;
  onSelect(value: Value): void;
  onClose(): void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const sheetRef = useModalFocusTrap(visible, onClose);

  return (
    <Modal
      testID={testID}
      visible={visible}
      transparent
      animationType={Platform.OS === "web" ? "none" : "slide"}
      onRequestClose={onClose}
      accessibilityLabel={title}
    >
      <View style={styles.overlayRoot}>
        <Pressable accessibilityLabel={t("common.close")} style={styles.overlay} onPress={onClose} />
        <View ref={sheetRef} role="dialog" accessibilityViewIsModal style={[styles.sheet, { maxHeight: Math.max(0, window.height - insets.top), paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>{title}</Text>
            <Pressable
              testID="settings-choice-cancel"
              accessibilityRole="button"
              accessibilityLabel={t("common.close")}
              onPress={onClose}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            >
              <X size={20} color={colors.textMuted} />
            </Pressable>
          </View>
          <ScrollView style={styles.options} showsVerticalScrollIndicator={false}>
            {options.map((option, index) => {
              const checked = option.value === selected;
              return (
                <Pressable
                  key={option.value}
                  testID={option.testID}
                  accessibilityRole="radio"
                  accessibilityState={{ checked }}
                  aria-checked={Platform.OS === "web" ? checked : undefined}
                  onPress={() => { onSelect(option.value); onClose(); }}
                  style={({ pressed }) => [styles.option, index < options.length - 1 && styles.optionDivider, pressed && styles.pressed]}
                >
                  <Text style={styles.optionLabel}>{option.label}</Text>
                  {checked ? <Check size={20} color={colors.text} /> : <View style={styles.emptyCheck} />}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  overlayRoot: { flex: 1, justifyContent: "flex-end", alignItems: "center" },
  overlay: { ...StyleSheet.absoluteFill, backgroundColor: colors.overlay },
  sheet: { width: "100%", maxWidth: 720, flexShrink: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.md, borderTopLeftRadius: radius.settingsGroup, borderTopRightRadius: radius.settingsGroup, backgroundColor: colors.settingsGroupBackground },
  header: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.sm },
  options: { flexShrink: 1 },
  title: { color: colors.text, fontSize: 17, fontWeight: "600" },
  closeButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.pill },
  option: { minHeight: 60, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  optionDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  optionLabel: { flex: 1, color: colors.text, fontSize: 16 },
  emptyCheck: { width: 20, height: 20 },
  pressed: { opacity: 0.72 },
});
