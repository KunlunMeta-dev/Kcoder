//! Target-agnostic self-evolution service layer.
//!
//! This crate owns the on-disk layout under `<scope-root>/evolution/`, the
//! per-usage scoring and Beta statistics, overlay slots, proposals, rollout
//! policy and scope decisions. It knows targets only by
//! [`kcoder_types::evolution::TargetKey`]; adapters, model calls and
//! injection belong to the engine and target integrations.
mod beta;
mod error;
mod evidence;
mod journal;
mod overlay;
mod paths;
mod patterns;
mod preferences;
mod proposals;
mod rollout;
mod scope;
mod score;
mod state;
mod stats;
mod status;
mod store;
mod time;
mod usage_tool_calls;

pub use beta::{BetaPosterior, BetaPrior, CREDIBLE_LEVEL, probability_greater};
pub use error::EvolutionError;
pub use evidence::{
    EVIDENCE_SNIPPET_MAX_BYTES, EVIDENCE_STORE_MAX_SNIPPETS, EvidenceSnippet, truncate_snippet,
};
pub use journal::{JournalRead, JournalStats};
pub use overlay::{
    OVERLAY_RETAINED_REVISIONS, OVERLAY_SLOT_MAX_CHARS, OverlayCandidate, OverlayDocument,
    OverlaySlot, OverlaySlotSource, OverlayView,
};
pub use paths::{
    EVOLUTION_DIR_NAME, EVOLUTION_PROJECTS_DIR_NAME, EvolutionScope, default_data_root,
    resolve_scope_root, target_storage_component,
};
pub use patterns::{
    PATTERN_STATEMENT_MAX_CHARS, PATTERN_TARGETS_MAX, PATTERNS_PER_TARGET_MAX, PatternDocument,
    StoredPattern,
};
pub use preferences::{
    PREFERENCE_VALUE_MAX_CHARS, PREFERENCES_MAX_ITEMS, PreferenceDocument, PreferenceEntry,
    parse_preference_key,
};
pub use proposals::{ProposalCreated, ProposalDraft, proposal_id};
pub use rollout::{
    CanaryWindow, DEFAULT_MIN_OBSERVATIONS, NO_EVALUATOR_MAX_TRAFFIC, RollbackReason,
    RolloutDecision, RolloutPolicy, channel_hash_unit, promotion_requires_user,
};
pub use scope::{
    CROSS_OBJECT_MIN_PER_TARGET, CROSS_OBJECT_MIN_TARGETS, CROSS_USER_MAX_SINGLE_USER_SHARE,
    CROSS_USER_MIN_USERS, DISTILL_CONFLICT_TRIGGER, DistillTrigger, InsufficientReason,
    MAX_COUNTER_EVIDENCE_RATIO, OBJECT_MIN_SESSIONS, OBJECT_MIN_USAGES, PROCEDURE_MIN_USAGES,
    PatternEvidence, PatternScope, cross_user_eligible, decide_pattern_scope, distill_due,
};
pub use score::{
    AMBIGUOUS_ATTRIBUTION_FACTOR, EDIT_RATIO_SATURATION, EXPLICIT_NEGATIVE_RATING_MAX,
    ScoreComponent, SignalWeights, UsageScore, score_usage,
};
pub use state::{DistillCursor, EvolutionState, JobRecord, USER_EDIT_EVIDENCE_MAX};
pub use stats::{
    BetaEvidence, BucketKey, EvolutionStats, ScoredUsage, StatsDiagnostics, score_journals,
};
pub use status::{StatusInputs, TargetSummaryInputs, proposal_summary};
pub use store::{EvolutionStore, FORMAT_VERSION, JobLease, ScopeLock};
pub use time::{month_key, rfc3339_from_unix_ms};

mod compaction;
mod distill;
mod ledger;
mod safety;
mod targets;
pub use compaction::{
    BaselineBucket, CompactionPolicy, CompactionReport, JOURNAL_RETENTION_DAYS, StatsBaseline,
};
pub use distill::{
    DISTILL_EVIDENCE_MAX_BYTES, DISTILL_EVIDENCE_PER_CATEGORY, DISTILL_MAX_PATTERNS, DistillOutput,
    DistillRejection, DistilledKnowledge, DistilledPattern, DistilledPatternKind,
    DistilledPreference, DistilledProposal, DistilledSupport, EvidenceSample,
    distill_output_schema, parse_distill_output, sample_evidence,
};
pub use ledger::{
    AwaitingPromotion, CLASSIFY_QUEUE_MAX, CLASSIFY_QUEUE_TEXT_MAX_BYTES, QueuedClassification,
    RolloutLedger,
};
pub use safety::{COPY_NGRAM_CHARS, COPY_OVERLAP_MAX, copies_evidence, ngram_overlap};
pub use targets::{
    Injection, InjectionPlacement, LearnableTarget, SignalProfile, WritePolicy, overlay_marker,
    render_overlay_block,
};

/// Target types whose integration has shipped. This is the single source
/// for `evolution/status` `implemented` flags and for which target types the
/// `evolution/*` RPCs and REPL commands accept; target integrations add
/// their type here when they ship.
pub const IMPLEMENTED_TARGET_TYPES: &[kcoder_types::evolution::TargetType] = &[
    kcoder_types::evolution::TargetType::Skill,
    kcoder_types::evolution::TargetType::Preference,
    kcoder_types::evolution::TargetType::ProjectKnowledge,
    kcoder_types::evolution::TargetType::ToolUsage,
    kcoder_types::evolution::TargetType::WorkflowTemplate,
];

#[cfg(test)]
mod tests;
