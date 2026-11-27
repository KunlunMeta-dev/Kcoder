use super::{EvolutionContractError, TargetKey, validate_evolution_id};
use serde::{Deserialize, Serialize};

/// Lifecycle of a proposal (plan §6.3):
/// `draft → evaluated → canary → promoted | rolled_back | rejected`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ProposalState {
    Draft,
    Evaluated,
    Canary,
    Promoted,
    RolledBack,
    Rejected,
}

impl ProposalState {
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::RolledBack | Self::Rejected)
    }

    /// Allowed transitions. A draft may enter canary directly when the target
    /// has no offline evaluator; a promoted proposal may still be rolled back
    /// by the user. Terminal states never change.
    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Draft, Self::Evaluated)
                | (Self::Draft, Self::Canary)
                | (Self::Draft, Self::Rejected)
                | (Self::Evaluated, Self::Canary)
                | (Self::Evaluated, Self::Rejected)
                | (Self::Canary, Self::Promoted)
                | (Self::Canary, Self::RolledBack)
                | (Self::Canary, Self::Rejected)
                | (Self::Promoted, Self::RolledBack)
        )
    }
}

/// Who performed a proposal step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ProposalActor {
    Auto,
    User,
}

/// Where a proposal applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ProposalLocation {
    Overlay,
    TargetFile,
}

/// Replacement of one existing lesson.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LessonRevision {
    pub from: String,
    pub to: String,
}

/// Example text written by the model from a pattern; never copied user work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalExample {
    pub name: String,
    pub text: String,
}

/// Structured change set of a proposal (matches the distill output schema).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalChanges {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lessons_add: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lessons_revise: Vec<LessonRevision>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lessons_remove: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checklist_edits: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub examples: Vec<ProposalExample>,
    /// Unified diff for `target_file` proposals.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

impl ProposalChanges {
    pub fn is_empty(&self) -> bool {
        self.lessons_add.is_empty()
            && self.lessons_revise.is_empty()
            && self.lessons_remove.is_empty()
            && self.checklist_edits.is_empty()
            && self.examples.is_empty()
            && self.diff.is_none()
    }
}

/// Result of the pre-write safety scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SafetyScanResult {
    pub passed: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub findings: Vec<String>,
}

/// Offline pairwise evaluation result. A timed-out evaluation has
/// `completed = false` and never counts as passed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationResult {
    pub completed: bool,
    pub passed: bool,
    pub wins: u32,
    pub losses: u32,
    pub ties: u32,
    #[serde(default)]
    pub hard_check_regressions: u32,
    /// Relative diversity change (negative is a drop), when measured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diversity_delta: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl EvaluationResult {
    /// Candidate win rate excluding ties, when any decisive comparison exists.
    pub fn win_rate(&self) -> Option<f64> {
        let decisive = self.wins + self.losses;
        (decisive > 0).then(|| f64::from(self.wins) / f64::from(decisive))
    }
}

/// One recorded state change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalTransition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<ProposalState>,
    pub to: ProposalState,
    pub actor: ProposalActor,
    pub at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// A persisted proposal (`proposals/<id>.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proposal {
    pub version: u32,
    /// Derived from the content hash and base revision; see
    /// `kcoder_evolution::proposal_id`.
    pub proposal_id: String,
    pub target_key: TargetKey,
    pub base_revision: String,
    pub location: ProposalLocation,
    pub changes: ProposalChanges,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pattern_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safety_scan: Option<SafetyScanResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evaluation: Option<EvaluationResult>,
    pub state: ProposalState,
    pub history: Vec<ProposalTransition>,
    /// Document revision for compare-and-swap updates.
    pub revision: u64,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

impl Proposal {
    pub fn validate(&self) -> Result<(), EvolutionContractError> {
        validate_evolution_id("proposalId", &self.proposal_id)?;
        for id in self.pattern_ids.iter() {
            validate_evolution_id("patternId", id)?;
        }
        for id in self.evidence_ids.iter() {
            validate_evolution_id("evidenceId", id)?;
        }
        if self.history.is_empty() {
            return Err(EvolutionContractError::InvalidValue {
                field: "history",
                reason: "must record at least the creation step",
            });
        }
        Ok(())
    }

    /// The actor of the most recent step.
    pub fn last_actor(&self) -> Option<ProposalActor> {
        self.history.last().map(|step| step.actor)
    }
}
