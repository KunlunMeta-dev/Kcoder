use super::*;
use crate::{
    BetaEvidence, BetaPrior, CanaryWindow, DistillTrigger, InsufficientReason, PatternEvidence,
    PatternScope, RollbackReason, RolloutDecision, RolloutPolicy, ScoredUsage, UsageScore,
    channel_hash_unit, cross_user_eligible, decide_pattern_scope, distill_due,
    promotion_requires_user,
};
use kcoder_config::EvolutionSettings;
use std::collections::BTreeMap;

fn policy() -> RolloutPolicy {
    RolloutPolicy::from_settings(&EvolutionSettings::default(), true)
}

fn evidence(successes: u64, failures: u64) -> BetaEvidence {
    let mut evidence = BetaEvidence::default();
    for (value, count) in [(1.0, successes), (0.0, failures)] {
        for _ in 0..count {
            evidence.add(
                &UsageScore {
                    score: Some(value),
                    weight: 1.0,
                    ..Default::default()
                },
                1,
            );
        }
    }
    evidence
}

#[test]
fn channel_hash_is_stable_and_matches_traffic() {
    let target = key("skill:bundled:docx");
    let first = channel_hash_unit("thread-1", &target);
    assert_eq!(
        first.to_bits(),
        channel_hash_unit("thread-1", &target).to_bits()
    );
    assert!((0.0..1.0).contains(&first));
    assert_ne!(
        first,
        channel_hash_unit("thread-1", &key("skill:bundled:pptx"))
    );
    // Pinned value: changing the hash rule would reshuffle running canaries.
    assert_eq!(
        channel_hash_unit("thread-fixed", &key("skill:bundled:docx")),
        0.386_106_159_086_790_25
    );

    let policy = policy();
    let candidates = (0..10_000)
        .filter(|index| {
            policy.assign_channel(&format!("thread-{index}"), &target, true) == Channel::Candidate
        })
        .count();
    assert!((4_700..5_300).contains(&candidates), "{candidates}");
    assert_eq!(
        policy.assign_channel("thread-1", &target, false),
        Channel::Stable
    );
    for index in 0..50 {
        let thread = format!("thread-{index}");
        assert_eq!(
            policy.assign_channel(&thread, &target, true),
            policy.assign_channel(&thread, &target, true),
            "one thread always sees the same version"
        );
    }
}

#[test]
fn targets_without_an_evaluator_get_small_traffic_and_longer_windows() {
    let settings = EvolutionSettings::default();
    let policy = RolloutPolicy::from_settings(&settings, false);
    assert_eq!(policy.candidate_traffic, 0.1);
    assert_eq!(policy.min_observations, 30);
    let low = EvolutionSettings {
        candidate_traffic: 0.05,
        ..Default::default()
    };
    assert_eq!(
        RolloutPolicy::from_settings(&low, false).candidate_traffic,
        0.05
    );
}

#[test]
fn decisions_promote_rollback_or_continue() {
    let policy = policy();
    let insufficient = CanaryWindow {
        stable: evidence(10, 4),
        candidate: evidence(14, 0),
    };
    assert!(matches!(
        policy.decide(&insufficient, BetaPrior::UNIFORM),
        RolloutDecision::Continue {
            probability: None,
            stable_observations: 14,
            ..
        }
    ));
    let better = CanaryWindow {
        stable: evidence(8, 8),
        candidate: evidence(15, 1),
    };
    assert!(matches!(
        policy.decide(&better, BetaPrior::UNIFORM),
        RolloutDecision::Promote { probability } if probability >= 0.8
    ));
    let worse = CanaryWindow {
        stable: evidence(15, 1),
        candidate: evidence(5, 11),
    };
    assert!(matches!(
        policy.decide(&worse, BetaPrior::UNIFORM),
        RolloutDecision::Rollback(RollbackReason::Probability(p)) if p <= 0.3
    ));
    let even = CanaryWindow {
        stable: evidence(10, 6),
        candidate: evidence(10, 6),
    };
    assert!(matches!(
        policy.decide(&even, BetaPrior::UNIFORM),
        RolloutDecision::Continue {
            probability: Some(_),
            ..
        }
    ));

    let mut negative = insufficient;
    negative.candidate.explicit_negatives = 1;
    assert_eq!(
        policy.decide(&negative, BetaPrior::UNIFORM),
        RolloutDecision::Rollback(RollbackReason::ExplicitNegative)
    );
    negative.candidate.hard_failures = 1;
    assert_eq!(
        policy.decide(&negative, BetaPrior::UNIFORM),
        RolloutDecision::Rollback(RollbackReason::HardFailure)
    );
    assert!(promotion_requires_user(EvolutionMode::Propose, false));
    assert!(promotion_requires_user(EvolutionMode::Auto, true));
    assert!(!promotion_requires_user(EvolutionMode::Auto, false));
}

#[test]
fn canary_window_uses_only_same_window_data() {
    let target = key("skill:bundled:docx");
    let stable_revision = TargetRevision::new("base-1", 1);
    let candidate_revision = TargetRevision::new("base-1", 2);
    let scored = |id: &str, channel, revision: &TargetRevision, at, value| ScoredUsage {
        usage_id: id.into(),
        thread_id: "t".into(),
        target_key: target.clone(),
        revision: revision.clone(),
        channel,
        started_at_ms: at,
        score: UsageScore {
            score: Some(value),
            weight: 1.0,
            ..Default::default()
        },
    };
    let usages = vec![
        scored("old", Channel::Stable, &stable_revision, 10, 0.0),
        scored("s", Channel::Stable, &stable_revision, 100, 1.0),
        scored("c", Channel::Candidate, &candidate_revision, 120, 1.0),
        scored("other-rev", Channel::Candidate, &stable_revision, 130, 0.0),
    ];
    let window =
        CanaryWindow::collect(&usages, &target, &stable_revision, &candidate_revision, 100);
    assert_eq!(window.stable.observations, 1);
    assert_eq!(window.candidate.observations, 1);
    assert_eq!(window.stable.beta, 0.0, "pre-window history is excluded");
}

#[test]
fn pattern_scope_thresholds_follow_the_plan() {
    let object = PatternEvidence {
        usages: 8,
        sessions: 3,
        counter_evidence: 2,
        ..Default::default()
    };
    assert_eq!(decide_pattern_scope(&object), PatternScope::TargetOverlay);
    for (evidence, reason) in [
        (
            PatternEvidence {
                usages: 7,
                ..object.clone()
            },
            InsufficientReason::TooFewUsages,
        ),
        (
            PatternEvidence {
                sessions: 2,
                ..object.clone()
            },
            InsufficientReason::TooFewSessions,
        ),
        (
            PatternEvidence {
                counter_evidence: 3,
                ..object.clone()
            },
            InsufficientReason::TooMuchCounterEvidence,
        ),
    ] {
        assert_eq!(
            decide_pattern_scope(&evidence),
            PatternScope::Insufficient(reason)
        );
    }

    let procedure = PatternEvidence {
        usages: 5,
        sessions: 1,
        procedural: true,
        has_adoption_contrast: true,
        ..Default::default()
    };
    assert_eq!(
        decide_pattern_scope(&procedure),
        PatternScope::TargetOverlay
    );
    assert_eq!(
        decide_pattern_scope(&PatternEvidence {
            has_adoption_contrast: false,
            ..procedure.clone()
        }),
        PatternScope::Insufficient(InsufficientReason::MissingAdoptionContrast)
    );
    assert_eq!(
        decide_pattern_scope(&PatternEvidence {
            usages: 4,
            ..procedure
        }),
        PatternScope::Insufficient(InsufficientReason::TooFewUsages)
    );

    let mut per_target = BTreeMap::new();
    per_target.insert(key("skill:bundled:docx"), 2);
    per_target.insert(key("skill:bundled:pptx"), 2);
    per_target.insert(key("skill:user_created:report"), 2);
    let cross = PatternEvidence {
        usages: 2,
        sessions: 2,
        counter_evidence: 2,
        per_target_support: per_target.clone(),
        ..Default::default()
    };
    assert_eq!(decide_pattern_scope(&cross), PatternScope::UserPreference);
    per_target.insert(key("skill:user_created:report"), 1);
    assert_ne!(
        decide_pattern_scope(&PatternEvidence {
            per_target_support: per_target,
            ..cross
        }),
        PatternScope::UserPreference
    );
}

#[test]
fn distill_triggers_and_cross_user_gate() {
    assert_eq!(distill_due(0, 0, 20, true), Some(DistillTrigger::Manual));
    assert_eq!(
        distill_due(1, 3, 20, false),
        Some(DistillTrigger::Conflicts)
    );
    assert_eq!(
        distill_due(20, 0, 20, false),
        Some(DistillTrigger::NewUsages)
    );
    assert_eq!(distill_due(19, 2, 20, false), None);

    let users = |pairs: &[(&str, u32)]| -> BTreeMap<String, u32> {
        pairs
            .iter()
            .map(|(user, count)| (user.to_string(), *count))
            .collect()
    };
    assert!(cross_user_eligible(&users(&[("a", 2), ("b", 1), ("c", 1)])));
    assert!(!cross_user_eligible(&users(&[
        ("a", 3),
        ("b", 1),
        ("c", 1)
    ])));
    assert!(!cross_user_eligible(&users(&[("a", 1), ("b", 1)])));
}
