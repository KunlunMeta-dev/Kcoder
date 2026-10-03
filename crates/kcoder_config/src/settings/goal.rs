//! Goal configuration types and their defaults.

use crate::*;

/// Reusable structured model slot; omitted fields inherit from the primary runtime.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelSlotConfig {
    /// Full provider profile name; takes precedence over provider/model when set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// Provider name; defaults to the primary session's active provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Model name; defaults to the primary session's active model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Retain the former public Goal Pro name as a type alias for configuration and caller compatibility.
pub type GoalProModelSlotConfig = ModelSlotConfig;

/// Normalize verifier-panel configuration by trimming fields, treating empty strings as inheritance, and enforcing the size limit.
pub fn normalize_goal_pro_verifier_panel(
    models: Vec<GoalProModelSlotConfig>,
) -> Vec<GoalProModelSlotConfig> {
    models
        .into_iter()
        .take(GOAL_PRO_VERIFIER_PANEL_MAX)
        .map(|mut slot| {
            slot.profile = slot.profile.and_then(non_empty_setting_string);
            slot.provider = slot.provider.and_then(non_empty_setting_string);
            slot.model = slot.model.and_then(non_empty_setting_string);
            slot
        })
        .collect()
}

pub(crate) fn non_empty_setting_string(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Runtime selection for an independent `/goal-pro` verifier.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoalProSettings {
    /// Full provider profile name; takes precedence over provider/model when set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verifier_profile: Option<String>,
    /// Provider name or configured custom profile name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verifier_provider: Option<String>,
    /// Model name used by the verifier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verifier_model: Option<String>,
    /// Multi-model verifier panel. Two or more entries enable majority voting; one
    /// entry acts as a single-verifier override; an empty list preserves the
    /// verifier_profile/provider/model behavior.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verifier_models: Vec<GoalProModelSlotConfig>,
    /// Maximum internal turns allowed for one verifier review.
    #[serde(default = "default_goal_pro_verifier_max_turns")]
    pub verifier_max_turns: usize,
    /// Block newly created Goal Pro runs after cumulative semantic completion rejections reach this value.
    #[serde(default = "default_goal_pro_completion_rejection_limit")]
    pub completion_rejection_limit: usize,
    /// Mandatory acceptance and environment-isolation policy for independent verifiers.
    #[serde(default)]
    pub verification: GoalProVerificationSettings,
    /// Automatic primary-agent model escalation after verifier rejections reach configured thresholds.
    #[serde(default)]
    pub model_escalation: GoalProModelEscalationSettings,
}

impl GoalProSettings {
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

impl Default for GoalProSettings {
    fn default() -> Self {
        Self {
            verifier_profile: None,
            verifier_provider: None,
            verifier_model: None,
            verifier_models: Vec::new(),
            verifier_max_turns: default_goal_pro_verifier_max_turns(),
            completion_rejection_limit: default_goal_pro_completion_rejection_limit(),
            verification: GoalProVerificationSettings::default(),
            model_escalation: GoalProModelEscalationSettings::default(),
        }
    }
}

/// Automatic `/goal-pro` primary-agent model escalation. Once semantic verifier
/// rejections reach a threshold, switch provider/model by rung while preserving
/// the full message history, using the same mechanism as manual `/model` changes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoalProModelEscalationSettings {
    /// When enabled, advance one rung whenever the rejection count reaches another multiple of the threshold.
    #[serde(default)]
    pub enabled: bool,
    /// Cumulative semantic rejections required to trigger each rung change.
    #[serde(default = "default_goal_pro_model_escalation_threshold")]
    pub threshold: usize,
    /// Ordered model rungs. Each entry's api_format and context_window_tokens must
    /// exactly match the primary provider; configuration loading fails fast otherwise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<GoalProModelSlotConfig>,
}

impl GoalProModelEscalationSettings {
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

impl Default for GoalProModelEscalationSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold: default_goal_pro_model_escalation_threshold(),
            models: Vec::new(),
        }
    }
}

/// Machine acceptance policy for the `/goal-pro` artifact verifier.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct GoalProVerificationSettings {
    /// Require a successful test actually executed by the verifier in this run before completion.
    pub require_tests: bool,
    /// Require the same read-only probe to prove that the candidate fixes the behavior that failed on the pristine baseline.
    pub require_behavior_delta: bool,
    /// Minimum acceptable test scope.
    pub minimum_test_scope: GoalProTestScope,
    /// Accept only the original test exit code without output filtering or failure suppression.
    pub require_raw_exit_code: bool,
    /// Allow the verifier to modify the candidate workspace.
    pub allow_workspace_changes: bool,
    /// Isolate the verifier's home, cache, temporary directory, and Python user site.
    pub isolate_environment: bool,
    /// Allow the verifier to install, remove, or update dependencies.
    pub allow_dependency_changes: bool,
    /// After target tests pass, allow peripheral failures caused solely by unavailable external networking.
    pub allow_network_only_failures: bool,
}

impl GoalProVerificationSettings {
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

impl Default for GoalProVerificationSettings {
    fn default() -> Self {
        default_goal_pro_verification_settings()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalProTestScope {
    Focused,
    TargetSuite,
}
