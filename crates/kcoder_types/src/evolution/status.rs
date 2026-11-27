//! Status and summary shapes that back the `evolution/*` RPC projections.
//! Field names follow the shared RPC contract; the protocol crate wraps
//! them with request parameters and capability negotiation.
use super::{
    EvaluationResult, EvolutionMode, ProposalActor, ProposalExample, ProposalState, TargetKey,
    TargetType,
};
use serde::{Deserialize, Serialize};

/// Why an enabled evolution currently does not act. A disabled master
/// switch is reported by `enabled: false` alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvolutionDisabledReason {
    TrainingMode,
    ProjectDisabled,
    ModelUnavailable,
    UsageLimit,
}

/// Posterior score of one (target, revision, channel) bucket.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionScore {
    /// [`super::TargetRevision::label`] of the scored revision.
    pub revision: String,
    pub mean: f64,
    /// Equal-tailed 95% credible interval.
    pub lower: f64,
    pub upper: f64,
    /// Scored usages contributing to the posterior.
    pub observations: u32,
}

/// Candidate slot state of an overlay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum OverlayCandidateState {
    /// Written but not yet serving traffic.
    Staged,
    Canary,
    Promoted,
    RolledBack,
}

/// How a target's learned content takes effect.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvolutionWriteMode {
    #[default]
    Overlay,
    SkillFile,
}

/// One row of `evolution/targets/list`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionTargetSummary {
    pub target_key: TargetKey,
    #[serde(rename = "type")]
    pub target_type: TargetType,
    pub source: String,
    pub name: String,
    pub enabled: bool,
    pub evolution_mode: EvolutionWriteMode,
    pub stable: EvolutionScore,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate: Option<EvolutionScore>,
    /// Candidate traffic share while a canary is active.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_traffic: Option<f64>,
    pub pending_proposals: u32,
    /// The target's base revision changed; the overlay is shown but not injected.
    pub needs_revalidation: bool,
    /// The user pinned the stable slot; candidates are not served.
    pub pinned: bool,
}

/// Overlay slot content as edited and displayed by clients.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverlayContent {
    #[serde(default)]
    pub lessons: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub checklist: String,
    #[serde(default)]
    pub examples: Vec<ProposalExample>,
}

impl OverlayContent {
    /// Character count used for the per-slot length limit.
    pub fn char_count(&self) -> usize {
        self.lessons.chars().count()
            + self.checklist.chars().count()
            + self
                .examples
                .iter()
                .map(|example| example.name.chars().count() + example.text.chars().count())
                .sum::<usize>()
    }

    pub fn is_empty(&self) -> bool {
        self.lessons.is_empty() && self.checklist.is_empty() && self.examples.is_empty()
    }
}

/// Compact evaluation projection for proposal lists.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionEvaluationSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub win_rate: Option<f64>,
    pub ties: u32,
    pub hard_check_regressions: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diversity_delta: Option<f64>,
    pub completed: bool,
}

impl From<&EvaluationResult> for EvolutionEvaluationSummary {
    fn from(result: &EvaluationResult) -> Self {
        Self {
            win_rate: result.win_rate(),
            ties: result.ties,
            hard_check_regressions: result.hard_check_regressions,
            diversity_delta: result.diversity_delta,
            completed: result.completed,
        }
    }
}

/// One row of a target's proposal list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionProposalSummary {
    pub id: String,
    pub state: ProposalState,
    /// RFC 3339 UTC timestamp.
    pub created_at: String,
    pub actor: ProposalActor,
    pub diff: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evaluation: Option<EvolutionEvaluationSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reject_reason: Option<String>,
}

/// Per-type row of `evolution/status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionTargetTypeStatus {
    #[serde(rename = "type")]
    pub target_type: TargetType,
    pub enabled: bool,
    /// False for target types whose integration has not shipped yet.
    pub implemented: bool,
    pub learned_items: u32,
    pub pending_proposals: u32,
}

/// Model selection projected for status.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvolutionModelSelection {
    #[default]
    FollowSession,
    Configured,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionModelStatus {
    pub selection: EvolutionModelSelection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// False pauses evolution model calls; there is no fallback model.
    pub available: bool,
}

/// Model token usage of evolution jobs in one calendar month (UTC).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionMonthUsage {
    /// `YYYY-MM`.
    pub month: String,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
}

impl EvolutionMonthUsage {
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens.saturating_add(self.output_tokens)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvolutionJobKind {
    Classify,
    Distill,
    Eval,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvolutionJobState {
    Idle,
    Running,
    Paused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionJobStatus {
    pub kind: EvolutionJobKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_key: Option<TargetKey>,
    pub state: EvolutionJobState,
    /// RFC 3339 UTC timestamp.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
}

/// Estimated money cost of evolution model calls.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionCost {
    pub amount: f64,
    pub currency: String,
}

/// Evolution model usage of the current month, as shown by clients.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionUsageSummary {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Absent when no price information is configured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_cost: Option<EvolutionCost>,
}

impl From<&EvolutionMonthUsage> for EvolutionUsageSummary {
    fn from(usage: &EvolutionMonthUsage) -> Self {
        Self {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            estimated_cost: None,
        }
    }
}

/// Where code placed a distilled pattern (plan section 8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvolutionPatternScope {
    TargetOverlay,
    UserPreference,
    Insufficient,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionPatternSupport {
    pub usages: u32,
    pub sessions: u32,
    pub users: u32,
}

/// One distilled pattern with its support.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionPattern {
    pub id: String,
    /// Generic category names, optionally followed by target domain names.
    pub categories: Vec<String>,
    pub statement: String,
    pub support: EvolutionPatternSupport,
    pub counter_evidence: u32,
    pub scope: EvolutionPatternScope,
}

/// Why project-scope evolution data was skipped; user scope keeps working.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvolutionProjectScopeIssue {
    /// The user data root lies inside the project (for example a developer
    /// home inside the checkout); project data is never written there.
    DataRootInsideProject,
    /// Project storage could not be opened.
    Unavailable,
}

/// Read-side counters of skipped journal lines.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionStorageDiagnostics {
    pub duplicate_records: u64,
    pub invalid_records: u64,
    pub future_records: u64,
    pub torn_tail: bool,
    /// Set when project-scope data was skipped for this request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_scope_issue: Option<EvolutionProjectScopeIssue>,
}

/// Scope-level status snapshot backing `evolution/status`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionStatusSnapshot {
    pub enabled: bool,
    pub mode: EvolutionMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled_reason: Option<EvolutionDisabledReason>,
    pub model: EvolutionModelStatus,
    pub targets: Vec<EvolutionTargetTypeStatus>,
    pub usage_this_month: EvolutionUsageSummary,
    #[serde(default)]
    pub jobs: Vec<EvolutionJobStatus>,
    /// Whether direct skill-file edits are available (requires skill-store
    /// candidate slots; false until then).
    #[serde(default)]
    pub skill_file_edits_supported: bool,
    #[serde(default)]
    pub diagnostics: EvolutionStorageDiagnostics,
}
