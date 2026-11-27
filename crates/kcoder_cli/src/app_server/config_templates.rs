//! Session-template RPC/session routing; persistence and import ownership belong to Config.
//! The native service returns the path and binding from one coordinated snapshot.

use anyhow::Result;
use kcoder_app_protocol::SettingsTemplateBinding;
use std::path::PathBuf;

pub(super) type ConfigTemplates = kcoder_config::settings_templates::SettingsTemplateStore;

/// Resolves the overlay path plus the frozen binding for a session start.
pub(super) fn resolve_session_template(id: &str) -> Result<(PathBuf, SettingsTemplateBinding)> {
    let store = user_template_store()?;
    store.freeze_for_session(id)
}

/// Resolves the store's default template for new sessions, if one is set.
///
/// An absent default uses baseline settings; corrupt or unavailable versions must not weaken policy.
pub(super) fn default_session_template() -> Result<Option<(PathBuf, SettingsTemplateBinding)>> {
    user_template_store()?.freeze_default_for_session()
}

/// Store backed by the active profile's config directory.
pub(super) fn user_template_store() -> Result<ConfigTemplates> {
    ConfigTemplates::open(&kcoder_config::Settings::config_dir()?)
}
