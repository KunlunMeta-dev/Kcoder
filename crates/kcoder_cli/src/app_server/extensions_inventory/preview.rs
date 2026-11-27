//! Conflict preview for a plugin before or after installation.
use super::Sources;
use super::shared::{self, PluginManifests, skill_ref};
use anyhow::{Result, bail};
use kcoder_app_protocol::{
    ExtensionConflict, ExtensionConflictOutcome, ExtensionConflictPreviewEntry,
    ExtensionConflictReason, ExtensionConflictsPreviewParams, ExtensionConflictsPreviewResult,
    ExtensionItemKind, ExtensionLayer, ExtensionSourceRef,
};
use std::collections::BTreeSet;

const MAX_NAMES: usize = 1024;

pub(super) fn validate(params: &ExtensionConflictsPreviewParams) -> Result<()> {
    let names = params.skill_names.iter().chain(&params.mcp_server_names);
    if params.skill_names.len() + params.mcp_server_names.len() > MAX_NAMES
        || params.plugin_id.as_ref().is_some_and(|id| id.len() > 256)
    {
        bail!("Too many names in a conflict preview");
    }
    for name in names {
        if name.trim().is_empty() || name.len() > 512 || name.chars().any(char::is_control) {
            bail!("Preview names must be nonempty text without control characters");
        }
    }
    if params.plugin_id.is_none()
        && params.skill_names.is_empty()
        && params.mcp_server_names.is_empty()
    {
        bail!("Name a pluginId or at least one skill or MCP server name");
    }
    Ok(())
}

/// Skill and MCP names the plugin contributes according to the current discovery.
fn plugin_names(sources: &Sources, plugin_id: &str) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut skills: BTreeSet<String> = sources
        .skills
        .source_candidates()
        .into_iter()
        .filter(|candidate| candidate.plugin_id.as_deref() == Some(plugin_id))
        .map(|candidate| candidate.name)
        .collect();
    let mut mcp = BTreeSet::new();
    if let Some(plugin) = sources.plugins.iter().find(|plugin| plugin.id == plugin_id) {
        for root in &plugin.skill_roots {
            for path in kcoder_skills::skill_entry_paths(root).unwrap_or_default() {
                if let Ok(skill) = kcoder_skills::parse_skill_file_lazy(&path) {
                    skills.insert(skill.name);
                }
            }
        }
        // Prompt skills exist in the registry only while the skill component is on.
        skills.extend(
            plugin
                .prompt_skills
                .iter()
                .map(|prompt| prompt.name.clone()),
        );
        mcp.extend(plugin.mcp_server_names.iter().cloned());
    }
    (skills, mcp)
}

fn bare_server_name<'a>(name: &'a str, plugin_id: Option<&str>) -> &'a str {
    if let Some(id) = plugin_id
        && let Some(rest) = name.strip_prefix(&format!("plugin.{id}."))
    {
        return rest;
    }
    name.strip_prefix("plugin.")
        .and_then(|rest| rest.rsplit_once('.'))
        .map(|(_, server)| server)
        .unwrap_or(name)
}

pub(super) fn preview(
    sources: &Sources,
    params: &ExtensionConflictsPreviewParams,
) -> Result<ExtensionConflictsPreviewResult> {
    let plugin_id = params.plugin_id.clone().unwrap_or_default();
    let (mut skill_names, mut mcp_names) = if params.plugin_id.is_some() {
        plugin_names(sources, &plugin_id)
    } else {
        Default::default()
    };
    skill_names.extend(params.skill_names.iter().cloned());
    mcp_names.extend(params.mcp_server_names.iter().cloned());
    let manifests = PluginManifests::read(&sources.plugins);
    let candidates = sources.skills.source_candidates();
    let plugin_upstream = manifests.get(&plugin_id).cloned();
    let mut entries = Vec::new();
    for name in &skill_names {
        let simulated = sources.skills.preview_plugin_copy(name, &plugin_id);
        let existing = simulated.existing.as_ref();
        let outcome = match (existing, simulated.plugin_wins) {
            (None, _) => ExtensionConflictOutcome::None,
            (Some(_), true) => ExtensionConflictOutcome::ShadowsExisting,
            (Some(_), false) => ExtensionConflictOutcome::ShadowedByExisting,
        };
        let own_upstream = candidates
            .iter()
            .find(|candidate| {
                candidate.name == *name && candidate.plugin_id.as_deref() == Some(&plugin_id)
            })
            .and_then(|candidate| super::skills::candidate_upstream(candidate, &manifests))
            .or_else(|| plugin_upstream.clone());
        let same_upstream = existing.is_some_and(|existing| {
            shared::same_upstream([
                super::skills::candidate_upstream(existing, &manifests).as_ref(),
                own_upstream.as_ref(),
            ])
        });
        entries.push(ExtensionConflictPreviewEntry {
            kind: ExtensionItemKind::Skill,
            name: name.clone(),
            outcome,
            existing: existing.map(skill_ref),
            same_upstream,
        });
    }
    let owner = params.plugin_id.as_deref();
    for name in &mcp_names {
        let bare = bare_server_name(name, owner);
        let existing = sources.mcp.iter().find(|server| {
            server.plugin_id.as_deref() != owner
                && bare_server_name(&server.config.name, server.plugin_id.as_deref()) == bare
        });
        entries.push(ExtensionConflictPreviewEntry {
            kind: ExtensionItemKind::McpServer,
            name: name.clone(),
            outcome: if existing.is_some() {
                ExtensionConflictOutcome::Coexists
            } else {
                ExtensionConflictOutcome::None
            },
            existing: existing.map(|server| ExtensionSourceRef {
                layer: if server.plugin_id.is_some() {
                    ExtensionLayer::Plugin
                } else {
                    ExtensionLayer::User
                },
                owner_plugin_id: server.plugin_id.clone(),
                path: None,
            }),
            same_upstream: false,
        });
    }
    let mut conflicts = Vec::new();
    for family in super::skills::bundled_families() {
        let members: BTreeSet<&str> = kcoder_skills::sources::bundled_skill_names()
            .into_iter()
            .filter(|name| kcoder_skills::sources::skill_family(name) == Some(family.as_str()))
            .collect();
        let provided: Vec<String> = skill_names
            .iter()
            .filter(|name| members.contains(name.as_str()))
            .cloned()
            .collect();
        if provided.is_empty() || provided.len() == members.len() {
            continue;
        }
        conflicts.push(ExtensionConflict {
            kind: ExtensionItemKind::Skill,
            reason: ExtensionConflictReason::MixedFamily,
            name: family.clone(),
            effective: None,
            shadowed: Vec::new(),
            same_upstream: false,
            plugin_id: params.plugin_id.clone(),
            missing: members
                .iter()
                .filter(|name| !provided.iter().any(|provided| provided == *name))
                .map(|name| (*name).to_owned())
                .collect(),
            provided,
            effective_from_plugin: entries
                .iter()
                .filter(|entry| {
                    entry.kind == ExtensionItemKind::Skill
                        && entry.outcome != ExtensionConflictOutcome::ShadowedByExisting
                        && kcoder_skills::sources::skill_family(&entry.name)
                            == Some(family.as_str())
                })
                .map(|entry| entry.name.clone())
                .collect(),
        });
    }
    Ok(ExtensionConflictsPreviewResult { entries, conflicts })
}

/// `extensionConflicts` attached to `plugin/install` and `plugin/read` results.
pub(crate) fn conflicts_for_plugin(
    factory: &super::super::engine_factory::AppServerEngineFactory,
    plugin_id: &str,
) -> Result<ExtensionConflictsPreviewResult> {
    let sources = Sources::load(factory)?;
    preview(
        &sources,
        &ExtensionConflictsPreviewParams {
            plugin_id: Some(plugin_id.to_owned()),
            ..Default::default()
        },
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn plugin_server_names_compare_without_their_namespace() {
        assert_eq!(
            super::bare_server_name("plugin.lark@trae.lark", Some("lark@trae")),
            "lark"
        );
        assert_eq!(super::bare_server_name("plugin.x.lark", None), "lark");
        assert_eq!(super::bare_server_name("lark", None), "lark");
    }
}
