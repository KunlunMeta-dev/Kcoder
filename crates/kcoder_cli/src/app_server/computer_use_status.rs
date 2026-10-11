//! Read-only preflight. Ready means eligible for explicit desktop approval;
//! it neither acquires a lease nor starts a desktop worker.
use kcoder_app_protocol::{ComputerUseAvailability as Availability, ComputerUseStatusResult};

pub(super) fn inspect(settings: kcoder_config::Settings) -> ComputerUseStatusResult {
    let mut result = ComputerUseStatusResult {
        availability: Availability::UnsupportedPlatform,
        can_control: false,
        platform: std::env::consts::OS.into(),
        windows_session_id: None,
        reason: "unsupported_platform".into(),
    };
    #[cfg(windows)]
    {
        let plugins = &settings.plugins;
        if kcoder_plugins::computer_use_policy_allows(plugins)
            && kcoder_plugins::computer_use_requires_explicit_enable(plugins, &settings.mcp_servers)
        {
            result.availability = Availability::PluginDisabled;
            result.reason = "existing_windows_mcp_requires_choice".into();
            return result;
        }
        if !kcoder_plugins::computer_use_is_enabled(plugins).unwrap_or(false) {
            result.availability = Availability::PluginDisabled;
            result.reason = "desktop_plugin_disabled_or_missing".into();
            return result;
        }
        match kcoder_computer_use::desktop::inspect_interactive_desktop() {
            Ok(desktop) => result.windows_session_id = Some(desktop.session_id),
            Err(_) => {
                result.availability = Availability::DesktopUnavailable;
                result.reason = "interactive_desktop_required".into();
                return result;
            }
        }
        // Packaged CLI lives under resources/bin. No user/model-supplied path or
        // environment override is accepted as proof of an installed component.
        let root = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent()?.parent().map(|root| root.join("computer-use")));
        if root
            .as_ref()
            .is_none_or(|root| !root.join("runtime-manifest.json").is_file())
        {
            result.availability = Availability::ComponentMissing;
            result.reason = "bundled_component_missing".into();
        } else {
            match std::env::current_exe().ok().and_then(|executable| {
                kcoder_computer_use::packaged::inspect_installed_layout(&executable).ok()
            }) {
                Some(_) => {
                    result.availability = Availability::Ready;
                    result.can_control = true;
                    result.reason = "explicit_turn_approval_required".into();
                }
                None => {
                    result.availability = Availability::ComponentInvalid;
                    result.reason = "bundled_component_verification_failed".into();
                }
            }
        }
    }
    #[cfg(not(windows))]
    let _ = (&mut result, settings);
    result
}
