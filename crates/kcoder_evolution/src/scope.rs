//! Where a distilled pattern goes (plan section 8), decided by code rather
//! than by the model, plus the distillation trigger rule.

use kcoder_types::evolution::TargetKey;
use std::collections::BTreeMap;

/// Object-level overlay: minimum supporting usages.
pub const OBJECT_MIN_USAGES: u32 = 8;
/// Object-level overlay: minimum distinct sessions.
pub const OBJECT_MIN_SESSIONS: u32 = 3;
/// Counter-evidence share `counter / (support + counter)` allowed for a pattern.
pub const MAX_COUNTER_EVIDENCE_RATIO: f64 = 0.25;
/// Cross-object preference: minimum distinct targets.
pub const CROSS_OBJECT_MIN_TARGETS: usize = 3;
/// Cross-object preference: minimum support per target.
pub const CROSS_OBJECT_MIN_PER_TARGET: u32 = 2;
/// Procedure pattern: minimum supporting usages.
pub const PROCEDURE_MIN_USAGES: u32 = 5;
/// Conflict events since the last distillation that trigger the next one.
pub const DISTILL_CONFLICT_TRIGGER: u64 = 3;
/// Cross-user improvement (phase 5): minimum distinct users.
pub const CROSS_USER_MIN_USERS: usize = 3;
/// Cross-user improvement (phase 5): maximum share of one user.
pub const CROSS_USER_MAX_SINGLE_USER_SHARE: f64 = 0.5;

/// Support of one distilled pattern.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PatternEvidence {
    /// Supporting usages of the current target.
    pub usages: u32,
    /// Distinct sessions among those usages.
    pub sessions: u32,
    pub counter_evidence: u32,
    /// Supporting usages per target, including the current one, for
    /// cross-object detection.
    pub per_target_support: BTreeMap<TargetKey, u32>,
    /// A procedural pattern such as "run X before Y".
    pub procedural: bool,
    /// Outcomes before and after adopting the procedure were compared.
    pub has_adoption_contrast: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsufficientReason {
    TooFewUsages,
    TooFewSessions,
    TooMuchCounterEvidence,
    MissingAdoptionContrast,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatternScope {
    /// Into the target's own overlay (local, this user only).
    TargetOverlay,
    /// Into the user's preferences: the pattern recurs across targets.
    UserPreference,
    Insufficient(InsufficientReason),
}

fn counter_ratio(support: u32, counter: u32) -> f64 {
    let total = support + counter;
    if total == 0 {
        return 1.0;
    }
    f64::from(counter) / f64::from(total)
}

/// Decide the scope of a pattern:
///
/// 1. supported by at least 2 usages in each of at least 3 targets with
///    counter-evidence share ≤ 25% → user preference;
/// 2. procedural: at least 5 usages and an adoption before/after contrast
///    → target overlay;
/// 3. otherwise at least 8 usages in at least 3 sessions with
///    counter-evidence share ≤ 25% → target overlay.
pub fn decide_pattern_scope(evidence: &PatternEvidence) -> PatternScope {
    let cross_targets = evidence
        .per_target_support
        .values()
        .filter(|support| **support >= CROSS_OBJECT_MIN_PER_TARGET)
        .count();
    let cross_support: u32 = evidence.per_target_support.values().sum();
    if cross_targets >= CROSS_OBJECT_MIN_TARGETS
        && counter_ratio(cross_support, evidence.counter_evidence) <= MAX_COUNTER_EVIDENCE_RATIO
    {
        return PatternScope::UserPreference;
    }
    if evidence.procedural {
        if evidence.usages < PROCEDURE_MIN_USAGES {
            return PatternScope::Insufficient(InsufficientReason::TooFewUsages);
        }
        if !evidence.has_adoption_contrast {
            return PatternScope::Insufficient(InsufficientReason::MissingAdoptionContrast);
        }
        return PatternScope::TargetOverlay;
    }
    if evidence.usages < OBJECT_MIN_USAGES {
        return PatternScope::Insufficient(InsufficientReason::TooFewUsages);
    }
    if evidence.sessions < OBJECT_MIN_SESSIONS {
        return PatternScope::Insufficient(InsufficientReason::TooFewSessions);
    }
    if counter_ratio(evidence.usages, evidence.counter_evidence) > MAX_COUNTER_EVIDENCE_RATIO {
        return PatternScope::Insufficient(InsufficientReason::TooMuchCounterEvidence);
    }
    PatternScope::TargetOverlay
}

/// Phase 5 statistical gate: at least 3 users and no user above 50% of the
/// support. Maintainer review is still required after this gate.
pub fn cross_user_eligible(support_per_user: &BTreeMap<String, u32>) -> bool {
    let users = support_per_user
        .values()
        .filter(|support| **support > 0)
        .count();
    let total: u32 = support_per_user.values().sum();
    let largest = support_per_user.values().copied().max().unwrap_or(0);
    users >= CROSS_USER_MIN_USERS
        && total > 0
        && f64::from(largest) / f64::from(total) <= CROSS_USER_MAX_SINGLE_USER_SHARE
}

/// Why a distillation is due.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistillTrigger {
    Manual,
    Conflicts,
    NewUsages,
}

/// Distillation trigger: a manual request, at least 3 conflict events, or
/// at least `distill_min_usages` new observed usages since the last run.
pub fn distill_due(
    new_observed_usages: u64,
    new_conflicts: u64,
    distill_min_usages: u32,
    manual: bool,
) -> Option<DistillTrigger> {
    if manual {
        Some(DistillTrigger::Manual)
    } else if new_conflicts >= DISTILL_CONFLICT_TRIGGER {
        Some(DistillTrigger::Conflicts)
    } else if new_observed_usages >= u64::from(distill_min_usages.max(1)) {
        Some(DistillTrigger::NewUsages)
    } else {
        None
    }
}
