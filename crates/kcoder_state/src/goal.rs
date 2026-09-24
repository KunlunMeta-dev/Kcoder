use anyhow::Context;
use kcoder_types::{ContentBlock, Message};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const GOAL_OBJECTIVE_INLINE_CHAR_LIMIT: usize = 4000;
pub const GOAL_EVENT_CAPACITY: usize = 64;
pub const GOAL_CONTEXT_SNAPSHOT_CHAR_LIMIT: usize = 6000;

/// Non-sensitive verifier runtime selection persisted when a strict goal is created.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoalVerifierSelection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Multi-model verifier panel frozen at strict-goal creation; two or more entries enable majority voting.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verifier_panel: Vec<kcoder_config::GoalProModelSlotConfig>,
    #[serde(default = "default_goal_verifier_max_turns")]
    pub verifier_max_turns: usize,
    /// Semantic completion-rejection limit frozen for a new Goal Pro; None preserves unlimited behavior for old goals.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_rejection_limit: Option<usize>,
    /// Machine acceptance policy frozen when a strict goal is created.
    #[serde(
        default,
        skip_serializing_if = "kcoder_config::GoalProVerificationSettings::is_default"
    )]
    pub verification: kcoder_config::GoalProVerificationSettings,
}

impl GoalVerifierSelection {
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

impl Default for GoalVerifierSelection {
    fn default() -> Self {
        Self {
            profile: None,
            provider: None,
            model: None,
            verifier_panel: Vec::new(),
            verifier_max_turns: default_goal_verifier_max_turns(),
            completion_rejection_limit: None,
            verification: kcoder_config::GoalProVerificationSettings::default(),
        }
    }
}

/// Private verifier baseline saved at goal creation for a workspace without a Git HEAD.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoalWorkspaceBaseline {
    pub bundle_path: PathBuf,
    pub bundle_sha256: String,
    pub commit: String,
    pub source_root: PathBuf,
}

fn default_goal_verifier_max_turns() -> usize {
    kcoder_config::default_goal_pro_verifier_max_turns()
}

pub fn goal_report_relative_path(goal_id: &str) -> PathBuf {
    PathBuf::from(".kcoder")
        .join("goal-reports")
        .join(format!("{}.md", crate::artifact_id_path_component(goal_id)))
}

/// Persistent long-running objective driven by the `/goal` command.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Goal {
    pub goal_id: String,
    pub objective: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective_file: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "GoalMode::is_standard")]
    pub mode: GoalMode,
    #[serde(default, skip_serializing_if = "GoalVerificationKind::is_artifact")]
    pub verification_kind: GoalVerificationKind,
    #[serde(default, skip_serializing_if = "GoalVerifierSelection::is_default")]
    pub verifier_selection: GoalVerifierSelection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_baseline: Option<GoalWorkspaceBaseline>,
    /// Optional durable orchestration-work binding; without it the goal and PlanStore are independent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestrate_work_id: Option<String>,
    pub status: GoalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<u64>,
    pub tokens_used: u64,
    pub time_used_seconds: u64,
    /// Execution epoch: zero at creation, then one increment per admitted outer Engine turn.
    /// API retries and tool iterations do not increment it.
    #[serde(default)]
    pub turn_count: u64,
    #[serde(default)]
    pub continuation_count: u32,
    #[serde(default)]
    pub complete_rejected_count: u32,
    /// Cumulative semantic Fail/Flaky results from deterministic pre-gates and verifier/machine gates; infrastructure errors are excluded.
    #[serde(default)]
    pub semantic_completion_rejected_count: usize,
    /// Current primary-agent model-escalation rung; zero means no switch has occurred.
    #[serde(default)]
    pub model_escalation_rung: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_candidate_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_candidate_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_candidate_reason: Option<String>,
    #[serde(default)]
    pub blocked_candidate_count: u32,
    #[serde(default)]
    pub blocked_audit_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_candidate_last_turn: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_progress_fingerprint: Option<String>,
    #[serde(default)]
    pub stall_count: u32,
    /// Semantic context captured at goal creation so a strict verifier can resolve references such as “continue.”
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_snapshot: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<GoalEvent>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Deserialize)]
struct GoalWire {
    goal_id: String,
    objective: String,
    #[serde(default)]
    objective_file: Option<PathBuf>,
    #[serde(default)]
    mode: GoalMode,
    #[serde(default)]
    verification_kind: GoalVerificationKind,
    #[serde(default)]
    verifier_selection: GoalVerifierSelection,
    #[serde(default)]
    workspace_baseline: Option<GoalWorkspaceBaseline>,
    #[serde(default)]
    orchestrate_work_id: Option<String>,
    status: GoalStatus,
    #[serde(default)]
    token_budget: Option<u64>,
    tokens_used: u64,
    time_used_seconds: u64,
    #[serde(default)]
    turn_count: u64,
    #[serde(default)]
    continuation_count: u32,
    #[serde(default)]
    complete_rejected_count: u32,
    #[serde(default)]
    semantic_completion_rejected_count: usize,
    #[serde(default)]
    model_escalation_rung: u32,
    #[serde(default)]
    blocked_candidate_fingerprint: Option<String>,
    #[serde(default)]
    blocked_candidate_id: Option<String>,
    #[serde(default)]
    blocked_candidate_reason: Option<String>,
    #[serde(default)]
    blocked_candidate_count: u32,
    #[serde(default)]
    blocked_audit_version: u32,
    #[serde(default)]
    blocked_candidate_last_turn: Option<u64>,
    #[serde(default)]
    last_progress_fingerprint: Option<String>,
    #[serde(default)]
    stall_count: u32,
    #[serde(default)]
    context_snapshot: Option<String>,
    #[serde(default)]
    events: Vec<GoalEvent>,
    created_at_ms: u64,
    updated_at_ms: u64,
    #[serde(default)]
    revision: u64,
}

impl<'de> Deserialize<'de> for Goal {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let mut wire = GoalWire::deserialize(deserializer)?;
        if wire.blocked_audit_version != 1 {
            // Legacy counts did not prove consecutive execution epochs.
            wire.blocked_candidate_count = 0;
            wire.blocked_candidate_last_turn = None;
            wire.blocked_candidate_fingerprint = None;
            wire.blocked_candidate_id = None;
            wire.blocked_candidate_reason = None;
        }
        if wire.verification_kind.is_answer() && !wire.mode.is_strict() {
            return Err(serde::de::Error::custom(
                "Answer verification requires Strict goal mode",
            ));
        }
        Ok(Self {
            goal_id: wire.goal_id,
            objective: wire.objective,
            objective_file: wire.objective_file,
            mode: wire.mode,
            verification_kind: wire.verification_kind,
            verifier_selection: wire.verifier_selection,
            workspace_baseline: wire.workspace_baseline,
            orchestrate_work_id: wire.orchestrate_work_id,
            status: wire.status,
            token_budget: wire.token_budget,
            tokens_used: wire.tokens_used,
            time_used_seconds: wire.time_used_seconds,
            turn_count: wire.turn_count,
            continuation_count: wire.continuation_count,
            complete_rejected_count: wire.complete_rejected_count,
            semantic_completion_rejected_count: wire.semantic_completion_rejected_count,
            model_escalation_rung: wire.model_escalation_rung,
            blocked_candidate_fingerprint: wire.blocked_candidate_fingerprint,
            blocked_candidate_id: wire.blocked_candidate_id,
            blocked_candidate_reason: wire.blocked_candidate_reason,
            blocked_candidate_count: wire.blocked_candidate_count,
            blocked_audit_version: 1,
            blocked_candidate_last_turn: wire.blocked_candidate_last_turn,
            last_progress_fingerprint: wire.last_progress_fingerprint,
            stall_count: wire.stall_count,
            context_snapshot: wire.context_snapshot,
            events: wire.events,
            created_at_ms: wire.created_at_ms,
            updated_at_ms: wire.updated_at_ms,
            revision: wire.revision,
        })
    }
}

impl Goal {
    pub fn new(objective: impl Into<String>, token_budget: Option<u64>) -> Self {
        Self::new_with_file(objective, None, token_budget)
    }

    pub fn new_with_file(
        objective: impl Into<String>,
        objective_file: Option<PathBuf>,
        token_budget: Option<u64>,
    ) -> Self {
        Self::new_with_file_and_mode(objective, objective_file, token_budget, GoalMode::Standard)
    }

    pub fn new_with_file_and_mode(
        objective: impl Into<String>,
        objective_file: Option<PathBuf>,
        token_budget: Option<u64>,
        mode: GoalMode,
    ) -> Self {
        Self::new_with_file_mode_and_verification(
            objective,
            objective_file,
            token_budget,
            mode,
            GoalVerificationKind::Artifact,
        )
        .expect("Artifact verification is valid for every goal mode")
    }

    pub fn new_with_file_mode_and_verification(
        objective: impl Into<String>,
        objective_file: Option<PathBuf>,
        token_budget: Option<u64>,
        mode: GoalMode,
        verification_kind: GoalVerificationKind,
    ) -> anyhow::Result<Self> {
        Self::new_with_file_mode_and_verification_and_verifier(
            objective,
            objective_file,
            token_budget,
            mode,
            verification_kind,
            GoalVerifierSelection::default(),
        )
    }

    pub fn new_with_file_mode_and_verification_and_verifier(
        objective: impl Into<String>,
        objective_file: Option<PathBuf>,
        token_budget: Option<u64>,
        mode: GoalMode,
        verification_kind: GoalVerificationKind,
        verifier_selection: GoalVerifierSelection,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(
            mode.is_strict() || verification_kind.is_artifact(),
            "Answer verification requires Strict goal mode"
        );
        let now = super::now_millis();
        Ok(Self {
            goal_id: format!("goal-{}", generate_unique_artifact_id()),
            objective: objective.into(),
            objective_file,
            mode,
            verification_kind,
            verifier_selection,
            workspace_baseline: None,
            orchestrate_work_id: None,
            status: GoalStatus::Active,
            token_budget,
            tokens_used: 0,
            time_used_seconds: 0,
            turn_count: 0,
            continuation_count: 0,
            complete_rejected_count: 0,
            semantic_completion_rejected_count: 0,
            model_escalation_rung: 0,
            blocked_candidate_fingerprint: None,
            blocked_candidate_id: None,
            blocked_candidate_reason: None,
            blocked_candidate_count: 0,
            blocked_audit_version: 1,
            blocked_candidate_last_turn: None,
            last_progress_fingerprint: None,
            stall_count: 0,
            context_snapshot: None,
            events: Vec::new(),
            created_at_ms: now,
            updated_at_ms: now,
            revision: 0,
        })
    }

    pub fn budget_exhausted(&self) -> bool {
        self.token_budget
            .map(|budget| self.tokens_used >= budget)
            .unwrap_or(false)
    }

    pub fn push_event(&mut self, kind: GoalEventKind, summary: impl Into<String>) {
        if self.events.len() >= GOAL_EVENT_CAPACITY {
            let overflow = self.events.len() + 1 - GOAL_EVENT_CAPACITY;
            self.events.drain(..overflow);
        }
        self.events.push(GoalEvent {
            kind,
            timestamp_ms: super::now_millis(),
            summary: summary.into().chars().take(240).collect(),
        });
    }

    pub fn latest_verification_rejection(&self) -> Option<&GoalEvent> {
        self.events
            .iter()
            .rev()
            .find_map(|event| match event.kind {
                GoalEventKind::VerificationRejected => Some(Some(event)),
                GoalEventKind::VerificationPassed => Some(None),
                _ => None,
            })
            .flatten()
    }

    /// Return the latest semantic rejection; protocol or runner infrastructure errors are not candidate-patch feedback.
    pub fn latest_semantic_verification_rejection(&self) -> Option<&GoalEvent> {
        self.events
            .iter()
            .rev()
            .find_map(|event| match event.kind {
                GoalEventKind::VerificationPassed => Some(None),
                GoalEventKind::VerificationRejected
                    if !event.summary.starts_with("verdict=infrastructure_error:") =>
                {
                    Some(Some(event))
                }
                _ => None,
            })
            .flatten()
    }

    /// Whether the latest verifier result is an infrastructure or protocol failure.
    pub fn latest_verification_was_infrastructure_error(&self) -> bool {
        self.events.iter().rev().find_map(|event| match event.kind {
            GoalEventKind::VerificationPassed => Some(false),
            GoalEventKind::VerificationRejected => {
                Some(event.summary.starts_with("verdict=infrastructure_error:"))
            }
            _ => None,
        }) == Some(true)
    }

    pub(crate) fn touch(&mut self) {
        self.touch_at(super::now_millis());
    }

    pub(crate) fn touch_at(&mut self, now_ms: u64) {
        self.revision = self.revision.wrapping_add(1);
        self.updated_at_ms = now_ms;
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum GoalVerificationKind {
    #[default]
    Artifact,
    Answer,
}

impl GoalVerificationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Artifact => "artifact",
            Self::Answer => "answer",
        }
    }

    pub fn is_artifact(&self) -> bool {
        matches!(self, Self::Artifact)
    }

    pub fn is_answer(self) -> bool {
        matches!(self, Self::Answer)
    }
}

impl<'de> Deserialize<'de> for GoalVerificationKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "answer" => Self::Answer,
            _ => Self::Artifact,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalVerificationVerdict {
    Pass,
    Fail,
    Flaky,
    InfrastructureError,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoalVerificationCommitOutcome {
    Applied(Goal),
    Stale(Option<Goal>),
}

impl GoalVerificationVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Fail => "fail",
            Self::Flaky => "flaky",
            Self::InfrastructureError => "infrastructure_error",
        }
    }

    pub fn passed(self) -> bool {
        matches!(self, Self::Pass)
    }

    pub fn is_semantic_rejection(self) -> bool {
        matches!(self, Self::Fail | Self::Flaky)
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum GoalMode {
    #[default]
    Standard,
    Arrangement,
    Strict,
}

impl GoalMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Arrangement => "arrangement",
            Self::Strict => "strict",
        }
    }

    pub fn is_standard(&self) -> bool {
        matches!(self, Self::Standard)
    }

    pub fn is_arrangement(self) -> bool {
        matches!(self, Self::Arrangement)
    }

    pub fn is_strict(self) -> bool {
        matches!(self, Self::Strict)
    }
}

impl<'de> Deserialize<'de> for GoalMode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "standard" => Self::Standard,
            "arrangement" => Self::Arrangement,
            "strict" => Self::Strict,
            _ => Self::Standard,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedGoalObjective {
    pub objective: String,
    pub objective_file: Option<PathBuf>,
    pub materialized: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Active,
    Paused,
    Blocked,
    UsageLimited,
    BudgetLimited,
    Complete,
    Cancelled,
}

impl<'de> Deserialize<'de> for GoalStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "active" => Self::Active,
            "paused" => Self::Paused,
            "blocked" => Self::Blocked,
            "usage_limited" => Self::UsageLimited,
            "budget_limited" => Self::BudgetLimited,
            "complete" => Self::Complete,
            "cancelled" => Self::Cancelled,
            _ => Self::Paused,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoalEvent {
    pub kind: GoalEventKind,
    pub timestamp_ms: u64,
    pub summary: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalEventKind {
    Continuation,
    Paused,
    Resumed,
    BlockedCandidate,
    Blocked,
    Stall,
    CompletionRejected,
    CompletionRejectionLimitReached,
    VerificationPassed,
    VerificationRejected,
    BudgetLimited,
    UsageLimited,
    Complete,
    Cancelled,
}

impl GoalEventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Continuation => "continuation",
            Self::Paused => "paused",
            Self::Resumed => "resumed",
            Self::BlockedCandidate => "blocked_candidate",
            Self::Blocked => "blocked",
            Self::Stall => "stall",
            Self::CompletionRejected => "completion_rejected",
            Self::CompletionRejectionLimitReached => "completion_rejection_limit_reached",
            Self::VerificationPassed => "verification_passed",
            Self::VerificationRejected => "verification_rejected",
            Self::BudgetLimited => "budget_limited",
            Self::UsageLimited => "usage_limited",
            Self::Complete => "complete",
            Self::Cancelled => "cancelled",
        }
    }
}

impl GoalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Blocked => "blocked",
            Self::UsageLimited => "usage_limited",
            Self::BudgetLimited => "budget_limited",
            Self::Complete => "complete",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_active(self) -> bool {
        matches!(self, Self::Active)
    }

    /// Allow explicit recovery after the user resolves a paused, blocked, or allowance-limited state.
    pub fn is_user_resumable(self) -> bool {
        matches!(self, Self::Paused | Self::Blocked | Self::UsageLimited)
    }

    pub fn is_unfinished(self) -> bool {
        !matches!(
            self,
            Self::Complete | Self::Cancelled | Self::BudgetLimited | Self::UsageLimited
        )
    }

    pub fn is_history_worthy(self) -> bool {
        matches!(
            self,
            Self::Complete | Self::Cancelled | Self::Blocked | Self::BudgetLimited | Self::UsageLimited
        )
    }
}

pub fn prepare_goal_objective(
    cwd: impl AsRef<Path>,
    objective: &str,
) -> anyhow::Result<PreparedGoalObjective> {
    let objective = objective.trim();
    if objective.chars().count() <= GOAL_OBJECTIVE_INLINE_CHAR_LIMIT {
        return Ok(PreparedGoalObjective {
            objective: objective.to_string(),
            objective_file: None,
            materialized: false,
        });
    }

    let dir = cwd
        .as_ref()
        .join(".kcoder")
        .join("attachments")
        .join(generate_unique_artifact_id());
    fs::create_dir_all(&dir)
        .with_context(|| format!("failed to create goal objective attachment dir {:?}", dir))?;
    let path = dir.join("goal-objective.md");
    fs::write(&path, objective)
        .with_context(|| format!("failed to write goal objective attachment {:?}", path))?;

    Ok(PreparedGoalObjective {
        objective: format!(
            "Long goal objective materialized at {}. Treat that file as the authoritative objective.",
            path.display()
        ),
        objective_file: Some(path),
        materialized: true,
    })
}

pub fn goal_objective_text(goal: &Goal) -> anyhow::Result<String> {
    let Some(path) = goal.objective_file.as_ref() else {
        return Ok(goal.objective.clone());
    };
    fs::read_to_string(path)
        .with_context(|| format!("failed to read materialized goal objective {:?}", path))
}

/// Extract a bounded semantic snapshot from conversation before goal creation without copying reasoning, ToolUse, or ToolResult blocks.
pub fn goal_context_snapshot(messages: &[Message]) -> Option<String> {
    let mut entries = messages
        .iter()
        .rev()
        .filter_map(|message| match message {
            Message::User { content, .. } => {
                let text = visible_text(content);
                (!text.is_empty() && kcoder_types::is_real_user_message(message))
                    .then(|| format!("User: {text}"))
            }
            Message::Assistant { content, .. } => {
                let text = visible_text(content);
                (!text.is_empty()).then(|| format!("Assistant: {text}"))
            }
        })
        .take(8)
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return None;
    }
    entries.reverse();
    let joined = entries.join("\n\n");
    let chars = joined.chars().collect::<Vec<_>>();
    let start = chars.len().saturating_sub(GOAL_CONTEXT_SNAPSHOT_CHAR_LIMIT);
    Some(chars[start..].iter().collect())
}

fn visible_text(content: &[ContentBlock]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.trim()),
            _ => None,
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn generate_unique_artifact_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = u128::from(std::process::id());
    format!("{now:032x}-{pid:08x}-{n:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_goal_objective_is_materialized_and_read_back() {
        let tmp = tempfile::tempdir().unwrap();
        let objective = "x".repeat(GOAL_OBJECTIVE_INLINE_CHAR_LIMIT + 1);

        let prepared = prepare_goal_objective(tmp.path(), &objective).unwrap();

        assert!(prepared.materialized);
        let path = prepared.objective_file.as_ref().unwrap();
        assert!(path.ends_with("goal-objective.md"));
        assert_eq!(fs::read_to_string(path).unwrap(), objective);

        let goal = Goal::new_with_file(prepared.objective, prepared.objective_file, None);
        assert_eq!(goal_objective_text(&goal).unwrap(), objective);
    }

    #[test]
    fn inline_goal_objective_stays_inline() {
        let tmp = tempfile::tempdir().unwrap();
        let prepared = prepare_goal_objective(tmp.path(), "  concise objective  ").unwrap();
        assert_eq!(prepared.objective, "concise objective");
        assert!(prepared.objective_file.is_none());
        assert!(!prepared.materialized);
    }

    #[test]
    fn goal_report_path_uses_one_safe_component() {
        let path = goal_report_relative_path("../../outside");
        assert_eq!(path.components().count(), 3);
        assert!(path.starts_with(".kcoder/goal-reports"));
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("md")
        );
        assert!(!path.to_string_lossy().contains("../"));
    }

    #[test]
    fn generated_goal_ids_are_unique_and_path_safe() {
        let ids = (0..1_000)
            .map(|_| Goal::new("ship", None).goal_id)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), 1_000);
        assert!(
            ids.iter()
                .all(|id| crate::artifact_id_path_component(id) == *id)
        );
    }

    #[test]
    fn answer_verification_requires_strict_mode_and_unknown_values_fail_safe() {
        assert!(
            Goal::new_with_file_mode_and_verification(
                "research",
                None,
                None,
                GoalMode::Standard,
                GoalVerificationKind::Answer,
            )
            .is_err()
        );
        assert_eq!(
            serde_json::from_str::<GoalVerificationKind>("\"future_kind\"").unwrap(),
            GoalVerificationKind::Artifact
        );
        assert_eq!(
            serde_json::from_str::<GoalVerificationKind>("\"answer\"").unwrap(),
            GoalVerificationKind::Answer
        );

        let mut invalid = serde_json::to_value(
            Goal::new_with_file_mode_and_verification(
                "research",
                None,
                None,
                GoalMode::Strict,
                GoalVerificationKind::Answer,
            )
            .unwrap(),
        )
        .unwrap();
        invalid["mode"] = serde_json::json!("standard");
        assert!(serde_json::from_value::<Goal>(invalid).is_err());
    }

    #[test]
    fn generated_artifact_id_preserves_each_uniqueness_component() {
        let id = generate_unique_artifact_id();
        let parts = id.split('-').collect::<Vec<_>>();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].len(), 32);
        assert_eq!(parts[1].len(), 8);
        assert_eq!(parts[2].len(), 16);
        assert!(
            parts
                .iter()
                .all(|part| part.chars().all(|ch| ch.is_ascii_hexdigit()))
        );
    }

    #[test]
    fn goal_defaults_to_active_standard_mode() {
        let goal = Goal::new("ship it", Some(100));
        assert_eq!(goal.mode, GoalMode::Standard);
        assert_eq!(goal.status, GoalStatus::Active);
        assert_eq!(goal.token_budget, Some(100));
        assert_eq!(goal.tokens_used, 0);
        assert_eq!(goal.turn_count, 0);
    }

    #[test]
    fn goal_status_helpers_cover_terminal_and_unfinished_states() {
        assert!(GoalStatus::Active.is_active());
        assert!(!GoalStatus::Active.is_user_resumable());
        assert!(GoalStatus::Paused.is_unfinished());
        assert!(GoalStatus::Paused.is_user_resumable());
        assert!(GoalStatus::Blocked.is_unfinished());
        assert!(GoalStatus::Blocked.is_user_resumable());
        assert!(GoalStatus::Blocked.is_history_worthy());
        assert!(GoalStatus::UsageLimited.is_user_resumable());
        assert!(!GoalStatus::BudgetLimited.is_user_resumable());
        assert!(!GoalStatus::Complete.is_unfinished());
        assert!(!GoalStatus::Complete.is_user_resumable());
        assert!(GoalStatus::Complete.is_history_worthy());
        assert_eq!(GoalStatus::UsageLimited.as_str(), "usage_limited");
    }

    #[test]
    fn goal_serde_defaults_mode_and_turn_count() {
        let value = serde_json::json!({
            "goal_id": "goal-1",
            "objective": "finish",
            "status": "active",
            "token_budget": null,
            "tokens_used": 0,
            "time_used_seconds": 0,
            "created_at_ms": 1,
            "updated_at_ms": 1
        });
        let goal: Goal = serde_json::from_value(value).unwrap();
        assert_eq!(goal.mode, GoalMode::Standard);
        assert_eq!(goal.turn_count, 0);
    }

    #[test]
    fn strict_goal_persists_verifier_selection() {
        let selection = GoalVerifierSelection {
            profile: Some("mimo-review".to_string()),
            provider: Some("minimax".to_string()),
            model: Some("mimo-v2.5".to_string()),
            verifier_panel: vec![kcoder_config::GoalProModelSlotConfig {
                profile: Some("mimo-review".to_string()),
                provider: None,
                model: None,
            }],
            verifier_max_turns: 6,
            completion_rejection_limit: Some(5),
            verification: kcoder_config::GoalProVerificationSettings::default(),
        };
        let goal = Goal::new_with_file_mode_and_verification_and_verifier(
            "verify",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Artifact,
            selection.clone(),
        )
        .unwrap();
        let restored: Goal = serde_json::from_value(serde_json::to_value(&goal).unwrap()).unwrap();
        assert_eq!(restored.verifier_selection, selection);
    }

    #[test]
    fn strict_goal_persists_private_workspace_baseline_and_old_goals_default_to_none() {
        let mut goal = Goal::new_with_file_and_mode("verify", None, None, GoalMode::Strict);
        goal.workspace_baseline = Some(GoalWorkspaceBaseline {
            bundle_path: PathBuf::from("/private/session/goal-baseline.bundle"),
            bundle_sha256: "a".repeat(64),
            commit: "b".repeat(40),
            source_root: PathBuf::from("/workspace"),
        });

        let value = serde_json::to_value(&goal).unwrap();
        let restored: Goal = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(restored.workspace_baseline, goal.workspace_baseline);

        let mut legacy = value;
        legacy.as_object_mut().unwrap().remove("workspace_baseline");
        let restored: Goal = serde_json::from_value(legacy).unwrap();
        assert_eq!(restored.workspace_baseline, None);
    }

    #[test]
    fn old_goal_without_model_escalation_rung_defaults_to_zero() {
        let goal = Goal::new("ship", None);
        let mut value = serde_json::to_value(&goal).unwrap();
        // Simulate an old goal persisted before this field existed.
        value
            .as_object_mut()
            .unwrap()
            .remove("model_escalation_rung");
        let restored: Goal = serde_json::from_value(value).unwrap();
        assert_eq!(restored.model_escalation_rung, 0);

        let mut escalated = Goal::new("ship", None);
        escalated.model_escalation_rung = 2;
        let restored: Goal =
            serde_json::from_value(serde_json::to_value(&escalated).unwrap()).unwrap();
        assert_eq!(restored.model_escalation_rung, 2);
    }

    #[test]
    fn old_goal_without_verifier_panel_defaults_to_single_verifier() {
        let goal = Goal::new_with_file_mode_and_verification_and_verifier(
            "verify",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Artifact,
            GoalVerifierSelection {
                profile: Some("mimo-review".to_string()),
                ..GoalVerifierSelection::default()
            },
        )
        .unwrap();
        let value = serde_json::to_value(goal).unwrap();
        // Do not serialize an empty panel, matching goals persisted before this field existed.
        assert!(
            value["verifier_selection"]
                .as_object()
                .unwrap()
                .get("verifier_panel")
                .is_none()
        );

        let restored: Goal = serde_json::from_value(value).unwrap();

        assert!(restored.verifier_selection.verifier_panel.is_empty());
    }

    #[test]
    fn old_goal_without_rejection_limit_keeps_unlimited_compatibility() {
        let selection = GoalVerifierSelection {
            completion_rejection_limit: Some(8),
            ..GoalVerifierSelection::default()
        };
        let goal = Goal::new_with_file_mode_and_verification_and_verifier(
            "verify",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Artifact,
            selection,
        )
        .unwrap();
        let mut value = serde_json::to_value(goal).unwrap();
        value["verifier_selection"]
            .as_object_mut()
            .unwrap()
            .remove("completion_rejection_limit");
        value
            .as_object_mut()
            .unwrap()
            .remove("semantic_completion_rejected_count");

        let restored: Goal = serde_json::from_value(value).unwrap();

        assert_eq!(restored.verifier_selection.completion_rejection_limit, None);
        assert_eq!(restored.semantic_completion_rejected_count, 0);
    }

    #[test]
    fn goal_status_deserializes_unknown_as_paused() {
        for value in ["paused", "garbage", "Active2"] {
            let status: GoalStatus = serde_json::from_value(serde_json::json!(value)).unwrap();
            assert_eq!(status, GoalStatus::Paused);
        }
    }

    #[test]
    fn goal_mode_deserializes_unknown_as_standard_and_strict_roundtrips() {
        let unknown: GoalMode = serde_json::from_value(serde_json::json!("future_mode")).unwrap();
        assert_eq!(unknown, GoalMode::Standard);

        let strict: GoalMode = serde_json::from_value(serde_json::json!("strict")).unwrap();
        assert_eq!(strict, GoalMode::Strict);
        assert_eq!(
            serde_json::to_value(strict).unwrap(),
            serde_json::json!("strict")
        );
    }

    #[test]
    fn goal_events_keep_only_the_latest_entries() {
        let mut goal = Goal::new("ship it", None);
        for index in 0..70 {
            goal.push_event(GoalEventKind::Continuation, format!("event-{index}"));
        }

        assert_eq!(goal.events.len(), 64);
        assert_eq!(goal.events.first().unwrap().summary, "event-6");
        assert_eq!(goal.events.last().unwrap().summary, "event-69");
    }

    #[test]
    fn latest_verification_rejection_respects_latest_verification_terminal_event() {
        let mut goal = Goal::new("ship it", None);
        assert!(goal.latest_verification_rejection().is_none());

        goal.push_event(GoalEventKind::VerificationRejected, "first rejection");
        goal.push_event(GoalEventKind::Continuation, "work continued");
        assert_eq!(
            goal.latest_verification_rejection()
                .map(|event| event.summary.as_str()),
            Some("first rejection")
        );

        goal.push_event(GoalEventKind::VerificationRejected, "latest rejection");
        assert_eq!(
            goal.latest_verification_rejection()
                .map(|event| event.summary.as_str()),
            Some("latest rejection")
        );

        goal.push_event(GoalEventKind::VerificationPassed, "verified");
        assert!(goal.latest_verification_rejection().is_none());

        goal.push_event(GoalEventKind::Resumed, "goal resumed");
        assert!(goal.latest_verification_rejection().is_none());
    }

    #[test]
    fn semantic_rejection_skips_verifier_infrastructure_errors() {
        let mut goal = Goal::new("ship it", None);
        goal.push_event(
            GoalEventKind::VerificationRejected,
            "verdict=fail: missing production path",
        );
        goal.push_event(
            GoalEventKind::VerificationRejected,
            "verdict=infrastructure_error: maximum turns reached",
        );

        assert!(goal.latest_verification_was_infrastructure_error());
        assert_eq!(
            goal.latest_semantic_verification_rejection()
                .map(|event| event.summary.as_str()),
            Some("verdict=fail: missing production path")
        );

        goal.push_event(GoalEventKind::VerificationPassed, "verified");
        assert!(!goal.latest_verification_was_infrastructure_error());
        assert!(goal.latest_semantic_verification_rejection().is_none());
    }

    #[test]
    fn context_snapshot_keeps_semantic_text_without_tool_traffic() {
        let messages = vec![
            Message::user_text("修复 token 刷新问题"),
            Message::Assistant {
                content: vec![
                    ContentBlock::Text {
                        text: "我已经定位到 auth.rs".to_string(),
                    },
                    ContentBlock::ToolUse {
                        id: "tool-1".to_string(),
                        name: "read".to_string(),
                        input: serde_json::json!({"path": "auth.rs"}),
                    },
                ],
                usage: None,
            },
            Message::User {
                origin: kcoder_types::MessageOrigin::Unknown,
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "tool-1".to_string(),
                    content: vec![ContentBlock::Text {
                        text: "secret tool output".to_string(),
                    }],
                    is_error: Some(false),
                }],
            },
        ];

        let snapshot = goal_context_snapshot(&messages).unwrap();
        assert!(snapshot.contains("修复 token 刷新问题"));
        assert!(snapshot.contains("我已经定位到 auth.rs"));
        assert!(!snapshot.contains("secret tool output"));
        assert!(!snapshot.contains("tool-1"));
    }
}
