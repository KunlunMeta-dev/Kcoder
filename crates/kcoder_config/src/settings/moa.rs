//! Moa configuration types and their defaults.

use crate::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MoaModelConfig {
    /// Optional provider; when set, provider/model may remain `current`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default = "default_moa_provider")]
    pub provider: String,
    #[serde(default = "default_moa_model")]
    pub model: String,
}

impl MoaModelConfig {
    pub fn new(provider: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            profile: None,
            provider: provider.into(),
            model: model.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MoaPresetConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_moa_reference_models")]
    pub reference_models: Vec<MoaModelConfig>,
    #[serde(default = "default_moa_aggregator")]
    pub aggregator: MoaModelConfig,
    #[serde(default = "default_moa_reference_max_tokens")]
    pub reference_max_tokens: Option<u32>,
    #[serde(default = "default_moa_aggregator_max_tokens")]
    pub aggregator_max_tokens: Option<u32>,
}

impl Default for MoaPresetConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            reference_models: default_moa_reference_models(),
            aggregator: default_moa_aggregator(),
            reference_max_tokens: default_moa_reference_max_tokens(),
            aggregator_max_tokens: default_moa_aggregator_max_tokens(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MoaSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_moa_default_preset")]
    pub default_preset: String,
    #[serde(default = "default_moa_max_reference_workers")]
    pub max_reference_workers: usize,
    #[serde(default = "default_moa_presets")]
    pub presets: BTreeMap<String, MoaPresetConfig>,
}

impl Default for MoaSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            default_preset: default_moa_default_preset(),
            max_reference_workers: default_moa_max_reference_workers(),
            presets: default_moa_presets(),
        }
    }
}

/// Independent orchestration settings for `/moa-plan`.
///
/// Model slots continue to use `moa.presets`, while turn, timeout, and
/// concurrency budgets remain separate from regular `/moa` execution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MoaPlanSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_moa_plan_preset")]
    pub preset: String,
    #[serde(default = "default_moa_plan_draft_max_turns")]
    pub draft_max_turns: usize,
    /// Output-token limit for each independent planner draft request.
    #[serde(default = "default_moa_plan_draft_max_tokens")]
    pub draft_max_tokens: u32,
    /// Output-token limit for the final synthesis request.
    #[serde(default = "default_moa_plan_synthesis_max_tokens")]
    pub synthesis_max_tokens: u32,
    #[serde(default = "default_moa_plan_draft_timeout_secs")]
    pub draft_timeout_secs: u64,
    #[serde(default = "default_moa_plan_max_planner_workers")]
    pub max_planner_workers: usize,
}

impl Default for MoaPlanSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            preset: default_moa_plan_preset(),
            draft_max_turns: default_moa_plan_draft_max_turns(),
            draft_max_tokens: default_moa_plan_draft_max_tokens(),
            synthesis_max_tokens: default_moa_plan_synthesis_max_tokens(),
            draft_timeout_secs: default_moa_plan_draft_timeout_secs(),
            max_planner_workers: default_moa_plan_max_planner_workers(),
        }
    }
}
