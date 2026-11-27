//! Self-evolution (`evolution/*`) wire shapes.
//!
//! Status, summary, overlay and proposal shapes are shared with
//! `kcoder_types::evolution` and produced by `kcoder_evolution`. Every
//! method is scoped to the current runtime target; `workspace` selects the
//! project partition. Settings are not written through these methods.
//!
//! The app-server advertises [`CAPABILITY_SELF_EVOLUTION_V1`] on connections
//! that can serve every method (a writable user settings file, not a native
//! source connection); clients must observe it before calling any method,
//! and the server refuses every method on a connection without it.

pub use kcoder_types::evolution::{
    EvolutionCost, EvolutionDisabledReason, EvolutionEvaluationSummary, EvolutionJobKind,
    EvolutionJobState, EvolutionJobStatus, EvolutionModelSelection, EvolutionModelStatus,
    EvolutionPattern, EvolutionPatternScope, EvolutionPatternSupport, EvolutionProjectScopeIssue,
    EvolutionProposalSummary, EvolutionScore, EvolutionStatusSnapshot as EvolutionStatusResult,
    EvolutionStorageDiagnostics, EvolutionTargetSummary, EvolutionTargetTypeStatus,
    EvolutionUsageSummary, EvolutionWriteMode, OverlayContent as EvolutionOverlayContent,
    ProposalExample as EvolutionOverlayExample, TargetKey as EvolutionTargetKey,
    TargetType as EvolutionTargetType,
};
use serde::{Deserialize, Serialize};

/// Server capability gating every `evolution/*` and `settings/evolution/*` method.
pub const CAPABILITY_SELF_EVOLUTION_V1: &str = "selfEvolutionV1";
/// Maximum list page size for `evolution/targets/list`.
pub const EVOLUTION_TARGETS_PAGE_MAX: u32 = 200;
/// Maximum characters of a rating reason.
pub const EVOLUTION_RATE_REASON_MAX_CHARS: usize = 500;
/// Maximum tool call ids one `evolution/rate` request names.
pub const EVOLUTION_RATE_TOOL_CALLS_MAX: usize = 64;
/// Most turns one `evolution/ratings/list` result carries (newest first).
pub const EVOLUTION_RATINGS_LIST_MAX: usize = 200;
const MAX_ATOM_BYTES: usize = 4096;

pub mod method {
    pub const STATUS: &str = "evolution/status";
    pub const TARGETS_LIST: &str = "evolution/targets/list";
    pub const TARGET_READ: &str = "evolution/target/read";
    pub const PROPOSAL_DECIDE: &str = "evolution/proposal/decide";
    pub const OVERLAY_UPDATE: &str = "evolution/overlay/update";
    pub const PREFERENCE_LIST: &str = "evolution/preference/list";
    pub const PREFERENCE_UPDATE: &str = "evolution/preference/update";
    pub const RATE: &str = "evolution/rate";
    /// Ratable turns of one thread (or subagent) and their standing rating.
    pub const RATINGS_LIST: &str = "evolution/ratings/list";
    pub const DATA_CLEAR: &str = "evolution/data/clear";
    /// Manually queue a distillation of one target ("organize feedback").
    pub const TARGET_DISTILL: &str = "evolution/target/distill";
    /// Server notification; clients refetch.
    pub const CHANGED: &str = "evolution/changed";
    /// Read the user-level `evolution` settings block.
    pub const SETTINGS_READ: &str = "settings/evolution/read";
    /// Revision-checked write of the user-level `evolution` settings block.
    pub const SETTINGS_SAVE: &str = "settings/evolution/save";
}

/// Stable error codes carried in JSON-RPC error data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvolutionErrorCode {
    EvolutionDisabled,
    EvolutionUnsupportedTargetType,
    EvolutionTargetNotFound,
    EvolutionRevisionConflict,
    EvolutionProposalNotFound,
    EvolutionInvalidTransition,
    EvolutionContentRejected,
    EvolutionContentTooLarge,
}

/// Parameter validation failure.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid evolution parameter {field}: {reason}")]
pub struct EvolutionParamsError {
    pub field: &'static str,
    pub reason: &'static str,
}

fn atom(field: &'static str, value: &str) -> Result<(), EvolutionParamsError> {
    if value.is_empty()
        || value.len() > MAX_ATOM_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(EvolutionParamsError {
            field,
            reason: "must be a non-empty bounded value without surrounding whitespace",
        });
    }
    Ok(())
}

fn workspace(value: &Option<String>) -> Result<(), EvolutionParamsError> {
    value
        .as_deref()
        .map_or(Ok(()), |workspace| atom("workspace", workspace))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionStatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

impl EvolutionStatusParams {
    pub fn validate(&self) -> Result<(), EvolutionParamsError> {
        workspace(&self.workspace)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionTargetsListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(rename = "type")]
    pub target_type: EvolutionTargetType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

impl EvolutionTargetsListParams {
    pub fn validate(&self) -> Result<(), EvolutionParamsError> {
        workspace(&self.workspace)?;
        if let Some(cursor) = &self.cursor {
            atom("cursor", cursor)?;
        }
        if self
            .limit
            .is_some_and(|limit| limit == 0 || limit > EVOLUTION_TARGETS_PAGE_MAX)
        {
            return Err(EvolutionParamsError {
                field: "limit",
                reason: "must be between 1 and 200",
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionTargetsListResult {
    pub items: Vec<EvolutionTargetSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionTargetReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    pub target_key: EvolutionTargetKey,
}

impl EvolutionTargetReadParams {
    pub fn validate(&self) -> Result<(), EvolutionParamsError> {
        workspace(&self.workspace)
    }
}

/// Overlay slots of one target. `overlay_revision` is the opaque document
/// revision to pass back as `expectedRevision`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionOverlayView {
    pub stable: EvolutionOverlayContent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate: Option<EvolutionOverlayContent>,
    pub overlay_revision: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionTargetReadResult {
    pub summary: EvolutionTargetSummary,
    pub overlay: EvolutionOverlayView,
    pub patterns: Vec<EvolutionPattern>,
    pub proposals: Vec<EvolutionProposalSummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvolutionDecision {
    Accept,
    Reject,
    Rollback,
    PinStable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionProposalDecideParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    pub target_key: EvolutionTargetKey,
    pub proposal_id: String,
    pub decision: EvolutionDecision,
    /// The target's current `overlay.overlayRevision` from the last
    /// `evolution/target/read` (for `skill_file` targets the skill revision).
    pub expected_revision: String,
}

impl EvolutionProposalDecideParams {
    pub fn validate(&self) -> Result<(), EvolutionParamsError> {
        workspace(&self.workspace)?;
        atom("proposalId", &self.proposal_id)?;
        atom("expectedRevision", &self.expected_revision)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionProposalDecideResult {
    pub summary: EvolutionTargetSummary,
    /// Part of the decision was not carried out and the user should know,
    /// e.g. a rolled-back skill edited after its promotion keeps the edit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

/// Only the stable slot accepts user edits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvolutionOverlaySlotName {
    Stable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionOverlayUpdateParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    pub target_key: EvolutionTargetKey,
    pub slot: EvolutionOverlaySlotName,
    pub content: EvolutionOverlayContent,
    pub expected_revision: String,
}

impl EvolutionOverlayUpdateParams {
    pub fn validate(&self) -> Result<(), EvolutionParamsError> {
        workspace(&self.workspace)?;
        atom("expectedRevision", &self.expected_revision)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionOverlayUpdateResult {
    pub overlay_revision: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionPreferenceListParams {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionPreferenceItem {
    /// `pref.<scope>.<category>`.
    pub key: String,
    pub value: String,
    pub scope: String,
    pub evidence_count: u32,
    /// RFC 3339 UTC timestamp.
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionPreferenceListResult {
    pub items: Vec<EvolutionPreferenceItem>,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionPreferenceUpdateParams {
    pub key: String,
    /// Absent or null deletes the preference.
    #[serde(default)]
    pub value: Option<String>,
    pub expected_revision: String,
}

impl EvolutionPreferenceUpdateParams {
    pub fn validate(&self) -> Result<(), EvolutionParamsError> {
        atom("key", &self.key)?;
        atom("expectedRevision", &self.expected_revision)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionPreferenceUpdateResult {
    pub revision: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvolutionRating {
    Up,
    Down,
}

/// Rates the usages of one turn. Without `targetKey` the rating applies to
/// every usage in that turn. A usage is addressed by its recorded turn id
/// (`turnId`, as `evolution/ratings/list` reports it) or by its recorded
/// tool call (`toolCallIds`, the turn's `skill` calls the client shows).
/// The latest rating of a usage stands: an opposite rating or a new reason
/// is appended as a new observation (earlier ones are kept, not counted);
/// repeating the standing rating appends nothing. With `subagentId` the
/// client still addresses the parent thread it owns; the server resolves
/// the child agent thread through the parent's agent registry and `turnId`
/// refers to the child turn. An unknown or unowned subagent fails with
/// `evolution_target_not_found`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionRateParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_id: Option<String>,
    pub turn_id: String,
    /// At most [`EVOLUTION_RATE_TOOL_CALLS_MAX`] tool call ids.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_call_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_key: Option<EvolutionTargetKey>,
    pub rating: EvolutionRating,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl EvolutionRateParams {
    pub fn validate(&self) -> Result<(), EvolutionParamsError> {
        atom("threadId", &self.thread_id)?;
        if let Some(subagent) = &self.subagent_id {
            atom("subagentId", subagent)?;
        }
        atom("turnId", &self.turn_id)?;
        if self.tool_call_ids.len() > EVOLUTION_RATE_TOOL_CALLS_MAX {
            return Err(EvolutionParamsError {
                field: "toolCallIds",
                reason: "must name at most 64 tool calls",
            });
        }
        for call in &self.tool_call_ids {
            atom("toolCallIds", call)?;
        }
        if self
            .reason
            .as_deref()
            .is_some_and(|reason| reason.chars().count() > EVOLUTION_RATE_REASON_MAX_CHARS)
        {
            return Err(EvolutionParamsError {
                field: "reason",
                reason: "must be at most 500 characters",
            });
        }
        Ok(())
    }
}

/// `evolution/ratings/list`: which turns of a thread `evolution/rate`
/// accepts. With `subagentId` the turns of that subagent of the thread,
/// resolved as for `evolution/rate`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionRatingsListParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_id: Option<String>,
}

impl EvolutionRatingsListParams {
    pub fn validate(&self) -> Result<(), EvolutionParamsError> {
        atom("threadId", &self.thread_id)?;
        if let Some(subagent) = &self.subagent_id {
            atom("subagentId", subagent)?;
        }
        Ok(())
    }
}

/// One ratable turn: it has at least one recorded skill usage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionRatableTurn {
    /// Recorded turn id; send it as `evolution/rate.turnId`.
    pub turn_id: String,
    /// Recorded `skill` tool calls that started the turn's usages; empty
    /// for usages recorded before tool calls were kept.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_call_ids: Vec<String>,
    pub target_keys: Vec<EvolutionTargetKey>,
    /// The rating that stands (the latest across the turn's usages).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rating: Option<EvolutionRating>,
}

/// Newest turns first, at most [`EVOLUTION_RATINGS_LIST_MAX`]. Empty while
/// `signals.rating_ui` is off.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionRatingsListResult {
    pub items: Vec<EvolutionRatableTurn>,
    /// Older ratable turns were left out.
    pub truncated: bool,
}

/// `recorded` is whether the requested rating now stands for at least one
/// usage of the turn; `false` when no usage of the turn is recorded (for
/// example the skill call failed, its target is off, or the data was
/// cleared) or the rating control signal is off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionRateResult {
    pub recorded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionTargetDistillParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    pub target_key: EvolutionTargetKey,
}

impl EvolutionTargetDistillParams {
    pub fn validate(&self) -> Result<(), EvolutionParamsError> {
        workspace(&self.workspace)
    }
}

/// Outcome of a manual distillation request. Only `queued` schedules work;
/// the job itself still runs from the session's idle step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvolutionDistillOutcome {
    Queued,
    /// Evolution, the target or its propose mode is not active.
    Disabled,
    /// The target is not a known skill of a session for that workspace.
    UnknownTarget,
    /// The distill model cannot be used; `reason` says why.
    ModelUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionTargetDistillResult {
    pub outcome: EvolutionDistillOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvolutionDataScope {
    Project,
    User,
    All,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionDataClearParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    pub scope: EvolutionDataScope,
    /// Must be `true`; the server rejects anything else.
    pub confirm: bool,
}

impl EvolutionDataClearParams {
    pub fn validate(&self) -> Result<(), EvolutionParamsError> {
        workspace(&self.workspace)?;
        if !self.confirm {
            return Err(EvolutionParamsError {
                field: "confirm",
                reason: "clearing evolution data requires confirm=true",
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionDataClearResult {
    pub cleared: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvolutionChangedReason {
    Proposal,
    Promoted,
    RolledBack,
    Settings,
    Cleared,
}

/// `evolution/changed` notification payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionChangedNotification {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_key: Option<EvolutionTargetKey>,
    pub reason: EvolutionChangedReason,
}

/// Per-item switch in `targets.<type>.items`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct EvolutionItemSetting {
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvolutionTargetScopeSetting {
    All,
    Selected,
}

/// One `targets.<type>` block. Optional fields keep the type's default.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct EvolutionTargetSetting {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<kcoder_types::evolution::EvolutionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<EvolutionTargetScopeSetting>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<std::collections::BTreeMap<String, EvolutionItemSetting>>,
    /// Skill only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_file_edits: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct EvolutionTargetSettings {
    pub skill: EvolutionTargetSetting,
    pub preference: EvolutionTargetSetting,
    pub project_knowledge: EvolutionTargetSetting,
    pub tool_usage: EvolutionTargetSetting,
    pub workflow_template: EvolutionTargetSetting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct EvolutionSignalSettings {
    pub artifact_edits: bool,
    pub procedure_results: bool,
    pub chat_corrections: bool,
    pub rating_ui: bool,
}

/// Reference to an already configured model, case-preserving.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct EvolutionModelRef {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct EvolutionStageModels {
    pub classifier: Option<EvolutionModelRef>,
    pub distill: Option<EvolutionModelRef>,
    pub eval: Option<EvolutionModelRef>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct EvolutionUsageLimit {
    pub monthly_max_tokens: Option<u64>,
}

/// Offline evaluation pass thresholds (`evolution.eval`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct EvolutionEvalSettings {
    /// Minimum share of decisive comparisons the candidate wins, in (0, 1].
    pub win_rate: f64,
    /// Largest accepted relative diversity drop for free text, in [0, 1].
    pub max_diversity_drop: f64,
}

/// The user-level `evolution` settings block with its persisted snake_case
/// keys (plan section 15). It mirrors `kcoder_config::EvolutionSettings`;
/// the server validates it with that type before writing user settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct EvolutionSettings {
    pub enabled: bool,
    pub mode: kcoder_types::evolution::EvolutionMode,
    pub targets: EvolutionTargetSettings,
    pub signals: EvolutionSignalSettings,
    pub distill_min_usages: u32,
    pub candidate_traffic: f64,
    pub promote_threshold: f64,
    pub rollback_threshold: f64,
    pub model: Option<EvolutionModelRef>,
    pub stage_models: EvolutionStageModels,
    pub evidence_ttl_days: u32,
    pub share_aggregates: bool,
    pub usage_limit: EvolutionUsageLimit,
    /// Always present in results. A save without it (a client that
    /// predates the field) keeps the stored thresholds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eval: Option<EvolutionEvalSettings>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionSettingsReadParams {}

/// Result of both settings methods. `revision` identifies the user settings
/// document state and is passed back as `expectedRevision`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EvolutionSettingsReadResult {
    pub settings: EvolutionSettings,
    pub revision: String,
}

/// Writes go to user settings only. A stale revision fails with error data
/// `{ "kind": "evolution_revision_conflict" }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionSettingsSaveParams {
    pub settings: EvolutionSettings,
    pub expected_revision: String,
}

impl EvolutionSettingsSaveParams {
    pub fn validate(&self) -> Result<(), EvolutionParamsError> {
        atom("expectedRevision", &self.expected_revision)
    }
}

#[cfg(test)]
#[path = "evolution_tests.rs"]
mod tests;
