use super::*;
use crate::beta::ln_gamma_for_test;
use crate::{BetaPosterior, BetaPrior, SignalWeights, probability_greater, score_usage};

fn beta(alpha: f64, beta: f64) -> BetaPosterior {
    BetaPosterior { alpha, beta }
}

fn close(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "expected {expected}, got {actual}"
    );
}

#[test]
fn ln_gamma_matches_known_values() {
    close(ln_gamma_for_test(1.0), 0.0, 1e-12);
    close(ln_gamma_for_test(5.0), 24f64.ln(), 1e-12);
    close(
        ln_gamma_for_test(0.5),
        std::f64::consts::PI.sqrt().ln(),
        1e-12,
    );
    close(ln_gamma_for_test(0.1), 9.513_507_698_668_732f64.ln(), 1e-10);
}

#[test]
fn cdf_quantile_and_interval_are_consistent() {
    let uniform = beta(1.0, 1.0);
    close(uniform.cdf(0.3), 0.3, 1e-12);
    let (low, high) = uniform.credible_interval(0.95);
    close(low, 0.025, 1e-9);
    close(high, 0.975, 1e-9);
    let skewed = beta(3.5, 12.25);
    for p in [0.01, 0.2, 0.5, 0.9] {
        close(skewed.cdf(skewed.quantile(p)), p, 1e-9);
    }
    close(beta(2.0, 6.0).mean(), 0.25, 1e-15);
}

#[test]
fn probability_greater_matches_closed_forms() {
    // P(Beta(a,1) > Beta(b,1)) = a / (a + b).
    close(
        probability_greater(&beta(2.0, 1.0), &beta(1.0, 1.0)),
        2.0 / 3.0,
        1e-6,
    );
    close(
        probability_greater(&beta(3.0, 1.0), &beta(1.0, 1.0)),
        0.75,
        1e-6,
    );
    // Unbounded densities (parameter below 1) stay well-defined.
    close(
        probability_greater(&beta(0.5, 1.0), &beta(1.0, 1.0)),
        1.0 / 3.0,
        1e-5,
    );
    for (a, b) in [(1.0, 1.0), (0.5, 0.5), (40.0, 7.0), (800.0, 900.0)] {
        close(probability_greater(&beta(a, b), &beta(a, b)), 0.5, 1e-5);
    }
    let better = probability_greater(&beta(30.0, 5.0), &beta(15.0, 20.0));
    assert!(better > 0.99);
    close(
        probability_greater(&beta(15.0, 20.0), &beta(30.0, 5.0)),
        1.0 - better,
        1e-6,
    );
}

#[test]
fn numerics_are_bitwise_deterministic() {
    let x = beta(17.3, 4.9);
    let y = beta(12.1, 8.4);
    let first = probability_greater(&x, &y);
    for _ in 0..3 {
        assert_eq!(probability_greater(&x, &y).to_bits(), first.to_bits());
    }
    assert_eq!(
        x.credible_interval(0.95).0.to_bits(),
        x.credible_interval(0.95).0.to_bits()
    );
}

#[test]
fn previous_stable_posterior_folds_to_ten_samples() {
    let folded = BetaPrior::from_previous_stable(&beta(80.0, 20.0));
    close(folded.alpha, 8.0, 1e-12);
    close(folded.beta, 2.0, 1e-12);
    let small = beta(3.0, 2.0);
    assert_eq!(
        BetaPrior::from_previous_stable(&small),
        BetaPrior {
            alpha: 3.0,
            beta: 2.0
        },
        "folding never inflates a weaker posterior"
    );
}

#[test]
fn score_reweights_missing_signals_proportionally() {
    let weights = SignalWeights::DEFAULT;
    let mut rating = outcome("o-1", "u", SignalKind::Rating);
    rating.metrics.rating_value = Some(1.0);
    let failure = success("o-2", "u", false);
    // Rating (0.25 → 1.0) and procedure (0.25 → 0.0) only.
    let score = score_usage([&rating, &failure], &weights);
    close(score.score.unwrap(), 0.5, 1e-12);
    close(score.weight, 1.0, 1e-12);

    let mut edit = outcome("o-3", "u", SignalKind::ArtifactEdit);
    edit.metrics.edit_ratio = Some(0.3);
    close(score_usage([&edit], &weights).score.unwrap(), 0.5, 1e-12);
    edit.metrics.edit_ratio = Some(5.0);
    close(score_usage([&edit], &weights).score.unwrap(), 0.0, 1e-12);

    let mut correction = outcome("o-4", "u", SignalKind::Correction);
    correction.metrics.correction_severity = Some(0.4);
    let regenerated = outcome("o-5", "u", SignalKind::Regenerated);
    let kept = outcome("o-6", "u", SignalKind::ArtifactKept);
    // (0.15 × 0.6 + 0.10 × 0 + 0.05 × 1) / 0.30
    close(
        score_usage([&correction, &regenerated, &kept], &weights)
            .score
            .unwrap(),
        (0.15 * 0.6 + 0.05) / 0.30,
        1e-12,
    );
}

#[test]
fn ambiguity_confidence_environment_and_disabled_signals_change_weight() {
    let weights = SignalWeights::DEFAULT;
    let mut ambiguous = success("o-1", "u", true);
    ambiguous.attribution = Attribution::Ambiguous;
    let score = score_usage([&ambiguous], &weights);
    close(score.score.unwrap(), 1.0, 1e-12);
    close(score.weight, crate::AMBIGUOUS_ATTRIBUTION_FACTOR, 1e-12);

    let mut unsure = success("o-2", "u", false);
    unsure.confidence = 0.2;
    close(score_usage([&unsure], &weights).weight, 0.2, 1e-12);

    let mut environment = success("o-3", "u", false);
    environment.cause = Some(OutcomeCause::Environment);
    environment.hard_failure = true;
    let score = score_usage([&environment], &weights);
    assert!(score.score.is_none() && !score.hard_failure);

    let mut interrupted = outcome("o-4", "u", SignalKind::TaskTerminal);
    interrupted.metrics.success = None;
    assert!(score_usage([&interrupted], &weights).score.is_none());

    let disabled = SignalWeights::from_settings(&kcoder_config::EvolutionSignalSettings {
        procedure_results: false,
        ..Default::default()
    });
    assert!(
        score_usage([&success("o-5", "u", true)], &disabled)
            .score
            .is_none()
    );
}

#[test]
fn explicit_negatives_conflicts_and_hard_failures_are_flagged() {
    let mut down = outcome("o-1", "u", SignalKind::Rating);
    down.metrics.rating_value = Some(0.0);
    down.conflict = true;
    let mut broken = success("o-2", "u", false);
    broken.hard_failure = true;
    let score = score_usage([&down, &broken], &SignalWeights::DEFAULT);
    assert!(score.explicit_negative && score.hard_failure);
    assert_eq!(score.conflicts, 1);
}

#[test]
fn only_the_latest_rating_of_a_usage_scores() {
    let weights = SignalWeights::DEFAULT;
    let rating = |id: &str, value: f64, at: u64| {
        let mut rating = outcome(id, "u", SignalKind::Rating);
        rating.metrics.rating_value = Some(value);
        rating.observed_at_ms = at;
        rating
    };
    let first = rating("r-1", 1.0, 10);
    let changed = rating("r-2", 0.0, 20);
    let score = score_usage([&first, &changed], &weights);
    close(score.score.unwrap(), 0.0, 1e-12);
    assert!(score.explicit_negative, "the standing rating is negative");
    assert_eq!(score.contributing, 1, "the superseded rating is ignored");

    // Changed back up: no explicit negative remains.
    let back = rating("r-3", 1.0, 30);
    let score = score_usage([&first, &changed, &back], &weights);
    close(score.score.unwrap(), 1.0, 1e-12);
    assert!(!score.explicit_negative);

    // Same timestamp: the later journal record stands.
    let tie = rating("r-4", 0.0, 30);
    let score = score_usage([&back, &tie], &weights);
    close(score.score.unwrap(), 0.0, 1e-12);

    // Other signals still count next to the standing rating.
    let failure = success("o-1", "u", false);
    let score = score_usage([&first, &failure, &changed], &weights);
    close(score.score.unwrap(), 0.0, 1e-12);
    assert_eq!(score.contributing, 2);
}
