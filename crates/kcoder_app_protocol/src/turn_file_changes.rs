//! Wire type for the turn-file-change snapshot policy (`settings/turn-file-changes/*`).

use serde::{Deserialize, Serialize};

fn default_true() -> bool {
    true
}
fn default_retention_days() -> u64 {
    14
}
fn default_max_total_bytes() -> u64 {
    5 * 1024 * 1024 * 1024
}
fn default_max_file_bytes() -> u64 {
    64 * 1024 * 1024
}

/// Effective `turn_file_changes` policy edited from KCoder Studio.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnFileChangesPolicy {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_retention_days")]
    pub retention_days: u64,
    #[serde(default = "default_max_total_bytes")]
    pub max_total_bytes: u64,
    #[serde(default = "default_max_file_bytes")]
    pub max_file_bytes: u64,
    #[serde(default)]
    pub ignore_globs: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_defaults_match_the_runtime_policy() {
        let policy: TurnFileChangesPolicy = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(policy.enabled);
        assert_eq!(policy.retention_days, 14);
        assert_eq!(policy.max_total_bytes, 5 * 1024 * 1024 * 1024);
        assert_eq!(policy.max_file_bytes, 64 * 1024 * 1024);
        assert!(policy.ignore_globs.is_empty());
    }

    #[test]
    fn policy_round_trips_as_camel_case_and_rejects_unknown_fields() {
        let policy = TurnFileChangesPolicy {
            enabled: false,
            retention_days: 3,
            max_total_bytes: 1024,
            max_file_bytes: 512,
            ignore_globs: vec!["**/*.gguf".into()],
        };
        let wire = serde_json::to_value(&policy).unwrap();
        assert_eq!(wire["retentionDays"], 3);
        assert_eq!(wire["maxTotalBytes"], 1024);
        assert_eq!(wire["maxFileBytes"], 512);
        assert_eq!(wire["ignoreGlobs"][0], "**/*.gguf");
        let back: TurnFileChangesPolicy = serde_json::from_value(wire).unwrap();
        assert_eq!(back, policy);

        let err = serde_json::from_value::<TurnFileChangesPolicy>(serde_json::json!({"bogus": 1}))
            .unwrap_err();
        assert!(err.to_string().contains("unknown field"), "{err}");
    }

    #[test]
    fn method_names_are_stable() {
        use crate::method;
        assert_eq!(
            method::SETTINGS_TURN_FILE_CHANGES_READ,
            "settings/turn-file-changes/read"
        );
        assert_eq!(
            method::SETTINGS_TURN_FILE_CHANGES_SAVE,
            "settings/turn-file-changes/save"
        );
    }
}
