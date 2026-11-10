//! Shared settings fixtures for unit tests in this crate.

use kcoder_config::Settings;

/// Default settings that also declare the default Provider profile.
///
/// Fresh installations ship an empty Provider catalog, so tests that need a
/// configured profile, its model or its context limits declare it explicitly
/// instead of relying on a built-in catalog.
pub(crate) fn settings_with_default_provider() -> Settings {
    const FIXTURE_PROVIDER: &str = "kunlunmeta";
    let mut settings = Settings::default();
    settings.providers.insert(
        FIXTURE_PROVIDER.to_string(),
        kcoder_config::default_active_provider_config(),
    );
    settings.active_provider = Some(FIXTURE_PROVIDER.to_string());
    settings
        .apply_provider(None)
        .expect("fixture Provider profile must apply");
    settings
}
