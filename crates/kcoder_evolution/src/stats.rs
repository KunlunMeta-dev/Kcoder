//! Beta statistics per (target key, revision, channel) and the rebuildable
//! `stats.json` cache.
//!
//! Statistics are a pure function of the two journals and the signal
//! weights. `stats.json` stores that result together with fingerprints of
//! both journals and the weights; a mismatch (new appends, a crash between
//! an append and the cache write, a replaced file or changed settings)
//! triggers a rebuild, so the cache can always be deleted safely.

use crate::beta::{BetaPosterior, BetaPrior, CREDIBLE_LEVEL};
use crate::error::Result;
use crate::journal::{self, JournalRead, JournalStats, OUTCOMES_FILE, USAGES_FILE};
use crate::score::{SignalWeights, UsageScore, score_usage};
use crate::store::EvolutionStore;
use kcoder_types::evolution::{
    Channel, EvolutionScore, EvolutionStorageDiagnostics, OutcomeObservation, TargetKey,
    TargetRevision, UsageRecord,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Duration;

const STATS_FILE: &str = "stats.json";
const STATS_VERSION: u32 = 1;

/// Identity of one statistics bucket.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BucketKey {
    pub target_key: TargetKey,
    pub revision: TargetRevision,
    pub channel: Channel,
}

/// Data-only evidence of one bucket; add a prior to get a posterior.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BetaEvidence {
    /// Sum of `weight × score`.
    pub alpha: f64,
    /// Sum of `weight × (1 - score)`.
    pub beta: f64,
    /// Usages with a score.
    pub observations: u64,
    /// All usages, scored or not.
    pub usages: u64,
    pub explicit_negatives: u64,
    pub hard_failures: u64,
    pub conflicts: u64,
    /// Start time of the latest usage in this bucket.
    pub last_usage_at_ms: u64,
}

impl BetaEvidence {
    pub fn add(&mut self, score: &UsageScore, started_at_ms: u64) {
        self.usages += 1;
        self.last_usage_at_ms = self.last_usage_at_ms.max(started_at_ms);
        if score.explicit_negative {
            self.explicit_negatives += 1;
        }
        if score.hard_failure {
            self.hard_failures += 1;
        }
        self.conflicts += u64::from(score.conflicts);
        if let Some(value) = score.score {
            self.observations += 1;
            self.alpha += score.weight * value;
            self.beta += score.weight * (1.0 - value);
        }
    }

    pub fn posterior(&self, prior: BetaPrior) -> BetaPosterior {
        BetaPosterior::from_evidence(prior, self.alpha, self.beta)
    }

    /// RPC score projection with the 95% credible interval.
    pub fn score(&self, revision: &TargetRevision, prior: BetaPrior) -> EvolutionScore {
        let posterior = self.posterior(prior);
        let (lower, upper) = posterior.credible_interval(CREDIBLE_LEVEL);
        EvolutionScore {
            revision: revision.label(),
            mean: posterior.mean(),
            lower,
            upper,
            observations: u32::try_from(self.observations).unwrap_or(u32::MAX),
        }
    }
}

/// One usage with its computed score.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScoredUsage {
    pub usage_id: String,
    pub thread_id: String,
    pub target_key: TargetKey,
    pub revision: TargetRevision,
    pub channel: Channel,
    pub started_at_ms: u64,
    pub score: UsageScore,
}

/// Score every deduplicated usage from its deduplicated observations.
/// Observations whose usage is unknown are ignored.
pub fn score_journals(
    usages: &JournalRead<UsageRecord>,
    outcomes: &JournalRead<OutcomeObservation>,
    weights: &SignalWeights,
) -> Vec<ScoredUsage> {
    let mut by_usage: HashMap<&str, Vec<&OutcomeObservation>> = HashMap::new();
    for observation in &outcomes.records {
        by_usage
            .entry(observation.usage_id.as_str())
            .or_default()
            .push(observation);
    }
    usages
        .records
        .iter()
        .map(|usage| {
            let observations = by_usage
                .get(usage.usage_id.as_str())
                .map(Vec::as_slice)
                .unwrap_or_default();
            ScoredUsage {
                usage_id: usage.usage_id.clone(),
                thread_id: usage.thread_id.clone(),
                target_key: usage.target_key.clone(),
                revision: usage.revision.clone(),
                channel: usage.channel,
                started_at_ms: usage.started_at_ms,
                score: score_usage(observations.iter().copied(), weights),
            }
        })
        .collect()
}

/// Aggregated statistics of one scope.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionStats {
    #[serde(with = "bucket_entries")]
    pub buckets: BTreeMap<BucketKey, BetaEvidence>,
    pub diagnostics: StatsDiagnostics,
}

/// Serializable copy of the read diagnostics.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatsDiagnostics {
    pub duplicate_records: u64,
    pub invalid_records: u64,
    pub future_records: u64,
    pub torn_tail: bool,
}

impl From<StatsDiagnostics> for EvolutionStorageDiagnostics {
    fn from(value: StatsDiagnostics) -> Self {
        Self {
            duplicate_records: value.duplicate_records,
            invalid_records: value.invalid_records,
            future_records: value.future_records,
            torn_tail: value.torn_tail,
            project_scope_issue: None,
        }
    }
}

fn diagnostics(usages: &JournalStats, outcomes: &JournalStats) -> StatsDiagnostics {
    StatsDiagnostics {
        duplicate_records: usages.duplicates + outcomes.duplicates,
        invalid_records: usages.invalid + outcomes.invalid,
        future_records: usages.future + outcomes.future,
        torn_tail: usages.torn_tail || outcomes.torn_tail,
    }
}

mod bucket_entries {
    use super::{BetaEvidence, BucketKey};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::collections::BTreeMap;

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Entry {
        key: BucketKey,
        evidence: BetaEvidence,
    }

    pub fn serialize<S: Serializer>(
        buckets: &BTreeMap<BucketKey, BetaEvidence>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let entries: Vec<Entry> = buckets
            .iter()
            .map(|(key, evidence)| Entry {
                key: key.clone(),
                evidence: *evidence,
            })
            .collect();
        entries.serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<BTreeMap<BucketKey, BetaEvidence>, D::Error> {
        Ok(Vec::<Entry>::deserialize(deserializer)?
            .into_iter()
            .map(|entry| (entry.key, entry.evidence))
            .collect())
    }
}

impl EvolutionStats {
    pub fn from_scored(scored: &[ScoredUsage], diagnostics: StatsDiagnostics) -> Self {
        let mut buckets: BTreeMap<BucketKey, BetaEvidence> = BTreeMap::new();
        for usage in scored {
            buckets
                .entry(BucketKey {
                    target_key: usage.target_key.clone(),
                    revision: usage.revision.clone(),
                    channel: usage.channel,
                })
                .or_default()
                .add(&usage.score, usage.started_at_ms);
        }
        Self {
            buckets,
            diagnostics,
        }
    }

    pub fn bucket(
        &self,
        target_key: &TargetKey,
        revision: &TargetRevision,
        channel: Channel,
    ) -> Option<&BetaEvidence> {
        self.buckets.get(&BucketKey {
            target_key: target_key.clone(),
            revision: revision.clone(),
            channel,
        })
    }

    pub fn target_buckets<'a>(
        &'a self,
        target_key: &'a TargetKey,
    ) -> impl Iterator<Item = (&'a BucketKey, &'a BetaEvidence)> + 'a {
        self.buckets
            .iter()
            .filter(move |(key, _)| &key.target_key == target_key)
    }

    /// The bucket of `channel` with the most recent usage.
    pub fn latest_bucket<'a>(
        &'a self,
        target_key: &'a TargetKey,
        channel: Channel,
    ) -> Option<(&'a BucketKey, &'a BetaEvidence)> {
        self.target_buckets(target_key)
            .filter(|(key, _)| key.channel == channel)
            .max_by_key(|(_, evidence)| evidence.last_usage_at_ms)
    }

    pub fn targets(&self) -> BTreeSet<TargetKey> {
        self.buckets
            .keys()
            .map(|key| key.target_key.clone())
            .collect()
    }

    /// All conflict events recorded for a target across revisions.
    pub fn conflicts(&self, target_key: &TargetKey) -> u64 {
        self.target_buckets(target_key)
            .map(|(_, evidence)| evidence.conflicts)
            .sum()
    }

    /// Scored usages recorded for a target across revisions and channels.
    pub fn observed_usages(&self, target_key: &TargetKey) -> u64 {
        self.target_buckets(target_key)
            .map(|(_, evidence)| evidence.observations)
            .sum()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatsCache {
    version: u32,
    weights: String,
    usages: Option<String>,
    outcomes: Option<String>,
    stats: EvolutionStats,
}

impl EvolutionStore {
    /// Score every usage from the journals (no cache).
    pub fn scored_usages(&self, weights: &SignalWeights) -> Result<Vec<ScoredUsage>> {
        // Tool-call attribution selects rating targets, but does not score a usage.
        let usages = journal::read(self.directory(), USAGES_FILE)?;
        let outcomes = self.read_outcomes()?;
        let mut scored = score_journals(&usages, &outcomes, weights);
        // Usages folded by an unfinished compaction are already counted in
        // the baseline.
        crate::compaction::without_pending(&mut scored, self.read_stats_baseline()?.as_ref());
        Ok(scored)
    }

    /// Statistics, served from `stats.json` when both journal fingerprints
    /// and the weights still match; otherwise rebuilt and re-cached.
    pub fn stats(&self, weights: &SignalWeights) -> Result<EvolutionStats> {
        let usages_fingerprint = journal::fingerprint(self.directory(), USAGES_FILE)?;
        let outcomes_fingerprint = journal::fingerprint(self.directory(), OUTCOMES_FILE)?;
        // A corrupt or future cache is treated as absent and rebuilt.
        if let Ok(Some(cache)) = self.read_json::<StatsCache>(STATS_FILE)
            && cache.version == STATS_VERSION
            && cache.weights == weights.fingerprint()
            && cache.usages == usages_fingerprint
            && cache.outcomes == outcomes_fingerprint
        {
            return Ok(cache.stats);
        }
        let stats = self.compute_stats(weights)?;
        // Cache only when the lock is free right now; a busy writer will
        // change the fingerprints anyway. Fingerprints were taken before the
        // journals were read, so the cache is never fresher than its key.
        if let Some(_lock) = self.try_lock_within(Duration::from_millis(50))? {
            self.write_json(
                STATS_FILE,
                &StatsCache {
                    version: STATS_VERSION,
                    weights: weights.fingerprint(),
                    usages: usages_fingerprint,
                    outcomes: outcomes_fingerprint,
                    stats: stats.clone(),
                },
            )?;
        }
        Ok(stats)
    }

    /// Recompute statistics from the journals and replace the cache.
    pub fn rebuild_stats(&self, weights: &SignalWeights) -> Result<EvolutionStats> {
        let _lock = self.lock()?;
        let usages_fingerprint = journal::fingerprint(self.directory(), USAGES_FILE)?;
        let outcomes_fingerprint = journal::fingerprint(self.directory(), OUTCOMES_FILE)?;
        let stats = self.compute_stats(weights)?;
        self.write_json(
            STATS_FILE,
            &StatsCache {
                version: STATS_VERSION,
                weights: weights.fingerprint(),
                usages: usages_fingerprint,
                outcomes: outcomes_fingerprint,
                stats: stats.clone(),
            },
        )?;
        Ok(stats)
    }

    fn compute_stats(&self, weights: &SignalWeights) -> Result<EvolutionStats> {
        // Tool-call attribution selects rating targets, but does not score a usage.
        let usages = journal::read(self.directory(), USAGES_FILE)?;
        let outcomes = self.read_outcomes()?;
        let mut scored = score_journals(&usages, &outcomes, weights);
        // Compacted history lives in the baseline (see `compaction`).
        let baseline = self.read_stats_baseline()?;
        crate::compaction::without_pending(&mut scored, baseline.as_ref());
        let mut stats =
            EvolutionStats::from_scored(&scored, diagnostics(&usages.stats, &outcomes.stats));
        if let Some(baseline) = &baseline {
            baseline.merge_into(&mut stats);
        }
        Ok(stats)
    }
}
