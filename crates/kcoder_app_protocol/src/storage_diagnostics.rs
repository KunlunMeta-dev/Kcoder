//! Wire types for the storage/diagnostics RPCs (`diagnostics/storage/*`).

use serde::{Deserialize, Serialize};

/// One labeled slice of the KCoder configuration directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageBucket {
    pub id: String,
    pub bytes: u64,
    pub files: usize,
    /// Whether `diagnostics/storage/clean` can reclaim this bucket.
    pub cleanable: bool,
}

/// State of the `DEV_DEBUG` request recorder for the target server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevDebugStatus {
    /// Whether request/response recording is active right now.
    pub enabled: bool,
    /// True when the process environment itself carries `DEV_DEBUG`.
    pub env_set: bool,
    /// `DEV_DEBUG` assignments still present in `<config>/.env`.
    pub dotenv_lines: usize,
    pub retention_days: i64,
    pub log_bytes: u64,
    pub log_files: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oldest_day: Option<String>,
}

/// Where provider credentials live and how exposed they are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialsStatus {
    pub path: String,
    pub present: bool,
    /// `None` when the platform cannot report permissions cheaply (Windows ACLs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_only: Option<bool>,
    pub providers: usize,
    /// Credential-shaped assignments still present in `<config>/.env`.
    pub dotenv_credential_lines: usize,
    /// Whether the operating-system credential store is reachable on this target.
    #[serde(default)]
    pub keyring_available: bool,
    /// Human-readable name of that store.
    #[serde(default)]
    pub keyring_backend: String,
    /// Providers whose secret already lives in the operating-system store.
    #[serde(default)]
    pub keyring_providers: Vec<String>,
    /// Providers still stored as plaintext in `credentials.json`.
    #[serde(default)]
    pub plaintext_providers: Vec<String>,
}

/// Footprint of the configuration directory plus the debug-recorder status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageReport {
    pub config_root: String,
    pub total_bytes: u64,
    pub total_files: usize,
    pub buckets: Vec<StorageBucket>,
    pub dev_debug: DevDebugStatus,
    pub credentials: CredentialsStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageCleanParams {
    /// `debug-logs` or `turn-snapshots`.
    pub target: String,
    /// Must be true; guards against an accidental cleanup call.
    #[serde(default)]
    pub confirm: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCleanResult {
    pub removed_bytes: u64,
    pub removed_files: usize,
    pub report: StorageReport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugLogDisableResult {
    pub changed: bool,
    pub dotenv_path: String,
    pub note: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_report() -> StorageReport {
        StorageReport {
            config_root: "/home/u/.config/kcoder".into(),
            total_bytes: 1024,
            total_files: 7,
            buckets: vec![StorageBucket {
                id: "debug-logs".into(),
                bytes: 512,
                files: 2,
                cleanable: true,
            }],
            credentials: CredentialsStatus {
                path: "/home/u/.config/kcoder/credentials.json".into(),
                present: true,
                user_only: Some(true),
                providers: 2,
                dotenv_credential_lines: 1,
            },
            dev_debug: DevDebugStatus {
                enabled: true,
                env_set: false,
                dotenv_lines: 1,
                retention_days: 7,
                log_bytes: 512,
                log_files: 2,
                oldest_day: Some("20260901".into()),
            },
        }
    }

    #[test]
    fn storage_report_round_trips_as_camel_case() {
        let wire = serde_json::to_value(sample_report()).unwrap();
        assert_eq!(wire["configRoot"], "/home/u/.config/kcoder");
        assert_eq!(wire["totalBytes"], 1024);
        assert_eq!(wire["buckets"][0]["id"], "debug-logs");
        assert_eq!(wire["buckets"][0]["cleanable"], true);
        assert_eq!(wire["devDebug"]["enabled"], true);
        assert_eq!(wire["devDebug"]["retentionDays"], 7);
        assert_eq!(wire["devDebug"]["oldestDay"], "20260901");
        assert_eq!(wire["credentials"]["userOnly"], true);
        assert_eq!(wire["credentials"]["dotenvCredentialLines"], 1);
        let back: StorageReport = serde_json::from_value(wire).unwrap();
        assert_eq!(back, sample_report());
    }

    #[test]
    fn clean_params_require_a_target_and_reject_unknown_fields() {
        let params: StorageCleanParams =
            serde_json::from_value(serde_json::json!({"target": "debug-logs"})).unwrap();
        assert_eq!(params.target, "debug-logs");
        assert!(!params.confirm, "confirmation defaults to false");
        let err = serde_json::from_value::<StorageCleanParams>(
            serde_json::json!({"target": "debug-logs", "bogus": 1}),
        )
        .unwrap_err();
        assert!(err.to_string().contains("unknown field"), "{err}");
    }

    #[test]
    fn clean_result_and_disable_result_carry_their_summaries() {
        let result = StorageCleanResult {
            removed_bytes: 2048,
            removed_files: 4,
            report: sample_report(),
        };
        let wire = serde_json::to_value(&result).unwrap();
        assert_eq!(wire["removedBytes"], 2048);
        assert_eq!(wire["report"]["totalFiles"], 7);

        let disabled = DebugLogDisableResult {
            changed: true,
            dotenv_path: "/home/u/.config/kcoder/.env".into(),
            note: "restart kcoder to stop recording requests".into(),
        };
        let wire = serde_json::to_value(&disabled).unwrap();
        assert_eq!(wire["changed"], true);
        assert_eq!(wire["dotenvPath"], "/home/u/.config/kcoder/.env");
    }

    #[test]
    fn method_names_are_stable() {
        use crate::method;
        assert_eq!(method::DIAGNOSTICS_STORAGE_READ, "diagnostics/storage/read");
        assert_eq!(
            method::DIAGNOSTICS_STORAGE_CLEAN,
            "diagnostics/storage/clean"
        );
        assert_eq!(
            method::DIAGNOSTICS_DEBUG_LOG_DISABLE,
            "diagnostics/debug-log/disable"
        );
    }
}
