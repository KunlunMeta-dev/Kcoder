use super::*;
use kcoder_app_protocol::{ToolProfile, ToolsSettingsResult};
fn wire(value: kcoder_config::ToolProfile) -> ToolProfile {
    match value {
        kcoder_config::ToolProfile::Full => ToolProfile::Full,
        kcoder_config::ToolProfile::Core => ToolProfile::Core,
        kcoder_config::ToolProfile::Nano => ToolProfile::Nano,
        kcoder_config::ToolProfile::None => ToolProfile::None,
    }
}
impl SessionConfiguration {
    pub(in crate::app_server) fn read_tool_profile(&self) -> Result<ToolsSettingsResult> {
        let configured = self.loader.load()?.settings.tools.profile;
        Ok(ToolsSettingsResult {
            profile: wire(configured),
            effective_profile: wire(self.cli.tool_profile.effective(configured)),
            cli_override: (self.cli.tool_profile != crate::cli_args::ToolProfile::Auto)
                .then(|| wire(self.cli.tool_profile.effective(configured))),
        })
    }
    pub(in crate::app_server) fn save_tool_profile(
        &self,
        profile: ToolProfile,
    ) -> Result<ToolsSettingsResult> {
        let loaded = self.loader.load()?;
        let covered = |field: &str| field == "tools.profile";
        if loaded.overlay_fields.iter().any(|field| covered(field))
            || loaded.field_sources.iter().any(|(field, scope)| {
                covered(field)
                    && matches!(
                        scope,
                        kcoder_config::ConfigScope::Executable
                            | kcoder_config::ConfigScope::Project
                            | kcoder_config::ConfigScope::Local
                    )
            })
        {
            anyhow::bail!("Tool profile is controlled by an executable, project, or read-only overlay; edit that source instead");
        }
        kcoder_config::update_settings_file(&loaded.paths.user_settings, |user| {
            if user.get("tools").is_none() {
                user["tools"] = serde_json::json!({});
            }
            let tools = user
                .get_mut("tools")
                .and_then(Value::as_object_mut)
                .context("Stored tools settings must be an object")?;
            tools.insert("profile".into(), serde_json::to_value(profile)?);
            Ok(())
        })?;
        self.read_tool_profile()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    #[test]
    fn save_preserves_siblings_and_reports_cli_override() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        std::fs::write(&path, r#"{"tools":{"coerce":{"semantic_boolean":false},"disabled":["WebBrowser"],"luna":{"allowed":["read"]}},"model":"fixture-model"}"#).unwrap();
        let config = SessionConfiguration::new(
            SettingsLoader::new(temp.path())
                .with_config_dir(temp.path())
                .with_executable_dir(temp.path()),
            crate::Cli::parse_from(["kcoder", "--tool-profile", "nano"]),
        );
        let result = config.save_tool_profile(ToolProfile::Core).unwrap();
        assert_eq!(result.profile, ToolProfile::Core);
        assert_eq!(result.effective_profile, ToolProfile::Nano);
        assert_eq!(result.cli_override, Some(ToolProfile::Nano));
        let stored = kcoder_config::read_settings_file(&path).unwrap();
        assert_eq!(stored["tools"]["coerce"]["semantic_boolean"], false);
        assert_eq!(
            stored["tools"]["disabled"],
            serde_json::json!(["WebBrowser"])
        );
        assert_eq!(
            stored["tools"]["luna"]["allowed"],
            serde_json::json!(["read"])
        );
        assert_eq!(stored["model"], "fixture-model");
    }
    #[test]
    fn project_siblings_allow_save_but_profile_overlay_rejects_it() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let home = temp.path().join("home");
        let exe = temp.path().join("exe");
        std::fs::create_dir_all(project.join(".kcoder")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&exe).unwrap();
        let project_settings = project.join(".kcoder/settings.json");
        std::fs::write(
            &project_settings,
            r#"{"tools":{"disabled":["WebBrowser"]}}"#,
        )
        .unwrap();
        let config = SessionConfiguration::new(
            SettingsLoader::new(&project)
                .with_config_dir(&home)
                .with_executable_dir(&exe),
            crate::Cli::parse_from(["kcoder"]),
        );
        assert_eq!(
            config.save_tool_profile(ToolProfile::Nano).unwrap().profile,
            ToolProfile::Nano
        );
        std::fs::write(&project_settings, r#"{"tools":{"profile":"core"}}"#).unwrap();
        assert!(config.save_tool_profile(ToolProfile::Full).is_err());
        std::fs::remove_file(project_settings).unwrap();
        std::fs::write(exe.join("settings.json"), r#"{"tools":{"profile":"core"}}"#).unwrap();
        // Use the loader's authoritative executable path (it may have a branded basename).
        let path = config.loader.paths().unwrap().executable_settings;
        std::fs::write(path, r#"{"tools":{"profile":"core"}}"#).unwrap();
        assert!(config.save_tool_profile(ToolProfile::Full).is_err());
        assert_eq!(
            kcoder_config::read_settings_file(&home.join("settings.json")).unwrap()["tools"]
                ["profile"],
            "nano"
        );
    }
}
