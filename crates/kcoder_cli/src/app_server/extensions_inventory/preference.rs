//! Revision-checked `skills.source_preference` edits in the target's user settings.
use anyhow::{Context, Result, bail};
use kcoder_app_protocol::{
    ExtensionSkillPreference, ExtensionSkillPreferenceResult, ExtensionSkillPreferenceUpdateParams,
};
use sha2::{Digest, Sha256};
use std::path::Path;

const MAX_ENTRIES: usize = 1024;
const MAX_IDENTITY_CHARS: usize = 256;

#[derive(Debug)]
pub(super) struct RevisionConflict;
impl std::fmt::Display for RevisionConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Skill source preference changed; reload before saving")
    }
}
impl std::error::Error for RevisionConflict {}

fn normalized(mut preference: ExtensionSkillPreference) -> ExtensionSkillPreference {
    preference.prefer_plugins.sort();
    preference.prefer_plugins.dedup();
    preference
}

fn from_document(document: &serde_json::Value) -> Result<ExtensionSkillPreference> {
    let Some(value) = document.pointer("/skills/source_preference") else {
        return Ok(ExtensionSkillPreference::default());
    };
    let typed: kcoder_config::SkillSourcePreferenceSettings = serde_json::from_value(value.clone())
        .context("skills.source_preference in user settings is invalid")?;
    Ok(normalized(ExtensionSkillPreference {
        prefer_plugin_skills: typed.prefer_plugin_skills,
        prefer_plugins: typed.prefer_plugins,
    }))
}

pub(super) fn revision(preference: &ExtensionSkillPreference) -> String {
    let bytes = serde_json::to_vec(preference).expect("preference serializes");
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn read(path: &Path) -> Result<(ExtensionSkillPreference, String)> {
    let document = kcoder_config::read_settings_file(path)?;
    let preference = from_document(&document)?;
    let revision = revision(&preference);
    Ok((preference, revision))
}

fn valid_identity(value: &str) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= MAX_IDENTITY_CHARS
        && !value.chars().any(char::is_control)
}

pub(super) fn validate(params: &ExtensionSkillPreferenceUpdateParams) -> Result<()> {
    let preference = &params.preference;
    if params.expected_revision.len() != 64
        || !params
            .expected_revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        bail!("expectedRevision must be the 64-character revision from extensions/inventory");
    }
    if preference.prefer_plugin_skills.len() > MAX_ENTRIES
        || preference.prefer_plugins.len() > MAX_ENTRIES
    {
        bail!("Too many skill source preferences");
    }
    if !preference
        .prefer_plugin_skills
        .iter()
        .all(|(name, plugin)| valid_identity(name) && valid_identity(plugin))
        || !preference
            .prefer_plugins
            .iter()
            .all(|id| valid_identity(id))
    {
        bail!("Skill names and plugin IDs must be nonempty text without control characters");
    }
    Ok(())
}

pub(super) fn update(
    path: &Path,
    params: ExtensionSkillPreferenceUpdateParams,
) -> Result<ExtensionSkillPreferenceResult> {
    let preference = normalized(params.preference);
    kcoder_config::update_settings_file(path, |document| {
        if revision(&from_document(document)?) != params.expected_revision.to_ascii_lowercase() {
            return Err(RevisionConflict.into());
        }
        let root = document
            .as_object_mut()
            .context("User settings must be an object")?;
        let skills = root
            .entry("skills")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .context("User settings `skills` must be an object")?;
        if preference.prefer_plugin_skills.is_empty() && preference.prefer_plugins.is_empty() {
            skills.remove("source_preference");
        } else {
            skills.insert(
                "source_preference".into(),
                serde_json::to_value(kcoder_config::SkillSourcePreferenceSettings {
                    prefer_plugin_skills: preference.prefer_plugin_skills.clone(),
                    prefer_plugins: preference.prefer_plugins.clone(),
                })?,
            );
        }
        if skills.is_empty() {
            root.remove("skills");
        }
        Ok(())
    })?;
    Ok(ExtensionSkillPreferenceResult {
        revision: revision(&preference),
        preference,
        applies_to_new_conversations: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn update_is_revision_checked_narrow_and_empty_preference_is_removed() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"model":"fixture","skills":{"external_dirs":["/x"]}}"#,
        )
        .unwrap();
        let (initial, revision) = read(&path).unwrap();
        assert_eq!(initial, ExtensionSkillPreference::default());
        let wanted = ExtensionSkillPreference {
            prefer_plugin_skills: BTreeMap::from([("lark-doc".into(), "lark@trae".into())]),
            prefer_plugins: vec!["b@m".into(), "a@m".into(), "a@m".into()],
        };
        let saved = update(
            &path,
            ExtensionSkillPreferenceUpdateParams {
                expected_revision: revision.clone(),
                preference: wanted,
            },
        )
        .unwrap();
        assert_eq!(saved.preference.prefer_plugins, ["a@m", "b@m"]);
        let document: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(document["model"], "fixture");
        assert_eq!(document["skills"]["external_dirs"][0], "/x");
        assert_eq!(
            document["skills"]["source_preference"]["prefer_plugin_skills"]["lark-doc"],
            "lark@trae"
        );
        let stale = update(
            &path,
            ExtensionSkillPreferenceUpdateParams {
                expected_revision: revision,
                preference: ExtensionSkillPreference::default(),
            },
        )
        .unwrap_err();
        assert!(stale.downcast_ref::<RevisionConflict>().is_some());
        update(
            &path,
            ExtensionSkillPreferenceUpdateParams {
                expected_revision: saved.revision,
                preference: ExtensionSkillPreference::default(),
            },
        )
        .unwrap();
        let document: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(document["skills"].get("source_preference").is_none());
    }
}
