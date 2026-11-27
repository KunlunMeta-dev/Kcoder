//! Deterministic Beta-distribution numerics.
//!
//! All results come from closed-form approximations and fixed-grid numeric
//! integration (no random sampling), so equal inputs always give equal
//! outputs on every platform with IEEE-754 doubles.

use serde::{Deserialize, Serialize};

/// Probability mass of the reported credible interval (equal-tailed).
pub const CREDIBLE_LEVEL: f64 = 0.95;

/// Equivalent sample size a previous stable posterior is folded to when it
/// becomes the prior of a new revision.
const FOLDED_PRIOR_SAMPLES: f64 = 10.0;
/// Cells of the fixed integration grid used by [`probability_greater`].
const INTEGRATION_CELLS: usize = 4096;
/// Tail mass excluded from the integration range.
const TAIL: f64 = 1e-12;

/// Prior of a Beta posterior.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BetaPrior {
    pub alpha: f64,
    pub beta: f64,
}

impl BetaPrior {
    /// Beta(1, 1).
    pub const UNIFORM: Self = Self {
        alpha: 1.0,
        beta: 1.0,
    };

    /// Prior for a new revision from the previous stable posterior, folded
    /// to 10 equivalent samples while keeping its mean. A posterior that
    /// already holds 10 or fewer equivalent samples is used unchanged, so
    /// folding never inflates confidence.
    pub fn from_previous_stable(previous: &BetaPosterior) -> Self {
        let samples = previous.alpha + previous.beta;
        if samples <= FOLDED_PRIOR_SAMPLES {
            return Self {
                alpha: previous.alpha,
                beta: previous.beta,
            };
        }
        let mean = previous.mean();
        Self {
            alpha: FOLDED_PRIOR_SAMPLES * mean,
            beta: FOLDED_PRIOR_SAMPLES * (1.0 - mean),
        }
    }
}

impl Default for BetaPrior {
    fn default() -> Self {
        Self::UNIFORM
    }
}

/// Beta(α, β) posterior.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BetaPosterior {
    pub alpha: f64,
    pub beta: f64,
}

impl BetaPosterior {
    /// Prior plus fractional evidence (`α += score`, `β += 1 - score`).
    pub fn from_evidence(prior: BetaPrior, alpha: f64, beta: f64) -> Self {
        // Guard against a degenerate prior; Beta parameters must be positive.
        Self {
            alpha: (prior.alpha + alpha).max(1e-9),
            beta: (prior.beta + beta).max(1e-9),
        }
    }

    pub fn mean(&self) -> f64 {
        self.alpha / (self.alpha + self.beta)
    }

    pub fn cdf(&self, x: f64) -> f64 {
        regularized_incomplete_beta(x, self.alpha, self.beta)
    }

    /// Inverse CDF by bisection (deterministic, about 1e-12 precision).
    pub fn quantile(&self, probability: f64) -> f64 {
        if probability <= 0.0 {
            return 0.0;
        }
        if probability >= 1.0 {
            return 1.0;
        }
        let (mut low, mut high) = (0.0_f64, 1.0_f64);
        for _ in 0..200 {
            let middle = 0.5 * (low + high);
            if self.cdf(middle) < probability {
                low = middle;
            } else {
                high = middle;
            }
            if high - low < 1e-13 {
                break;
            }
        }
        0.5 * (low + high)
    }

    /// Equal-tailed credible interval with the given mass.
    pub fn credible_interval(&self, level: f64) -> (f64, f64) {
        let tail = (1.0 - level.clamp(0.0, 1.0)) / 2.0;
        (self.quantile(tail), self.quantile(1.0 - tail))
    }
}

/// `P(X > Y)` for independent `X ~ x` and `Y ~ y`, computed as
/// `∫ F_Y(t) dF_X(t)` on a fixed grid over the union of both distributions'
/// central `1 - 2e-12` mass. Using CDF increments keeps the integral
/// well-defined when a parameter is below 1 and the density is unbounded.
pub fn probability_greater(x: &BetaPosterior, y: &BetaPosterior) -> f64 {
    let low = x.quantile(TAIL).min(y.quantile(TAIL));
    let high = x.quantile(1.0 - TAIL).max(y.quantile(1.0 - TAIL));
    if high <= low {
        return 0.5;
    }
    let step = (high - low) / INTEGRATION_CELLS as f64;
    let mut total = 0.0;
    let mut previous = x.cdf(low);
    for cell in 0..INTEGRATION_CELLS {
        let start = low + step * cell as f64;
        let end = if cell + 1 == INTEGRATION_CELLS {
            high
        } else {
            start + step
        };
        let current = x.cdf(end);
        total += (current - previous) * y.cdf(0.5 * (start + end));
        previous = current;
    }
    // Mass of X above the grid sees F_Y = 1.
    total += 1.0 - previous;
    total.clamp(0.0, 1.0)
}

fn ln_gamma(x: f64) -> f64 {
    const COEFFICIENTS: [f64; 9] = [
        0.999_999_999_999_809_9,
        676.520_368_121_885_1,
        -1_259.139_216_722_402_8,
        771.323_428_777_653_1,
        -176.615_029_162_140_6,
        12.507_343_278_686_905,
        -0.138_571_095_265_720_12,
        9.984_369_578_019_572e-6,
        1.505_632_735_149_311_6e-7,
    ];
    if x < 0.5 {
        // Reflection formula.
        let pi = std::f64::consts::PI;
        return (pi / (pi * x).sin()).ln() - ln_gamma(1.0 - x);
    }
    let x = x - 1.0;
    let mut sum = COEFFICIENTS[0];
    for (index, coefficient) in COEFFICIENTS.iter().enumerate().skip(1) {
        sum += coefficient / (x + index as f64);
    }
    let t = x + 7.5;
    0.5 * (2.0 * std::f64::consts::PI).ln() + (x + 0.5) * t.ln() - t + sum.ln()
}

/// Regularized incomplete beta `I_x(a, b)` (continued fraction, Lentz).
fn regularized_incomplete_beta(x: f64, a: f64, b: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    let ln_front = ln_gamma(a + b) - ln_gamma(a) - ln_gamma(b) + a * x.ln() + b * (1.0 - x).ln();
    let value = if x < (a + 1.0) / (a + b + 2.0) {
        ln_front.exp() * beta_continued_fraction(x, a, b) / a
    } else {
        1.0 - ln_front.exp() * beta_continued_fraction(1.0 - x, b, a) / b
    };
    value.clamp(0.0, 1.0)
}

fn beta_continued_fraction(x: f64, a: f64, b: f64) -> f64 {
    const MAX_ITERATIONS: usize = 500;
    const EPSILON: f64 = 1e-15;
    const TINY: f64 = 1e-300;
    let qab = a + b;
    let qap = a + 1.0;
    let qam = a - 1.0;
    let mut c = 1.0;
    let mut d = 1.0 - qab * x / qap;
    if d.abs() < TINY {
        d = TINY;
    }
    d = 1.0 / d;
    let mut h = d;
    for m in 1..=MAX_ITERATIONS {
        let m = m as f64;
        let m2 = 2.0 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1.0 + aa * d;
        if d.abs() < TINY {
            d = TINY;
        }
        c = 1.0 + aa / c;
        if c.abs() < TINY {
            c = TINY;
        }
        d = 1.0 / d;
        h *= d * c;
        let aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1.0 + aa * d;
        if d.abs() < TINY {
            d = TINY;
        }
        c = 1.0 + aa / c;
        if c.abs() < TINY {
            c = TINY;
        }
        d = 1.0 / d;
        let delta = d * c;
        h *= delta;
        if (delta - 1.0).abs() < EPSILON {
            break;
        }
    }
    h
}

#[cfg(test)]
pub(crate) fn ln_gamma_for_test(x: f64) -> f64 {
    ln_gamma(x)
}
