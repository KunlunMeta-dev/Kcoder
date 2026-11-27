//! Default rating recorder: `rating` observations of the usages of the
//! rated turn, and the ratable-turn projection clients use to offer the
//! control.
//!
//! The latest rating of a usage stands. The journal is append-only, so a
//! changed rating (or a later reason) is a new observation: the first
//! rating of a usage keeps the id derived from the usage id alone, revision
//! `n` derives its id from the usage id and `n`. Scoring only counts the
//! latest rating (`kcoder_evolution::score_usage`). A replay of the rating
//! that currently stands (same value, no new reason) appends nothing and
//! still reports `recorded`, so a retried request after a lost receipt is
//! idempotent. Each decision is made under the scope lock against the
//! journal as it is then, so concurrent ratings never share a revision.

use super::{RatingRequest, ServiceResult};
use kcoder_evolution::{EVIDENCE_SNIPPET_MAX_BYTES, EvolutionStore, truncate_snippet};
use kcoder_types::evolution::{
    Attribution, EVOLUTION_RECORD_VERSION, ObservationMetrics, OutcomeObservation, SignalKind,
    TargetKey, TargetType, UsageRecord,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};

const RATING_SOURCE: &str = "rating_ui";

fn digest_id(seed: &str) -> String {
    let digest = Sha256::digest(seed.as_bytes());
    let hex: String = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("rating-{hex}")
}

/// Id of the first rating of a usage (unchanged from the first format).
pub(super) fn observation_id(usage_id: &str) -> String {
    digest_id(&format!("rating\0{usage_id}"))
}

/// Id of rating revision `revision` of a usage; revision 0 is the first.
pub(super) fn revision_id(usage_id: &str, revision: usize) -> String {
    if revision == 0 {
        observation_id(usage_id)
    } else {
        digest_id(&format!("rating\0{usage_id}\0{revision}"))
    }
}

fn now_ms() -> u64 {
    super::now_ms()
}

/// Rating observations of `usage_id` in journal order.
fn ratings_of<'a>(
    outcomes: &'a [OutcomeObservation],
    usage_id: &str,
) -> Vec<&'a OutcomeObservation> {
    outcomes
        .iter()
        .filter(|item| item.usage_id == usage_id && item.signal == SignalKind::Rating)
        .collect()
}

/// The rating that currently stands: latest `observedAtMs`, then journal
/// order (the same choice scoring makes).
fn current_rating<'a>(
    outcomes: &'a [OutcomeObservation],
    usage_id: &str,
) -> Option<&'a OutcomeObservation> {
    ratings_of(outcomes, usage_id)
        .into_iter()
        .enumerate()
        .max_by_key(|(position, item)| (item.observed_at_ms, *position))
        .map(|(_, item)| item)
}

/// Whether `usage` is addressed by `request`: same thread, and either the
/// recorded turn id or the recorded tool call id the client named.
fn addressed(
    usage: &UsageRecord,
    thread_id: &str,
    turn_id: &str,
    tool_call_ids: &[String],
) -> bool {
    usage.thread_id == thread_id
        && (usage.turn_id.as_deref() == Some(turn_id)
            || usage
                .tool_call_id
                .as_ref()
                .is_some_and(|call| tool_call_ids.contains(call)))
}

pub(super) fn record(
    store: &EvolutionStore,
    request: &RatingRequest,
    evidence_ttl_days: u32,
) -> ServiceResult<bool> {
    let usages = store.read_usages()?.records;
    let matching: Vec<_> = usages
        .iter()
        .filter(|usage| {
            addressed(
                usage,
                &request.thread_id,
                &request.turn_id,
                &request.tool_call_ids,
            ) && request
                .target_key
                .as_ref()
                .is_none_or(|key| &usage.target_key == key)
        })
        .collect();
    if matching.is_empty() {
        return Ok(false);
    }
    let value = if request.up { 1.0 } else { 0.0 };
    let targets: BTreeSet<_> = matching.iter().map(|usage| &usage.target_key).collect();
    let ambiguous = request.target_key.is_none() && targets.len() > 1;
    // Content-addressed: the same reason always yields the same id, so it
    // can be compared with the standing rating before deciding.
    let evidence_ref = match request
        .reason
        .as_deref()
        .filter(|text| !text.trim().is_empty())
    {
        Some(reason) => {
            let (redacted, _) = crate::session_read::redact_secrets(reason);
            let snippet = truncate_snippet(&redacted, EVIDENCE_SNIPPET_MAX_BYTES);
            Some(store.put_evidence(snippet, now_ms(), evidence_ttl_days)?)
        }
        None => None,
    };
    let mut recorded = false;
    for usage in matching {
        let attribution = if ambiguous || !usage.concurrent_targets.is_empty() {
            Attribution::Ambiguous
        } else {
            Attribution::Direct
        };
        store.append_outcome_with(|existing| {
            if let Some(current) = current_rating(existing, &usage.usage_id)
                && current.metrics.rating_value == Some(value)
                && (evidence_ref.is_none() || current.evidence_ref == evidence_ref)
            {
                // The standing rating already says this: a replay.
                return None;
            }
            // A changed value, or the same value with a new reason. The
            // reason of an opposite earlier rating is not carried over.
            let revision = ratings_of(existing, &usage.usage_id).len();
            Some(OutcomeObservation {
                version: EVOLUTION_RECORD_VERSION,
                observation_id: revision_id(&usage.usage_id, revision),
                usage_id: usage.usage_id.clone(),
                signal: SignalKind::Rating,
                metrics: ObservationMetrics {
                    rating_value: Some(value),
                    ..Default::default()
                },
                categories: Vec::new(),
                cause: None,
                attribution,
                confidence: 1.0,
                conflict: false,
                hard_failure: false,
                evidence_ref: evidence_ref.clone(),
                source: RATING_SOURCE.into(),
                observed_at_ms: now_ms(),
            })
        })?;
        recorded = true;
    }
    Ok(recorded)
}

/// One ratable turn of a thread, as `evolution/ratings/list` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RatableTurn {
    pub turn_id: String,
    /// Recorded tool calls that started the turn's usages.
    pub tool_call_ids: Vec<String>,
    pub target_keys: Vec<TargetKey>,
    /// The rating that stands for the turn (the latest across its
    /// usages), `Some(true)` for up.
    pub rating: Option<bool>,
    /// Newest usage start, for ordering.
    pub(super) started_at_ms: u64,
    /// When the standing rating was observed.
    pub(super) rated_at_ms: Option<u64>,
}

/// Fold `other` (the same turn in another scope) into `turn`.
pub(super) fn merge_ratable_turn(turn: &mut RatableTurn, other: RatableTurn) {
    for call in other.tool_call_ids {
        if !turn.tool_call_ids.contains(&call) {
            turn.tool_call_ids.push(call);
        }
    }
    for key in other.target_keys {
        if !turn.target_keys.contains(&key) {
            turn.target_keys.push(key);
        }
    }
    turn.started_at_ms = turn.started_at_ms.max(other.started_at_ms);
    if other.rated_at_ms > turn.rated_at_ms {
        turn.rating = other.rating;
        turn.rated_at_ms = other.rated_at_ms;
    }
}

/// Ratable turns of `thread_id` in `store`: skill usages grouped by their
/// recorded turn id. Usages without a turn id are not addressable.
pub(super) fn ratable_turns(
    store: &EvolutionStore,
    thread_id: &str,
) -> ServiceResult<Vec<RatableTurn>> {
    let usages = store.read_usages()?.records;
    let usages: Vec<_> = usages
        .into_iter()
        .filter(|usage| {
            usage.thread_id == thread_id
                && usage.turn_id.is_some()
                && usage.target_key.target_type() == TargetType::Skill
        })
        .collect();
    if usages.is_empty() {
        return Ok(Vec::new());
    }
    let outcomes = store.read_outcomes()?.records;
    let mut ratings: HashMap<&str, &OutcomeObservation> = HashMap::new();
    for usage in &usages {
        if let Some(current) = current_rating(&outcomes, &usage.usage_id) {
            ratings.insert(usage.usage_id.as_str(), current);
        }
    }
    let mut turns: BTreeMap<String, (RatableTurn, Option<(u64, usize)>)> = BTreeMap::new();
    for (position, usage) in usages.iter().enumerate() {
        let turn_id = usage.turn_id.clone().unwrap_or_default();
        let (turn, latest) = turns.entry(turn_id.clone()).or_insert_with(|| {
            (
                RatableTurn {
                    turn_id,
                    tool_call_ids: Vec::new(),
                    target_keys: Vec::new(),
                    rating: None,
                    started_at_ms: 0,
                    rated_at_ms: None,
                },
                None,
            )
        });
        if let Some(call) = &usage.tool_call_id
            && !turn.tool_call_ids.contains(call)
        {
            turn.tool_call_ids.push(call.clone());
        }
        if !turn.target_keys.contains(&usage.target_key) {
            turn.target_keys.push(usage.target_key.clone());
        }
        turn.started_at_ms = turn.started_at_ms.max(usage.started_at_ms);
        if let Some(current) = ratings.get(usage.usage_id.as_str()) {
            let order = (current.observed_at_ms, position);
            if latest.is_none_or(|latest| order > latest) {
                *latest = Some(order);
                turn.rating = current.metrics.rating_value.map(|value| value >= 0.5);
                turn.rated_at_ms = Some(current.observed_at_ms);
            }
        }
    }
    Ok(turns.into_values().map(|(turn, _)| turn).collect())
}
