//! Self-evolution hook at skill activation.
//!
//! The `skill` tool reports every successful activation to a host-installed
//! observer (the Engine evolution runtime). The observer records the usage
//! and may return a served overlay block, which the tool appends to its own
//! result so it is persisted in the transcript (plan section 3.2): a
//! restored session shows the version that was actually in effect and never
//! re-injects it. Without an observer activation behaves as before.

use crate::evolution_service::{SkillOriginResolver, skill_base_revision};
use async_trait::async_trait;
use kcoder_skills::{SkillLayer, SkillRegistry};
use kcoder_types::evolution::TargetKey;
use std::path::PathBuf;

/// Stable-channel evolution score the curator consults; see
/// [`SkillCurationSignal::persistently_low`] for the archival thresholds.
pub use kcoder_skill_support::curator::{
    EvolutionSignal as SkillCurationSignal, LOW_SCORE_MAX_MEAN, LOW_SCORE_MAX_UPPER,
    LOW_SCORE_MIN_OBSERVATIONS,
};

/// One successful `skill` activation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillActivationEvent {
    pub skill_name: String,
    pub target_key: TargetKey,
    /// The effective copy is a project skill (project evolution partition).
    pub project_scope: bool,
    /// [`skill_base_revision`] of the loaded body.
    pub base_revision: String,
    /// Declared `metadata.kcoder.category`, used as the preference domain.
    pub domain: Option<String>,
    pub arguments: Option<String>,
    /// The skill was already active before this call.
    pub already_active: bool,
    pub tool_call_id: Option<String>,
    pub source: PathBuf,
}

/// Host observer of skill activations.
#[async_trait]
pub trait SkillEvolutionObserver: Send + Sync {
    /// Record the activation. Returns text to append to the tool result
    /// (for example a served overlay), or `None`.
    async fn skill_activated(&self, event: SkillActivationEvent) -> Option<String>;

    /// Stable-channel score of a skill target for the curator, when one is
    /// recorded.
    fn curation_signal(&self, _target_key: &TargetKey) -> Option<SkillCurationSignal> {
        None
    }

    /// The skill behind `target_key` was archived (`true`) or restored
    /// (`false`). Its learned overlay is keyed by the target and carried
    /// along: archiving stops a running canary, restoring serves it again.
    fn target_archived(&self, _target_key: &TargetKey, _archived: bool) {}
}

/// Resolve the evolution identity of the effective copy of `name`.
pub fn activation_identity(
    registry: &SkillRegistry,
    name: &str,
) -> Option<(TargetKey, bool, String, Option<String>)> {
    let skill = registry.get_active(name)?;
    let candidate = registry
        .source_candidates()
        .into_iter()
        .find(|candidate| candidate.name == skill.name && candidate.effective)?;
    let key = SkillOriginResolver::default().target_key(&candidate)?;
    Some((
        key,
        candidate.layer == SkillLayer::Project,
        skill_base_revision(skill),
        skill.category.clone(),
    ))
}
