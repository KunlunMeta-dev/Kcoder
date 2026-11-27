//! Read-only validation of an explicit CLI Provider selector over native snapshot bytes.
use super::RemoteIntegrationSettings;
use anyhow::{Result, ensure};

impl RemoteIntegrationSettings {
    /// Reuse the normal pure settings resolver and Provider selection. This
    /// never loads credential stores, dotenv, a Provider transport or services.
    /// The original native snapshot remains the only receiver policy source.
    pub fn validate_native_read_provider_selection(bytes: &[u8], selected: &str) -> Result<()> {
        ensure!(
            !bytes.is_empty()
                && bytes.len() <= 8 * 1024 * 1024
                && !selected.is_empty()
                && selected.trim() == selected,
            "REMOTE_ORIGINAL_READ_PROVIDER_INVALID"
        );
        let document: serde_json::Value =
            jsonc_parser::parse_to_serde_value(std::str::from_utf8(bytes)?, &Default::default())
                .map_err(|_| anyhow::anyhow!("REMOTE_ORIGINAL_READ_PROVIDER_INVALID"))?;
        let settings = crate::validate_and_resolve_settings_document(&document)
            .map_err(|_| anyhow::anyhow!("REMOTE_ORIGINAL_READ_PROVIDER_INVALID"))?;
        Self::validate_native_read_provider_from_settings(&settings, selected)
    }

    /// Validate an explicit selector over normal read-only layered configuration.
    /// Neither this value nor project layers become Receiver PDP authority.
    pub fn validate_native_read_provider_from_settings(
        configured: &crate::Settings,
        selected: &str,
    ) -> Result<()> {
        ensure!(
            !selected.is_empty() && selected.trim() == selected,
            "REMOTE_ORIGINAL_READ_PROVIDER_INVALID"
        );
        let mut settings = configured.clone();
        let policy = settings.integrations.remotes.clone();
        let history = settings.history_directory.clone();
        let memory = settings.memory_directory.clone();
        settings
            .apply_provider(Some(selected))
            .map_err(|_| anyhow::anyhow!("REMOTE_ORIGINAL_READ_PROVIDER_INVALID"))?;
        ensure!(
            settings.active_provider.as_deref() == Some(selected)
                && settings.integrations.remotes == policy
                && settings.history_directory == history
                && settings.memory_directory == memory,
            "REMOTE_ORIGINAL_READ_PROVIDER_CHANGED_SCOPE"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn document() -> serde_json::Value {
        json!({"active_provider":"OwnedReadProvider","model":"owned-model",
            "providers":{"OwnedReadProvider":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},
                "endpoint":"http://127.0.0.1:1/v1","default_model":"owned-model","context_window_tokens":8192,
                "max_output_tokens":64,"output_headroom_tokens":1024}},
            "integrations":{"remotes":{"receiver":{"enabled":true,"allowedSenderAccounts":["original-source"],
                "maximumTotalTokens":1000,"maximumModelCalls":1,"maximumDurationSeconds":60}}}})
    }

    #[test]
    fn native_read_provider_selection_uses_normal_pure_resolution_and_keeps_original_policy() {
        let value = document();
        let bytes = serde_json::to_vec(&value).unwrap();
        let before =
            RemoteIntegrationSettings::admit_native_sender(&bytes, "original-source").unwrap();
        RemoteIntegrationSettings::validate_native_read_provider_selection(
            &bytes,
            "OwnedReadProvider",
        )
        .unwrap();
        assert_eq!(
            RemoteIntegrationSettings::admit_native_sender(&bytes, "original-source").unwrap(),
            before
        );
        assert!(RemoteIntegrationSettings::admit_native_sender(&bytes, "other-source").is_err());
        let mut with_alternate = value.clone();
        let mut alternate = with_alternate["providers"]["OwnedReadProvider"].clone();
        alternate["default_model"] = json!("alternate-model");
        with_alternate["providers"]["AlternateReadProvider"] = alternate;
        let alternate_bytes = serde_json::to_vec(&with_alternate).unwrap();
        RemoteIntegrationSettings::validate_native_read_provider_selection(
            &alternate_bytes,
            "AlternateReadProvider",
        )
        .unwrap();
        assert_eq!(
            RemoteIntegrationSettings::admit_native_sender(&alternate_bytes, "original-source")
                .unwrap(),
            before
        );
        assert!(
            RemoteIntegrationSettings::validate_native_read_provider_selection(
                &bytes,
                "ownedreadprovider"
            )
            .is_err()
        );
        assert!(
            RemoteIntegrationSettings::validate_native_read_provider_selection(
                &bytes,
                "kunlunmeta"
            )
            .is_err(),
            "an omitted built-in cannot replace the explicit selected catalog"
        );
        assert!(
            RemoteIntegrationSettings::validate_native_read_provider_selection(&bytes, "").is_err()
        );
    }

    #[test]
    fn native_read_provider_selection_refuses_invalid_models_without_transport_or_credentials() {
        let mut invalid = document();
        invalid["providers"]["OwnedReadProvider"]["models"] =
            json!([{"id":"duplicate"},{"id":"duplicate"}]);
        let bytes = serde_json::to_vec(&invalid).unwrap();
        assert!(
            RemoteIntegrationSettings::validate_native_read_provider_selection(
                &bytes,
                "OwnedReadProvider"
            )
            .is_err()
        );
        let bytes = serde_json::to_vec(&document()).unwrap();
        let error = RemoteIntegrationSettings::validate_native_read_provider_selection(
            &bytes,
            "unknown-private-provider",
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "REMOTE_ORIGINAL_READ_PROVIDER_INVALID");
    }
}

#[cfg(test)]
mod layered_tests {
    use super::*;
    use crate::SettingsLoader;
    use serde_json::json;
    use std::{fs, path::Path};

    fn provider(name: &str) -> serde_json::Value {
        json!({"providers":{name:{"api_format":"openai_chat_completions","authentication":{"mode":"none"},
            "endpoint":"http://127.0.0.1:1/v1","default_model":"owned-model","context_window_tokens":8192,
            "max_output_tokens":64,"output_headroom_tokens":1024}}})
    }
    fn tree(path: &Path) -> Vec<(std::path::PathBuf, Vec<u8>)> {
        let mut rows = Vec::new();
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                rows.extend(tree(&path));
            } else {
                rows.push((path.clone(), fs::read(&path).unwrap()));
            }
        }
        rows.sort();
        rows
    }

    #[test]
    fn normal_read_only_loader_preserves_all_provider_layers_without_credentials_or_writes() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("profile");
        let executable = temp.path().join("executable");
        let workspace = temp.path().join("workspace");
        for path in [&profile, &executable, &workspace.join(".kcoder")] {
            fs::create_dir_all(path).unwrap();
        }
        let mut user = provider("OwnedUser");
        user["active_provider"] = json!("OwnedUser");
        user["model"] = json!("owned-model");
        user["integrations"] = json!({"remotes":{"receiver":{"enabled":true,"allowedSenderAccounts":["original-source"],
            "maximumTotalTokens":1000,"maximumModelCalls":1,"maximumDurationSeconds":60}}});
        let user_bytes = serde_json::to_vec(&user).unwrap();
        fs::write(profile.join("settings.json"), &user_bytes).unwrap();
        fs::write(
            profile.join("credentials.json"),
            b"not-a-credential-document",
        )
        .unwrap();
        for (path, name) in [
            (executable.join("settings.json"), "OwnedExecutable"),
            (workspace.join(".kcoder/settings.json"), "OwnedProject"),
            (workspace.join(".kcoder/settings.local.json"), "OwnedLocal"),
            (temp.path().join("explicit.json"), "OwnedOverlay"),
        ] {
            fs::write(path, serde_json::to_vec(&provider(name)).unwrap()).unwrap();
        }
        let before = tree(temp.path());
        let loaded = SettingsLoader::new(&workspace)
            .with_config_dir(&profile)
            .with_executable_dir(&executable)
            .with_overlay_files([temp.path().join("explicit.json")])
            .load_read_only_configuration()
            .unwrap();
        for selected in [
            "OwnedUser",
            "OwnedExecutable",
            "OwnedProject",
            "OwnedLocal",
            "OwnedOverlay",
        ] {
            RemoteIntegrationSettings::validate_native_read_provider_from_settings(
                &loaded.settings,
                selected,
            )
            .unwrap();
        }
        assert!(
            RemoteIntegrationSettings::validate_native_read_provider_from_settings(
                &loaded.settings,
                "kunlunmeta"
            )
            .is_err()
        );
        assert_eq!(
            tree(temp.path()),
            before,
            "read-only parsing cannot initialize a lock, journal, credentials or settings"
        );
        assert!(
            RemoteIntegrationSettings::admit_native_sender(&user_bytes, "original-source").is_ok()
        );
        assert!(
            RemoteIntegrationSettings::admit_native_sender(&user_bytes, "other-source").is_err()
        );
    }

    #[test]
    fn normal_read_only_loader_absence_never_initializes_a_profile_or_project() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("never-created-profile");
        let loaded = SettingsLoader::new(temp.path())
            .with_config_dir(&profile)
            .with_executable_dir(temp.path().join("never-created-executable"))
            .load_read_only_configuration()
            .unwrap();
        assert!(!profile.exists());
        assert!(!temp.path().join(".kcoder").exists());
        assert!(loaded.loaded_sources.is_empty());
    }

    #[test]
    fn normal_read_only_loader_refuses_pending_private_transactions_without_recovery() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("settings.json"), b"{}").unwrap();
        fs::write(
            temp.path().join("credentials.json"),
            b"not-a-credential-document",
        )
        .unwrap();
        for name in [
            ".provider-transaction.json",
            crate::imported_credentials::GROUP_JOURNAL,
        ] {
            let path = temp.path().join(name);
            fs::write(&path, b"not-a-secret-journal-document").unwrap();
            let before = tree(temp.path());
            let error = SettingsLoader::new(temp.path())
                .with_config_dir(temp.path())
                .with_executable_dir(temp.path().join("no-executable"))
                .load_read_only_configuration()
                .unwrap_err();
            assert_eq!(
                error.to_string(),
                "CONFIGURATION_READ_ONLY_TRANSACTION_PENDING"
            );
            assert_eq!(tree(temp.path()), before);
            fs::remove_file(path).unwrap();
        }
    }
}
