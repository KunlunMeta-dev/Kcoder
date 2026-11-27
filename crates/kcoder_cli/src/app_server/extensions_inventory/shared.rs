//! Shared projection helpers: display paths, plugin manifest upstream and plugin items.
use super::Sources;
use kcoder_app_protocol::{
    ExtensionDisabledBy, ExtensionInventoryItem, ExtensionItemKind, ExtensionLayer,
    ExtensionSourceRef, ExtensionUpstream,
};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

const MANIFEST_CANDIDATES: &[&str] = &[
    ".kcoder-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".trae-plugin/plugin.json",
    ".qoder-plugin/plugin.json",
    ".codebuddy-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
    ".grok-plugin/plugin.json",
    "plugin.json",
    "kcoder-plugin.json",
    "package.json",
];
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

/// Show the target account's home directory as `~`, as Studio does for paths.
pub(super) fn display_path(path: &Path) -> String {
    if let Some(home) = dirs::home_dir()
        && let Ok(relative) = path.strip_prefix(&home)
    {
        return if relative.as_os_str().is_empty() {
            "~".to_owned()
        } else {
            format!("~{}{}", std::path::MAIN_SEPARATOR, relative.display())
        };
    }
    path.display().to_string()
}

pub(super) fn layer(layer: kcoder_skills::SkillLayer) -> ExtensionLayer {
    use kcoder_skills::SkillLayer as L;
    match layer {
        L::Builtin => ExtensionLayer::Builtin,
        L::Bundled => ExtensionLayer::Bundled,
        L::Plugin => ExtensionLayer::Plugin,
        L::Project => ExtensionLayer::Project,
        L::External => ExtensionLayer::External,
        L::User => ExtensionLayer::User,
        L::Runtime => ExtensionLayer::Runtime,
    }
}

pub(super) fn skill_ref(candidate: &kcoder_skills::SkillCandidateInfo) -> ExtensionSourceRef {
    ExtensionSourceRef {
        layer: layer(candidate.layer),
        owner_plugin_id: candidate.plugin_id.clone(),
        path: Some(display_path(&candidate.path)),
    }
}

pub(super) fn upstream(value: &kcoder_skills::SkillUpstream) -> ExtensionUpstream {
    ExtensionUpstream {
        repository: value.repository.clone(),
        git_ref: value.git_ref.clone(),
        version: value.version.clone(),
    }
}

pub(super) fn marketplace_of(plugin_id: &str) -> Option<String> {
    plugin_id
        .split_once('@')
        .map(|(_, marketplace)| marketplace.to_owned())
        .filter(|marketplace| !marketplace.is_empty())
}

/// Declared repository/homepage/version from each plugin's manifest file.
#[derive(Default)]
pub(super) struct PluginManifests {
    by_id: HashMap<String, ExtensionUpstream>,
}

fn repository_value(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Object(object) => object
            .get("url")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        _ => None,
    }
    .filter(|text| !text.trim().is_empty() && text.len() <= 512)
}

fn read_manifest_upstream(root: &Path) -> Option<ExtensionUpstream> {
    for candidate in MANIFEST_CANDIDATES {
        let path = root.join(candidate);
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_MANIFEST_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(document) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        let repository = document
            .get("repository")
            .and_then(repository_value)
            .or_else(|| document.get("homepage").and_then(repository_value))
            .or_else(|| {
                document
                    .pointer("/interface/websiteURL")
                    .and_then(repository_value)
            });
        let version = document
            .get("version")
            .and_then(serde_json::Value::as_str)
            .filter(|version| version.len() <= 64)
            .map(str::to_owned);
        if repository.is_some() || version.is_some() {
            return Some(ExtensionUpstream {
                repository,
                git_ref: None,
                version,
            });
        }
    }
    None
}

impl PluginManifests {
    pub fn read(plugins: &[kcoder_plugins::PluginListItem]) -> Self {
        Self {
            by_id: plugins
                .iter()
                .filter_map(|plugin| {
                    read_manifest_upstream(&plugin.root)
                        .map(|upstream| (plugin.id.clone(), upstream))
                })
                .collect(),
        }
    }

    pub fn get(&self, plugin_id: &str) -> Option<&ExtensionUpstream> {
        self.by_id.get(plugin_id)
    }
}

/// Both copies declare the same normalized repository.
pub(super) fn same_upstream<'a>(
    upstreams: impl IntoIterator<Item = Option<&'a ExtensionUpstream>>,
) -> bool {
    let mut repositories = Vec::new();
    for upstream in upstreams {
        let Some(repository) = upstream
            .and_then(|upstream| upstream.repository.as_deref())
            .and_then(kcoder_skills::sources::normalize_repository)
        else {
            return false;
        };
        repositories.push(repository);
    }
    repositories.len() >= 2 && repositories.windows(2).all(|pair| pair[0] == pair[1])
}

pub(super) fn item(
    kind: ExtensionItemKind,
    name: &str,
    layer: ExtensionLayer,
) -> ExtensionInventoryItem {
    ExtensionInventoryItem {
        id: String::new(),
        kind,
        name: name.to_owned(),
        layer,
        owner_plugin_id: None,
        marketplace_id: None,
        path: None,
        description: None,
        enabled: true,
        disabled_by: None,
        effective: true,
        shadowed_by: None,
        shadows: Vec::new(),
        upstream: None,
        version: None,
        preferred: false,
        family: None,
        detail: None,
        count: None,
        bundled: None,
        skills_enabled: None,
        skill_policy_revision: None,
        target_key: None,
    }
}

/// The per-plugin skill switch applies to installed (managed) plugins that
/// contribute skills or prompt-backed skills.
pub(super) fn has_switchable_skills(plugin: &kcoder_plugins::PluginListItem) -> bool {
    plugin.managed && (!plugin.skill_roots.is_empty() || !plugin.prompt_skills.is_empty())
}

pub(super) fn plugin_items(
    sources: &Sources,
    manifests: &PluginManifests,
    items: &mut Vec<ExtensionInventoryItem>,
) {
    for plugin in &sources.plugins {
        let mut entry = item(
            ExtensionItemKind::Plugin,
            &plugin.name,
            ExtensionLayer::Plugin,
        );
        entry.owner_plugin_id = Some(plugin.id.clone());
        entry.marketplace_id = marketplace_of(&plugin.id).or_else(|| match &plugin.source {
            Some(kcoder_plugins::InstalledPluginSource::Marketplace { marketplace, .. }) => {
                Some(marketplace.clone())
            }
            _ => None,
        });
        entry.path = Some(display_path(&plugin.root));
        entry.description = plugin.description.clone();
        entry.enabled = plugin.enabled;
        entry.effective = plugin.enabled;
        entry.disabled_by = (!plugin.enabled).then_some(ExtensionDisabledBy::Plugin);
        entry.upstream = manifests.get(&plugin.id).cloned();
        entry.version = plugin.version.clone();
        entry.detail = Some(
            if plugin.managed {
                "managed"
            } else {
                "discovered"
            }
            .to_owned(),
        );
        if let Some(revision) = sources.skill_policy_revisions.get(&plugin.id) {
            entry.skills_enabled = Some(
                sources
                    .settings
                    .plugins
                    .installed
                    .get(&plugin.id)
                    .and_then(|policy| policy.skills.enabled)
                    != Some(false),
            );
            entry.skill_policy_revision = Some(revision.clone());
        }
        entry.count = u32::try_from(
            plugin.skill_roots.len()
                + plugin.prompt_skills.len()
                + plugin.mcp_server_names.len()
                + plugin.hook_event_names.len(),
        )
        .ok();
        items.push(entry);
    }
}

/// Item IDs are `<kind>:<layer>:<owner>:<name>`, suffixed when repeated.
pub(super) fn assign_unique_ids(items: &mut [ExtensionInventoryItem]) {
    let mut seen = BTreeMap::<String, usize>::new();
    for item in items {
        let kind = serde_json::to_value(item.kind).ok();
        let layer = serde_json::to_value(item.layer).ok();
        let base = format!(
            "{}:{}:{}:{}",
            kind.as_ref().and_then(|v| v.as_str()).unwrap_or("item"),
            layer.as_ref().and_then(|v| v.as_str()).unwrap_or("layer"),
            item.owner_plugin_id.as_deref().unwrap_or(""),
            item.name
        );
        let count = seen.entry(base.clone()).or_default();
        *count += 1;
        item.id = if *count == 1 {
            base
        } else {
            format!("{base}#{count}")
        };
    }
}
