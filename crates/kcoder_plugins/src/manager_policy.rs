//! Per-plugin component policy edits in the user settings layer.
//!
//! `plugins.installed.<id>.skills.enabled` removes only that plugin's skill
//! copies from new discovery snapshots; other copies of the same names, the
//! plugin's MCP servers and its Hooks are unaffected. Writes are
//! revision-checked against the user file while its settings lock is held.
use super::{PluginManager, object_entry};
use crate::PluginId;
use anyhow::{Context, Result};
use kcoder_config::{ConfigScope, update_scope};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// The supplied `expectedRevision` no longer matches the user setting.
#[derive(Debug)]
pub struct PluginSkillPolicyConflict;

impl std::fmt::Display for PluginSkillPolicyConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("plugin skill setting changed; reload before saving")
    }
}

impl std::error::Error for PluginSkillPolicyConflict {}

/// Outcome of one plugin skill switch request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginSkillPolicyUpdate {
    pub enabled: bool,
    pub revision: String,
    pub changed: bool,
    pub generation: u64,
}

/// Opaque revision of one plugin's user-layer skill switch. `None` means the
/// user file does not set it (skills default to enabled).
pub fn plugin_skill_policy_revision(plugin_id: &str, user_value: Option<bool>) -> String {
    let bytes = serde_json::to_vec(&serde_json::json!({
        "pluginId": plugin_id,
        "skillsEnabled": user_value,
    }))
    .expect("skill policy revision input serializes");
    format!("{:x}", Sha256::digest(bytes))
}

fn user_skills_enabled(document: &Value, plugin_id: &str) -> Result<Option<bool>> {
    let Some(value) = document
        .get("plugins")
        .and_then(|plugins| plugins.get("installed"))
        .and_then(|installed| installed.get(plugin_id))
        .and_then(|policy| policy.get("skills"))
        .and_then(|skills| skills.get("enabled"))
    else {
        return Ok(None);
    };
    match value {
        Value::Null => Ok(None),
        Value::Bool(enabled) => Ok(Some(*enabled)),
        _ => anyhow::bail!("plugins.installed.{plugin_id}.skills.enabled must be a boolean"),
    }
}

impl PluginManager {
    /// Revisions of the listed plugins' user-layer skill switches from one
    /// read of the user settings file.
    pub fn skill_policy_revisions<'a>(
        &self,
        plugin_ids: impl IntoIterator<Item = &'a str>,
    ) -> Result<BTreeMap<String, String>> {
        let paths = self
            .config_paths
            .as_ref()
            .context("plugin manager has no user settings path")?;
        let document = kcoder_config::read_scope(paths, ConfigScope::User)?;
        plugin_ids
            .into_iter()
            .map(|id| {
                let value = user_skills_enabled(&document, id)?;
                Ok((id.to_owned(), plugin_skill_policy_revision(id, value)))
            })
            .collect()
    }

    /// Turn one installed plugin's skills on or off. Disabling records
    /// `skills.enabled = false`; enabling removes the override so the default
    /// (enabled) applies again. With `expected_revision`, a concurrent change
    /// fails with [`PluginSkillPolicyConflict`] and nothing is written.
    pub fn set_skills_enabled(
        &self,
        plugin_id: &PluginId,
        enabled: bool,
        expected_revision: Option<&str>,
    ) -> Result<PluginSkillPolicyUpdate> {
        self.store
            .read(plugin_id)?
            .with_context(|| format!("plugin {plugin_id} is not installed"))?;
        let paths = self
            .config_paths
            .as_ref()
            .context("plugin manager has no writable user settings path")?;
        let id = plugin_id.to_string();
        let mut changed = false;
        let mut stored = None;
        update_scope(paths, ConfigScope::User, |document| {
            let current = user_skills_enabled(document, &id)?;
            if let Some(expected) = expected_revision
                && plugin_skill_policy_revision(&id, current) != expected.to_ascii_lowercase()
            {
                return Err(PluginSkillPolicyConflict.into());
            }
            stored = current;
            if current.unwrap_or(true) == enabled {
                return Ok(());
            }
            let root = document
                .as_object_mut()
                .context("settings root must be an object")?;
            let plugins = object_entry(root, "plugins")?;
            let installed = object_entry(plugins, "installed")?;
            let policy = object_entry(installed, &id)?;
            if enabled {
                if let Some(skills) = policy.get_mut("skills").and_then(Value::as_object_mut) {
                    skills.remove("enabled");
                    if skills.is_empty() {
                        policy.remove("skills");
                    }
                }
                if policy.is_empty() {
                    installed.remove(&id);
                }
            } else {
                object_entry(policy, "skills")?.insert("enabled".into(), Value::Bool(false));
            }
            stored = (!enabled).then_some(false);
            changed = true;
            Ok(())
        })?;
        let generation = if changed {
            self.update_cached_settings(|settings| {
                settings
                    .installed
                    .entry(id.clone())
                    .or_default()
                    .skills
                    .enabled = stored;
            });
            self.store.bump_generation()?
        } else {
            self.store.generation()?
        };
        Ok(PluginSkillPolicyUpdate {
            enabled,
            revision: plugin_skill_policy_revision(&id, stored),
            changed,
            generation,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn plugin_with_skill(root: &std::path::Path) {
        std::fs::create_dir_all(root.join(".codex-plugin")).unwrap();
        std::fs::write(
            root.join(".codex-plugin/plugin.json"),
            r#"{"name":"skill-switch","version":"1.0.0"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(root.join("skills/switch-doc")).unwrap();
        std::fs::write(
            root.join("skills/switch-doc/SKILL.md"),
            "---\nname: switch-doc\ndescription: fixture\n---\nbody",
        )
        .unwrap();
    }

    fn user_settings(config: &std::path::Path) -> Value {
        serde_json::from_slice(&std::fs::read(config.join("settings.json")).unwrap()).unwrap()
    }

    #[test]
    fn skill_switch_is_revision_checked_narrow_and_removes_only_skill_roots() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(
            config.join("settings.json"),
            r#"{"model":"fixture","plugins":{"installed":{"other@m":{"enabled":false}}}}"#,
        )
        .unwrap();
        let source = temp.path().join("plugin");
        plugin_with_skill(&source);
        let manager = PluginManager::open(&config.join("plugin_store")).unwrap();
        let record = manager.install_local(&source).unwrap();
        let id = record.plugin_id.to_string();
        let initial = manager.skill_policy_revisions([id.as_str()]).unwrap()[&id].clone();
        assert_eq!(initial, plugin_skill_policy_revision(&id, None));
        assert!(
            !manager
                .effective_snapshot(temp.path(), true)
                .unwrap()
                .skill_roots
                .is_empty()
        );
        let generation = manager.store().generation().unwrap();

        let disabled = manager
            .set_skills_enabled(&record.plugin_id, false, Some(&initial))
            .unwrap();
        assert!(disabled.changed && !disabled.enabled);
        assert_eq!(disabled.generation, generation + 1);
        let document = user_settings(&config);
        assert_eq!(document["model"], "fixture");
        assert_eq!(
            document["plugins"]["installed"]["other@m"]["enabled"],
            false
        );
        assert_eq!(
            document["plugins"]["installed"][&id]["skills"]["enabled"],
            false
        );
        assert!(
            document["plugins"]["installed"][&id]
                .get("enabled")
                .is_none()
        );
        let snapshot = manager.effective_snapshot(temp.path(), true).unwrap();
        assert!(snapshot.skill_roots.is_empty());
        assert_eq!(snapshot.plugin_ids, std::slice::from_ref(&id));

        let stale = manager
            .set_skills_enabled(&record.plugin_id, true, Some(&initial))
            .unwrap_err();
        assert!(stale.downcast_ref::<PluginSkillPolicyConflict>().is_some());
        assert_eq!(
            user_settings(&config)["plugins"]["installed"][&id]["skills"]["enabled"],
            false
        );

        let repeated = manager
            .set_skills_enabled(&record.plugin_id, false, Some(&disabled.revision))
            .unwrap();
        assert!(!repeated.changed);
        assert_eq!(repeated.generation, disabled.generation);

        let restored = manager
            .set_skills_enabled(&record.plugin_id, true, Some(&disabled.revision))
            .unwrap();
        assert!(restored.changed && restored.enabled);
        assert_eq!(restored.revision, initial);
        assert!(
            user_settings(&config)["plugins"]["installed"]
                .get(&id)
                .is_none()
        );
        assert!(
            !manager
                .effective_snapshot(temp.path(), true)
                .unwrap()
                .skill_roots
                .is_empty()
        );
        let unconditional = manager
            .set_skills_enabled(&record.plugin_id, true, None)
            .unwrap();
        assert!(!unconditional.changed);
    }

    #[test]
    fn skill_switch_requires_an_installed_plugin() {
        let temp = TempDir::new().unwrap();
        let manager = PluginManager::open(&temp.path().join("config/plugin_store")).unwrap();
        let missing: PluginId = "absent@market".parse().unwrap();
        let error = manager
            .set_skills_enabled(&missing, false, None)
            .unwrap_err();
        assert!(format!("{error:#}").contains("not installed"));
    }
}
