//! `settings/evolution/read|save`: the user-level `evolution` block only.
//!
//! The revision is the SHA-256 of the persisted user block, so any other
//! writer of `evolution` (another client, a manual edit) invalidates it.
//! Project and local layers are never read or written here.

use crate::app_server::private_files::hex_sha256;
use kcoder_app_protocol::evolution::{
    EvolutionSettings, EvolutionSettingsReadResult, EvolutionSettingsSaveParams,
};
use kcoder_tools::evolution_service::EvolutionServiceError;
use serde_json::{Value, json};
use std::path::Path;

const FIELD: &str = "evolution";

#[derive(Debug)]
struct RevisionConflict;
impl std::fmt::Display for RevisionConflict {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("evolution settings changed; reload before saving")
    }
}
impl std::error::Error for RevisionConflict {}

#[derive(Debug)]
struct InvalidSettings(String);
impl std::fmt::Display for InvalidSettings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for InvalidSettings {}

/// The typed, validated block to store: `incoming`, with the stored
/// `eval` thresholds kept when the client did not send them.
fn checked_block(
    mut incoming: Value,
    keep_eval_from: Option<&Value>,
) -> Result<Value, InvalidSettings> {
    if let Some(eval) = keep_eval_from.and_then(|block| block.get("eval")) {
        incoming["eval"] = eval.clone();
    }
    let typed: kcoder_config::EvolutionSettings = serde_json::from_value(incoming)
        .map_err(|error| InvalidSettings(format!("invalid evolution settings: {error}")))?;
    typed
        .validate()
        .map_err(|error| InvalidSettings(error.to_string()))?;
    serde_json::to_value(&typed).map_err(|error| InvalidSettings(error.to_string()))
}

fn block(document: &Value) -> Value {
    document.get(FIELD).cloned().unwrap_or_else(|| json!({}))
}

fn revision(block: &Value) -> Result<String, EvolutionServiceError> {
    Ok(hex_sha256(
        &serde_json::to_vec(block).map_err(anyhow::Error::from)?,
    ))
}

fn invalid(message: impl Into<String>) -> EvolutionServiceError {
    EvolutionServiceError::new("evolution_invalid_params", message)
}

/// Resolve the stored block with typed defaults and mirror it on the wire.
fn project(block: &Value) -> Result<EvolutionSettings, EvolutionServiceError> {
    let typed: kcoder_config::EvolutionSettings = serde_json::from_value(block.clone())
        .map_err(|error| invalid(format!("stored evolution settings are invalid: {error}")))?;
    serde_json::from_value(serde_json::to_value(typed).map_err(anyhow::Error::from)?)
        .map_err(|error| invalid(format!("evolution settings cannot be projected: {error}")))
}

fn result(document: &Value) -> Result<EvolutionSettingsReadResult, EvolutionServiceError> {
    let block = block(document);
    Ok(EvolutionSettingsReadResult {
        settings: project(&block)?,
        revision: revision(&block)?,
    })
}

pub(super) fn read(path: &Path) -> Result<EvolutionSettingsReadResult, EvolutionServiceError> {
    let document = kcoder_config::read_settings_file_if_present(path)?.unwrap_or_else(|| json!({}));
    result(&document)
}

pub(super) fn save(
    path: &Path,
    params: EvolutionSettingsSaveParams,
) -> Result<EvolutionSettingsReadResult, EvolutionServiceError> {
    let keep_eval = params.settings.eval.is_none();
    let incoming = serde_json::to_value(&params.settings).map_err(anyhow::Error::from)?;
    // Reject an invalid document before touching the file.
    checked_block(incoming.clone(), None).map_err(|error| invalid(error.0))?;
    let expected = params.expected_revision;
    let document = kcoder_config::update_settings_file(path, |document| {
        let stored = block(document);
        if revision(&stored).map_err(|error| anyhow::anyhow!(error.message))? != expected {
            return Err(RevisionConflict.into());
        }
        let value = checked_block(incoming.clone(), keep_eval.then_some(&stored))?;
        kcoder_config::set_dotted_value(document, FIELD, value)
    })
    .map_err(|error| {
        if error.downcast_ref::<RevisionConflict>().is_some() {
            EvolutionServiceError::new("evolution_revision_conflict", error.to_string())
        } else if let Some(invalid_settings) = error.downcast_ref::<InvalidSettings>() {
            invalid(invalid_settings.0.clone())
        } else {
            EvolutionServiceError::from(error)
        }
    })?;
    result(&document)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire mirror and the typed settings share one default document;
    /// a field missing from either side fails here.
    #[test]
    fn the_wire_mirror_and_the_typed_settings_have_the_same_default() {
        let temp = tempfile::tempdir().unwrap();
        let read = read(&temp.path().join("settings.json")).unwrap();
        assert_eq!(
            serde_json::to_value(&read.settings).unwrap(),
            serde_json::to_value(kcoder_config::EvolutionSettings::default()).unwrap()
        );
        let mirrored: EvolutionSettings = serde_json::from_value(
            serde_json::to_value(kcoder_config::EvolutionSettings::default()).unwrap(),
        )
        .unwrap();
        assert_eq!(mirrored, read.settings);
    }

    #[test]
    fn a_save_without_eval_keeps_the_stored_thresholds() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"evolution":{"eval":{"win_rate":0.75,"max_diversity_drop":0.05}}}"#,
        )
        .unwrap();
        let initial = read(&path).unwrap();
        let eval = initial.settings.eval.expect("results carry eval");
        assert_eq!(eval.win_rate, 0.75);
        let mut settings = initial.settings.clone();
        settings.eval = None;
        settings.enabled = true;
        let saved = save(
            &path,
            EvolutionSettingsSaveParams {
                settings,
                expected_revision: initial.revision,
            },
        )
        .unwrap();
        assert!(saved.settings.enabled);
        assert_eq!(saved.settings.eval, Some(eval));

        let mut invalid_eval = saved.settings.clone();
        invalid_eval.eval = Some(kcoder_app_protocol::evolution::EvolutionEvalSettings {
            win_rate: 0.0,
            max_diversity_drop: 0.1,
        });
        let error = save(
            &path,
            EvolutionSettingsSaveParams {
                settings: invalid_eval,
                expected_revision: saved.revision,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "evolution_invalid_params");
    }

    #[test]
    fn save_is_user_only_revision_checked_and_validated() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        std::fs::write(&path, r#"{"model":"keep-me"}"#).unwrap();
        let initial = read(&path).unwrap();
        assert!(!initial.settings.enabled);
        let mut settings = initial.settings.clone();
        settings.enabled = true;
        settings.model = Some(kcoder_app_protocol::evolution::EvolutionModelRef {
            provider: "Acme".into(),
            model: "Fast-1".into(),
        });
        let saved = save(
            &path,
            EvolutionSettingsSaveParams {
                settings: settings.clone(),
                expected_revision: initial.revision.clone(),
            },
        )
        .unwrap();
        assert!(saved.settings.enabled);
        assert_ne!(saved.revision, initial.revision);
        let document: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(document["model"], "keep-me");
        assert_eq!(document["evolution"]["model"]["provider"], "Acme");

        let stale = save(
            &path,
            EvolutionSettingsSaveParams {
                settings: settings.clone(),
                expected_revision: initial.revision,
            },
        )
        .unwrap_err();
        assert_eq!(stale.code, "evolution_revision_conflict");

        settings.rollback_threshold = 0.95;
        let invalid = save(
            &path,
            EvolutionSettingsSaveParams {
                settings,
                expected_revision: saved.revision,
            },
        )
        .unwrap_err();
        assert_eq!(invalid.code, "evolution_invalid_params");
    }
}
