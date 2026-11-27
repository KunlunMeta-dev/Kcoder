use super::*;
use crate::{CompactionPolicy, QueuedClassification, SignalWeights};
use std::io::Write;

const DAY: u64 = 24 * 60 * 60 * 1000;

fn assert_same_stats(left: &crate::EvolutionStats, right: &crate::EvolutionStats) {
    assert_eq!(
        left.buckets.keys().collect::<Vec<_>>(),
        right.buckets.keys().collect::<Vec<_>>()
    );
    for (key, before) in &left.buckets {
        let after = &right.buckets[key];
        assert!((before.alpha - after.alpha).abs() < 1e-9, "{key:?}");
        assert!((before.beta - after.beta).abs() < 1e-9, "{key:?}");
        assert_eq!(before.observations, after.observations);
        assert_eq!(before.usages, after.usages);
        assert_eq!(before.explicit_negatives, after.explicit_negatives);
        assert_eq!(before.hard_failures, after.hard_failures);
        assert_eq!(before.conflicts, after.conflicts);
        assert_eq!(before.last_usage_at_ms, after.last_usage_at_ms);
    }
}

fn seed(store: &EvolutionStore, now: u64) {
    for index in 0..12u64 {
        // Half of the usages are older than the one-year retention.
        let at = if index % 2 == 0 {
            now - 400 * DAY + index
        } else {
            now - DAY + index
        };
        let id = format!("u-{index}");
        let mut record = usage(&id, "t-1", "skill:bundled:docx", Channel::Stable, at);
        record.revision = TargetRevision::new("base-1", index % 3);
        store.append_usage(&record).unwrap();
        let mut observation = success(&format!("o-{index}"), &id, index % 3 != 0);
        observation.observed_at_ms = at + 1;
        store.append_outcome(&observation).unwrap();
        store
            .append_usage_amendment(&UsageAmendment {
                version: EVOLUTION_RECORD_VERSION,
                amendment_id: format!("a-{index}"),
                usage_id: id.clone(),
                profile_hints: ProfileHints::default(),
                artifacts: Vec::new(),
                artifact_evidence: Default::default(),
                concurrent_targets: Vec::new(),
                recorded_at_ms: at + 2,
            })
            .unwrap();
    }
    // A retried append and a torn tail.
    store
        .append_usage(&usage(
            "u-1",
            "t-1",
            "skill:bundled:docx",
            Channel::Stable,
            5,
        ))
        .unwrap();
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(store.path().join("outcomes.jsonl"))
        .unwrap();
    file.write_all(b"{\"version\":1,\"observ").unwrap();
}

#[test]
fn compaction_keeps_stats_identical_and_drops_retired_records() {
    let (_temp, store) = temp_store();
    let now = 1_000 * DAY;
    seed(&store, now);
    let weights = SignalWeights::default();
    let before = store.rebuild_stats(&weights).unwrap();

    let report = store
        .compact_journals(&weights, CompactionPolicy::new(now))
        .unwrap();
    assert!(report.rewritten);
    assert_eq!(report.folded_usages, 6);
    assert_eq!(report.dropped_duplicates, 1);
    assert_eq!(report.dropped_invalid, 1, "the torn tail");
    assert_eq!(store.read_usages().unwrap().records.len(), 6);
    assert_eq!(store.read_outcomes().unwrap().records.len(), 6);
    assert_eq!(store.read_usage_amendments().unwrap().records.len(), 6);

    // Cached, rebuilt and recomputed statistics all match the original.
    assert_same_stats(&before, &store.stats(&weights).unwrap());
    assert_same_stats(&before, &store.rebuild_stats(&weights).unwrap());
    let baseline = store.read_stats_baseline().unwrap().unwrap();
    assert!(baseline.pending_usage_ids.is_empty());
    assert_eq!(baseline.folded_usages, 6);

    // A second compaction has nothing left to do and changes nothing.
    let again = store
        .compact_journals(&weights, CompactionPolicy::new(now))
        .unwrap();
    assert!(!again.rewritten);
    assert_eq!(again.folded_usages, 0);
    assert_same_stats(&before, &store.rebuild_stats(&weights).unwrap());
}

#[test]
fn pending_folded_ids_are_not_double_counted_after_a_crash() {
    let (_temp, store) = temp_store();
    let now = 1_000 * DAY;
    seed(&store, now);
    let weights = SignalWeights::default();
    let before = store.rebuild_stats(&weights).unwrap();
    store
        .compact_journals(&weights, CompactionPolicy::new(now))
        .unwrap();
    // Simulate a crash after the baseline was written but before the
    // journals were replaced: re-append a folded usage and mark it pending.
    let mut baseline = store.read_stats_baseline().unwrap().unwrap();
    baseline.pending_usage_ids = vec!["u-0".into()];
    std::fs::write(
        store.path().join("stats-baseline.json"),
        serde_json::to_vec(&baseline).unwrap(),
    )
    .unwrap();
    let mut old = usage(
        "u-0",
        "t-1",
        "skill:bundled:docx",
        Channel::Stable,
        now - 400 * DAY,
    );
    old.revision = TargetRevision::new("base-1", 0);
    store.append_usage(&old).unwrap();
    assert_same_stats(&before, &store.rebuild_stats(&weights).unwrap());
    // The next compaction finishes the interrupted one.
    store
        .compact_journals(&weights, CompactionPolicy::new(now))
        .unwrap();
    assert!(
        store
            .read_usages()
            .unwrap()
            .records
            .iter()
            .all(|usage| usage.usage_id != "u-0")
    );
    assert_same_stats(&before, &store.rebuild_stats(&weights).unwrap());
}

#[test]
fn future_lines_survive_compaction_and_canary_windows_are_never_folded() {
    let (_temp, store) = temp_store();
    let now = 1_000 * DAY;
    let key = key("skill:bundled:docx");
    store
        .stage_candidate(
            &key,
            None,
            "base-1",
            &OverlayContent {
                lessons: "- lead with the outcome".into(),
                ..Default::default()
            },
            "prop-1",
            1,
        )
        .unwrap();
    let document = store.overlay_document(&key).unwrap().unwrap();
    // The canary started long ago (older than the retention cutoff).
    store
        .start_canary(&key, document.revision, 0.5, now - 500 * DAY)
        .unwrap();
    store
        .append_usage(&usage(
            "inside",
            "t-1",
            "skill:bundled:docx",
            Channel::Candidate,
            now - 450 * DAY,
        ))
        .unwrap();
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(store.path().join("usages.jsonl"))
        .unwrap();
    file.write_all(b"{\"version\":99,\"usageId\":\"future\"}\n")
        .unwrap();
    let report = store
        .compact_journals(&SignalWeights::default(), CompactionPolicy::new(now))
        .unwrap();
    assert_eq!(report.folded_usages, 0, "inside an active canary window");
    let raw = std::fs::read_to_string(store.path().join("usages.jsonl")).unwrap();
    assert!(raw.contains("\"version\":99"));
    assert_eq!(store.read_usages().unwrap().records.len(), 1);
}

#[test]
fn rollout_ledger_and_classification_queue_round_trip() {
    let (_temp, store) = temp_store();
    let ledger = store
        .update_rollout_ledger(|ledger| {
            ledger.approved.insert("prop-1".into(), 5);
            ledger.eval_attempts.insert("prop-1".into(), 1);
        })
        .unwrap();
    assert_eq!(ledger.revision, 1);
    let ledger = store
        .update_rollout_ledger(|ledger| ledger.settle("prop-1"))
        .unwrap();
    assert!(ledger.approved.is_empty() && ledger.eval_attempts.is_empty());

    let item = |id: &str, at: u64| QueuedClassification {
        usage_id: id.into(),
        user_text: "no, the summary goes first".into(),
        previous_answer: "Here is the report.".into(),
        overlay_text: None,
        concurrent: 0,
        queued_at_ms: at,
    };
    store
        .enqueue_classifications(&[item("use-1", 10), item("use-2", 20)])
        .unwrap();
    // Re-queueing the same usage keeps one entry.
    store.enqueue_classifications(&[item("use-1", 30)]).unwrap();
    // A reopened store (a restarted process) sees the queue.
    let reopened = EvolutionStore::open(_temp.path()).unwrap();
    let queue = reopened.read_classification_queue().unwrap();
    assert_eq!(
        queue
            .iter()
            .map(|item| item.usage_id.as_str())
            .collect::<Vec<_>>(),
        ["use-1", "use-2"]
    );
    reopened.remove_classifications(&["use-1".into()]).unwrap();
    assert_eq!(reopened.expire_classifications(25).unwrap(), 1);
    assert!(reopened.read_classification_queue().unwrap().is_empty());
    let mut oversized = item("use-3", 1);
    oversized.user_text = "x".repeat(crate::CLASSIFY_QUEUE_TEXT_MAX_BYTES + 1);
    assert!(reopened.enqueue_classifications(&[oversized]).is_err());
}
