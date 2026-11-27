//! Preserve actionable read failures without exposing configuration, paths or credentials.
use std::io::ErrorKind;

pub(super) fn classify(error: anyhow::Error) -> anyhow::Error {
    let code = error.chain().find_map(|cause| {
        match cause.to_string().as_str() {
            "settings_busy" => return Some("migration_settings_busy"),
            "settings_lock_changed" => {
                return Some("migration_target_configuration_lock_changed");
            }
            "settings_transaction_requires_recovery" => {
                return Some("migration_target_configuration_recovery_required");
            }
            "settings document exceeds budget" => {
                return Some("migration_target_configuration_budget_exceeded");
            }
            "settings file must be owned and have one link"
            | "settings file must have one link" => {
                return Some("migration_target_configuration_ownership_invalid");
            }
            "settings root must be an object" => {
                return Some("migration_target_configuration_invalid");
            }
            _ => {}
        }
        cause
            .downcast_ref::<std::io::Error>()
            .and_then(|io| match io.kind() {
                ErrorKind::PermissionDenied => Some("migration_target_configuration_access_denied"),
                ErrorKind::NotFound => Some("migration_target_configuration_missing"),
                ErrorKind::WouldBlock => Some("migration_settings_busy"),
                ErrorKind::InvalidData => Some("migration_target_configuration_invalid"),
                _ => None,
            })
    });
    anyhow::anyhow!(code.unwrap_or("migration_target_configuration_unavailable"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_coordinator_contention_is_reported_without_replaying_or_editing_settings() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings.json");
        let original = r#"{"model":"PRIVATE_MODEL_LABEL"}"#;
        std::fs::write(&path, original).unwrap();
        let target = super::super::ProviderTarget::open(root.path()).unwrap();
        let directory = kcoder_config::PrivateDirectory::open_existing(root.path()).unwrap();
        let guard = directory
            .try_exclusive_lock(std::ffi::OsStr::new(".provider-transaction.json.lock"))
            .unwrap()
            .unwrap();
        assert_eq!(
            target.read_settings().unwrap_err().to_string(),
            "migration_settings_busy"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        drop(guard);
        assert_eq!(
            target.read_settings().unwrap()["model"],
            "PRIVATE_MODEL_LABEL"
        );
    }

    #[test]
    fn chained_contention_remains_distinct_from_missing_or_unreadable_configuration() {
        for (input, code) in [
            (anyhow::anyhow!("settings_busy"), "migration_settings_busy"),
            (
                anyhow::Error::from(std::io::Error::new(
                    ErrorKind::PermissionDenied,
                    "SECRET/path",
                )),
                "migration_target_configuration_access_denied",
            ),
            (
                anyhow::Error::from(std::io::Error::new(ErrorKind::NotFound, "SECRET/path")),
                "migration_target_configuration_missing",
            ),
            (
                anyhow::anyhow!("settings_transaction_requires_recovery"),
                "migration_target_configuration_recovery_required",
            ),
        ] {
            assert_eq!(
                classify(input.context("SECRET outer diagnostic")).to_string(),
                code
            );
        }
    }

    #[test]
    fn unknown_messages_and_substring_matches_never_leak_or_claim_contention() {
        for text in [
            "SECRET configuration value",
            "SECRET settings_busy",
            "SECRET/path",
        ] {
            assert_eq!(
                classify(anyhow::anyhow!(text)).to_string(),
                "migration_target_configuration_unavailable"
            );
        }
    }
}
