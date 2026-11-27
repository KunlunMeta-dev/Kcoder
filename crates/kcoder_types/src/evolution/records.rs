use super::{Channel, EvolutionContractError, TargetKey, TargetRevision, validate_evolution_id};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Maximum serialized size of one usage or outcome journal line.
pub const EVOLUTION_RECORD_MAX_BYTES: usize = 64 * 1024;
/// Maximum number of artifacts, concurrent targets, domain fields or
/// categories carried by one record.
pub const USAGE_LIST_MAX_ITEMS: usize = 64;

/// One use of a learnable target (`usages.jsonl`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageRecord {
    pub version: u32,
    /// Stable id used for deduplication and reconciliation.
    pub usage_id: String,
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    /// Tool call that started the usage (for a skill, its `skill` call),
    /// when the call id is a valid evolution id. Clients that do not see the
    /// server turn identity (for example a subagent view) rate by it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    pub target_key: TargetKey,
    pub revision: TargetRevision,
    pub channel: Channel,
    #[serde(default)]
    pub task: UsageTask,
    #[serde(default)]
    pub profile_hints: ProfileHints,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<ArtifactRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub concurrent_targets: Vec<TargetKey>,
    /// Unix epoch milliseconds when the usage started.
    pub started_at_ms: u64,
}

impl UsageRecord {
    pub fn validate(&self) -> Result<(), EvolutionContractError> {
        validate_evolution_id("usageId", &self.usage_id)?;
        validate_evolution_id("threadId", &self.thread_id)?;
        if let Some(turn) = &self.turn_id {
            validate_evolution_id("turnId", turn)?;
        }
        if let Some(attempt) = &self.attempt_id {
            validate_evolution_id("attemptId", attempt)?;
        }
        if let Some(call) = &self.tool_call_id {
            validate_evolution_id("toolCallId", call)?;
        }
        self.revision.validate()?;
        if let Some(evidence) = &self.task.evidence_ref {
            validate_evolution_id("evidenceRef", evidence)?;
        }
        if let Some(hash) = &self.task.request_hash {
            validate_evolution_id("requestHash", hash)?;
        }
        let short_text = |value: &str| value.len() <= 1024 && !value.chars().any(char::is_control);
        if self
            .task
            .arguments
            .as_deref()
            .is_some_and(|value| !short_text(value))
            || self.task.domain.len() > USAGE_LIST_MAX_ITEMS
            || self.task.domain.iter().any(|(key, value)| {
                validate_evolution_id("domain", key).is_err() || !short_text(value)
            })
        {
            return Err(EvolutionContractError::InvalidValue {
                field: "task",
                reason: "arguments and domain values must be at most 1024 bytes without control characters; at most 64 domain fields",
            });
        }
        if self.artifacts.len() > USAGE_LIST_MAX_ITEMS
            || self.concurrent_targets.len() > USAGE_LIST_MAX_ITEMS
        {
            return Err(EvolutionContractError::InvalidValue {
                field: "artifacts",
                reason: "at most 64 artifacts and 64 concurrent targets",
            });
        }
        validate_artifacts(&self.artifacts)
    }
}

fn validate_artifacts(artifacts: &[ArtifactRef]) -> Result<(), EvolutionContractError> {
    let short_text = |value: &str| value.len() <= 1024 && !value.chars().any(char::is_control);
    for artifact in artifacts {
        let valid = match artifact {
            ArtifactRef::File { path, content_hash } => {
                !path.is_empty()
                    && short_text(path)
                    && validate_evolution_id("contentHash", content_hash).is_ok()
            }
            ArtifactRef::Message { message_id } => {
                validate_evolution_id("messageId", message_id).is_ok()
            }
        };
        if !valid {
            return Err(EvolutionContractError::InvalidValue {
                field: "artifacts",
                reason: "file artifacts need a bounded path and a valid content hash; messages need a valid id",
            });
        }
    }
    Ok(())
}

/// Facts about a usage that are only known after its turn settles (what the
/// turn actually did and which artifacts it produced). Usage records are
/// append-only and first-wins, so these facts are journaled separately and
/// merged on read: profile hints are OR-ed, artifacts and concurrent targets
/// are unioned (the first baseline of a path wins).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageAmendment {
    pub version: u32,
    /// Stable id for deduplication (for example derived from the usage id
    /// and the turn that produced the facts).
    pub amendment_id: String,
    pub usage_id: String,
    #[serde(default)]
    pub profile_hints: ProfileHints,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<ArtifactRef>,
    /// Redacted baseline snapshot of each file artifact, by path.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub artifact_evidence: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub concurrent_targets: Vec<TargetKey>,
    pub recorded_at_ms: u64,
}

impl UsageAmendment {
    pub fn validate(&self) -> Result<(), EvolutionContractError> {
        validate_evolution_id("amendmentId", &self.amendment_id)?;
        validate_evolution_id("usageId", &self.usage_id)?;
        if self.artifacts.len() > USAGE_LIST_MAX_ITEMS
            || self.concurrent_targets.len() > USAGE_LIST_MAX_ITEMS
            || self.artifact_evidence.len() > USAGE_LIST_MAX_ITEMS
        {
            return Err(EvolutionContractError::InvalidValue {
                field: "artifacts",
                reason: "at most 64 artifacts, evidence references and concurrent targets",
            });
        }
        for evidence in self.artifact_evidence.values() {
            validate_evolution_id("artifactEvidence", evidence)?;
        }
        validate_artifacts(&self.artifacts)
    }
}

impl UsageRecord {
    /// Merge a later amendment into this record (see [`UsageAmendment`]).
    pub fn apply_amendment(&mut self, amendment: &UsageAmendment) {
        let hints = &mut self.profile_hints;
        hints.wrote_files |= amendment.profile_hints.wrote_files;
        hints.ran_commands |= amendment.profile_hints.ran_commands;
        hints.text_only = (hints.text_only || amendment.profile_hints.text_only)
            && !hints.wrote_files
            && !hints.ran_commands;
        for artifact in &amendment.artifacts {
            let duplicate = self
                .artifacts
                .iter()
                .any(|existing| match (existing, artifact) {
                    (
                        ArtifactRef::File { path: left, .. },
                        ArtifactRef::File { path: right, .. },
                    ) => left == right,
                    (left, right) => left == right,
                });
            if !duplicate && self.artifacts.len() < USAGE_LIST_MAX_ITEMS {
                self.artifacts.push(artifact.clone());
            }
        }
        for target in &amendment.concurrent_targets {
            if target != &self.target_key
                && !self.concurrent_targets.contains(target)
                && self.concurrent_targets.len() < USAGE_LIST_MAX_ITEMS
            {
                self.concurrent_targets.push(target.clone());
            }
        }
    }
}

/// Task summary for one usage. Raw request text never appears here; a
/// redacted snippet may be stored in `evidence/` and referenced by id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageTask {
    /// Hash of the request summary; a changed hash starts a new usage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_hash: Option<String>,
    /// Target arguments, for example the `skill` tool arguments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<String>,
    /// Optional domain fields declared by the target (for example a genre).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub domain: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_ref: Option<String>,
    /// True when the task depends on workspace state and cannot be replayed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub workspace_dependent: bool,
}

/// What actually happened during the turn; selects signal adapters.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileHints {
    #[serde(default)]
    pub wrote_files: bool,
    #[serde(default)]
    pub ran_commands: bool,
    #[serde(default)]
    pub text_only: bool,
}

/// Location of an output produced under a usage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ArtifactRef {
    File {
        path: String,
        #[serde(rename = "contentHash")]
        content_hash: String,
    },
    Message {
        #[serde(rename = "messageId")]
        message_id: String,
    },
}

/// Kind of outcome signal (plan §6.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum SignalKind {
    ArtifactEdit,
    ArtifactKept,
    ArtifactDiscarded,
    Regenerated,
    Correction,
    ToolResult,
    Verification,
    TaskTerminal,
    Rating,
    Exported,
}

/// Generic outcome categories (plan §7.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum OutcomeCategory {
    Accuracy,
    Missing,
    Extra,
    Structure,
    Style,
    Length,
    Format,
    Step,
    Scope,
    Other,
}

/// A category assessment. `domain` is an optional target-declared refinement
/// of the generic category, for example `dialogue` under `style`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CategoryAssessment {
    pub category: OutcomeCategory,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    /// Confidence in `[0, 1]`.
    pub confidence: f64,
}

/// Cause of a failed outcome (plan §7.2). Environment failures never score.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum OutcomeCause {
    Target,
    Environment,
    Unknown,
}

/// Whether an outcome is attributed directly to this target or could not be
/// separated from concurrently used targets.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum Attribution {
    #[default]
    Direct,
    Ambiguous,
}

/// Signal-specific numeric facts. Each signal reads only its own fields;
/// see `kcoder_evolution::score` for the scoring contract.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservationMetrics {
    /// Fraction of the produced artifact changed afterwards (`artifact_edit`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_ratio: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    /// Rating normalized to `[0, 1]` (`rating`); thumbs up is 1, down is 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rating_value: Option<f64>,
    /// Correction severity in `[0, 1]` (`correction`); absent means 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correction_severity: Option<f64>,
    /// Final success of a procedure (`tool_result`, `verification`,
    /// `task_terminal`). Absent for interrupted or unknown results.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub success: Option<bool>,
    /// For `regenerated`: whether a regeneration happened (absent means true);
    /// `false` records a closed window without regeneration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurred: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_step: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, f64>,
}

/// One outcome observation for a usage (`outcomes.jsonl`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutcomeObservation {
    pub version: u32,
    /// Stable id; duplicates are ignored on read.
    pub observation_id: String,
    pub usage_id: String,
    pub signal: SignalKind,
    #[serde(default)]
    pub metrics: ObservationMetrics,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub categories: Vec<CategoryAssessment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<OutcomeCause>,
    #[serde(default)]
    pub attribution: Attribution,
    /// Overall confidence in `[0, 1]` of this observation.
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    /// The target required X, the model did X and the user corrected X or
    /// X failed (plan §7.2). Counted separately and may trigger distillation.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub conflict: bool,
    /// A hard failure (for example a failed hard check); rolls back a canary.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hard_failure: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_ref: Option<String>,
    /// Signal adapter that produced the observation.
    pub source: String,
    /// Unix epoch milliseconds.
    pub observed_at_ms: u64,
}

const fn default_confidence() -> f64 {
    1.0
}

impl OutcomeObservation {
    pub fn validate(&self) -> Result<(), EvolutionContractError> {
        validate_evolution_id("observationId", &self.observation_id)?;
        validate_evolution_id("usageId", &self.usage_id)?;
        if let Some(evidence) = &self.evidence_ref {
            validate_evolution_id("evidenceRef", evidence)?;
        }
        if self.source.is_empty() || self.source.len() > 64 {
            return Err(EvolutionContractError::InvalidValue {
                field: "source",
                reason: "must be 1..=64 bytes",
            });
        }
        let unit = |value: f64| value.is_finite() && (0.0..=1.0).contains(&value);
        if !unit(self.confidence) {
            return Err(EvolutionContractError::InvalidValue {
                field: "confidence",
                reason: "must be within [0, 1]",
            });
        }
        if self.categories.len() > USAGE_LIST_MAX_ITEMS
            || self.metrics.extra.len() > USAGE_LIST_MAX_ITEMS
        {
            return Err(EvolutionContractError::InvalidValue {
                field: "categories",
                reason: "at most 64 categories and 64 extra metrics",
            });
        }
        if self
            .categories
            .iter()
            .filter_map(|item| item.domain.as_deref())
            .any(|domain| validate_evolution_id("domain", domain).is_err())
        {
            return Err(EvolutionContractError::InvalidValue {
                field: "categories.domain",
                reason: "domain categories use the record id alphabet",
            });
        }
        if self.categories.iter().any(|item| !unit(item.confidence)) {
            return Err(EvolutionContractError::InvalidValue {
                field: "categories.confidence",
                reason: "must be within [0, 1]",
            });
        }
        let metrics = &self.metrics;
        if [metrics.rating_value, metrics.correction_severity]
            .into_iter()
            .flatten()
            .any(|value| !unit(value))
        {
            return Err(EvolutionContractError::InvalidValue {
                field: "metrics",
                reason: "ratingValue and correctionSeverity must be within [0, 1]",
            });
        }
        if metrics
            .edit_ratio
            .is_some_and(|value| !value.is_finite() || value < 0.0)
        {
            return Err(EvolutionContractError::InvalidValue {
                field: "metrics.editRatio",
                reason: "must be a finite non-negative number",
            });
        }
        if metrics.extra.values().any(|value| !value.is_finite()) {
            return Err(EvolutionContractError::InvalidValue {
                field: "metrics.extra",
                reason: "values must be finite",
            });
        }
        Ok(())
    }
}
