//! Read and write the `turn_file_changes` policy of the session's settings file.

use anyhow::{Context, Result};
use kcoder_app_protocol::TurnFileChangesPolicy;
use kcoder_engine::QueryEngine;

fn policy_from(settings: kcoder_config::TurnFileChangesSettings) -> TurnFileChangesPolicy {
    TurnFileChangesPolicy {
        enabled: settings.enabled,
        retention_days: settings.retention_days,
        max_total_bytes: settings.max_total_bytes,
        max_file_bytes: settings.max_file_bytes,
        ignore_globs: settings.ignore_globs,
    }
}

fn settings_from(policy: &TurnFileChangesPolicy) -> kcoder_config::TurnFileChangesSettings {
    kcoder_config::TurnFileChangesSettings {
        enabled: policy.enabled,
        retention_days: policy.retention_days,
        max_total_bytes: policy.max_total_bytes,
        max_file_bytes: policy.max_file_bytes,
        ignore_globs: policy.ignore_globs.clone(),
    }
}

/// Current policy from the persisted settings file (defaults when unset).
pub(super) fn read(engine: &QueryEngine) -> Result<TurnFileChangesPolicy> {
    let Some(path) = engine.settings_persistence_path() else {
        return Ok(policy_from(
            kcoder_config::TurnFileChangesSettings::default(),
        ));
    };
    let user = kcoder_config::read_settings_file(&path)?;
    let settings = match user.get("turn_file_changes").cloned() {
        Some(value) => serde_json::from_value::<kcoder_config::TurnFileChangesSettings>(value)
            .context("stored turn_file_changes policy is invalid")?,
        None => kcoder_config::TurnFileChangesSettings::default(),
    };
    Ok(policy_from(settings))
}

/// Validates and persists the policy, returning what is now stored.
pub(super) fn save(
    engine: &QueryEngine,
    policy: &TurnFileChangesPolicy,
) -> Result<TurnFileChangesPolicy> {
    let settings = settings_from(policy);
    settings
        .compile_ignore_globs()
        .context("ignore_globs contains an invalid pattern")?;
    let path = engine
        .settings_persistence_path()
        .context("Settings persistence is unavailable for this runtime")?;
    let stored = settings.clone();
    kcoder_config::update_settings_file(&path, |user| {
        user["turn_file_changes"] = serde_json::to_value(&stored)?;
        Ok(())
    })?;
    Ok(policy_from(settings))
}
