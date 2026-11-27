//! Skill copies: effective winner, shadowed copies, disabled plugin copies and conflicts.
use super::Sources;
use super::shared::{self, PluginManifests, display_path, item, skill_ref};
use kcoder_app_protocol::{
    ExtensionConflict, ExtensionConflictReason, ExtensionDisabledBy, ExtensionInventoryItem,
    ExtensionItemKind, ExtensionLayer, ExtensionUpstream,
};
use kcoder_skills::{SkillCandidateInfo, SkillLayer};
use std::collections::{BTreeMap, BTreeSet};

/// Bundled name prefixes shared by at least two bundled skills (for example `lark`).
pub(super) fn bundled_families() -> BTreeSet<String> {
    let mut counts = BTreeMap::<String, usize>::new();
    for name in kcoder_skills::sources::bundled_skill_names() {
        if let Some(family) = kcoder_skills::sources::skill_family(name) {
            *counts.entry(family.to_owned()).or_default() += 1;
        }
    }
    counts
        .into_iter()
        .filter(|(_, count)| *count >= 2)
        .map(|(family, _)| family)
        .collect()
}

pub(super) fn candidate_upstream(
    candidate: &SkillCandidateInfo,
    manifests: &PluginManifests,
) -> Option<ExtensionUpstream> {
    match candidate.layer {
        SkillLayer::Bundled => {
            kcoder_skills::sources::bundled_upstream(&candidate.name).map(|u| shared::upstream(&u))
        }
        SkillLayer::Builtin | SkillLayer::Runtime => None,
        SkillLayer::Plugin => kcoder_skills::sources::read_upstream_for(&candidate.path)
            .map(|u| shared::upstream(&u))
            .or_else(|| {
                candidate
                    .plugin_id
                    .as_deref()
                    .and_then(|id| manifests.get(id).cloned())
            }),
        _ => {
            kcoder_skills::sources::read_upstream_for(&candidate.path).map(|u| shared::upstream(&u))
        }
    }
}

pub(super) fn project(
    sources: &Sources,
    manifests: &PluginManifests,
    items: &mut Vec<ExtensionInventoryItem>,
    conflicts: &mut Vec<ExtensionConflict>,
) {
    let registry = &sources.skills;
    let families = bundled_families();
    let candidates = registry.source_candidates();
    let mut by_name = BTreeMap::<&str, Vec<&SkillCandidateInfo>>::new();
    for candidate in &candidates {
        by_name.entry(&candidate.name).or_default().push(candidate);
    }
    let upstreams: Vec<Option<ExtensionUpstream>> = candidates
        .iter()
        .map(|candidate| candidate_upstream(candidate, manifests))
        .collect();
    let upstream_of = |candidate: &SkillCandidateInfo| {
        candidates
            .iter()
            .position(|other| std::ptr::eq(other, candidate))
            .and_then(|index| upstreams[index].as_ref())
    };
    let mut origins = kcoder_tools::evolution_service::SkillOriginResolver::default();
    for (index, candidate) in candidates.iter().enumerate() {
        let copies = &by_name[candidate.name.as_str()];
        let mut entry = item(
            ExtensionItemKind::Skill,
            &candidate.name,
            shared::layer(candidate.layer),
        );
        entry.owner_plugin_id = candidate.plugin_id.clone();
        entry.marketplace_id = candidate.marketplace_id.clone();
        entry.path = Some(display_path(&candidate.path));
        entry.description = Some(candidate.description.clone()).filter(|d| !d.is_empty());
        let name_enabled = registry.is_enabled(&candidate.name);
        entry.disabled_by = if candidate.removed {
            Some(ExtensionDisabledBy::Policy)
        } else if !candidate.trusted {
            Some(ExtensionDisabledBy::Trust)
        } else if !name_enabled {
            Some(ExtensionDisabledBy::Name)
        } else {
            None
        };
        entry.enabled = entry.disabled_by.is_none();
        entry.effective = candidate.effective && entry.enabled;
        let winner = copies.iter().find(|copy| copy.effective);
        if !candidate.effective {
            entry.shadowed_by = winner.map(|winner| skill_ref(winner));
        } else {
            entry.shadows = copies
                .iter()
                .filter(|copy| !std::ptr::eq(**copy, candidate))
                .map(|copy| skill_ref(copy))
                .collect();
        }
        entry.upstream = upstreams[index].clone();
        entry.version = candidate
            .version
            .clone()
            .or_else(|| entry.upstream.as_ref().and_then(|u| u.version.clone()));
        entry.preferred = candidate.preferred;
        entry.family = kcoder_skills::sources::skill_family(&candidate.name)
            .filter(|family| families.contains(*family))
            .map(str::to_owned);
        entry.detail = (!candidate.user_invocable).then(|| "conditional".to_owned());
        // Same provenance-based key as `evolution/targets/list`.
        entry.target_key = origins.target_key(candidate);
        items.push(entry);
    }
    for (name, copies) in &by_name {
        if copies.len() < 2 || copies.iter().all(|copy| copy.removed) {
            continue;
        }
        let effective = copies.iter().find(|copy| copy.effective);
        conflicts.push(ExtensionConflict {
            kind: ExtensionItemKind::Skill,
            reason: ExtensionConflictReason::SameName,
            name: (*name).to_owned(),
            effective: effective.map(|copy| skill_ref(copy)),
            shadowed: copies
                .iter()
                .filter(|copy| !copy.effective)
                .map(|copy| skill_ref(copy))
                .collect(),
            same_upstream: shared::same_upstream(copies.iter().map(|copy| upstream_of(copy))),
            plugin_id: None,
            provided: Vec::new(),
            missing: Vec::new(),
            effective_from_plugin: Vec::new(),
        });
    }
    for overlap in registry.family_overlaps() {
        conflicts.push(ExtensionConflict {
            kind: ExtensionItemKind::Skill,
            reason: ExtensionConflictReason::MixedFamily,
            name: overlap.family,
            effective: None,
            shadowed: Vec::new(),
            same_upstream: false,
            plugin_id: Some(overlap.plugin_id),
            provided: overlap.provided,
            missing: overlap.missing,
            effective_from_plugin: overlap.effective_from_plugin,
        });
    }
    disabled_plugin_skills(sources, &families, items);
}

/// A plugin-owned skill copy that contributes no registry candidate.
fn disabled_plugin_copy(
    plugin: &kcoder_plugins::PluginListItem,
    name: &str,
    path: &std::path::Path,
    description: Option<String>,
    families: &BTreeSet<String>,
) -> ExtensionInventoryItem {
    let mut entry = item(ExtensionItemKind::Skill, name, ExtensionLayer::Plugin);
    entry.owner_plugin_id = Some(plugin.id.clone());
    entry.marketplace_id = shared::marketplace_of(&plugin.id);
    entry.path = Some(display_path(path));
    entry.description = description.filter(|d| !d.is_empty());
    entry.enabled = false;
    entry.effective = false;
    entry.disabled_by = Some(ExtensionDisabledBy::Plugin);
    entry.family = kcoder_skills::sources::skill_family(name)
        .filter(|family| families.contains(*family))
        .map(str::to_owned);
    entry
}

/// Plugins that are disabled, or whose skill component is switched off, contribute no
/// registry candidates. Their skill entries, including command/Agent profiles adapted
/// into namespaced prompt skills, are listed as disabled copies.
fn disabled_plugin_skills(
    sources: &Sources,
    families: &BTreeSet<String>,
    items: &mut Vec<ExtensionInventoryItem>,
) {
    for plugin in &sources.plugins {
        let policy_off = sources
            .settings
            .plugins
            .installed
            .get(&plugin.id)
            .and_then(|policy| policy.skills.enabled)
            == Some(false);
        if plugin.enabled && !policy_off {
            continue;
        }
        for root in &plugin.skill_roots {
            let Ok(entries) = kcoder_skills::skill_entry_paths(root) else {
                continue;
            };
            for path in entries {
                let Ok(skill) = kcoder_skills::parse_skill_file_lazy(&path) else {
                    continue;
                };
                let mut entry = disabled_plugin_copy(
                    plugin,
                    &skill.name,
                    &path,
                    Some(skill.description.clone()),
                    families,
                );
                entry.version = skill.version.clone();
                items.push(entry);
            }
        }
        // Prompt skills are materialized only while the skill component is on;
        // list the original command/Agent file, described as plugin details do.
        for prompt in &plugin.prompt_skills {
            let description = (!prompt.description.is_empty())
                .then(|| format!("{} (plugin {})", prompt.description, prompt.kind));
            items.push(disabled_plugin_copy(
                plugin,
                &prompt.name,
                &prompt.source,
                description,
                families,
            ));
        }
    }
}
