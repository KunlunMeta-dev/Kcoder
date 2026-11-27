//! Template-before-settings lock order protects dependent resources during Provider removal.
use super::*;
use std::{ffi::OsStr, io::Read};

fn uses_provider(value: &Value, names: &[&str]) -> bool {
    match value {
        Value::Object(fields) => fields.iter().any(|(key, value)| {
            let selector = matches!(
                key.as_str(),
                "active_provider"
                    | "provider"
                    | "profile"
                    | "summary_provider"
                    | "summary_profile"
                    | "verifier_provider"
                    | "verifier_profile"
            );
            selector && value.as_str().is_some_and(|name| names.contains(&name))
                || key == "model"
                    && value.as_str().is_some_and(|model| {
                        names
                            .iter()
                            .any(|name| model.starts_with(&format!("{name}/")))
                    })
                || uses_provider(value, names)
        }),
        Value::Array(items) => items.iter().any(|item| uses_provider(item, names)),
        _ => false,
    }
}

impl SettingsTemplateStore {
    /// The operation may acquire settings locks; callers must not already hold those locks.
    pub fn with_unreferenced_providers<T>(
        &self,
        names: &[&str],
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        if names.is_empty() {
            return operation();
        }
        let _guard = self.guard()?;
        for entry in &self.read_index()?.templates {
            let bytes = self.read_template_bytes(&entry.id)?;
            let body = std::str::from_utf8(&bytes)
                .map_err(|_| anyhow::anyhow!("settings_template_references_unknown"))?;
            anyhow::ensure!(
                !uses_provider(&checked_content(body)?, names),
                "settings_template_provider_referenced"
            );
        }
        if let Some(directory) = self.bindings_directory(false)? {
            let mut total = 0usize;
            directory.visit_entry_names_bounded(1024, |name| {
                let text = name
                    .to_str()
                    .and_then(|name| name.strip_suffix(".jsonc"))
                    .ok_or_else(|| anyhow::anyhow!("settings_template_references_unknown"))?;
                let (id, revision) = text
                    .rsplit_once('-')
                    .ok_or_else(|| anyhow::anyhow!("settings_template_references_unknown"))?;
                validate_id(id)?;
                anyhow::ensure!(revision.len() == 64, "settings_template_references_unknown");
                let mut file = directory.open_single_link_regular_file(name)?;
                let before = PrivateDirectory::identity_of_file(&file)?;
                anyhow::ensure!(
                    file.metadata()?.len() <= MAX_TEMPLATE_BYTES as u64,
                    "settings_template_references_unknown"
                );
                let mut bytes = Vec::new();
                (&mut file)
                    .take(MAX_TEMPLATE_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)?;
                total = total.saturating_add(bytes.len());
                anyhow::ensure!(
                    bytes.len() <= MAX_TEMPLATE_BYTES
                        && total <= 16 * 1024 * 1024
                        && before == PrivateDirectory::identity_of_file(&file)?
                        && before
                            == directory.regular_file_identity(OsStr::new(&format!(
                                "{id}-{revision}.jsonc"
                            )))?
                        && hex_sha256(&bytes) == revision,
                    "settings_template_references_unknown"
                );
                let body = std::str::from_utf8(&bytes)
                    .map_err(|_| anyhow::anyhow!("settings_template_references_unknown"))?;
                anyhow::ensure!(
                    !uses_provider(&checked_content(body)?, names),
                    "settings_template_provider_referenced"
                );
                Ok(())
            })?;
        }
        operation()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProfileSettingsFile;

    fn fixture(root: &Path) -> (SettingsTemplateStore, crate::ProviderConfig) {
        let provider = crate::default_active_provider_config();
        std::fs::write(root.join("settings.json"), serde_json::json!({
            "active_provider":"Imported", "providers":{"Imported":provider}, "credential_store":"file",
        }).to_string()).unwrap();
        (SettingsTemplateStore::open(root).unwrap(), provider)
    }

    #[test]
    fn dependent_publication_uses_the_exact_stable_provider_and_rejects_changes() {
        let root = tempfile::tempdir().unwrap();
        let (store, provider) = fixture(root.path());
        let content = r#"{"active_provider":"Imported"}"#;
        let reference = store
            .prepare_owned("report", "Report", None, content)
            .unwrap();
        let mut changed = provider.clone();
        changed.endpoint = "https://example.invalid/changed".into();
        assert!(
            store
                .install_owned_with_provider(&reference, content, "Imported", &changed)
                .is_err()
        );
        assert!(store.list().unwrap().templates.is_empty());
        assert_eq!(store.import_state(&reference).unwrap(), None);
        assert_eq!(
            store
                .install_owned_with_provider(&reference, content, "Imported", &provider)
                .unwrap(),
            TemplateImportState::Committed
        );
        let settings =
            ProfileSettingsFile::new(PrivateDirectory::open_existing(root.path()).unwrap())
                .unwrap();
        settings
            .inspect_locked(|snapshot| {
                assert!(
                    settings
                        .update(|next| {
                            next["max_retries"] = 77.into();
                            Ok(())
                        })
                        .is_err()
                );
                assert_ne!(snapshot.get("max_retries"), Some(&77.into()));
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn dependent_observation_requires_both_ownership_and_the_unchanged_connection() {
        let root = tempfile::tempdir().unwrap();
        let (store, provider) = fixture(root.path());
        let content = r#"{"active_provider":"Imported"}"#;
        let reference = store
            .prepare_owned("report", "Report", None, content)
            .unwrap();
        store
            .install_owned_with_provider(&reference, content, "Imported", &provider)
            .unwrap();
        assert_eq!(
            store
                .import_state_with_provider(&reference, "Imported", &provider)
                .unwrap(),
            Some(TemplateImportState::Committed)
        );
        let mut changed = provider.clone();
        changed.endpoint = "https://example.invalid/changed".into();
        let settings =
            ProfileSettingsFile::new(PrivateDirectory::open_existing(root.path()).unwrap())
                .unwrap();
        settings
            .update(|document| {
                document["providers"]["Imported"] = serde_json::to_value(&changed)?;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            store.import_state(&reference).unwrap(),
            Some(TemplateImportState::Committed)
        );
        assert!(
            store
                .import_state_with_provider(&reference, "Imported", &provider)
                .is_err()
        );
        store
            .save(&SettingsTemplateSaveParams {
                id: Some("report".into()),
                name: "User report".into(),
                description: None,
                content: content.into(),
            })
            .unwrap();
        assert_eq!(
            store
                .import_state_with_provider(&reference, "Imported", &changed)
                .unwrap(),
            Some(TemplateImportState::Superseded)
        );
    }

    #[test]
    fn both_current_templates_and_frozen_versions_keep_their_provider_dependency() {
        let root = tempfile::tempdir().unwrap();
        let (store, _) = fixture(root.path());
        store
            .save(&SettingsTemplateSaveParams {
                id: Some("report".into()),
                name: "Report".into(),
                description: None,
                content: r#"{"active_provider":"Imported"}"#.into(),
            })
            .unwrap();
        assert!(
            store
                .with_unreferenced_providers(&["Imported"], || -> Result<()> {
                    panic!("referenced removal must never execute")
                })
                .is_err()
        );
        store.freeze_for_session("report").unwrap();
        store.delete("report").unwrap();
        assert!(
            store
                .with_unreferenced_providers(&["Imported"], || -> Result<()> {
                    panic!("a retained version still has a dependency")
                })
                .is_err()
        );
        assert_eq!(
            store
                .with_unreferenced_providers(&["Other"], || Ok(17))
                .unwrap(),
            17
        );
    }

    #[cfg(unix)]
    #[test]
    fn damaged_or_linked_versions_cannot_authorize_provider_removal() {
        for linked in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let (store, _) = fixture(root.path());
            store
                .save(&SettingsTemplateSaveParams {
                    id: Some("report".into()),
                    name: "Report".into(),
                    description: None,
                    content: r#"{"active_provider":"Imported"}"#.into(),
                })
                .unwrap();
            let (path, _) = store.freeze_for_session("report").unwrap();
            store.delete("report").unwrap();
            if linked {
                std::fs::hard_link(&path, root.path().join("other-link")).unwrap();
            } else {
                std::fs::write(&path, "{}").unwrap();
            }
            assert!(
                store
                    .with_unreferenced_providers(&["Imported"], || -> Result<()> {
                        panic!("unknown references cannot grant deletion")
                    })
                    .is_err()
            );
        }
    }
}
