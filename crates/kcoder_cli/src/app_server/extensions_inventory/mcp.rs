//! MCP servers: configured, plugin-contributed, plugin-disabled and
//! policy-disabled ones. Nothing here connects to or starts a server.
use super::Sources;
use super::shared::{display_path, item, marketplace_of};
use kcoder_app_protocol::{
    ExtensionDisabledBy, ExtensionInventoryItem, ExtensionItemKind, ExtensionLayer,
};
use std::collections::BTreeSet;

pub(super) fn project(sources: &Sources, items: &mut Vec<ExtensionInventoryItem>) {
    let project_names = kcoder_cli_commands::entry_modes::project_mcp_server_names(&sources.cwd);
    let mut listed = BTreeSet::new();
    for server in &sources.mcp {
        let name = &server.config.name;
        let layer = if server.plugin_id.is_some() {
            ExtensionLayer::Plugin
        } else if project_names.contains(name) {
            ExtensionLayer::Project
        } else {
            ExtensionLayer::User
        };
        let mut entry = item(ExtensionItemKind::McpServer, name, layer);
        entry.owner_plugin_id = server.plugin_id.clone();
        entry.marketplace_id = server.plugin_id.as_deref().and_then(marketplace_of);
        entry.detail = Some(server.config.transport.clone());
        entry.enabled = sources.settings.mcp_server_enabled(name);
        entry.disabled_by = (!entry.enabled).then_some(ExtensionDisabledBy::Name);
        entry.effective = entry.enabled;
        listed.insert(name.clone());
        items.push(entry);
    }
    // Untrusted project MCP declarations are not loaded; show why.
    if !sources.folder_trusted {
        let unlisted: Vec<&String> = project_names
            .iter()
            .filter(|name| !listed.contains(*name))
            .collect();
        for name in unlisted {
            let mut entry = item(ExtensionItemKind::McpServer, name, ExtensionLayer::Project);
            entry.path = Some(display_path(&sources.cwd.join(".kcoder")));
            entry.enabled = false;
            entry.effective = false;
            entry.disabled_by = Some(ExtensionDisabledBy::Trust);
            listed.insert(name.clone());
            items.push(entry);
        }
    }
    for plugin in &sources.plugins {
        let prefix = format!("plugin.{}.", plugin.id);
        if !plugin.enabled {
            let unlisted: Vec<&String> = plugin
                .mcp_server_names
                .iter()
                .filter(|name| !listed.contains(*name))
                .collect();
            for name in unlisted {
                items.push(plugin_server(plugin, name, ExtensionDisabledBy::Plugin));
                listed.insert(name.clone());
            }
        }
        // Per-server plugin policy drops a server during discovery; keep it visible.
        let Some(policy) = sources.settings.plugins.installed.get(&plugin.id) else {
            continue;
        };
        for (server, server_policy) in &policy.mcp_servers {
            let name = format!("{prefix}{server}");
            if server_policy.enabled == Some(false) && !listed.contains(&name) {
                items.push(plugin_server(plugin, &name, ExtensionDisabledBy::Policy));
                listed.insert(name);
            }
        }
    }
}

fn plugin_server(
    plugin: &kcoder_plugins::PluginListItem,
    name: &str,
    disabled_by: ExtensionDisabledBy,
) -> ExtensionInventoryItem {
    let mut entry = item(ExtensionItemKind::McpServer, name, ExtensionLayer::Plugin);
    entry.owner_plugin_id = Some(plugin.id.clone());
    entry.marketplace_id = marketplace_of(&plugin.id);
    entry.path = Some(display_path(&plugin.root));
    entry.enabled = false;
    entry.effective = false;
    entry.disabled_by = Some(disabled_by);
    entry
}
