import { Text, View } from "react-native";
import { Button, Field } from "@/components/ui";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import { makeStyles } from "../migration-result-ui";
const problemCopy: Readonly<Record<string, string>> = {
  migration_plugin_projects_update_required: 'plugin_upgrade',
  source_transfer_plugins_update_required: 'plugin_upgrade',
  source_transfer_plugin_projects_update_required: 'plugin_upgrade',
  migration_settings_busy: 'settings_busy',
  migration_target_configuration_recovery_required: 'settings_recovery_required',
  migration_target_configuration_access_denied: 'settings_access_denied',
  migration_target_configuration_missing: 'settings_missing',
  migration_target_configuration_invalid: 'settings_invalid',
  migration_target_configuration_ownership_invalid: 'settings_ownership_invalid',
  migration_target_configuration_budget_exceeded: 'settings_budget_exceeded',
  source_transfer_directory_invalid: 'directory_problem',
  source_transfer_directory_changed: 'directory_problem',
  source_transfer_directory_expired: 'directory_problem',
  source_transfer_directory_update_required: 'directory_upgrade',
};
export function MigrationProblem({ code }: { code?: string | null }) {
  const styles = useThemedStyles(makeStyles);
  const preparation = code === 'private_credentials_preparation_pending' || code === 'private_credentials_publication_unknown';
  const catalog = code === 'source_transfer_history_catalog_unavailable' || code === 'source_transfer_catalog_expired';
  const safe = code && (preparation || /^(?:migration|source_upload|source_transfer|plugin_migration|history|continuation|historical_projection|historical_context|historical_seed|historical_undo|external_history|local_upload|local_attachment)_[a-z_]{1,120}$/.test(code)) ? code : "migration_request_failed";
  return code ? <View><Text accessibilityRole="alert" style={styles.error}>{t(catalog ? 'migration_history_families.catalog_unavailable' : preparation ? 'migration_private.preparation_problem' : safe === 'source_transfer_definitions_update_required' ? 'migration_definitions.update_required' : problemCopy[safe] ? `migration_source.${problemCopy[safe]}` : "migration_workbench.request_failed")}</Text><Text selectable style={styles.note}>{safe}</Text></View> : null;
}
export function Check({ checked, onPress, label, testID, disabled }: { checked: boolean; onPress(): void; label: string; testID: string; disabled?: boolean }) {
  return <Button testID={testID} disabled={disabled} variant={checked ? "secondary" : "ghost"} onPress={onPress}>{`${checked ? "☑" : "☐"} ${label}`}</Button>;
}
export function Confirm({ keyword, value, onChange, onConfirm, onDismiss, busy, disabled, testID }: { keyword: string; value: string; onChange(value: string): void; onConfirm(): void; onDismiss(): void; busy: boolean; disabled?: boolean; testID: string }) {
  return <View>
    <Field testID={`${testID}-input`} label={t("migration_workbench.confirm_keyword", { keyword })} value={value} onChangeText={onChange} autoCapitalize="characters" autoCorrect={false} maxLength={16}/>
    <Button testID={`${testID}-submit`} variant={keyword === "UNDO" ? "danger" : "primary"} disabled={busy || disabled || value !== keyword} onPress={onConfirm}>{t("migration_workbench.confirm")}</Button>
    <Button testID={`${testID}-dismiss`} variant="ghost" disabled={busy} onPress={onDismiss}>{t("migration_workbench.dismiss")}</Button>
  </View>;
}
