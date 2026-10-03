//! Persist only the existing audited model semantics snapshot, never Settings,
//! Provider instances, authorization headers or credential values.
use super::{knowledge_job_runner, knowledge_model::ProviderWikiModel};
use anyhow::{Context, Result, ensure};
use clap::Parser;
use kcoder_engine::ClientModelConfiguration;
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, io::Read, path::Path};

fn recipe(purpose: &str, snapshot: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(kcoder_knowledge::PREPARATION_VERSION.as_bytes());
    hash.update([0]);
    hash.update(purpose.as_bytes());
    hash.update([0]);
    hash.update(snapshot);
    format!("wiki-v3:{:x}", hash.finalize())
}

fn filename(key: &str) -> Result<String> {
    let digest = key
        .strip_prefix("wiki-v3:")
        .or_else(|| key.strip_prefix("wiki-v2:"))
        .context("Invalid Wiki model recipe")?;
    ensure!(
        digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid Wiki model recipe"
    );
    Ok(format!("{digest}.json"))
}

pub(super) fn save(
    path: &Path,
    settings: &kcoder_config::Settings,
    model: &ProviderWikiModel,
    purpose: &str,
    source: &dyn ClientModelConfiguration,
) -> Result<String> {
    let snapshot = source
        .freeze_model(settings, model.provider.as_ref())?
        .context("This model cannot be used by the persistent Wiki worker")?;
    ensure!(
        snapshot.len() <= 512 * 1024,
        "Wiki model snapshot exceeds limit"
    );
    // Hash the frozen semantics themselves. Thawing normalizes defaults such
    // as api_format=None to Some(AnthropicMessages), which must not invalidate
    // an otherwise identical accepted request.
    let key = recipe(purpose, &snapshot);
    let root = path
        .parent()
        .context("Wiki profile unavailable")?
        .join("knowledge/worker-models");
    let directory = kcoder_config::PrivateDirectory::open_or_create(&root)?;
    directory.atomic_replace(OsStr::new(&filename(&key)?), &snapshot)?;
    Ok(key)
}

pub(super) fn load(
    path: &Path,
    key: &str,
    purpose: &str,
) -> Result<(kcoder_config::Settings, ProviderWikiModel)> {
    let profile = path.parent().context("Wiki profile unavailable")?;
    let directory =
        kcoder_config::PrivateDirectory::open_existing(&profile.join("knowledge/worker-models"))?;
    let file = directory.open_regular_file(OsStr::new(&filename(key)?))?;
    ensure!(
        file.metadata()?.len() <= 512 * 1024,
        "Wiki model snapshot exceeds limit"
    );
    let mut snapshot = Vec::new();
    file.take(512 * 1024 + 1).read_to_end(&mut snapshot)?;
    ensure!(
        snapshot.len() <= 512 * 1024,
        "Wiki model snapshot exceeds limit"
    );
    let mut cli = crate::Cli::try_parse_from(["kcoder"])?;
    // This is a source reference emitted by freeze_model, not a submitted
    // credential. The resolver validates the authority again for each call.
    let metadata: serde_json::Value =
        serde_json::from_slice(&snapshot).context("wiki_snapshot_decode")?;
    if let Some(file) = metadata
        .pointer("/credential/credential_file")
        .and_then(|v| v.as_str())
    {
        cli.credential_env_file = Some(file.into());
    }
    let source = crate::model_configuration::ModelConfiguration::new(
        kcoder_config::SettingsLoader::new(profile).with_config_dir(profile),
        cli,
    );
    if key.starts_with("wiki-v3:") {
        ensure!(recipe(purpose, &snapshot) == key, "wiki_snapshot_integrity");
    }
    let (settings, provider) = source
        .thaw_model(&snapshot, None)
        .context("wiki_snapshot_restore")?;
    let model = ProviderWikiModel {
        provider,
        model: settings.model.clone(),
        max_output_tokens: settings.max_tokens,
        reasoning: settings.model_reasoning_effort.clone(),
    };
    if key.starts_with("wiki-v2:") {
        // Read the development-era recipe while new jobs use representation-
        // independent v3. Old conflicts are paused rather than rewritten.
        let base = knowledge_job_runner::recipe_key(&settings, &model, purpose)?;
        let mut hash = Sha256::new();
        hash.update(base.as_bytes());
        hash.update([0]);
        hash.update(&snapshot);
        ensure!(
            format!("wiki-v2:{:x}", hash.finalize()) == key,
            "wiki_snapshot_integrity"
        );
    }
    Ok((settings, model))
}

/// Diagnostics contain only host-authored categories, never error text or input.
pub(super) fn record_failure(
    path: &Path,
    error: &anyhow::Error,
) -> kcoder_types::ProviderErrorSummary {
    let stage = if error
        .chain()
        .any(|e| e.to_string() == "wiki_snapshot_integrity")
    {
        "snapshot_integrity"
    } else if error
        .chain()
        .any(|e| e.to_string() == "wiki_snapshot_restore")
    {
        "model_restore"
    } else if error
        .chain()
        .any(|e| e.to_string() == "wiki_snapshot_decode")
    {
        "snapshot_decode"
    } else {
        "snapshot_read_or_configuration"
    };
    let kind = if error
        .chain()
        .any(|e| e.to_string().to_ascii_lowercase().contains("credential"))
    {
        "authentication_error"
    } else {
        "request_build_error"
    };
    if let Some(root) = path.parent() {
        if let Ok(directory) =
            kcoder_config::PrivateDirectory::open_existing(&root.join("knowledge"))
        {
            let value = serde_json::json!({"stage":stage, "errorType":kind});
            let _ = directory.atomic_replace(
                OsStr::new("worker-diagnostic.json"),
                value.to_string().as_bytes(),
            );
        }
    }
    kcoder_types::ProviderErrorSummary::new(kind, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stored_anthropic_snapshot_survives_normalized_defaults_without_storing_keys() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = temp.path().join("config");
        std::fs::create_dir(&root)?;
        let path = root.join("settings.json");
        std::fs::write(&path, serde_json::json!({
            "knowledge":{"enabled":true}, "active_provider":"kunlunmeta",
            "providers":{"kunlunmeta":{"api_format":"anthropic_messages",
                "endpoint":"http://127.0.0.1:1", "default_model":"MiniMax-M3",
                "authentication":{"mode":"api_key"}, "no_proxy":true,
                "context_window_tokens":1000000,"max_output_tokens":8192,"output_headroom_tokens":8192}}
        }).to_string())?;
        let credentials = root.join("credentials.json");
        std::fs::write(
            &credentials,
            r#"{"kunlunmeta":{"type":"api","key":"fixture-private-key-never-real"}}"#,
        )?;
        let source = crate::model_configuration::ModelConfiguration::new(
            kcoder_config::SettingsLoader::new(&root)
                .with_config_dir(&root)
                .with_executable_dir(temp.path()),
            crate::Cli::try_parse_from(["kcoder"])?,
        );
        let mut settings = source.settings("kunlunmeta")?;
        // The built-in provider may imply its protocol instead of materializing
        // it in Settings. Thawing makes the same protocol explicit.
        settings.api_format = None;
        let provider = source.provider(&settings)?;
        let model = ProviderWikiModel {
            provider,
            model: settings.model.clone(),
            max_output_tokens: settings.max_tokens,
            reasoning: settings.model_reasoning_effort.clone(),
        };
        std::fs::create_dir(root.join("knowledge"))?;
        let key = save(&path, &settings, &model, "Test Wiki", &source)?;
        assert!(key.starts_with("wiki-v3:"));
        let snapshot = std::fs::read(root.join("knowledge/worker-models").join(filename(&key)?))?;
        assert!(!String::from_utf8_lossy(&snapshot).contains("fixture-private-key-never-real"));
        let (restored, model) = load(&path, &key, "Test Wiki")?;
        assert_eq!(restored.model, "MiniMax-M3");
        assert_eq!(
            restored.api_format,
            Some(kcoder_config::ApiFormat::AnthropicMessages)
        );
        assert_eq!(model.provider.api_key_configured(), Some(true));
        assert!(load(&path, &key, "Changed purpose").is_err());
        std::fs::write(&credentials, r#"{"kunlunmeta":{"type":"revoked"}}"#)?;
        assert!(load(&path, &key, "Test Wiki").is_err());
        Ok(())
    }
}
