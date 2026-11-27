//! Per-usage outcome score (plan section 7.4).
//!
//! Every usage gets a score in `[0, 1]`: the weighted mean of the score
//! components that were actually observed. Missing components do not count;
//! their weight is redistributed proportionally to the observed ones.
//!
//! Within one component, each observation weighs
//! `confidence × attribution factor` (direct 1.0, ambiguous
//! [`AMBIGUOUS_ATTRIBUTION_FACTOR`]). Observations whose cause is
//! `environment` never count. The usage's Beta update weight is the
//! component-weighted mean of the strongest observation weight per
//! component, so a usage known only through ambiguous or low-confidence
//! observations moves the posterior less than a directly attributed one.

use kcoder_config::EvolutionSignalSettings;
use kcoder_types::evolution::{Attribution, OutcomeCause, OutcomeObservation, SignalKind};
use serde::{Deserialize, Serialize};

/// Weight multiplier for outcomes that could not be separated between
/// concurrently used targets.
pub const AMBIGUOUS_ATTRIBUTION_FACTOR: f64 = 0.5;
/// A rating at or below this normalized value is an explicit negative
/// rating, which rolls back a canary immediately.
pub const EXPLICIT_NEGATIVE_RATING_MAX: f64 = 0.25;
/// `edit_ratio` at which the artifact-edit component reaches 0.
pub const EDIT_RATIO_SATURATION: f64 = 0.6;

/// Score component and its default weight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScoreComponent {
    /// Explicit rating (0.25).
    Rating,
    /// Procedure result or task terminal state (0.25).
    Procedure,
    /// Artifact edits: `1 - clamp(editRatio / 0.6)` (0.20).
    ArtifactEdit,
    /// Correction: `1 - severity` (0.15).
    Correction,
    /// Regeneration: 0 when regenerated, 1 when the window closed without (0.10).
    Regenerated,
    /// Kept or exported 1, discarded 0 (0.05).
    KeptExported,
}

impl ScoreComponent {
    pub const ALL: [ScoreComponent; 6] = [
        Self::Rating,
        Self::Procedure,
        Self::ArtifactEdit,
        Self::Correction,
        Self::Regenerated,
        Self::KeptExported,
    ];

    pub fn for_signal(signal: SignalKind) -> Self {
        match signal {
            SignalKind::Rating => Self::Rating,
            SignalKind::ToolResult | SignalKind::Verification | SignalKind::TaskTerminal => {
                Self::Procedure
            }
            SignalKind::ArtifactEdit => Self::ArtifactEdit,
            SignalKind::Correction => Self::Correction,
            SignalKind::Regenerated => Self::Regenerated,
            SignalKind::ArtifactKept | SignalKind::ArtifactDiscarded | SignalKind::Exported => {
                Self::KeptExported
            }
        }
    }

    fn index(self) -> usize {
        self as usize
    }
}

/// Component weights. A disabled signal family has weight 0.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignalWeights {
    pub rating: f64,
    pub procedure: f64,
    pub artifact_edit: f64,
    pub correction: f64,
    pub regenerated: f64,
    pub kept_exported: f64,
}

impl SignalWeights {
    pub const DEFAULT: Self = Self {
        rating: 0.25,
        procedure: 0.25,
        artifact_edit: 0.20,
        correction: 0.15,
        regenerated: 0.10,
        kept_exported: 0.05,
    };

    /// Map `evolution.signals.*` switches onto component weights:
    /// `artifact_edits` → artifact edit and kept/exported,
    /// `procedure_results` → procedure, `chat_corrections` → correction and
    /// regeneration, `rating_ui` → rating.
    pub fn from_settings(signals: &EvolutionSignalSettings) -> Self {
        let on = |enabled: bool, weight: f64| if enabled { weight } else { 0.0 };
        let d = Self::DEFAULT;
        Self {
            rating: on(signals.rating_ui, d.rating),
            procedure: on(signals.procedure_results, d.procedure),
            artifact_edit: on(signals.artifact_edits, d.artifact_edit),
            correction: on(signals.chat_corrections, d.correction),
            regenerated: on(signals.chat_corrections, d.regenerated),
            kept_exported: on(signals.artifact_edits, d.kept_exported),
        }
    }

    pub fn weight(&self, component: ScoreComponent) -> f64 {
        match component {
            ScoreComponent::Rating => self.rating,
            ScoreComponent::Procedure => self.procedure,
            ScoreComponent::ArtifactEdit => self.artifact_edit,
            ScoreComponent::Correction => self.correction,
            ScoreComponent::Regenerated => self.regenerated,
            ScoreComponent::KeptExported => self.kept_exported,
        }
    }

    /// Stable fingerprint used to invalidate cached statistics.
    pub(crate) fn fingerprint(&self) -> String {
        format!(
            "{}:{}:{}:{}:{}:{}",
            self.rating,
            self.procedure,
            self.artifact_edit,
            self.correction,
            self.regenerated,
            self.kept_exported
        )
    }
}

impl Default for SignalWeights {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// Outcome of scoring one usage.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageScore {
    /// `None` when no scorable observation exists (only environment
    /// failures, interrupted results, or no observations at all).
    pub score: Option<f64>,
    /// Beta update weight in `[0, 1]`.
    pub weight: f64,
    pub explicit_negative: bool,
    pub hard_failure: bool,
    pub conflicts: u32,
    /// Observations that contributed to the score.
    pub contributing: u32,
}

/// Value in `[0, 1]` of one observation, or `None` when it carries no
/// scorable fact.
fn observation_value(observation: &OutcomeObservation) -> Option<f64> {
    let metrics = &observation.metrics;
    match observation.signal {
        SignalKind::Rating => metrics.rating_value.map(|value| value.clamp(0.0, 1.0)),
        SignalKind::ToolResult | SignalKind::Verification | SignalKind::TaskTerminal => metrics
            .success
            .map(|success| if success { 1.0 } else { 0.0 }),
        SignalKind::ArtifactEdit => metrics
            .edit_ratio
            .map(|ratio| 1.0 - (ratio / EDIT_RATIO_SATURATION).clamp(0.0, 1.0)),
        SignalKind::Correction => {
            Some(1.0 - metrics.correction_severity.unwrap_or(1.0).clamp(0.0, 1.0))
        }
        SignalKind::Regenerated => Some(if metrics.occurred.unwrap_or(true) {
            0.0
        } else {
            1.0
        }),
        SignalKind::ArtifactKept | SignalKind::Exported => Some(1.0),
        SignalKind::ArtifactDiscarded => Some(0.0),
    }
}

/// Position of the rating that stands for one usage: the latest by
/// `observedAtMs`, ties broken by journal order. A changed rating or a
/// later reason is appended as a new observation (the journal is never
/// rewritten), so only this one counts.
fn current_rating(observations: &[&OutcomeObservation]) -> Option<usize> {
    observations
        .iter()
        .enumerate()
        .filter(|(_, observation)| observation.signal == SignalKind::Rating)
        .max_by_key(|(position, observation)| (observation.observed_at_ms, *position))
        .map(|(position, _)| position)
}

/// Score one usage from its (already deduplicated) observations, in
/// journal order. Of several explicit ratings only the latest counts.
pub fn score_usage<'a>(
    observations: impl IntoIterator<Item = &'a OutcomeObservation>,
    weights: &SignalWeights,
) -> UsageScore {
    let observations: Vec<&OutcomeObservation> = observations.into_iter().collect();
    let rating = current_rating(&observations);
    let mut sums = [0.0_f64; 6];
    let mut masses = [0.0_f64; 6];
    let mut strongest = [0.0_f64; 6];
    let mut result = UsageScore::default();
    for (position, observation) in observations.into_iter().enumerate() {
        if observation.signal == SignalKind::Rating && Some(position) != rating {
            continue;
        }
        if observation.cause == Some(OutcomeCause::Environment) {
            continue;
        }
        if observation.conflict {
            result.conflicts += 1;
        }
        if observation.hard_failure {
            result.hard_failure = true;
        }
        let Some(value) = observation_value(observation) else {
            continue;
        };
        if observation.signal == SignalKind::Rating && value <= EXPLICIT_NEGATIVE_RATING_MAX {
            result.explicit_negative = true;
        }
        let component = ScoreComponent::for_signal(observation.signal);
        if weights.weight(component) <= 0.0 {
            continue;
        }
        let attribution = match observation.attribution {
            Attribution::Direct => 1.0,
            Attribution::Ambiguous => AMBIGUOUS_ATTRIBUTION_FACTOR,
        };
        let weight = observation.confidence.clamp(0.0, 1.0) * attribution;
        if weight <= 0.0 {
            continue;
        }
        let index = component.index();
        sums[index] += weight * value;
        masses[index] += weight;
        strongest[index] = strongest[index].max(weight);
        result.contributing += 1;
    }
    let mut weighted_value = 0.0;
    let mut weighted_strength = 0.0;
    let mut total_weight = 0.0;
    for component in ScoreComponent::ALL {
        let index = component.index();
        if masses[index] <= 0.0 {
            continue;
        }
        let component_weight = weights.weight(component);
        weighted_value += component_weight * (sums[index] / masses[index]);
        weighted_strength += component_weight * strongest[index];
        total_weight += component_weight;
    }
    if total_weight > 0.0 {
        result.score = Some((weighted_value / total_weight).clamp(0.0, 1.0));
        result.weight = (weighted_strength / total_weight).clamp(0.0, 1.0);
    }
    result
}
