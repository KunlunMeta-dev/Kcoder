//! Policy bridge for the native desktop component and its bundled guidance.
use crate::{InstalledPluginSource, PluginId, PluginStore};
use anyhow::Result;
use kcoder_config::PluginsSettings;
pub const COMPUTER_USE_PLUGIN_ID: &str = "kcoder-windows-computer-use@kcoder-bundled";

/// Refresh only our existing bundled guidance, never replace a custom source.
pub fn computer_use_guidance_needs_update(source: &InstalledPluginSource) -> bool {
    matches!(source, InstalledPluginSource::Bundled { bundle, digest }
        if bundle == "kcoder-windows-computer-use" && digest != crate::bundled::computer_use_digest())
}

/// Recognize known Windows-MCP invocations, not arbitrary server labels or
/// command-line substrings. Custom wrappers remain the user's explicit choice.
pub fn computer_use_requires_explicit_enable(
    settings: &PluginsSettings,
    servers: &[kcoder_types::McpServerConfig],
) -> bool {
    if settings
        .installed
        .get(COMPUTER_USE_PLUGIN_ID)
        .and_then(|policy| policy.enabled)
        == Some(true)
    {
        return false;
    }
    servers.iter().any(|server| {
        if !server.transport.is_empty() && server.transport != "stdio" {
            return false;
        }
        let command = server
            .command
            .trim_matches('"')
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if matches!(command.as_str(), "windows-mcp" | "windows-mcp.exe") {
            return true;
        }
        let module = || {
            server.args.windows(2).any(|pair| {
                pair[0] == "-m"
                    && matches!(pair[1].as_str(), "windows_mcp" | "windows_mcp.__main__")
            })
        };
        let package = || {
            server
                .args
                .iter()
                .any(|arg| arg == "windows-mcp" || arg.starts_with("windows-mcp@"))
        };
        match command.as_str() {
            "python" | "python.exe" | "python3" | "python3.exe" | "py" | "py.exe" => module(),
            "uvx" | "uvx.exe" => package(),
            "uv" | "uv.exe" => {
                (server.args.first().is_some_and(|arg| arg == "run") && module())
                    || (server.args.starts_with(&["tool".into(), "run".into()]) && package())
            }
            _ => false,
        }
    })
}

pub fn computer_use_policy_allows(settings: &PluginsSettings) -> bool {
    settings.runtime.enabled
        && settings
            .installed
            .get(COMPUTER_USE_PLUGIN_ID)
            .and_then(|policy| policy.enabled)
            != Some(false)
}
/// Uninstalled or non-bundled imitations cannot authorize native desktop tools.
pub fn computer_use_is_enabled(settings: &PluginsSettings) -> Result<bool> {
    if !computer_use_policy_allows(settings) {
        return Ok(false);
    }
    let store = PluginStore::open_default()?;
    computer_use_enabled_in_store(settings, &store)
}
pub fn computer_use_enabled_in_store(
    settings: &PluginsSettings,
    store: &PluginStore,
) -> Result<bool> {
    if !computer_use_policy_allows(settings) {
        return Ok(false);
    }
    let id = PluginId::new("kcoder-windows-computer-use", "kcoder-bundled")?;
    let Some(record) = store.read(&id)? else {
        return Ok(false);
    };
    Ok(
        matches!(record.source,InstalledPluginSource::Bundled{ref bundle,..} if bundle=="kcoder-windows-computer-use")
            && settings
                .installed
                .get(COMPUTER_USE_PLUGIN_ID)
                .and_then(|policy| policy.enabled)
                .unwrap_or(record.enabled_by_default),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_windows_mcp_requires_a_deliberate_builtin_choice() {
        let mut settings = PluginsSettings::default();
        for (command, args) in [
            (r"C:\Tools\windows-mcp.exe", vec![]),
            ("uvx", vec!["windows-mcp@0.8.6"]),
            ("uv", vec!["tool", "run", "windows-mcp"]),
            ("python.exe", vec!["-m", "windows_mcp"]),
        ] {
            let server = serde_json::from_value(
                serde_json::json!({"name":"anything", "command":command,"args":args}),
            )
            .unwrap();
            assert!(computer_use_requires_explicit_enable(&settings, &[server]));
        }
        let server = serde_json::from_value(serde_json::json!({"name":"windows-mcp", "command":"unrelated", "args":["--label","windows-mcp"]})).unwrap();
        assert!(!computer_use_requires_explicit_enable(&settings, &[server]));
        settings
            .installed
            .entry(COMPUTER_USE_PLUGIN_ID.into())
            .or_default()
            .enabled = Some(true);
        let server =
            serde_json::from_value(serde_json::json!({"name":"old", "command":"windows-mcp.exe"}))
                .unwrap();
        assert!(!computer_use_requires_explicit_enable(&settings, &[server]));
    }
    #[test]
    fn missing_or_explicitly_disabled_plugin_never_authorizes_control() {
        let temp = tempfile::tempdir().unwrap();
        let store = PluginStore::open(temp.path()).unwrap();
        let mut settings = PluginsSettings::default();
        assert!(!computer_use_enabled_in_store(&settings, &store).unwrap());
        settings
            .installed
            .entry(COMPUTER_USE_PLUGIN_ID.into())
            .or_default()
            .enabled = Some(false);
        assert!(!computer_use_policy_allows(&settings));
        settings.installed.clear();
        settings.runtime.enabled = false;
        assert!(!computer_use_policy_allows(&settings));
    }
}
