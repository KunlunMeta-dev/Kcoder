//! Skill-file evolution targets (plan section 5.2): learned content is
//! materialized into the skill package and staged in the skill store's
//! candidate slot; promotion publishes it through the store's commit
//! journal, rollback discards it. Which skills qualify is decided by
//! [`kcoder_tools::skill_file_evolution::skill_write_mode`]; project skills
//! additionally need a workspace that allows implicit project writes.

use crate::{QueryEngine, recover_read_lock};
use kcoder_config::Settings;
use kcoder_skills::{
    PrePromotionRestore, SkillEvolutionDeclaration, SkillLayer, SkillMutationActor, SkillStore,
    skill_evolution_declaration, split_skill_frontmatter,
};
use kcoder_tools::evolution_service::{
    SkillOriginResolver, TargetFileRollback, apply_changes, guard_overlay_content,
};
use kcoder_tools::skill_file_evolution::{
    materialize_overlay, materialized_overlay, skill_write_mode, validate_skill_file_candidate,
};
use kcoder_types::evolution::{EvolutionWriteMode, ProposalChanges, TargetKey, TargetType};
use std::io::Read;
use std::path::{Path, PathBuf};

const SKILL_MD_MAX_BYTES: u64 = 1024 * 1024;

/// A skill whose own files evolve.
pub(crate) struct SkillFileTarget {
    pub(crate) store: SkillStore,
    pub(crate) name: String,
    pub(crate) declaration: Option<SkillEvolutionDeclaration>,
}

fn read_skill_md(path: &Path) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(SKILL_MD_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= SKILL_MD_MAX_BYTES)
        .then(|| String::from_utf8(bytes).ok())
        .flatten()
}

/// `skill_base_revision` of a `SKILL.md` text (hash of the trimmed body).
pub(crate) fn base_revision_of(skill_md: &str) -> String {
    use sha2::{Digest, Sha256};
    let body = split_skill_frontmatter(skill_md).1;
    let digest = Sha256::digest(body.trim().as_bytes());
    let hex: String = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("sha256:{hex}")
}

impl QueryEngine {
    /// Directory and `evolution:` declaration of the effective copy of a
    /// skill target, and whether that copy is the built-in/bundled one.
    pub(crate) fn evolution_skill_declaration(
        &self,
        key: &TargetKey,
    ) -> (Option<PathBuf>, Option<SkillEvolutionDeclaration>, bool) {
        if key.target_type() != TargetType::Skill {
            return (None, None, false);
        }
        let registry = recover_read_lock(&self.skill_registry, "skill_registry");
        let mut resolver = SkillOriginResolver::default();
        let Some(candidate) = registry
            .source_candidates()
            .into_iter()
            .filter(|candidate| candidate.effective && !candidate.removed)
            .find(|candidate| resolver.target_key(candidate).as_ref() == Some(key))
        else {
            return (None, None, false);
        };
        let bundled = matches!(candidate.layer, SkillLayer::Builtin | SkillLayer::Bundled);
        let skill_md = if candidate
            .path
            .file_name()
            .is_some_and(|name| name == "SKILL.md")
        {
            candidate.path.clone()
        } else {
            candidate.path.join("SKILL.md")
        };
        let declaration = read_skill_md(&skill_md)
            .and_then(|text| skill_evolution_declaration(&text).ok().flatten());
        (
            skill_md.parent().map(Path::to_path_buf),
            declaration,
            bundled,
        )
    }

    /// The managed skill store holding `key` and the skill's name there,
    /// whatever its current write mode (a rollback must still reach a skill
    /// whose file edits were switched off after a promotion).
    pub(crate) fn evolution_skill_store(&self, key: &TargetKey) -> Option<(SkillStore, String)> {
        if key.target_type() != TargetType::Skill {
            return None;
        }
        let (layer, skill_dir) = {
            let registry = recover_read_lock(&self.skill_registry, "skill_registry");
            let mut resolver = SkillOriginResolver::default();
            let candidate = registry
                .source_candidates()
                .into_iter()
                .filter(|candidate| candidate.effective && !candidate.removed)
                .find(|candidate| resolver.target_key(candidate).as_ref() == Some(key))?;
            let skill_dir = if candidate
                .path
                .file_name()
                .is_some_and(|name| name == "SKILL.md")
            {
                candidate.path.parent()?.to_path_buf()
            } else {
                candidate.path.clone()
            };
            (candidate.layer, skill_dir)
        };
        // Same writable layers as promotion: project skills also need a
        // workspace that allows implicit project writes.
        match layer {
            SkillLayer::User => {}
            SkillLayer::Project
                if self
                    .workspace_persistence_mode
                    .allows_implicit_project_writes() => {}
            _ => return None,
        }
        let name = skill_dir.file_name()?.to_str()?.to_string();
        let store = SkillStore::open(skill_dir.parent()?).ok()?;
        Some((store, name))
    }

    /// The skill-store target of `key` when it evolves its own files.
    pub(crate) fn evolution_skill_file_target(
        &self,
        key: &TargetKey,
        settings: &Settings,
    ) -> Option<SkillFileTarget> {
        if key.target_type() != TargetType::Skill {
            return None;
        }
        let (origin, layer, skill_dir) = {
            let registry = recover_read_lock(&self.skill_registry, "skill_registry");
            let mut resolver = SkillOriginResolver::default();
            let candidate = registry
                .source_candidates()
                .into_iter()
                .filter(|candidate| candidate.effective && !candidate.removed)
                .find(|candidate| resolver.target_key(candidate).as_ref() == Some(key))?;
            let skill_dir = if candidate
                .path
                .file_name()
                .is_some_and(|name| name == "SKILL.md")
            {
                candidate.path.parent()?.to_path_buf()
            } else {
                candidate.path.clone()
            };
            (resolver.origin(&candidate), candidate.layer, skill_dir)
        };
        // Only managed, writable layers; project skills also need a
        // workspace that allows implicit project writes.
        match layer {
            SkillLayer::User => {}
            SkillLayer::Project
                if self
                    .workspace_persistence_mode
                    .allows_implicit_project_writes() => {}
            _ => return None,
        }
        let declaration = read_skill_md(&skill_dir.join("SKILL.md"))
            .and_then(|text| skill_evolution_declaration(&text).ok().flatten());
        if declaration
            .as_ref()
            .is_some_and(|declaration| declaration.enabled == Some(false))
            || skill_write_mode(&settings.evolution, &origin, declaration.as_ref())
                != EvolutionWriteMode::SkillFile
        {
            return None;
        }
        let name = skill_dir.file_name()?.to_str()?.to_string();
        let store = SkillStore::open(skill_dir.parent()?).ok()?;
        Some(SkillFileTarget {
            store,
            name,
            declaration,
        })
    }
}

/// Materialize `changes` on top of the learned block already in the
/// stable package and stage the result as the skill's candidate.
pub(crate) fn stage(
    target: &SkillFileTarget,
    changes: &ProposalChanges,
    proposal_id: &str,
    now_ms: u64,
) -> Result<(), String> {
    let declaration = target.declaration.as_ref();
    let stable = target
        .store
        .read_package(&target.name)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "the skill no longer exists".to_string())?;
    let revision = target
        .store
        .current_revision(&target.name)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "the skill no longer exists".to_string())?;
    let learned = apply_changes(&materialized_overlay(&stable, declaration), changes);
    let learned = guard_overlay_content(&learned).map_err(|error| error.message)?;
    let candidate = materialize_overlay(&stable, &learned, declaration)?;
    validate_skill_file_candidate(&stable, &candidate, declaration)?;
    target
        .store
        .stage_candidate(candidate, &revision, proposal_id, now_ms)
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Publish the staged candidate of `proposal_id`. Returns the new base
/// revision of the skill body, or `None` when nothing was staged.
pub(crate) fn promote(
    target: &SkillFileTarget,
    proposal_id: &str,
) -> Result<Option<String>, String> {
    let staged = target
        .store
        .read_candidate(&target.name)
        .map_err(|error| error.to_string())?
        .filter(|(candidate, _)| candidate.proposal_id == proposal_id);
    let Some((candidate, _)) = staged else {
        return Ok(None);
    };
    let skill_md = candidate
        .package
        .files
        .iter()
        .find(|file| file.relative_path == Path::new("SKILL.md"))
        .and_then(|file| std::str::from_utf8(&file.content).ok())
        .map(base_revision_of)
        .ok_or_else(|| "the candidate has no SKILL.md".to_string())?;
    target
        .store
        .promote_candidate(
            &target.name,
            proposal_id,
            &format!("evolution-promote-{proposal_id}"),
            SkillMutationActor::System {
                component: "self_evolution".into(),
                session_id: None,
            },
        )
        .map_err(|error| error.to_string())?;
    Ok(Some(skill_md))
}

impl QueryEngine {
    /// Roll back the file promotion of `proposal_id`: restore the skill's
    /// package from before it (plan section 5.2). The store refuses when the
    /// skill changed after the promotion, so a user edit is never lost.
    pub(crate) fn restore_evolution_skill_file(
        &self,
        key: &TargetKey,
        proposal_id: &str,
    ) -> Result<TargetFileRollback, String> {
        let Some((store, name)) = self.evolution_skill_store(key) else {
            return Ok(TargetFileRollback::NotApplicable);
        };
        let outcome = store
            .restore_pre_promotion(
                &name,
                proposal_id,
                &format!("evolution-rollback-{proposal_id}"),
                SkillMutationActor::System {
                    component: "self_evolution".into(),
                    session_id: None,
                },
            )
            .map_err(|error| error.to_string())?;
        Ok(match outcome {
            PrePromotionRestore::Restored => TargetFileRollback::Restored,
            PrePromotionRestore::NotRecorded => TargetFileRollback::NotApplicable,
            PrePromotionRestore::ChangedSincePromotion { .. } => {
                TargetFileRollback::Refused(format!(
                    "The skill `{name}` was edited after this proposal was promoted, so its files \
                     were kept as they are; only the learned notes were reverted. Undo the \
                     learned block in the skill by hand if you no longer want it."
                ))
            }
        })
    }

    /// Discard the skill-store candidate staged for `proposal_id` of `key`,
    /// when that skill evolves its own files (best effort).
    pub(crate) fn discard_evolution_skill_candidate(&self, key: &TargetKey, proposal_id: &str) {
        let settings = recover_read_lock(&self.settings, "settings").clone();
        if let Some(target) = self.evolution_skill_file_target(key, &settings) {
            discard(&target, proposal_id);
        }
    }
}

/// Discard the staged candidate of `proposal_id` (best effort).
pub(crate) fn discard(target: &SkillFileTarget, proposal_id: &str) {
    if let Err(error) = target
        .store
        .discard_candidate(&target.name, Some(proposal_id))
    {
        tracing::warn!(%error, skill = %target.name, "skill candidate not discarded");
    }
}
