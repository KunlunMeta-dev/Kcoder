//! Skill targets: provenance-based target keys, scope and base revision.

use super::EvolutionScopeKind;
use crate::skill_provenance::{SkillOrigin, SkillProvenanceStore, load_store};
use kcoder_config::EvolutionSettings;
use kcoder_skills::{Skill, SkillCandidateInfo, SkillLayer, SkillRegistry};
use kcoder_types::evolution::{EvolutionWriteMode, TargetKey, TargetType};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// One skill of the registry as an evolution target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillTarget {
    pub key: TargetKey,
    pub scope: EvolutionScopeKind,
    pub base_revision: String,
    pub layer: SkillLayer,
    /// How learned content of this skill takes effect.
    pub write_mode: EvolutionWriteMode,
}

/// The `.provenance.json` origin wire name used as the target key source.
pub fn skill_origin_source(origin: &SkillOrigin) -> &'static str {
    match origin {
        SkillOrigin::Bundled => "bundled",
        SkillOrigin::UserCreated => "user_created",
        SkillOrigin::AgentCreated => "agent_created",
        SkillOrigin::HubInstalled => "hub_installed",
        SkillOrigin::ExternalDir => "external_dir",
    }
}

/// Origin assumed for a copy without a provenance record.
fn layer_origin(layer: SkillLayer) -> SkillOrigin {
    match layer {
        SkillLayer::Builtin | SkillLayer::Bundled => SkillOrigin::Bundled,
        SkillLayer::Plugin => SkillOrigin::HubInstalled,
        SkillLayer::External => SkillOrigin::ExternalDir,
        SkillLayer::Runtime => SkillOrigin::AgentCreated,
        SkillLayer::Project | SkillLayer::User => SkillOrigin::UserCreated,
    }
}

/// The skills root that holds a copy's `.provenance.json`.
fn skills_root(path: &Path) -> Option<PathBuf> {
    let directory = if path.file_name().is_some_and(|name| name == "SKILL.md") {
        path.parent()?
    } else {
        path
    };
    directory.parent().map(Path::to_path_buf)
}

/// Resolves skill origins, reading each skills root's provenance once.
#[derive(Default)]
pub struct SkillOriginResolver {
    stores: HashMap<PathBuf, Option<SkillProvenanceStore>>,
}

impl SkillOriginResolver {
    pub fn origin(&mut self, candidate: &SkillCandidateInfo) -> SkillOrigin {
        let recorded = skills_root(&candidate.path).and_then(|root| {
            self.stores
                .entry(root.clone())
                .or_insert_with(|| load_store(&root).ok())
                .as_ref()
                .and_then(|store| store.skills.get(&candidate.name))
                .map(|record| record.origin.clone())
        });
        recorded.unwrap_or_else(|| layer_origin(candidate.layer))
    }

    /// `skill:<origin>:<name>`, or `None` when the name cannot form a key.
    pub fn target_key(&mut self, candidate: &SkillCandidateInfo) -> Option<TargetKey> {
        let origin = self.origin(candidate);
        TargetKey::new(
            TargetType::Skill,
            skill_origin_source(&origin),
            &candidate.name,
        )
        .ok()
    }
}

/// Base revision of a skill for overlays and usage records: the first 16
/// hex digits of SHA-256 over the loaded skill body. Uses the in-memory
/// content; it never rereads or hashes files.
pub fn skill_base_revision(skill: &Skill) -> String {
    let digest = Sha256::digest(skill.content.as_bytes());
    let hex: String = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("sha256:{hex}")
}

/// Every effective, available skill of the registry as a target.
pub(super) fn skill_targets(
    registry: &SkillRegistry,
    settings: &EvolutionSettings,
) -> Vec<SkillTarget> {
    let mut resolver = SkillOriginResolver::default();
    let mut targets: Vec<SkillTarget> = registry
        .source_candidates()
        .iter()
        .filter(|candidate| candidate.effective && !candidate.removed)
        .filter_map(|candidate| {
            let key = resolver.target_key(candidate)?;
            let write_mode =
                skill_target_write_mode(settings, &resolver.origin(candidate), candidate);
            Some(SkillTarget {
                key,
                scope: if candidate.layer == SkillLayer::Project {
                    EvolutionScopeKind::Project
                } else {
                    EvolutionScopeKind::User
                },
                base_revision: registry
                    .get(&candidate.name)
                    .map(skill_base_revision)
                    .unwrap_or_default(),
                layer: candidate.layer,
                write_mode,
            })
        })
        .collect();
    targets.sort_by(|left, right| left.key.cmp(&right.key));
    targets.dedup_by(|left, right| left.key == right.key);
    targets
}

/// [`crate::skill_file_evolution::skill_write_mode`] of one registry
/// candidate. Only skills in the managed user and project layers can carry
/// a skill-file candidate; the `SKILL.md` declaration is read only when it
/// can change the outcome (agent-created skills).
fn skill_target_write_mode(
    settings: &EvolutionSettings,
    origin: &SkillOrigin,
    candidate: &SkillCandidateInfo,
) -> EvolutionWriteMode {
    if !matches!(candidate.layer, SkillLayer::User | SkillLayer::Project)
        || !crate::skill_file_evolution::skill_file_edits_supported()
    {
        return EvolutionWriteMode::Overlay;
    }
    let declaration = matches!(origin, SkillOrigin::AgentCreated)
        .then(|| {
            let path = if candidate
                .path
                .file_name()
                .is_some_and(|name| name == "SKILL.md")
            {
                candidate.path.clone()
            } else {
                candidate.path.join("SKILL.md")
            };
            let text = std::fs::read_to_string(path).ok()?;
            kcoder_skills::skill_evolution_declaration(&text)
                .ok()
                .flatten()
        })
        .flatten();
    crate::skill_file_evolution::skill_write_mode(settings, origin, declaration.as_ref())
}
