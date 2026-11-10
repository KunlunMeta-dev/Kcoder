//! First-party task infrastructure has no platform or background execution grant.
use super::super::NativeServiceLeases;
use crate::app_server::QueryEngine;
use anyhow::{Context, Result};

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
pub(in crate::app_server) fn guard_stdio_against_legacy_host(
    origin: &QueryEngine,
) -> Result<Option<kcoder_config::VerifiedPrivateLease>> {
    use crate::app_server::integrations::core::NativeIntegrationContext;
    let Some(settings) = origin.settings_persistence_path() else {
        return Ok(None);
    };
    let profile = settings
        .parent()
        .context("APP_SERVER_HOST_PROFILE_REQUIRED")?;
    let native = match NativeIntegrationContext::capture_existing(
        profile,
        &origin.state.cwd(),
        "gateway-stdio",
        "gateway-stdio-v1",
    ) {
        Ok(native) => native,
        Err(error) if error.to_string() == "INTEGRATION_EXISTING_NATIVE_IDENTITY_REQUIRED" => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let Some(storage) = NativeServiceLeases::load(&native)? else {
        return Ok(None);
    };
    storage.store(&native)?.guard_stdio_against_legacy_host()
}
