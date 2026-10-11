//! Persist only the existing audited model semantics snapshot, never Settings,
//! Provider instances, authorization headers or credential values.
use super::{knowledge_job_runner, knowledge_model::ProviderWikiModel};
use anyhow::{Context, Result, ensure};
use clap::Parser;
use kcoder_engine::ClientModelConfiguration;
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, io::Read, path::Path};

/// Normalize only the private Wiki Provider request copy. Vendor extra-body
/// output fields are late overrides; retaining them bypasses every stage limit.
pub(super) fn prepare_settings(settings: &mut kcoder_config::Settings) -> Result<()> {
    let mut ceiling = settings
        .max_tokens
        .unwrap_or(kcoder_knowledge::WIKI_MAX_OUTPUT_TOKENS);
    for field in ["max_tokens", "max_completion_tokens", "max_output_tokens"] {
        if let Some(value) = settings.provider_extra_body.remove(field) {
            let limit = value
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .filter(|v| *v > 0)
                .context("Wiki output override must be a positive integer")?;
            ceiling = ceiling.min(limit);
        }
    }
    ceiling = ceiling.min(kcoder_knowledge::WIKI_MAX_OUTPUT_TOKENS);
    settings.max_tokens = Some(ceiling);
    if settings.api_format == Some(kcoder_config::ApiFormat::AnthropicMessages)
        && settings
            .provider_extra_body
            .get("thinking")
            .and_then(|v| v.get("type"))
            .and_then(|v| v.as_str())
            == Some("enabled")
    {
        let budget = settings.provider_extra_body["thinking"]
            .get("budget_tokens")
            .and_then(|v| v.as_u64())
            .and_then(|v| u32::try_from(v).ok())
            .filter(|v| *v >= 1024 && *v < ceiling)
            .context("Wiki thinking budget must be at least 1024 and below the output ceiling")?;
        // Numeric effort is the existing Anthropic bounded budget path. It keeps
        // the user's requested budget while clamping it to each stage request.
        settings.model_reasoning_effort =
            Some(kcoder_types::ReasoningEffort::Custom(budget.to_string()));
        settings.provider_extra_body.remove("thinking");
    }
    Ok(())
}

/// Project the accepted normalized request, including persistent-worker thaw.
/// This worker never sends tools, regardless of conversation tool profiles.
pub(super) fn summary(
    settings: &kcoder_config::Settings,
) -> Result<kcoder_types::ModelConfigurationSummary> {
    let mut summary = kcoder_engine::model_configuration_summary(
        settings,
        kcoder_types::ModelConfigurationBoundary::SessionSnapshot,
    )?;
    summary.tool_set = Some(kcoder_types::ModelToolSetSummary {
        profile: None,
        registry_scope: kcoder_types::ModelToolRegistryScope::WikiWorker,
        registered_tool_count: Some(0),
        exposed_tool_count: Some(0),
    });
    for field in [
        "api_format",
        "chat_protocol",
        "context_window_tokens",
        "max_output_tokens",
        "output_headroom_tokens",
        "reasoning_effort",
        "reasoning_policy",
        "extra_body",
    ] {
        summary
            .sources
            .insert(field.into(), ["session_snapshot".into()].into());
    }
    Ok(summary)
}

fn recipe(purpose: &str, snapshot: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(kcoder_knowledge::PREPARATION_VERSION.as_bytes());
    hash.update([0]);
    hash.update(purpose.as_bytes());
    hash.update([0]);
    hash.update(snapshot);
    format!("wiki-v4:{:x}", hash.finalize())
}

fn filename(key: &str) -> Result<String> {
    let digest = key
        .strip_prefix("wiki-v4:")
        .or_else(|| key.strip_prefix("wiki-v3:"))
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
    ensure!(
        settings.model == model.model
            && settings.max_tokens == model.max_output_tokens
            && settings.model_reasoning_effort == model.reasoning,
        "Wiki snapshot must match the effective worker request"
    );
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
    // Earlier recipes have different preparation/budget semantics. Preserve the
    // job/source and ask for explicit reorganization instead of thawing silently.
    ensure!(key.starts_with("wiki-v4:"), "wiki_recipe_changed");
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
    if key.starts_with("wiki-v4:") {
        ensure!(recipe(purpose, &snapshot) == key, "wiki_snapshot_integrity");
    }
    let (settings, provider) = source
        .thaw_model(&snapshot, None)
        .context("wiki_snapshot_restore")?;
    // Earlier v4 snapshots could carry late body overrides that bypass stage
    // budgets. Preserve the queued job and require explicit reorganization;
    // never silently alter an already accepted frozen recipe.
    ensure!(
        !["max_tokens", "max_completion_tokens", "max_output_tokens"]
            .iter()
            .any(|field| settings.provider_extra_body.contains_key(*field))
            && settings
                .provider_extra_body
                .get("thinking")
                .and_then(|v| v.get("type"))
                .and_then(|v| v.as_str())
                != Some("enabled"),
        "wiki_recipe_changed"
    );
    let model = ProviderWikiModel {
        configuration: Some(summary(&settings)?),
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
    if let Some(root) = path.parent()
        && let Ok(directory) =
            kcoder_config::PrivateDirectory::open_existing(&root.join("knowledge"))
    {
        let value = serde_json::json!({"stage":stage, "errorType":kind});
        let _ = directory.atomic_replace(
            OsStr::new("worker-diagnostic.json"),
            value.to_string().as_bytes(),
        );
    }
    kcoder_types::ProviderErrorSummary::new(kind, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wiki_private_limits_remove_late_overrides_and_keep_bounded_thinking() -> Result<()> {
        let mut settings = kcoder_config::Settings {
            api_format: Some(kcoder_config::ApiFormat::AnthropicMessages),
            max_tokens: Some(65536),
            provider_extra_body: serde_json::json!({"max_tokens":32768,
                "thinking":{"type":"enabled","budget_tokens":16000},"temperature":0.2})
            .as_object()
            .unwrap()
            .clone(),
            ..Default::default()
        };
        let original = settings.clone();
        prepare_settings(&mut settings)?;
        assert_eq!(settings.max_tokens, Some(32768));
        assert_eq!(
            settings.model_reasoning_effort,
            Some(kcoder_types::ReasoningEffort::Custom("16000".into()))
        );
        assert!(!settings.provider_extra_body.contains_key("max_tokens"));
        assert!(!settings.provider_extra_body.contains_key("thinking"));
        assert_eq!(settings.provider_extra_body["temperature"], 0.2);
        assert_eq!(
            original.provider_extra_body["thinking"]["budget_tokens"],
            16000
        );
        Ok(())
    }

    #[test]
    fn invalid_wiki_budget_does_not_echo_submitted_values() {
        for value in [serde_json::json!(0), serde_json::json!("private-sentinel")] {
            let mut settings = kcoder_config::Settings::default();
            settings
                .provider_extra_body
                .insert("max_tokens".into(), value);
            let error = prepare_settings(&mut settings).unwrap_err();
            assert!(!error.to_string().contains("private-sentinel"));
        }
    }

    #[test]
    fn wiki_model_and_effort_overrides_use_qualified_resolver_without_changing_defaults()
    -> Result<()> {
        let temp = tempfile::tempdir()?;
        let path = temp.path().join("settings.json");
        std::fs::write(&path,serde_json::json!({
            "knowledge":{"organization_enabled":true,"organization_model":"wiki::alternate",
                "organization_reasoning_effort":"high"},
            "active_provider":"wiki","providers":{"wiki":{"authentication":{"mode":"none"},
                "api_format":"openai_chat_completions","endpoint":"http://127.0.0.1:1",
                "default_model":"default","context_window_tokens":100000,"max_output_tokens":65536,
                "output_headroom_tokens":65536,"models":{
                    "default":{"context_window_tokens":100000,"max_output_tokens":32768,"output_headroom_tokens":32768,"capabilities":{"vision":true}},
                    "alternate":{"context_window_tokens":100000,"max_output_tokens":65536,"output_headroom_tokens":65536,
                        "capabilities":{"reasoning":true,"vision":false}}
                }}}}).to_string())?;
        let before = std::fs::read(&path)?;
        let (settings, model) = super::super::knowledge_worker::model(&path)?;
        assert_eq!(settings.model, "alternate");
        assert_eq!(model.model, "alternate");
        assert_eq!(model.reasoning, Some(kcoder_types::ReasoningEffort::High));
        assert_eq!(settings.providers["wiki"].default_model, "default");
        let (image_settings, image_model) = super::super::knowledge_worker::image_model(&path)?;
        assert_eq!(image_model.model, "default");
        assert!(image_settings.model_capabilities.vision);
        assert!(!settings.model_capabilities.vision);
        assert!(image_model.reasoning.is_none());
        assert_eq!(std::fs::read(&path)?, before);
        Ok(())
    }

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
            configuration: None,
            provider,
            model: settings.model.clone(),
            max_output_tokens: settings.max_tokens,
            reasoning: settings.model_reasoning_effort.clone(),
        };
        std::fs::create_dir(root.join("knowledge"))?;
        let key = save(&path, &settings, &model, "Test Wiki", &source)?;
        assert!(key.starts_with("wiki-v4:"));
        let snapshot = std::fs::read(root.join("knowledge/worker-models").join(filename(&key)?))?;
        assert!(!String::from_utf8_lossy(&snapshot).contains("fixture-private-key-never-real"));
        let (restored, model) = load(&path, &key, "Test Wiki")?;
        assert_eq!(restored.model, "MiniMax-M3");
        assert_eq!(
            restored.api_format,
            Some(kcoder_config::ApiFormat::AnthropicMessages)
        );
        assert_eq!(model.provider.api_key_configured(), Some(true));
        let frozen = model.configuration.as_ref().unwrap();
        assert_eq!(frozen.model_id, "MiniMax-M3");
        assert_eq!(frozen.api_format.as_deref(), Some("anthropic_messages"));
        assert_eq!(frozen.max_output_tokens, Some(8192));
        assert_eq!(
            frozen.tool_set.as_ref().unwrap().registered_tool_count,
            Some(0)
        );
        assert_eq!(
            frozen.tool_set.as_ref().unwrap().exposed_tool_count,
            Some(0)
        );
        let public = serde_json::to_string(frozen)?;
        assert!(!public.contains("fixture-private-key"));
        assert!(!public.contains("127.0.0.1"));
        assert!(!public.contains(&root.display().to_string()));
        std::fs::write(&path, r#"{"model":"changed","max_tokens":512}"#)?;
        let (_, restored_again) = load(&path, &key, "Test Wiki")?;
        assert_eq!(restored_again.configuration.unwrap(), *frozen);
        assert!(load(&path, &key, "Changed purpose").is_err());
        let mut legacy_settings = restored.clone();
        legacy_settings
            .provider_extra_body
            .insert("max_tokens".into(), serde_json::json!(32768));
        let legacy_model = ProviderWikiModel {
            configuration: None,
            provider: source.provider(&legacy_settings)?,
            model: legacy_settings.model.clone(),
            max_output_tokens: legacy_settings.max_tokens,
            reasoning: legacy_settings.model_reasoning_effort.clone(),
        };
        let legacy_key = save(&path, &legacy_settings, &legacy_model, "Test Wiki", &source)?;
        let legacy_path = root
            .join("knowledge/worker-models")
            .join(filename(&legacy_key)?);
        let legacy_before = std::fs::read(&legacy_path)?;
        assert!(
            load(&path, &legacy_key, "Test Wiki")
                .err()
                .context("unsafe legacy recipe unexpectedly loaded")?
                .to_string()
                .contains("wiki_recipe_changed")
        );
        assert_eq!(std::fs::read(&legacy_path)?, legacy_before);
        std::fs::write(&credentials, r#"{"kunlunmeta":{"type":"revoked"}}"#)?;
        assert!(load(&path, &key, "Test Wiki").is_err());
        Ok(())
    }
}
