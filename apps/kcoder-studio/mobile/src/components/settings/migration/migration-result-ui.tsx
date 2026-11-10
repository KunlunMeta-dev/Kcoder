import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Button } from "@/components/ui";
import { t } from "@/i18n";
import { spacing, useThemedStyles, type ThemeColors } from "@/theme";
export function ReadNotice({ loading, error }: {
    loading?: boolean;
    error?: string | null;
}) {
    const styles = useThemedStyles(makeStyles);
    return loading ? <ActivityIndicator accessibilityLabel={t("migration_results.loading")}/> : error ? <Text accessibilityRole="alert" style={styles.error}>{t(`migration_results.error_${error}`)}</Text> : null;
}
export function Empty() { const styles = useThemedStyles(makeStyles); return <Text style={styles.note}>{t("migration_results.empty")}</Text>; }
export function PageControls({ previous, next, onPrevious, onNext, onFirst }: {
    previous: boolean;
    next: boolean;
    onPrevious(): void;
    onNext(): void;
    onFirst?(): void;
}) {
    const styles = useThemedStyles(makeStyles);
    return <View style={styles.actions}>
    {onFirst ? <Button variant="ghost" onPress={onFirst}>{t("migration_results.first")}</Button> : null}
    <Button variant="ghost" disabled={!previous} onPress={onPrevious}>{t("migration_results.previous")}</Button>
    <Button variant="ghost" disabled={!next} onPress={onNext}>{t("migration_results.next")}</Button>
  </View>;
}
export const makeStyles = (colors: ThemeColors) => StyleSheet.create({
    stack: { gap: spacing.md, padding: spacing.md }, actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
    row: { gap: spacing.xs, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    title: { color: colors.text, fontSize: 16, fontWeight: "600" }, text: { color: colors.text, fontSize: 14, lineHeight: 22 },
    note: { color: colors.textMuted, fontSize: 13, lineHeight: 20, padding: spacing.sm }, error: { color: colors.red, fontSize: 13, lineHeight: 20, padding: spacing.sm }, warning: { color: colors.yellow, fontSize: 13, lineHeight: 20, padding: spacing.sm },
});
export function appendPage<T>(pages: T[], cursor: T): T[] { return [...pages.slice(-255), cursor]; }
