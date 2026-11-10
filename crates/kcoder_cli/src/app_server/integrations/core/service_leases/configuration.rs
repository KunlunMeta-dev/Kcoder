//! Original persistent native service configuration; not a client overlay.
use anyhow::{Result, ensure};
use kcoder_config::{Settings, SettingsLoader};
use std::path::Path;
pub fn load_settings(profile: &Path, workspace: &Path, settings: &Path) -> Result<Settings> {
    let resolved = load_host_settings(profile, workspace, settings)?;
    ensure!(
        resolved.integrations.services.enabled,
        "SERVICE_FEATURE_DISABLED"
    );
    Ok(resolved)
}
pub fn load_host_settings(profile: &Path, workspace: &Path, settings: &Path) -> Result<Settings> {
    Ok(host_loader(profile, workspace, settings)?.load()?.settings)
}

fn host_loader(profile: &Path, workspace: &Path, settings: &Path) -> Result<SettingsLoader> {
    ensure!(
        profile.is_absolute() && workspace.is_absolute() && settings.parent() == Some(profile),
        "NATIVE_CODE_TARGET_LOCATOR_INVALID"
    );
    let mut loader = SettingsLoader::new(workspace).with_config_dir(profile);
    if settings.file_name() != Some(std::ffi::OsStr::new("settings.json")) {
        loader = loader.with_overlay_files([settings.to_path_buf()]);
    }
    Ok(loader)
}
