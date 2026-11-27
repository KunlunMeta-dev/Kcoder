//! Canary channel assignment and promotion/rollback decisions (plan section 12).

use crate::beta::{BetaPrior, probability_greater};
use crate::stats::{BetaEvidence, ScoredUsage};
use kcoder_config::EvolutionSettings;
use kcoder_types::evolution::{Channel, EvolutionMode, TargetKey, TargetRevision};
use sha2::{Digest, Sha256};

/// Observations each channel needs before a probability-based decision.
pub const DEFAULT_MIN_OBSERVATIONS: u64 = 15;
/// Traffic cap for targets without an offline evaluator (plan section 9).
pub const NO_EVALUATOR_MAX_TRAFFIC: f64 = 0.1;

/// Canary rollout policy for one target.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RolloutPolicy {
    pub candidate_traffic: f64,
    pub promote_threshold: f64,
    pub rollback_threshold: f64,
    pub min_observations: u64,
}

impl RolloutPolicy {
    /// Policy from settings. Targets without an offline evaluator get at
    /// most 10% traffic and a doubled observation period (30 per channel).
    pub fn from_settings(settings: &EvolutionSettings, has_offline_evaluator: bool) -> Self {
        let (candidate_traffic, min_observations) = if has_offline_evaluator {
            (settings.candidate_traffic, DEFAULT_MIN_OBSERVATIONS)
        } else {
            (
                settings.candidate_traffic.min(NO_EVALUATOR_MAX_TRAFFIC),
                DEFAULT_MIN_OBSERVATIONS * 2,
            )
        };
        Self {
            candidate_traffic,
            promote_threshold: settings.promote_threshold,
            rollback_threshold: settings.rollback_threshold,
            min_observations,
        }
    }

    /// Channel for a thread. Without an active canary every thread is
    /// stable; otherwise `hash(threadId, targetKey) < traffic` selects the
    /// candidate, so one thread always sees the same version.
    pub fn assign_channel(&self, thread_id: &str, key: &TargetKey, canary_active: bool) -> Channel {
        if canary_active && channel_hash_unit(thread_id, key) < self.candidate_traffic {
            Channel::Candidate
        } else {
            Channel::Stable
        }
    }

    /// Decide on a canary from same-window data only. Both channels share
    /// the same prior (normally the previous stable posterior folded to 10
    /// samples), so the prior never favours either side.
    pub fn decide(&self, window: &CanaryWindow, prior: BetaPrior) -> RolloutDecision {
        if window.candidate.hard_failures > 0 {
            return RolloutDecision::Rollback(RollbackReason::HardFailure);
        }
        if window.candidate.explicit_negatives > 0 {
            return RolloutDecision::Rollback(RollbackReason::ExplicitNegative);
        }
        if window.stable.observations < self.min_observations
            || window.candidate.observations < self.min_observations
        {
            return RolloutDecision::Continue {
                probability: None,
                stable_observations: window.stable.observations,
                candidate_observations: window.candidate.observations,
            };
        }
        let probability = probability_greater(
            &window.candidate.posterior(prior),
            &window.stable.posterior(prior),
        );
        if probability >= self.promote_threshold {
            RolloutDecision::Promote { probability }
        } else if probability <= self.rollback_threshold {
            RolloutDecision::Rollback(RollbackReason::Probability(probability))
        } else {
            RolloutDecision::Continue {
                probability: Some(probability),
                stable_observations: window.stable.observations,
                candidate_observations: window.candidate.observations,
            }
        }
    }
}

/// Deterministic position of `(threadId, targetKey)` in `[0, 1)`: the first
/// 8 bytes of SHA-256 over `threadId`, a NUL separator and the key.
pub fn channel_hash_unit(thread_id: &str, key: &TargetKey) -> f64 {
    let mut hasher = Sha256::new();
    hasher.update(thread_id.as_bytes());
    hasher.update([0]);
    hasher.update(key.to_string().as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 8];
    bytes.copy_from_slice(&digest[..8]);
    // 53 significant bits map exactly onto f64 in [0, 1).
    (u64::from_be_bytes(bytes) >> 11) as f64 / (1_u64 << 53) as f64
}

/// Whether a promotion needs user confirmation: anything but `auto` mode,
/// and pinned targets always.
pub fn promotion_requires_user(mode: EvolutionMode, pinned: bool) -> bool {
    mode != EvolutionMode::Auto || pinned
}

/// Per-channel evidence collected during one canary window.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CanaryWindow {
    pub stable: BetaEvidence,
    pub candidate: BetaEvidence,
}

impl CanaryWindow {
    /// Collect usages of `key` that started at or after `since_ms` on the
    /// stable revision (stable channel) and the candidate revision
    /// (candidate channel). Older history is deliberately excluded.
    pub fn collect(
        scored: &[ScoredUsage],
        key: &TargetKey,
        stable_revision: &TargetRevision,
        candidate_revision: &TargetRevision,
        since_ms: u64,
    ) -> Self {
        let mut window = Self::default();
        for usage in scored {
            if &usage.target_key != key || usage.started_at_ms < since_ms {
                continue;
            }
            match usage.channel {
                Channel::Stable if &usage.revision == stable_revision => {
                    window.stable.add(&usage.score, usage.started_at_ms)
                }
                Channel::Candidate if &usage.revision == candidate_revision => {
                    window.candidate.add(&usage.score, usage.started_at_ms)
                }
                _ => {}
            }
        }
        window
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RollbackReason {
    /// `P(candidate > stable)` at or below the rollback threshold.
    Probability(f64),
    /// A candidate usage received an explicit negative rating.
    ExplicitNegative,
    /// A candidate usage had a hard failure.
    HardFailure,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RolloutDecision {
    /// Keep collecting. `probability` is `None` below the sample threshold.
    Continue {
        probability: Option<f64>,
        stable_observations: u64,
        candidate_observations: u64,
    },
    Promote {
        probability: f64,
    },
    /// Switch the pointer back to stable; the candidate content is kept.
    Rollback(RollbackReason),
}
