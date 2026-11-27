//! Same-name skill provenance, effective-winner precedence and upstream identity.
//!
//! Every discovered copy of a skill name is kept as a candidate. Exactly one
//! candidate per name is effective; the others stay available for inventory
//! but never reach invocation, catalogs or automatic activation.
//!
//! Precedence, lowest to highest:
//! 1. plugin skills (default)
//! 2. built-in and bundled skills (`<profile>/skills/.builtin`)
//! 3. plugin skills the user explicitly preferred
//!    (`skills.source_preference`)
//! 4. project skills (`.kcoder/skills`, outer directories before inner ones)
//! 5. `skills.external_dirs` (later directories win)
//! 6. user skills (`<profile>/skills`)
//!
//! Runtime expert skills (`expert:` namespace) are inserted separately and
//! cannot collide with discovered names.
use crate::Skill;
use kcoder_config::SkillSourcePreferenceSettings;
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Where a skill candidate was discovered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SkillLayer {
    /// Shipped KCoder management skill compiled into the binary.
    Builtin,
    /// Third-party skill bundled with KCoder (for example `docx`, `lark-*`).
    Bundled,
    Plugin,
    Project,
    External,
    User,
    Runtime,
}

impl SkillLayer {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Builtin => "builtin",
            Self::Bundled => "bundled",
            Self::Plugin => "plugin",
            Self::Project => "project",
            Self::External => "external",
            Self::User => "user",
            Self::Runtime => "runtime",
        }
    }
}

/// A plugin-contributed skill root with the owning plugin identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginSkillRoot {
    pub root: PathBuf,
    pub plugin_id: String,
    pub marketplace_id: Option<String>,
}

impl PluginSkillRoot {
    /// Managed plugin IDs have the form `<plugin>@<marketplace>`.
    pub fn new(root: PathBuf, plugin_id: impl Into<String>) -> Self {
        let plugin_id = plugin_id.into();
        let marketplace_id = plugin_id
            .split_once('@')
            .map(|(_, marketplace)| marketplace.to_owned())
            .filter(|marketplace| !marketplace.is_empty());
        Self {
            root,
            plugin_id,
            marketplace_id,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct SkillCandidate {
    pub(crate) skill: Arc<Skill>,
    pub(crate) layer: SkillLayer,
    pub(crate) plugin_id: Option<String>,
    pub(crate) marketplace_id: Option<String>,
    /// Discovery order; later scans win inside non-plugin layers.
    pub(crate) order: usize,
}

type Rank = (u8, bool, Reverse<String>, i64);

impl SkillCandidate {
    pub(crate) fn preferred(&self, preference: &SkillSourcePreferenceSettings) -> bool {
        self.layer == SkillLayer::Plugin
            && self
                .plugin_id
                .as_deref()
                .is_some_and(|id| preference.prefers(&self.skill.name, id))
    }

    fn rank(&self, preference: &SkillSourcePreferenceSettings) -> Rank {
        let order = self.order as i64;
        match self.layer {
            SkillLayer::Plugin => {
                let id = self.plugin_id.clone().unwrap_or_default();
                let pinned = preference.pins(&self.skill.name, &id);
                let tier = if self.preferred(preference) { 2 } else { 0 };
                // Between plugins the lexicographically smallest plugin ID wins,
                // independent of directory scan order; a per-name pin wins first.
                (tier, pinned, Reverse(id), -order)
            }
            SkillLayer::Builtin | SkillLayer::Bundled => (1, false, Reverse(String::new()), order),
            SkillLayer::Project => (3, false, Reverse(String::new()), order),
            SkillLayer::External => (4, false, Reverse(String::new()), order),
            SkillLayer::User => (5, false, Reverse(String::new()), order),
            SkillLayer::Runtime => (6, false, Reverse(String::new()), order),
        }
    }
}

/// Index of the effective candidate for every name not removed by policy.
pub(crate) fn effective_winners(
    candidates: &[SkillCandidate],
    preference: &SkillSourcePreferenceSettings,
    removed: &BTreeSet<String>,
) -> BTreeMap<String, usize> {
    let mut winners = BTreeMap::<String, usize>::new();
    for (index, candidate) in candidates.iter().enumerate() {
        if removed.contains(&candidate.skill.name) {
            continue;
        }
        match winners.get(&candidate.skill.name) {
            Some(current)
                if candidates[*current].rank(preference) >= candidate.rank(preference) => {}
            _ => {
                winners.insert(candidate.skill.name.clone(), index);
            }
        }
    }
    winners
}

/// Re-tag external candidates that live under a plugin skill root.
pub(crate) fn tag_plugin_candidates(candidates: &mut [SkillCandidate], roots: &[PluginSkillRoot]) {
    for candidate in candidates
        .iter_mut()
        .filter(|candidate| matches!(candidate.layer, SkillLayer::External | SkillLayer::Plugin))
    {
        let owner = roots
            .iter()
            .filter(|root| candidate.skill.source.starts_with(&root.root))
            .max_by_key(|root| root.root.components().count());
        match owner {
            Some(owner) => {
                candidate.layer = SkillLayer::Plugin;
                candidate.plugin_id = Some(owner.plugin_id.clone());
                candidate.marketplace_id = owner.marketplace_id.clone();
            }
            None => {
                candidate.layer = SkillLayer::External;
                candidate.plugin_id = None;
                candidate.marketplace_id = None;
            }
        }
    }
}

/// Read-only description of one discovered skill copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillCandidateInfo {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub layer: SkillLayer,
    pub plugin_id: Option<String>,
    pub marketplace_id: Option<String>,
    pub version: Option<String>,
    pub user_invocable: bool,
    /// This copy is the one invocation, catalogs and activation use.
    pub effective: bool,
    /// The copy is a plugin copy selected by `skills.source_preference`.
    pub preferred: bool,
    /// Policy (for example training isolation) removed every copy of the name.
    pub removed: bool,
    /// Live folder trust admits this copy's source directory.
    pub trusted: bool,
}

/// A plugin that provides only part of a bundled skill family, or whose
/// copies are effective for only part of what it provides.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillFamilyOverlap {
    /// Shared name prefix, for example `lark`.
    pub family: String,
    pub plugin_id: String,
    /// Bundled family names the plugin also provides.
    pub provided: Vec<String>,
    /// Bundled family names the plugin does not provide.
    pub missing: Vec<String>,
    /// Family names the plugin provides that are not bundled.
    pub extra: Vec<String>,
    /// Provided names whose effective copy is the plugin's.
    pub effective_from_plugin: Vec<String>,
}

/// Outcome of adding one plugin's copy of a name to the current candidates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginCopyPreview {
    /// The copy effective without this plugin's copies, if any.
    pub existing: Option<SkillCandidateInfo>,
    /// The plugin's copy would become the effective copy.
    pub plugin_wins: bool,
}

pub(crate) fn placeholder_skill(name: &str, source: PathBuf) -> Skill {
    Skill {
        activation: None,
        name: name.to_owned(),
        description: String::new(),
        content: String::new(),
        references: Vec::new(),
        source,
        when_to_use: None,
        allowed_tools: Vec::new(),
        arguments: Vec::new(),
        paths: None,
        user_invocable: true,
        version: None,
        author: None,
        license: None,
        platforms: Vec::new(),
        requires_tools: Vec::new(),
        fallback_for_tools: Vec::new(),
        requires_toolsets: Vec::new(),
        fallback_for_toolsets: Vec::new(),
        required_env_vars: Vec::new(),
        category: None,
        tags: Vec::new(),
    }
}

/// Family prefix of a skill name: the part before the first `-`.
pub fn skill_family(name: &str) -> Option<&str> {
    name.split_once('-')
        .map(|(family, _)| family)
        .filter(|family| !family.is_empty())
}

pub(crate) fn family_overlaps(
    candidates: &[SkillCandidate],
    winners: &BTreeMap<String, usize>,
) -> Vec<SkillFamilyOverlap> {
    let mut bundled = BTreeMap::<String, BTreeSet<String>>::new();
    for candidate in candidates
        .iter()
        .filter(|candidate| candidate.layer == SkillLayer::Bundled)
    {
        if let Some(family) = skill_family(&candidate.skill.name) {
            bundled
                .entry(family.to_owned())
                .or_default()
                .insert(candidate.skill.name.clone());
        }
    }
    // A single bundled name with a common prefix is not a family.
    bundled.retain(|_, members| members.len() >= 2);
    let mut by_plugin = BTreeMap::<(String, String), BTreeSet<String>>::new();
    for candidate in candidates
        .iter()
        .filter(|candidate| candidate.layer == SkillLayer::Plugin)
    {
        let (Some(family), Some(plugin)) = (
            skill_family(&candidate.skill.name),
            candidate.plugin_id.as_ref(),
        ) else {
            continue;
        };
        if bundled.contains_key(family) {
            by_plugin
                .entry((family.to_owned(), plugin.clone()))
                .or_default()
                .insert(candidate.skill.name.clone());
        }
    }
    let mut overlaps = Vec::new();
    for ((family, plugin_id), names) in by_plugin {
        let members = &bundled[&family];
        let provided: Vec<String> = names.intersection(members).cloned().collect();
        if provided.is_empty() {
            continue;
        }
        let missing: Vec<String> = members.difference(&names).cloned().collect();
        let extra: Vec<String> = names.difference(members).cloned().collect();
        let effective_from_plugin: Vec<String> = provided
            .iter()
            .filter(|name| {
                winners.get(*name).is_some_and(|index| {
                    let winner = &candidates[*index];
                    winner.layer == SkillLayer::Plugin
                        && winner.plugin_id.as_deref() == Some(plugin_id.as_str())
                })
            })
            .cloned()
            .collect();
        let partial = !missing.is_empty() || !extra.is_empty();
        let mixed =
            !effective_from_plugin.is_empty() && effective_from_plugin.len() != provided.len();
        if partial || mixed {
            overlaps.push(SkillFamilyOverlap {
                family,
                plugin_id,
                provided,
                missing,
                extra,
                effective_from_plugin,
            });
        }
    }
    overlaps
}

/// Upstream identity recorded in a skill's `UPSTREAM.md`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SkillUpstream {
    pub repository: Option<String>,
    /// Upstream tag when recorded, otherwise the commit.
    pub git_ref: Option<String>,
    pub commit: Option<String>,
    /// Version derived from a `vX.Y.Z` tag.
    pub version: Option<String>,
}

impl SkillUpstream {
    pub fn is_empty(&self) -> bool {
        self.repository.is_none() && self.git_ref.is_none() && self.version.is_none()
    }
}

fn backtick_value(text: &str) -> Option<String> {
    let start = text.find('`')? + 1;
    let end = start + text[start..].find('`')?;
    let value = text[start..end].trim();
    (!value.is_empty() && value.len() <= 256).then(|| value.to_owned())
}

/// Parse the fixed `- Project:` / `- Upstream tag:` / `- Upstream commit:` lines.
pub fn parse_upstream_markdown(text: &str) -> SkillUpstream {
    let mut upstream = SkillUpstream::default();
    for line in text.lines().take(64) {
        let line = line.trim().trim_start_matches(['-', '*']).trim();
        if let Some(value) = line.strip_prefix("Project:") {
            let value = value.trim().trim_matches(['<', '>']);
            if value.starts_with("https://") && value.len() <= 512 && !value.contains(' ') {
                upstream.repository = Some(value.trim_end_matches('/').to_owned());
            }
        } else if let Some(value) = line.strip_prefix("Upstream tag:") {
            upstream.git_ref = backtick_value(value).or(upstream.git_ref);
        } else if let Some(value) = line.strip_prefix("Upstream commit:") {
            upstream.commit = backtick_value(value);
        }
    }
    if upstream.git_ref.is_none() {
        upstream.git_ref = upstream.commit.clone();
    }
    upstream.version = upstream
        .git_ref
        .as_deref()
        .and_then(|tag| tag.strip_prefix('v'))
        .filter(|version| version.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(str::to_owned);
    upstream
}

/// Upstream identity of a bundled skill from the copy compiled into the binary.
pub fn bundled_upstream(name: &str) -> Option<SkillUpstream> {
    crate::bundled_assets::file(name, "UPSTREAM.md")
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .map(parse_upstream_markdown)
        .filter(|upstream| !upstream.is_empty())
}

/// Names of third-party skills bundled into this binary.
pub fn bundled_skill_names() -> BTreeSet<&'static str> {
    crate::bundled_assets::names()
}

/// Read a sibling `UPSTREAM.md` of a skill entry. Only explicit inventory
/// requests call this; it reads one small regular file and never hashes.
pub fn read_upstream_for(skill_entry: &Path) -> Option<SkillUpstream> {
    use std::io::Read;
    const MAX_BYTES: u64 = 64 * 1024;
    let path = skill_entry.parent()?.join("UPSTREAM.md");
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_BYTES {
        return None;
    }
    let mut text = String::new();
    std::fs::File::open(&path)
        .ok()?
        .take(MAX_BYTES)
        .read_to_string(&mut text)
        .ok()?;
    Some(parse_upstream_markdown(&text)).filter(|upstream| !upstream.is_empty())
}

/// Normalize a repository reference for "same upstream" comparison.
pub fn normalize_repository(value: &str) -> Option<String> {
    let value = value.trim();
    let value = value.strip_prefix("git+").unwrap_or(value);
    let value = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
        .or_else(|| value.strip_prefix("ssh://git@"))
        .or_else(|| value.strip_prefix("git@"))
        .or_else(|| value.strip_prefix("github:"))
        .unwrap_or(value);
    let value = value.replacen("github.com:", "github.com/", 1);
    let value = value
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_ascii_lowercase();
    let value = if value.contains('/') && !value.contains('.') {
        // `owner/repo` shorthand (npm `repository` and `github:` forms).
        format!("github.com/{value}")
    } else {
        value
    };
    (!value.is_empty() && value.len() <= 512).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_lines_and_repository_forms_normalize() {
        let upstream = parse_upstream_markdown(
            "# Upstream source\n\n- Project: https://github.com/larksuite/cli\n- Upstream tag: `v1.0.100`\n- Upstream commit: `ac22a60` (date)\n",
        );
        assert_eq!(
            upstream.repository.as_deref(),
            Some("https://github.com/larksuite/cli")
        );
        assert_eq!(upstream.git_ref.as_deref(), Some("v1.0.100"));
        assert_eq!(upstream.commit.as_deref(), Some("ac22a60"));
        assert_eq!(upstream.version.as_deref(), Some("1.0.100"));
        let commit_only = parse_upstream_markdown(
            "- Project: https://github.com/anthropics/skills\n- Upstream commit: `e4bb5d9`\n",
        );
        assert_eq!(commit_only.git_ref.as_deref(), Some("e4bb5d9"));
        assert!(commit_only.version.is_none());
        for form in [
            "https://github.com/larksuite/cli",
            "https://github.com/larksuite/cli.git",
            "git+https://github.com/LarkSuite/cli.git",
            "git@github.com:larksuite/cli.git",
            "github:larksuite/cli",
            "larksuite/cli",
        ] {
            assert_eq!(
                normalize_repository(form).as_deref(),
                Some("github.com/larksuite/cli"),
                "{form}"
            );
        }
    }

    #[test]
    fn bundled_lark_skills_record_the_pinned_cli_release() {
        let upstream = bundled_upstream("lark-shared").expect("lark-shared UPSTREAM.md");
        let pin = include_str!("../../../scripts/release/prepare-lark-cli.mjs");
        let marker = "export const LARK_CLI_VERSION = '";
        let start = pin.find(marker).expect("lark-cli version pin") + marker.len();
        let pinned = &pin[start..start + pin[start..].find('\'').unwrap()];
        assert_eq!(upstream.version.as_deref(), Some(pinned));
        assert_eq!(
            upstream.repository.as_deref(),
            Some("https://github.com/larksuite/cli")
        );
        assert!(bundled_skill_names().contains("lark-doc"));
        assert_eq!(skill_family("lark-doc"), Some("lark"));
        assert_eq!(skill_family("docx"), None);
    }
}
