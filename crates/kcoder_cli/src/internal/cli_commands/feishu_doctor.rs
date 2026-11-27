//! `kcoder doctor` Feishu/Lark section: bundled lark-cli pin, the copy on
//! `PATH`, plugin copies of `lark-*` skills and Feishu MCP servers.
use crate::extension_binaries::{self, BinaryProbe};
use kcoder_config::Settings;
use kcoder_skills::{SkillCandidateInfo, SkillLayer};
use std::collections::BTreeMap;
use std::path::Path;

/// One configured MCP server that looks like a Feishu/Lark integration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeishuMcpServer {
    pub name: String,
    pub transport: String,
    pub enabled: bool,
    pub plugin_id: Option<String>,
}

pub fn is_feishu_mcp(config: &kcoder_mcp::McpServerConfig) -> bool {
    let haystack = format!(
        "{} {} {} {}",
        config.name,
        config.command,
        config.args.join(" "),
        config.url
    )
    .to_ascii_lowercase();
    ["lark", "feishu", "larksuite"]
        .iter()
        .any(|needle| haystack.contains(needle))
}

/// Pure formatting so the report is testable without probing a real host.
pub fn report_lines(
    pin: Option<&str>,
    probe: &BinaryProbe,
    skills: &[SkillCandidateInfo],
    mcp: &[FeishuMcpServer],
) -> Vec<String> {
    let mut lines = vec!["Feishu/Lark:".to_owned()];
    lines.push(format!(
        "  bundled lark-cli pin: {} (skills/lark-shared/UPSTREAM.md)",
        pin.unwrap_or("unknown")
    ));
    match probe.resolved() {
        None => lines.push(
            "  lark-cli on PATH: not found (KCoder Studio adds its bundled copy for local targets)"
                .to_owned(),
        ),
        Some(path) => {
            let version = probe
                .version
                .clone()
                .or_else(|| {
                    probe
                        .probe_error
                        .clone()
                        .map(|error| format!("unknown: {error}"))
                })
                .unwrap_or_else(|| "unknown".to_owned());
            lines.push(format!(
                "  lark-cli on PATH: {} (version {version}; {})",
                path.display(),
                if probe.bundled {
                    "bundled KCoder copy"
                } else {
                    "not the bundled copy"
                }
            ));
            if let (Some(pin), Some(version)) = (pin, probe.version.as_deref())
                && pin != version
            {
                lines.push(format!(
                    "  warning: lark-cli {version} differs from the bundled {pin}; bundled lark-* skills target {pin}"
                ));
            }
        }
    }
    if probe.copies.len() > 1 {
        lines.push(format!(
            "  warning: {} lark-cli executables on PATH; the first wins:",
            probe.copies.len()
        ));
        for copy in &probe.copies {
            lines.push(format!("    {}", copy.display()));
        }
    }
    let bundled = skills
        .iter()
        .filter(|skill| skill.name.starts_with("lark-") && skill.layer == SkillLayer::Bundled)
        .count();
    lines.push(format!("  bundled lark-* skills: {bundled}"));
    let mut plugins = BTreeMap::<&str, (usize, usize)>::new();
    for skill in skills
        .iter()
        .filter(|skill| skill.name.starts_with("lark-") && skill.layer == SkillLayer::Plugin)
    {
        let entry = plugins
            .entry(skill.plugin_id.as_deref().unwrap_or("unknown"))
            .or_default();
        entry.0 += 1;
        entry.1 += usize::from(skill.effective);
    }
    if plugins.is_empty() {
        lines.push("  plugin lark-* skills: none".to_owned());
    }
    for (plugin, (total, active)) in plugins {
        lines.push(format!(
            "  plugin {plugin}: {total} lark-* skills, {active} active, {} shadowed by higher layers",
            total - active
        ));
    }
    if mcp.is_empty() {
        lines.push("  Feishu MCP servers: none configured".to_owned());
    }
    for server in mcp {
        lines.push(format!(
            "  Feishu MCP {:?} [{}{}]: {} (authorized separately from lark-cli)",
            server.name,
            server.transport,
            server
                .plugin_id
                .as_deref()
                .map(|plugin| format!(", plugin {plugin}"))
                .unwrap_or_default(),
            if server.enabled {
                "enabled"
            } else {
                "disabled"
            }
        ));
    }
    lines.push(
        "  note: every lark-cli copy shares ~/.lark-cli configuration and the OS keychain; logging out in one affects all"
            .to_owned(),
    );
    lines
}

/// Gather and format the section. Probes run only because doctor is explicit.
pub fn gather(settings: &Settings, cwd: &Path, project_trusted: bool) -> Vec<String> {
    let pin = extension_binaries::bundled_lark_cli_version();
    let path = std::env::var_os("PATH");
    let probe = extension_binaries::probe(
        "lark-cli",
        path.as_deref(),
        extension_binaries::VERSION_PROBE_TIMEOUT,
    );
    let plugins = if settings.training_mode {
        Ok(kcoder_plugins::EffectivePluginSnapshot::default())
    } else {
        kcoder_plugins::PluginManager::open_default_for_cwd_with_effective_settings(
            cwd,
            settings.plugins.clone(),
        )
        .and_then(|manager| manager.effective_snapshot(cwd, project_trusted))
    };
    let mut lines = Vec::new();
    let plugins = plugins.unwrap_or_else(|error| {
        lines.push(format!("  warning: plugin snapshot unavailable: {error:#}"));
        kcoder_plugins::EffectivePluginSnapshot::default()
    });
    let mut roots = settings.skills.external_dirs.clone();
    roots.extend(plugins.skill_roots.iter().cloned());
    let skills = kcoder_skills::SkillRegistry::load_with_external_dirs_and_trust(
        cwd,
        roots.iter(),
        project_trusted,
    )
    .map(|mut registry| {
        crate::training_isolation::apply_skill_source_policy(settings, &plugins, &mut registry);
        registry.source_candidates()
    })
    .unwrap_or_default();
    let mcp = match plugins.configured_mcp_servers(settings) {
        Ok(servers) => servers
            .filter(|(config, _)| is_feishu_mcp(config))
            .map(|(config, source)| FeishuMcpServer {
                name: config.name.clone(),
                transport: config.transport.clone(),
                enabled: settings.mcp_server_enabled(&config.name),
                plugin_id: source.map(|source| source.plugin_id.clone()),
            })
            .collect::<Vec<_>>(),
        Err(error) => {
            lines.push(format!(
                "  warning: MCP configuration unavailable: {error:#}"
            ));
            Vec::new()
        }
    };
    let mut report = report_lines(pin.as_deref(), &probe, &skills, &mcp);
    report.splice(1..1, lines);
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn skill(
        name: &str,
        layer: SkillLayer,
        plugin: Option<&str>,
        effective: bool,
    ) -> SkillCandidateInfo {
        SkillCandidateInfo {
            name: name.into(),
            description: String::new(),
            path: PathBuf::from("/skills").join(name),
            layer,
            plugin_id: plugin.map(str::to_owned),
            marketplace_id: None,
            version: None,
            user_invocable: true,
            effective,
            preferred: false,
            removed: false,
            trusted: true,
        }
    }

    #[test]
    fn report_flags_version_drift_multiple_copies_shadowed_plugins_and_mcp() {
        let probe = BinaryProbe {
            name: "lark-cli".into(),
            copies: vec![
                PathBuf::from("/usr/local/bin/lark-cli"),
                PathBuf::from("/opt/bundle/lark-cli"),
            ],
            version: Some("1.0.8".into()),
            bundled: false,
            bundled_marker_version: None,
            probe_error: None,
        };
        let skills = [
            skill("lark-doc", SkillLayer::Bundled, None, true),
            skill("lark-doc", SkillLayer::Plugin, Some("lark@trae"), false),
            skill("lark-legacy", SkillLayer::Plugin, Some("lark@trae"), true),
        ];
        let mcp = [FeishuMcpServer {
            name: "lark-mcp".into(),
            transport: "stdio".into(),
            enabled: true,
            plugin_id: None,
        }];
        let text = report_lines(Some("1.0.100"), &probe, &skills, &mcp).join("\n");
        assert!(text.contains("bundled lark-cli pin: 1.0.100"), "{text}");
        assert!(text.contains("/usr/local/bin/lark-cli (version 1.0.8; not the bundled copy)"));
        assert!(text.contains("lark-cli 1.0.8 differs from the bundled 1.0.100"));
        assert!(text.contains("2 lark-cli executables on PATH"));
        assert!(text.contains("plugin lark@trae: 2 lark-* skills, 1 active, 1 shadowed"));
        assert!(text.contains("Feishu MCP \"lark-mcp\" [stdio]: enabled"));
        assert!(text.contains("~/.lark-cli"));
    }
}
