mod compaction;
mod distill;
mod math;
mod overlays;
mod patterns;
mod policy;
mod preferences;
mod proposals;
mod status;
mod storage;

use crate::EvolutionStore;
use kcoder_types::evolution::*;

pub(crate) fn temp_store() -> (tempfile::TempDir, EvolutionStore) {
    let temp = tempfile::tempdir().unwrap();
    let store = EvolutionStore::open(temp.path()).unwrap();
    (temp, store)
}

pub(crate) fn key(value: &str) -> TargetKey {
    TargetKey::parse(value).unwrap()
}

pub(crate) fn usage(
    id: &str,
    thread: &str,
    target: &str,
    channel: Channel,
    at: u64,
) -> UsageRecord {
    UsageRecord {
        version: EVOLUTION_RECORD_VERSION,
        usage_id: id.into(),
        thread_id: thread.into(),
        turn_id: None,
        attempt_id: None,
        tool_call_id: None,
        target_key: key(target),
        revision: TargetRevision::new("base-1", 0),
        channel,
        task: UsageTask::default(),
        profile_hints: ProfileHints::default(),
        artifacts: Vec::new(),
        concurrent_targets: Vec::new(),
        started_at_ms: at,
    }
}

pub(crate) fn outcome(id: &str, usage_id: &str, signal: SignalKind) -> OutcomeObservation {
    OutcomeObservation {
        version: EVOLUTION_RECORD_VERSION,
        observation_id: id.into(),
        usage_id: usage_id.into(),
        signal,
        metrics: ObservationMetrics::default(),
        categories: Vec::new(),
        cause: None,
        attribution: Attribution::Direct,
        confidence: 1.0,
        conflict: false,
        hard_failure: false,
        evidence_ref: None,
        source: "procedure".into(),
        observed_at_ms: 1,
    }
}

pub(crate) fn success(id: &str, usage_id: &str, ok: bool) -> OutcomeObservation {
    let mut observation = outcome(id, usage_id, SignalKind::TaskTerminal);
    observation.metrics.success = Some(ok);
    observation
}
