//! Revision-checked edits to user-owned Studio defaults, not resident settings.
use super::*;
use kcoder_app_protocol::ToolSelectionsSaveParams;
use kcoder_cli_storage::private_files::{error_is_not_found, hex_sha256};

fn covered(field: &str, target: &str) -> bool {
    field == target
        || field.starts_with(&format!("{target}."))
        || target.starts_with(&format!("{field}."))
}
pub fn editable(
    loaded: &kcoder_config::LoadedSettings,
    mode: kcoder_types::StudioWorkMode,
) -> bool {
    let name = match mode {
        kcoder_types::StudioWorkMode::Kcoder => "kcoder",
        kcoder_types::StudioWorkMode::Kworker => "kworker",
    };
    let target = format!("tools.studio.{name}");
    !loaded
        .overlay_fields
        .iter()
        .any(|field| covered(field, &target))
        && !loaded.field_sources.iter().any(|(field, scope)| {
            covered(field, &target)
                && matches!(
                    scope,
                    kcoder_config::ConfigScope::Executable
                        | kcoder_config::ConfigScope::Project
                        | kcoder_config::ConfigScope::Local
                )
        })
}
fn stored(path: &std::path::Path) -> Result<Value> {
    match kcoder_config::read_settings_file(path) {
        Ok(value) => Ok(value),
        Err(error) if error_is_not_found(&error) => Ok(serde_json::json!({})),
        Err(error) => Err(error),
    }
}
fn revision(loaded: &kcoder_config::LoadedSettings, user: &Value) -> Result<String> {
    Ok(hex_sha256(&serde_json::to_vec(&(
        loaded.paths.user_settings.to_string_lossy(),
        &loaded.settings.tools,
        user.get("tools"),
    ))?))
}
impl SessionConfiguration {
    pub fn studio_tool_selection_loaded(
        &self,
    ) -> Result<(
        kcoder_config::LoadedSettings,
        kcoder_config::ToolProfile,
        String,
    )> {
        let loaded = self.loader.load_read_only_configuration()?;
        let profile = self
            .cli
            .tool_profile
            .effective(loaded.settings.tools.profile);
        let revision = revision(&loaded, &stored(&loaded.paths.user_settings)?)?;
        Ok((loaded, profile, revision))
    }
    pub fn save_studio_tool_selection(&self, params: &ToolSelectionsSaveParams) -> Result<()> {
        let loaded = self.loader.load_read_only_configuration()?;
        anyhow::ensure!(
            editable(&loaded, params.mode),
            "TOOL_SELECTION_CONTROLLED_BY_OVERLAY"
        );
        anyhow::ensure!(
            params.allowed_tools.len() <= 1024,
            "TOOL_SELECTION_TOO_LARGE"
        );
        let mut unique = std::collections::BTreeSet::new();
        for name in &params.allowed_tools {
            anyhow::ensure!(
                !name.is_empty()
                    && name.len() <= 256
                    && name.trim() == name
                    && !name.chars().any(char::is_control)
                    && unique.insert(name),
                "TOOL_SELECTION_INVALID_NAMES"
            );
        }
        kcoder_config::update_settings_file(&loaded.paths.user_settings, |user| {
            anyhow::ensure!(
                revision(&loaded, user)? == params.expected_revision,
                "TOOL_SELECTION_REVISION_CONFLICT"
            );
            if user.get("tools").is_none() {
                user["tools"] = serde_json::json!({});
            }
            let tools = user
                .get_mut("tools")
                .and_then(Value::as_object_mut)
                .context("Stored tools settings must be an object")?;
            if !tools.contains_key("studio") {
                tools.insert("studio".into(), serde_json::json!({}));
            }
            let studio = tools
                .get_mut("studio")
                .and_then(Value::as_object_mut)
                .context("Stored Studio tools settings must be an object")?;
            let mode = match params.mode {
                kcoder_types::StudioWorkMode::Kcoder => "kcoder",
                kcoder_types::StudioWorkMode::Kworker => "kworker",
            };
            studio.insert(mode.into(), serde_json::to_value(&params.allowed_tools)?);
            Ok(())
        })
        .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use kcoder_types::StudioWorkMode;
    fn fixture(root: &std::path::Path) -> SessionConfiguration {
        for directory in ["project", "home", "bin"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        std::fs::write(root.join("home/settings.json"), r#"{"tools":{"profile":"core","disabled":["WebBrowser"],"studio":{"kcoder":["read"],"kworker":["write"]},"luna":{"allowed":["read"]}},"model":"fixture-model"}"#).unwrap();
        SessionConfiguration::new(
            SettingsLoader::new(root.join("project"))
                .with_config_dir(root.join("home"))
                .with_executable_dir(root.join("bin")),
            Cli::parse_from(["kcoder"]),
        )
    }
    fn params(
        config: &SessionConfiguration,
        mode: StudioWorkMode,
        names: Vec<String>,
    ) -> ToolSelectionsSaveParams {
        ToolSelectionsSaveParams {
            mode,
            allowed_tools: names,
            expected_revision: config.studio_tool_selection_loaded().unwrap().2,
        }
    }
    #[test]
    fn tool_selections_cas_preserves_other_mode_and_configuration_siblings() {
        let root = tempfile::tempdir().unwrap();
        let config = fixture(root.path());
        let save = params(&config, StudioWorkMode::Kcoder, vec![]);
        config.save_studio_tool_selection(&save).unwrap();
        let stored =
            kcoder_config::read_settings_file(&root.path().join("home/settings.json")).unwrap();
        assert_eq!(stored["tools"]["studio"]["kcoder"], serde_json::json!([]));
        assert_eq!(
            stored["tools"]["studio"]["kworker"],
            serde_json::json!(["write"])
        );
        assert_eq!(stored["tools"]["profile"], "core");
        assert_eq!(
            stored["tools"]["disabled"],
            serde_json::json!(["WebBrowser"])
        );
        assert_eq!(
            stored["tools"]["luna"]["allowed"],
            serde_json::json!(["read"])
        );
        assert_eq!(stored["model"], "fixture-model");
        assert_ne!(
            config.studio_tool_selection_loaded().unwrap().2,
            save.expected_revision
        );
        let bytes = std::fs::read(root.path().join("home/settings.json")).unwrap();
        assert!(
            config
                .save_studio_tool_selection(&save)
                .unwrap_err()
                .to_string()
                .contains("REVISION_CONFLICT")
        );
        assert_eq!(
            std::fs::read(root.path().join("home/settings.json")).unwrap(),
            bytes
        );
    }
    #[test]
    fn tool_selections_cas_rejects_a_competing_writer_without_clobbering_it() {
        let root = tempfile::tempdir().unwrap();
        let config = fixture(root.path());
        let stale = params(&config, StudioWorkMode::Kcoder, vec!["write".into()]);
        kcoder_config::update_settings_file(&root.path().join("home/settings.json"), |document| {
            document["tools"]["disabled"] = serde_json::json!(["read"]);
            Ok(())
        })
        .unwrap();
        assert!(config.save_studio_tool_selection(&stale).is_err());
        let stored =
            kcoder_config::read_settings_file(&root.path().join("home/settings.json")).unwrap();
        assert_eq!(stored["tools"]["disabled"], serde_json::json!(["read"]));
        assert_eq!(
            stored["tools"]["studio"]["kcoder"],
            serde_json::json!(["read"])
        );
    }
    #[test]
    fn tool_selections_project_and_explicit_overlay_lock_only_the_covered_mode() {
        let root = tempfile::tempdir().unwrap();
        let config = fixture(root.path());
        std::fs::create_dir(root.path().join("project/.kcoder")).unwrap();
        std::fs::write(
            root.path().join("project/.kcoder/settings.json"),
            r#"{"tools":{"studio":{"kcoder":["write"]}}}"#,
        )
        .unwrap();
        let (loaded, _, _) = config.studio_tool_selection_loaded().unwrap();
        assert!(!editable(&loaded, StudioWorkMode::Kcoder));
        assert!(editable(&loaded, StudioWorkMode::Kworker));
        let save = params(&config, StudioWorkMode::Kcoder, vec![]);
        assert!(
            config
                .save_studio_tool_selection(&save)
                .unwrap_err()
                .to_string()
                .contains("CONTROLLED_BY_OVERLAY")
        );
        config
            .save_studio_tool_selection(&params(&config, StudioWorkMode::Kworker, vec![]))
            .unwrap();
        let overlay = root.path().join("overlay.json");
        std::fs::write(&overlay, r#"{"tools":{"studio":{"kworker":["read"]}}}"#).unwrap();
        let overlay_config = SessionConfiguration::new(
            config.loader.clone().with_overlay_files(vec![overlay]),
            config.cli.clone(),
        );
        assert!(!editable(
            &overlay_config.studio_tool_selection_loaded().unwrap().0,
            StudioWorkMode::Kworker
        ));
    }
    #[test]
    fn tool_selections_invalid_names_do_not_mutate_settings() {
        let root = tempfile::tempdir().unwrap();
        let config = fixture(root.path());
        let before = std::fs::read(root.path().join("home/settings.json")).unwrap();
        for names in [
            vec!["read".into(), "read".into()],
            vec![" read".into()],
            vec!["".into()],
        ] {
            assert!(
                config
                    .save_studio_tool_selection(&params(&config, StudioWorkMode::Kcoder, names))
                    .is_err()
            );
        }
        assert_eq!(
            std::fs::read(root.path().join("home/settings.json")).unwrap(),
            before
        );
    }
}
