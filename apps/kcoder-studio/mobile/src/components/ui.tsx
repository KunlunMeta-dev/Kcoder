import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from "react-native";
import { colors, radius, spacing } from "@/theme";

export function Button({
  children,
  onPress,
  variant = "secondary",
  disabled = false,
  loading = false,
  testID,
  style,
}: {
  children: ReactNode;
  onPress(): void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === "primary" && styles.primaryButton,
        variant === "ghost" && styles.ghostButton,
        variant === "danger" && styles.dangerButton,
        (disabled || loading) && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === "primary" ? colors.accentText : colors.text} />
      ) : typeof children === "string" ? (
        <Text
          style={[
            styles.buttonText,
            variant === "primary" && styles.primaryButtonText,
            variant === "danger" && styles.dangerButtonText,
          ]}
        >
          {children}
        </Text>
      ) : (
        children
      )}
    </Pressable>
  );
}

export function Field({ label, hint, accessibilityLabel, ...props }: TextInputProps & { label?: string; hint?: string }) {
  return (
    <View style={styles.fieldRoot}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        accessibilityLabel={accessibilityLabel ?? label}
        placeholderTextColor={colors.textDim}
        selectionColor={colors.blue}
        style={[styles.input, props.multiline && styles.multilineInput]}
        {...props}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function StatusDot({ status }: { status: "online" | "offline" | "checking" }) {
  return (
    <View
      accessibilityLabel={status}
      style={[
        styles.dot,
        status === "online" && styles.dotOnline,
        status === "offline" && styles.dotOffline,
        status === "checking" && styles.dotChecking,
      ]}
    />
  );
}

export function EmptyState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <View style={styles.empty}>
      {icon}
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    flexDirection: "row",
    gap: spacing.sm,
  },
  primaryButton: { backgroundColor: colors.accent, borderColor: colors.accent },
  ghostButton: { backgroundColor: "transparent", borderColor: "transparent" },
  dangerButton: { backgroundColor: "rgba(251,113,133,0.12)", borderColor: "rgba(251,113,133,0.3)" },
  buttonText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  primaryButtonText: { color: colors.accentText },
  dangerButtonText: { color: colors.red },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
  fieldRoot: { gap: spacing.sm },
  label: { color: colors.text, fontSize: 13, fontWeight: "600" },
  hint: { color: colors.textDim, fontSize: 12, lineHeight: 18 },
  input: {
    minHeight: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: spacing.md,
    fontSize: 15,
  },
  multilineInput: { minHeight: 112, paddingTop: spacing.md, textAlignVertical: "top" },
  dot: { width: 9, height: 9, borderRadius: 9 },
  dotOnline: { backgroundColor: colors.green },
  dotOffline: { backgroundColor: colors.textDim },
  dotChecking: { backgroundColor: colors.yellow },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xxl, gap: spacing.md },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: "600", textAlign: "center" },
  emptyBody: { color: colors.textMuted, fontSize: 14, lineHeight: 21, textAlign: "center", maxWidth: 360 },
});
