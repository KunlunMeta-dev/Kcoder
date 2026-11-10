//! Fixed domain codes keep source paths and parser contents out of durable/public diagnostics.
pub fn error_code(error: &anyhow::Error) -> &'static str {
    for cause in error.chain() {
        match cause.to_string().as_str() {
            "plugin_migration_cancelled" | "plugin operation cancelled" => {
                return "plugin_migration_cancelled";
            }
            "plugin_migration_private_state_not_copied" => {
                return "plugin_migration_private_state_not_copied";
            }
            "plugin_migration_user_policy_changed" => return "plugin_migration_user_policy_changed",
            "plugin_migration_local_install_disabled" => {
                return "plugin_migration_local_install_disabled";
            }
            "plugin_migration_format_disabled" => return "plugin_migration_format_disabled",
            "plugin_migration_source_changed" => return "plugin_migration_source_changed",
            "plugin_migration_source_unavailable" => return "plugin_migration_source_unavailable",
            "plugin_migration_invalid_package" => return "plugin_migration_invalid_package",
            "plugin_migration_target_changed" => return "plugin_migration_target_changed",
            "plugin_migration_in_use" => return "plugin_migration_in_use",
            "plugin_migration_output_missing" => return "plugin_migration_output_missing",
            "plugin_migration_staging_budget_exceeded" => {
                return "plugin_migration_staging_budget_exceeded";
            }
            "plugin_migration_capture_retry_budget_exceeded" => {
                return "plugin_migration_capture_retry_budget_exceeded";
            }
            _ => {}
        }
    }
    "plugin_migration_outcome_unknown"
}
