//! User-level self-evolution settings (plan section 15).
//!
//! Only user, executable-directory and explicit overlay layers configure
//! evolution. Project and local layers may only set `evolution.enabled` to
//! `false`; every other evolution key from those layers is ignored with a
//! load warning (see [`restrict_project_evolution_layer`]).

use anyhow::{Result, bail, ensure};
use kcoder_types::evolution::{EvolutionMode, TargetKey, TargetType};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(crate) const fn default_evolution_mode() -> EvolutionMode {
    // Phase 3 (overlays, distillation and proposals) defaults to "propose":
    // learned changes wait for the user. "auto" stays an explicit choice.
    EvolutionMode::Propose
}

pub(crate) const fn default_distill_min_usages() -> u32 {
    20
}

pub(crate) const fn default_candidate_traffic() -> f64 {
    0.5
}

pub(crate) const fn default_promote_threshold() -> f64 {
    0.8
}

pub(crate) const fn default_rollback_threshold() -> f64 {
    0.3
}

pub(crate) const fn default_evidence_ttl_days() -> u32 {
    90
}

pub const EVOLUTION_EVIDENCE_TTL_MAX_DAYS: u32 = 3650;

const fn default_true() -> bool {
    true
}

/// Self-evolution configuration. Disabled by default.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvolutionSettings {
    /// Master switch. When false nothing is collected, distilled or served
    /// from a candidate; existing data is kept.
    #[serde(default)]
    pub enabled: bool,
    /// Global mode. Per-target modes can only narrow it.
    #[serde(default = "default_evolution_mode")]
    pub mode: EvolutionMode,
    #[serde(default)]
    pub targets: EvolutionTargetsSettings,
    #[serde(default)]
    pub signals: EvolutionSignalSettings,
    /// New observed usages since the last distillation that trigger the next one.
    #[serde(default = "default_distill_min_usages")]
    pub distill_min_usages: u32,
    /// Candidate traffic share for targets with an offline evaluator.
    #[serde(default = "default_candidate_traffic")]
    pub candidate_traffic: f64,
    /// Minimum `P(candidate > stable)` for promotion.
    #[serde(default = "default_promote_threshold")]
    pub promote_threshold: f64,
    /// `P(candidate > stable)` at or below which a candidate is rolled back.
    #[serde(default = "default_rollback_threshold")]
    pub rollback_threshold: f64,
    /// Model for evolution calls. `None` follows the triggering session's model.
    #[serde(default)]
    pub model: Option<EvolutionModelRef>,
    #[serde(default)]
    pub stage_models: EvolutionStageModels,
    #[serde(default = "default_evidence_ttl_days")]
    pub evidence_ttl_days: u32,
    /// Phase 5 cross-user aggregate sharing; never uploads content.
    #[serde(default)]
    pub share_aggregates: bool,
    #[serde(default)]
    pub usage_limit: EvolutionUsageLimit,
    /// Offline evaluation thresholds a candidate must meet before its canary.
    #[serde(default)]
    pub eval: EvolutionEvalSettings,
}

impl Default for EvolutionSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: default_evolution_mode(),
            targets: EvolutionTargetsSettings::default(),
            signals: EvolutionSignalSettings::default(),
            distill_min_usages: default_distill_min_usages(),
            candidate_traffic: default_candidate_traffic(),
            promote_threshold: default_promote_threshold(),
            rollback_threshold: default_rollback_threshold(),
            model: None,
            stage_models: EvolutionStageModels::default(),
            evidence_ttl_days: default_evidence_ttl_days(),
            share_aggregates: false,
            usage_limit: EvolutionUsageLimit::default(),
            eval: EvolutionEvalSettings::default(),
        }
    }
}

fn default_eval_win_rate() -> f64 {
    0.6
}

fn default_eval_max_diversity_drop() -> f64 {
    0.1
}

/// Pass thresholds of the offline pairwise evaluation.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvolutionEvalSettings {
    /// Minimum share of decisive comparisons the candidate wins (ties
    /// excluded).
    #[serde(default = "default_eval_win_rate")]
    pub win_rate: f64,
    /// Largest accepted relative drop of output diversity for free-text
    /// targets (0.1 = 10%).
    #[serde(default = "default_eval_max_diversity_drop")]
    pub max_diversity_drop: f64,
}

impl Default for EvolutionEvalSettings {
    fn default() -> Self {
        Self {
            win_rate: default_eval_win_rate(),
            max_diversity_drop: default_eval_max_diversity_drop(),
        }
    }
}

/// Whether all targets or only selected targets of one type evolve.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvolutionTargetScope {
    #[default]
    All,
    Selected,
}

/// Per-target switch inside `targets.<type>.items`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvolutionItemSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// Settings for one target type. `enabled` and `mode` are optional so a
/// partial document resolves to the type's own default (see
/// [`EvolutionTargetsSettings::type_enabled`] and
/// [`EvolutionSettings::effective_mode`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvolutionTargetSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Narrows the global mode for this type; `None` inherits it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<EvolutionMode>,
    #[serde(default)]
    pub scope: EvolutionTargetScope,
    /// Keyed by full target key, for example `skill:project:deploy-check`.
    #[serde(default)]
    pub items: BTreeMap<String, EvolutionItemSettings>,
    /// Skill only: allow direct edits of user/agent-created skill files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_file_edits: Option<bool>,
}

impl EvolutionTargetSettings {
    fn with_defaults(enabled: bool, mode: Option<EvolutionMode>, skill: bool) -> Self {
        Self {
            enabled: Some(enabled),
            mode,
            scope: EvolutionTargetScope::All,
            items: BTreeMap::new(),
            allow_file_edits: skill.then_some(false),
        }
    }
}

/// `evolution.targets`. Unknown target types are rejected by
/// `deny_unknown_fields` and the settings schema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvolutionTargetsSettings {
    #[serde(default = "default_skill_target")]
    pub skill: EvolutionTargetSettings,
    #[serde(default = "default_preference_target")]
    pub preference: EvolutionTargetSettings,
    #[serde(default = "default_project_knowledge_target")]
    pub project_knowledge: EvolutionTargetSettings,
    #[serde(default = "default_tool_usage_target")]
    pub tool_usage: EvolutionTargetSettings,
    #[serde(default = "default_workflow_template_target")]
    pub workflow_template: EvolutionTargetSettings,
}

fn default_skill_target() -> EvolutionTargetSettings {
    EvolutionTargetSettings::with_defaults(true, None, true)
}

fn default_preference_target() -> EvolutionTargetSettings {
    EvolutionTargetSettings::with_defaults(true, None, false)
}

fn default_project_knowledge_target() -> EvolutionTargetSettings {
    EvolutionTargetSettings::with_defaults(true, Some(EvolutionMode::Propose), false)
}

fn default_tool_usage_target() -> EvolutionTargetSettings {
    EvolutionTargetSettings::with_defaults(false, None, false)
}

fn default_workflow_template_target() -> EvolutionTargetSettings {
    EvolutionTargetSettings::with_defaults(false, None, false)
}

impl Default for EvolutionTargetsSettings {
    fn default() -> Self {
        Self {
            skill: default_skill_target(),
            preference: default_preference_target(),
            project_knowledge: default_project_knowledge_target(),
            tool_usage: default_tool_usage_target(),
            workflow_template: default_workflow_template_target(),
        }
    }
}

impl EvolutionTargetsSettings {
    pub fn get(&self, target_type: TargetType) -> &EvolutionTargetSettings {
        match target_type {
            TargetType::Skill => &self.skill,
            TargetType::Preference => &self.preference,
            TargetType::ProjectKnowledge => &self.project_knowledge,
            TargetType::ToolUsage => &self.tool_usage,
            TargetType::WorkflowTemplate => &self.workflow_template,
        }
    }

    /// Type switch, resolving an absent value to the type's default
    /// (skill, preference and project knowledge on; the others off).
    pub fn type_enabled(&self, target_type: TargetType) -> bool {
        self.get(target_type).enabled.unwrap_or(matches!(
            target_type,
            TargetType::Skill | TargetType::Preference | TargetType::ProjectKnowledge
        ))
    }
}

/// Signal adapter switches. Turning one off sets its score weights to zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvolutionSignalSettings {
    /// Artifact edits plus kept/exported outcomes.
    #[serde(default = "default_true")]
    pub artifact_edits: bool,
    /// Tool results, verification and task terminal states.
    #[serde(default = "default_true")]
    pub procedure_results: bool,
    /// Conversational corrections and regeneration requests.
    #[serde(default = "default_true")]
    pub chat_corrections: bool,
    /// Explicit rating controls in clients.
    #[serde(default = "default_true")]
    pub rating_ui: bool,
}

impl Default for EvolutionSignalSettings {
    fn default() -> Self {
        Self {
            artifact_edits: true,
            procedure_results: true,
            chat_corrections: true,
            rating_ui: true,
        }
    }
}

/// Reference to an already configured model: Provider id plus model id,
/// both case-preserving. It never carries endpoints or credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvolutionModelRef {
    pub provider: String,
    pub model: String,
}

/// Optional per-stage model overrides; `None` uses `evolution.model`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvolutionStageModels {
    #[serde(default)]
    pub classifier: Option<EvolutionModelRef>,
    #[serde(default)]
    pub distill: Option<EvolutionModelRef>,
    #[serde(default)]
    pub eval: Option<EvolutionModelRef>,
}

/// Evolution job stage that issues model calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvolutionStage {
    Classifier,
    Distill,
    Eval,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvolutionUsageLimit {
    /// `None` is unlimited (the default).
    #[serde(default)]
    pub monthly_max_tokens: Option<u64>,
}

impl EvolutionSettings {
    /// Effective mode for a target type: the per-type mode can only narrow
    /// the global mode, and project knowledge never exceeds `propose`
    /// because version 1 always requires user confirmation for it.
    pub fn effective_mode(&self, target_type: TargetType) -> EvolutionMode {
        let mut mode = self.mode;
        if let Some(narrowed) = self.targets.get(target_type).mode {
            mode = mode.min(narrowed);
        }
        if target_type == TargetType::ProjectKnowledge {
            mode = mode.min(EvolutionMode::Propose);
        }
        mode
    }

    /// Whether one concrete target may evolve: master switch, type switch,
    /// then the per-item switch under the type's selection scope.
    pub fn target_enabled(&self, key: &TargetKey) -> bool {
        let target_type = key.target_type();
        if !self.enabled || !self.targets.type_enabled(target_type) {
            return false;
        }
        let settings = self.targets.get(target_type);
        match settings.items.get(&key.to_string()) {
            Some(item) => item.enabled,
            None => settings.scope == EvolutionTargetScope::All,
        }
    }

    /// Model reference for a stage; `None` follows the session model.
    pub fn stage_model(&self, stage: EvolutionStage) -> Option<&EvolutionModelRef> {
        let staged = match stage {
            EvolutionStage::Classifier => &self.stage_models.classifier,
            EvolutionStage::Distill => &self.stage_models.distill,
            EvolutionStage::Eval => &self.stage_models.eval,
        };
        staged.as_ref().or(self.model.as_ref())
    }

    pub fn validate(&self) -> Result<()> {
        let unit = |value: f64| value.is_finite() && (0.0..=1.0).contains(&value);
        ensure!(
            unit(self.candidate_traffic),
            "evolution.candidate_traffic must be within [0, 1]"
        );
        ensure!(
            unit(self.promote_threshold) && unit(self.rollback_threshold),
            "evolution.promote_threshold and evolution.rollback_threshold must be within [0, 1]"
        );
        ensure!(
            self.rollback_threshold < self.promote_threshold,
            "evolution.rollback_threshold must be lower than evolution.promote_threshold"
        );
        ensure!(
            unit(self.eval.win_rate) && self.eval.win_rate > 0.0,
            "evolution.eval.win_rate must be within (0, 1]"
        );
        ensure!(
            unit(self.eval.max_diversity_drop),
            "evolution.eval.max_diversity_drop must be within [0, 1]"
        );
        ensure!(
            self.distill_min_usages >= 1,
            "evolution.distill_min_usages must be at least 1"
        );
        ensure!(
            (1..=EVOLUTION_EVIDENCE_TTL_MAX_DAYS).contains(&self.evidence_ttl_days),
            "evolution.evidence_ttl_days must be between 1 and {EVOLUTION_EVIDENCE_TTL_MAX_DAYS}"
        );
        if let Some(limit) = self.usage_limit.monthly_max_tokens {
            ensure!(
                limit > 0,
                "evolution.usage_limit.monthly_max_tokens must be positive or null"
            );
        }
        for (name, model) in [
            ("model", &self.model),
            ("stage_models.classifier", &self.stage_models.classifier),
            ("stage_models.distill", &self.stage_models.distill),
            ("stage_models.eval", &self.stage_models.eval),
        ] {
            if let Some(model) = model {
                for (field, value) in [("provider", &model.provider), ("model", &model.model)] {
                    ensure!(
                        !value.is_empty()
                            && value.trim() == value
                            && !value.chars().any(char::is_control),
                        "evolution.{name}.{field} must be a non-empty configured identifier"
                    );
                }
            }
        }
        for target_type in TargetType::ALL {
            let settings = self.targets.get(target_type);
            if target_type != TargetType::Skill && settings.allow_file_edits.is_some() {
                bail!(
                    "evolution.targets.{target_type}.allow_file_edits is only supported for skills"
                );
            }
            for key in settings.items.keys() {
                let parsed = TargetKey::parse(key).map_err(|error| {
                    anyhow::anyhow!("evolution.targets.{target_type}.items `{key}`: {error}")
                })?;
                ensure!(
                    parsed.target_type() == target_type,
                    "evolution.targets.{target_type}.items `{key}` belongs to another target type"
                );
            }
        }
        Ok(())
    }
}

/// Keep only what a project or local layer may say about evolution:
/// `evolution.enabled = false`. Returns the dotted names of ignored keys.
pub(crate) fn restrict_project_evolution_layer(layer: &mut serde_json::Value) -> Vec<String> {
    let Some(root) = layer.as_object_mut() else {
        return Vec::new();
    };
    let Some(evolution) = root.get_mut("evolution") else {
        return Vec::new();
    };
    let mut ignored = Vec::new();
    let keep_disable = evolution
        .as_object()
        .and_then(|object| object.get("enabled"))
        .is_some_and(|value| value == &serde_json::Value::Bool(false));
    match evolution.as_object() {
        Some(object) => {
            for key in object.keys() {
                if !(key == "enabled" && keep_disable) {
                    ignored.push(format!("evolution.{key}"));
                }
            }
        }
        None => ignored.push("evolution".to_string()),
    }
    if keep_disable {
        *evolution = serde_json::json!({ "enabled": false });
    } else {
        root.remove("evolution");
    }
    ignored
}

#[cfg(test)]
#[path = "evolution.test.rs"]
mod tests;
