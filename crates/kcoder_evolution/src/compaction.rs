//! Journal compaction and retention (`usages.jsonl`, `outcomes.jsonl`,
//! `usage-amendments.jsonl`).
//!
//! Compaction runs under the scope lock and rewrites each journal by atomic
//! replacement:
//!
//! - duplicate ids (retried appends), invalid lines and a torn final line
//!   (a crash remnant; no writer can be active under the lock) are dropped;
//! - lines written by a newer format version are kept verbatim;
//! - usages that started before the retention cutoff, whose observations are
//!   all older than the cutoff and that are not part of an active canary
//!   window, are **folded**: their scored contribution is added to
//!   `stats-baseline.json` and the usage, its observations and amendments
//!   leave the journals.
//!
//! Statistics stay rebuildable: [`EvolutionStore::stats`] adds the baseline
//! buckets to what the journals yield, so the result after compaction equals
//! the result before it (up to floating-point summation order). The
//! baseline keeps the signal weights of the compaction that folded each
//! usage; changing the weights later re-scores only the retained journals.
//!
//! Crash safety: the baseline is written first with the ids being folded
//! listed as `pendingUsageIds`; statistics ignore journal records with those
//! ids, so a crash before the journals are replaced never double counts.
//! After the journals are replaced the pending list is cleared.

use crate::error::Result;
use crate::journal::{
    AMENDMENTS_FILE, JournalRead, JournalRecord, OUTCOMES_FILE, USAGES_FILE, is_not_found,
};
use crate::score::SignalWeights;
use crate::stats::{BetaEvidence, BucketKey, EvolutionStats, ScoredUsage, score_journals};
use crate::store::{EvolutionStore, read_versioned_in, write_json_in};
use crate::usage_tool_calls::{
    USAGE_TOOL_CALLS_FILE, UsageToolCall, normalize_inline_usages, usage_sha256,
};
use kcoder_config::PrivateDirectory;
use kcoder_types::evolution::{
    EVOLUTION_RECORD_VERSION, OutcomeObservation, OverlayCandidateState, UsageAmendment,
    UsageRecord,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::ffi::OsStr;
use std::io::Read;

const BASELINE_FILE: &str = "stats-baseline.json";
const BASELINE_VERSION: u32 = 1;
/// Largest journal compaction reads into memory.
pub(crate) const JOURNAL_COMPACT_MAX_BYTES: u64 = 256 * 1024 * 1024;
/// Default journal retention: usages older than this are folded into the
/// statistics baseline.
pub const JOURNAL_RETENTION_DAYS: u32 = 365;
/// Most folded usage ids a baseline lists while a compaction is in flight.
const PENDING_IDS_MAX: usize = 500_000;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// Folded statistics of usages that left the journals.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatsBaseline {
    pub version: u32,
    /// Weights fingerprint of the most recent fold.
    #[serde(default)]
    pub weights: String,
    #[serde(default)]
    pub buckets: Vec<BaselineBucket>,
    /// Usage ids folded by an unfinished compaction; journal records with
    /// these ids are ignored by statistics.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_usage_ids: Vec<String>,
    /// Total usages folded so far.
    #[serde(default)]
    pub folded_usages: u64,
    #[serde(default)]
    pub updated_at_ms: u64,
}

/// One folded bucket.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BaselineBucket {
    pub key: BucketKey,
    pub evidence: BetaEvidence,
}

/// What one compaction changed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CompactionReport {
    /// Whether any journal was rewritten.
    pub rewritten: bool,
    pub folded_usages: u64,
    pub dropped_outcomes: u64,
    pub dropped_amendments: u64,
    pub dropped_duplicates: u64,
    pub dropped_invalid: u64,
    pub kept_future_lines: u64,
}

/// Retention policy of one compaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompactionPolicy {
    pub now_ms: u64,
    pub retention_days: u32,
}

impl CompactionPolicy {
    pub fn new(now_ms: u64) -> Self {
        Self {
            now_ms,
            retention_days: JOURNAL_RETENTION_DAYS,
        }
    }

    fn cutoff_ms(&self) -> u64 {
        self.now_ms
            .saturating_sub(u64::from(self.retention_days).saturating_mul(DAY_MS))
    }
}

/// Merge `other` into `into` (sums and the latest usage time).
pub(crate) fn merge_evidence(into: &mut BetaEvidence, other: &BetaEvidence) {
    into.alpha += other.alpha;
    into.beta += other.beta;
    into.observations += other.observations;
    into.usages += other.usages;
    into.explicit_negatives += other.explicit_negatives;
    into.hard_failures += other.hard_failures;
    into.conflicts += other.conflicts;
    into.last_usage_at_ms = into.last_usage_at_ms.max(other.last_usage_at_ms);
}

impl StatsBaseline {
    /// Add the baseline buckets to journal-derived statistics.
    pub(crate) fn merge_into(&self, stats: &mut EvolutionStats) {
        for bucket in &self.buckets {
            merge_evidence(
                stats.buckets.entry(bucket.key.clone()).or_default(),
                &bucket.evidence,
            );
        }
    }

    pub(crate) fn pending(&self) -> HashSet<&str> {
        self.pending_usage_ids.iter().map(String::as_str).collect()
    }
}

/// Drop scored usages a pending compaction already folded.
pub(crate) fn without_pending(scored: &mut Vec<ScoredUsage>, baseline: Option<&StatsBaseline>) {
    if let Some(baseline) = baseline
        && !baseline.pending_usage_ids.is_empty()
    {
        let pending = baseline.pending();
        scored.retain(|usage| !pending.contains(usage.usage_id.as_str()));
    }
}

/// One journal line as compaction sees it.
enum RawLine<T> {
    Record(T),
    Future(Vec<u8>),
    Duplicate,
    Invalid,
}

struct RawJournal<T> {
    lines: Vec<RawLine<T>>,
}

impl<T> RawJournal<T> {
    fn records(&self) -> impl Iterator<Item = &T> {
        self.lines.iter().filter_map(|line| match line {
            RawLine::Record(record) => Some(record),
            _ => None,
        })
    }

    fn count(&self, predicate: impl Fn(&RawLine<T>) -> bool) -> u64 {
        self.lines.iter().filter(|line| predicate(line)).count() as u64
    }
}

trait CompactRecord: DeserializeOwned + Serialize {
    fn id(&self) -> &str;
    fn valid(&self) -> bool;
}

impl CompactRecord for UsageRecord {
    fn id(&self) -> &str {
        &self.usage_id
    }
    fn valid(&self) -> bool {
        self.validate().is_ok()
    }
}

impl CompactRecord for OutcomeObservation {
    fn id(&self) -> &str {
        &self.observation_id
    }
    fn valid(&self) -> bool {
        self.validate().is_ok()
    }
}

impl CompactRecord for UsageAmendment {
    fn id(&self) -> &str {
        &self.amendment_id
    }
    fn valid(&self) -> bool {
        self.validate().is_ok()
    }
}

impl CompactRecord for UsageToolCall {
    fn id(&self) -> &str {
        self.record_id()
    }
    fn valid(&self) -> bool {
        self.check().is_ok()
    }
}

fn read_raw<T: CompactRecord>(directory: &PrivateDirectory, name: &str) -> Result<RawJournal<T>> {
    let file = match directory.open_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if is_not_found(&error) => return Ok(RawJournal { lines: Vec::new() }),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    file.take(JOURNAL_COMPACT_MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > JOURNAL_COMPACT_MAX_BYTES {
        return Err(crate::EvolutionError::RecordTooLarge {
            limit: JOURNAL_COMPACT_MAX_BYTES as usize,
            actual: bytes.len(),
        });
    }
    let mut lines = Vec::new();
    let mut seen = HashSet::new();
    let terminated = bytes.last() == Some(&b'\n');
    let parts: Vec<&[u8]> = bytes.split(|byte| *byte == b'\n').collect();
    let last_index = parts.len().saturating_sub(1);
    for (index, part) in parts.into_iter().enumerate() {
        let line = part.strip_suffix(b"\r").unwrap_or(part);
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        // The unterminated final line is a crash remnant: no writer can be
        // appending while compaction holds the scope lock.
        if index == last_index && !terminated {
            lines.push(RawLine::Invalid);
            continue;
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
            lines.push(RawLine::Invalid);
            continue;
        };
        match value.get("version").and_then(serde_json::Value::as_u64) {
            Some(version) if version > u64::from(EVOLUTION_RECORD_VERSION) => {
                lines.push(RawLine::Future(line.to_vec()));
            }
            Some(_) => match serde_json::from_value::<T>(value) {
                Ok(record) if record.valid() => {
                    if seen.insert(record.id().to_string()) {
                        lines.push(RawLine::Record(record));
                    } else {
                        lines.push(RawLine::Duplicate);
                    }
                }
                _ => lines.push(RawLine::Invalid),
            },
            None => lines.push(RawLine::Invalid),
        }
    }
    Ok(RawJournal { lines })
}

/// Serialize kept lines; `None` when nothing would change.
fn rewrite<T: CompactRecord>(
    journal: &RawJournal<T>,
    keep: impl Fn(&T) -> bool,
) -> Result<Option<Vec<u8>>> {
    let mut changed = false;
    let mut bytes = Vec::new();
    for line in &journal.lines {
        match line {
            RawLine::Record(record) if keep(record) => {
                bytes.extend(serde_json::to_vec(record)?);
                bytes.push(b'\n');
            }
            RawLine::Future(raw) => {
                bytes.extend_from_slice(raw);
                bytes.push(b'\n');
            }
            _ => changed = true,
        }
    }
    Ok(changed.then_some(bytes))
}

fn journal_read<T: Clone>(journal: &RawJournal<T>) -> JournalRead<T> {
    let records: Vec<T> = journal.records().cloned().collect();
    JournalRead {
        stats: crate::JournalStats {
            records: records.len() as u64,
            ..Default::default()
        },
        records,
    }
}

impl EvolutionStore {
    /// The folded statistics baseline, if a compaction ever folded usages.
    pub fn read_stats_baseline(&self) -> Result<Option<StatsBaseline>> {
        read_versioned_in(self.directory(), BASELINE_FILE, BASELINE_VERSION)
    }

    /// Compact the journals (see the module documentation). Safe to call at
    /// any time; a no-op when nothing is due.
    pub fn compact_journals(
        &self,
        weights: &SignalWeights,
        policy: CompactionPolicy,
    ) -> Result<CompactionReport> {
        let _lock = self.lock()?;
        let directory = self.directory();
        let mut usages = read_raw::<UsageRecord>(directory, USAGES_FILE)?;
        if usages.records().any(|usage| usage.tool_call_id.is_some()) {
            normalize_inline_usages(directory)?;
            usages = read_raw(directory, USAGES_FILE)?;
        }
        let outcomes = read_raw::<OutcomeObservation>(directory, OUTCOMES_FILE)?;
        let amendments = read_raw::<UsageAmendment>(directory, AMENDMENTS_FILE)?;
        let tool_calls = read_raw::<UsageToolCall>(directory, USAGE_TOOL_CALLS_FILE)?;
        let mut baseline = self.read_stats_baseline()?.unwrap_or(StatsBaseline {
            version: BASELINE_VERSION,
            ..Default::default()
        });
        let already_folded: HashSet<String> = baseline.pending_usage_ids.iter().cloned().collect();

        // Canary windows compare same-period data; never fold inside one.
        let canary_since = self
            .list_overlay_documents()?
            .iter()
            .filter_map(|document| document.candidate.as_ref())
            .filter(|candidate| candidate.state == OverlayCandidateState::Canary)
            .filter_map(|candidate| candidate.canary_started_at_ms)
            .min()
            .unwrap_or(u64::MAX);
        let cutoff = policy.cutoff_ms().min(canary_since);
        let mut latest_observation: HashMap<&str, u64> = HashMap::new();
        for outcome in outcomes.records() {
            let entry = latest_observation
                .entry(outcome.usage_id.as_str())
                .or_default();
            *entry = (*entry).max(outcome.observed_at_ms);
        }
        let folding: BTreeSet<String> = usages
            .records()
            .filter(|usage| {
                usage.started_at_ms < cutoff
                    && latest_observation
                        .get(usage.usage_id.as_str())
                        .is_none_or(|at| *at < cutoff)
            })
            .map(|usage| usage.usage_id.clone())
            .chain(already_folded.iter().cloned())
            .collect();
        let known: HashSet<&str> = usages
            .records()
            .map(|usage| usage.usage_id.as_str())
            .collect();

        let mut report = CompactionReport {
            dropped_duplicates: usages.count(|line| matches!(line, RawLine::Duplicate))
                + outcomes.count(|line| matches!(line, RawLine::Duplicate))
                + amendments.count(|line| matches!(line, RawLine::Duplicate))
                + tool_calls.count(|line| matches!(line, RawLine::Duplicate)),
            dropped_invalid: usages.count(|line| matches!(line, RawLine::Invalid))
                + outcomes.count(|line| matches!(line, RawLine::Invalid))
                + amendments.count(|line| matches!(line, RawLine::Invalid))
                + tool_calls.count(|line| matches!(line, RawLine::Invalid)),
            kept_future_lines: usages.count(|line| matches!(line, RawLine::Future(_)))
                + outcomes.count(|line| matches!(line, RawLine::Future(_)))
                + amendments.count(|line| matches!(line, RawLine::Future(_)))
                + tool_calls.count(|line| matches!(line, RawLine::Future(_))),
            ..Default::default()
        };

        // Fold newly retired usages into the baseline before any journal
        // changes (crash safety, see the module documentation).
        let newly: Vec<&str> = folding
            .iter()
            .map(String::as_str)
            .filter(|id| !already_folded.contains(*id) && known.contains(id))
            .collect();
        if !newly.is_empty() {
            let newly_set: HashSet<&str> = newly.iter().copied().collect();
            let scored = score_journals(&journal_read(&usages), &journal_read(&outcomes), weights);
            let mut buckets: BTreeMap<BucketKey, BetaEvidence> = baseline
                .buckets
                .drain(..)
                .map(|bucket| (bucket.key, bucket.evidence))
                .collect();
            for usage in scored
                .iter()
                .filter(|usage| newly_set.contains(usage.usage_id.as_str()))
            {
                buckets
                    .entry(BucketKey {
                        target_key: usage.target_key.clone(),
                        revision: usage.revision.clone(),
                        channel: usage.channel,
                    })
                    .or_default()
                    .add(&usage.score, usage.started_at_ms);
            }
            baseline.buckets = buckets
                .into_iter()
                .map(|(key, evidence)| BaselineBucket { key, evidence })
                .collect();
            baseline.folded_usages += newly.len() as u64;
            baseline.weights = weights.fingerprint();
            baseline.pending_usage_ids = folding.iter().take(PENDING_IDS_MAX).cloned().collect();
            baseline.updated_at_ms = policy.now_ms;
            baseline.version = BASELINE_VERSION;
            write_json_in(directory, BASELINE_FILE, &baseline)?;
            report.folded_usages = newly.len() as u64;
        }

        let cutoff_for_orphans = policy.cutoff_ms();
        let keep_usage = |usage: &UsageRecord| !folding.contains(&usage.usage_id);
        let keep_outcome = |outcome: &OutcomeObservation| {
            if folding.contains(&outcome.usage_id) {
                return false;
            }
            known.contains(outcome.usage_id.as_str())
                || outcome.observed_at_ms >= cutoff_for_orphans
        };
        let keep_amendment = |amendment: &UsageAmendment| {
            if folding.contains(&amendment.usage_id) {
                return false;
            }
            known.contains(amendment.usage_id.as_str())
                || amendment.recorded_at_ms >= cutoff_for_orphans
        };
        report.dropped_outcomes = outcomes
            .records()
            .filter(|outcome| !keep_outcome(outcome))
            .count() as u64;
        report.dropped_amendments = amendments
            .records()
            .filter(|amendment| !keep_amendment(amendment))
            .count() as u64;
        let linked_usage_ids: HashSet<_> = tool_calls
            .records()
            .map(|link| link.usage_id.as_str())
            .collect();
        let retained_linked_rows: HashSet<_> = usages
            .records()
            .filter(|usage| {
                keep_usage(usage)
                    && usage.tool_call_id.is_none()
                    && linked_usage_ids.contains(usage.usage_id.as_str())
            })
            .map(usage_sha256)
            .collect::<Result<_>>()?;
        for (name, bytes) in [
            (USAGES_FILE, rewrite(&usages, keep_usage)?),
            (OUTCOMES_FILE, rewrite(&outcomes, keep_outcome)?),
            (AMENDMENTS_FILE, rewrite(&amendments, keep_amendment)?),
            // Replace links after usages so a retained v1 row always has its original attribution.
            (
                USAGE_TOOL_CALLS_FILE,
                rewrite(&tool_calls, |link| {
                    retained_linked_rows.contains(&link.usage_sha256)
                })?,
            ),
        ] {
            if let Some(bytes) = bytes {
                directory.atomic_replace(OsStr::new(name), &bytes)?;
                report.rewritten = true;
            }
        }
        if !baseline.pending_usage_ids.is_empty() {
            baseline.pending_usage_ids.clear();
            write_json_in(directory, BASELINE_FILE, &baseline)?;
        }
        Ok(report)
    }
}
