use super::*;
use crate::{EvolutionError, SignalWeights, month_key};
use std::io::Write;
use std::time::Duration;

#[test]
fn journals_append_and_deduplicate_by_id() {
    let (_temp, store) = temp_store();
    let record = usage("u-1", "t-1", "skill:bundled:docx", Channel::Stable, 10);
    store.append_usage(&record).unwrap();
    // A retried append after a lost receipt must not double count.
    store.append_usage(&record).unwrap();
    store
        .append_usage(&usage(
            "u-2",
            "t-1",
            "skill:bundled:docx",
            Channel::Stable,
            11,
        ))
        .unwrap();
    store.append_outcome(&success("o-1", "u-1", true)).unwrap();
    store.append_outcome(&success("o-1", "u-1", false)).unwrap();

    let usages = store.read_usages().unwrap();
    assert_eq!(usages.records.len(), 2);
    assert_eq!(usages.stats.duplicates, 1);
    let outcomes = store.read_outcomes().unwrap();
    assert_eq!(outcomes.records.len(), 1);
    assert_eq!(
        outcomes.records[0].metrics.success,
        Some(true),
        "first record wins"
    );
    assert_eq!(outcomes.stats.duplicates, 1);
}

// The v1 UsageRecord fields at 581eb7dd3. A strict old binary rejects an
// unknown inline toolCallId, so a round-trip through the new decoder alone
// cannot exercise the downgrade boundary.
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyUsageRow {
    version: u32,
    usage_id: String,
    thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    attempt_id: Option<String>,
    target_key: TargetKey,
    revision: TargetRevision,
    channel: Channel,
    #[serde(default)]
    task: UsageTask,
    #[serde(default)]
    profile_hints: ProfileHints,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    artifacts: Vec<ArtifactRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    concurrent_targets: Vec<TargetKey>,
    started_at_ms: u64,
}

#[test]
fn usage_tool_calls_keep_v1_rows_readable_and_restore_the_first_matching_call() {
    let (temp, store) = temp_store();
    let mut record = usage("u-rated", "t", "skill:bundled:docx", Channel::Stable, 10);
    record.turn_id = Some("turn-1".into());
    record.attempt_id = Some("attempt-1".into());
    record.tool_call_id = Some("call-original".into());
    record.task.domain = (0..USAGE_LIST_MAX_ITEMS)
        .map(|index| (format!("field-{index}"), "fixture".into()))
        .collect();

    let bytes = serde_json::to_vec(&record).unwrap();
    assert!(serde_json::from_slice::<LegacyUsageRow>(&bytes).is_err());
    store.append_usage(&record).unwrap();
    let raw = std::fs::read_to_string(store.path().join("usages.jsonl")).unwrap();
    let old = serde_json::from_str::<LegacyUsageRow>(raw.trim()).unwrap();
    let mut expected_base = record.clone();
    expected_base.tool_call_id = None;
    assert_eq!(
        serde_json::to_value(&old).unwrap(),
        serde_json::to_value(&expected_base).unwrap()
    );

    // An older app may rewrite retained v1 rows during compaction.
    let rewritten = format!("{}\n", serde_json::to_string(&old).unwrap());
    store
        .directory()
        .atomic_replace(std::ffi::OsStr::new("usages.jsonl"), rewritten.as_bytes())
        .unwrap();
    let mut duplicate = record.clone();
    duplicate.tool_call_id = Some("call-retried".into());
    store.append_usage(&duplicate).unwrap();
    let mut conflicting = record.clone();
    conflicting.started_at_ms += 1;
    conflicting.tool_call_id = Some("call-conflicting-row".into());
    store.append_usage(&conflicting).unwrap();
    drop(store);

    let reopened = EvolutionStore::open(temp.path()).unwrap();
    let read = reopened.read_usages().unwrap();
    assert_eq!(read.records, [record]);
    assert_eq!(read.stats.duplicates, 2);
    assert_eq!(read.stats.invalid, 0);
}

#[test]
fn usage_tool_calls_keep_inline_history_and_remove_orphan_links_during_compaction() {
    use crate::usage_tool_calls::USAGE_TOOL_CALLS_FILE;

    let (_temp, store) = temp_store();
    let day = 24 * 60 * 60 * 1000;
    let now = 700 * day;
    let mut retired = usage("u-retired", "t", "skill:bundled:docx", Channel::Stable, 1);
    retired.tool_call_id = Some("retired-call".into());
    store.append_usage(&retired).unwrap();
    let mut active = usage(
        "u-active",
        "t",
        "skill:bundled:docx",
        Channel::Stable,
        now - day,
    );
    active.tool_call_id = Some("active-call".into());
    store.append_usage(&active).unwrap();
    let mut inline = usage(
        "u-inline",
        "t",
        "skill:bundled:docx",
        Channel::Stable,
        now - day,
    );
    inline.tool_call_id = Some("inline-call".into());
    append_raw(
        &store,
        "usages.jsonl",
        format!("{}\n", serde_json::to_string(&inline).unwrap()).as_bytes(),
    );
    let mut unattached = active.clone();
    unattached.started_at_ms += 2;
    unattached.tool_call_id = Some("other-call".into());
    store.append_usage(&unattached).unwrap();

    assert_eq!(
        store.read_usages().unwrap().records,
        [retired, active.clone(), inline.clone()]
    );
    let report = store
        .compact_journals(&SignalWeights::default(), crate::CompactionPolicy::new(now))
        .unwrap();
    assert_eq!(report.folded_usages, 1);
    assert_eq!(store.read_usages().unwrap().records, [active, inline]);
    let raw = std::fs::read_to_string(store.path().join(USAGE_TOOL_CALLS_FILE)).unwrap();
    assert_eq!(raw.lines().count(), 2);
    assert!(raw.contains("active-call"));
    assert!(raw.contains("inline-call"));
    let usages = std::fs::read_to_string(store.path().join("usages.jsonl")).unwrap();
    assert!(
        usages
            .lines()
            .all(|line| serde_json::from_str::<LegacyUsageRow>(line).is_ok())
    );
}

#[test]
fn usage_tool_calls_normalize_inline_rows_at_open_and_recover_staged_links() {
    use crate::usage_tool_calls::USAGE_TOOL_CALLS_FILE;
    use std::ffi::OsStr;

    let (temp, store) = temp_store();
    let mut inline = usage("one", "t", "skill:bundled:docx", Channel::Stable, 10);
    inline.tool_call_id = Some("call-inline".into());
    let mut conflicting = inline.clone();
    conflicting.tool_call_id = Some("call-conflicting".into());
    // A previous attempt can already have staged a link for the same base.
    store.append_usage(&conflicting).unwrap();
    let original_inline = serde_json::to_string(&inline).unwrap();
    let plain = usage("two", "t", "skill:bundled:docx", Channel::Stable, 11);
    let original_plain = format!("  {}", serde_json::to_string(&plain).unwrap());
    let unknown = b"{ \"version\": 81, \"futureFields\": [1, 2] }\r\n";
    let invalid = b"{\"version\": 1, \"usageId\": \"malformed\"}\n";
    let torn = b"{\"version\":1,";
    let original = [
        original_inline.as_bytes(),
        b"\n",
        original_plain.as_bytes(),
        b"\n",
        unknown,
        invalid,
        torn,
    ]
    .concat();
    let old_format = br#"{"format":"kcoder.evolution","version":1}"#;
    let reset_base = |store: &EvolutionStore| {
        store
            .directory()
            .atomic_replace(OsStr::new("usages.jsonl"), &original)
            .unwrap();
        store
            .directory()
            .atomic_replace(OsStr::new("format.json"), old_format)
            .unwrap();
    };
    reset_base(&store);
    assert!(serde_json::from_str::<LegacyUsageRow>(&original_inline).is_err());
    assert_eq!(
        store.read_usages().unwrap().records,
        [inline.clone(), plain.clone()]
    );
    drop(store);

    let migrated = EvolutionStore::open(temp.path()).unwrap();
    let raw = std::fs::read(migrated.path().join("usages.jsonl")).unwrap();
    let first_line_end = raw.iter().position(|byte| *byte == b'\n').unwrap();
    let legacy = serde_json::from_slice::<LegacyUsageRow>(&raw[..first_line_end]).unwrap();
    assert_eq!(legacy.version, 1);
    assert_eq!(legacy.usage_id, "one");
    assert_eq!(
        &raw[first_line_end + 1..],
        [original_plain.as_bytes(), b"\n", unknown, invalid, torn,].concat()
    );
    let staged_links = std::fs::read(migrated.path().join(USAGE_TOOL_CALLS_FILE)).unwrap();
    assert_eq!(
        migrated.read_usages().unwrap().records,
        [inline.clone(), plain.clone()]
    );
    let marker: serde_json::Value = migrated.read_json("format.json").unwrap().unwrap();
    assert_eq!(marker["version"], 1);
    assert_eq!(marker["usageToolCallsV1"], true);

    // Restore the pre-commit base while leaving the staged links in place.
    // This is the layout after an interruption between atomic replacements.
    reset_base(&migrated);
    assert_eq!(
        migrated.read_usages().unwrap().records,
        [inline.clone(), plain.clone()]
    );
    drop(migrated);
    let reopened = EvolutionStore::open(temp.path()).unwrap();
    assert_eq!(
        std::fs::read(reopened.path().join("usages.jsonl")).unwrap(),
        raw
    );
    assert_eq!(
        std::fs::read(reopened.path().join(USAGE_TOOL_CALLS_FILE)).unwrap(),
        staged_links
    );
    assert_eq!(reopened.read_usages().unwrap().records, [inline, plain]);
}

#[test]
fn conditional_outcome_appends_decide_on_the_journal_under_the_lock() {
    let (_temp, store) = temp_store();
    store.append_outcome(&success("o-1", "u-1", true)).unwrap();
    let appended = store
        .append_outcome_with(|existing| {
            assert_eq!(existing.len(), 1, "the decision sees the journal");
            Some(success(&format!("o-{}", existing.len() + 1), "u-1", false))
        })
        .unwrap();
    assert_eq!(
        appended.map(|item| item.observation_id).as_deref(),
        Some("o-2")
    );
    assert!(store.append_outcome_with(|_| None).unwrap().is_none());
    let outcomes = store.read_outcomes().unwrap().records;
    let ids: Vec<_> = outcomes
        .iter()
        .map(|item| item.observation_id.as_str())
        .collect();
    assert_eq!(ids, ["o-1", "o-2"]);
}

#[test]
fn invalid_records_are_rejected_before_writing() {
    let (_temp, store) = temp_store();
    let mut record = usage("../escape", "t-1", "skill:bundled:docx", Channel::Stable, 1);
    assert!(store.append_usage(&record).is_err());
    record.usage_id = "u-1".into();
    record.task.arguments = Some("x".repeat(70_000));
    assert!(store.append_usage(&record).is_err());
    assert!(store.read_usages().unwrap().records.is_empty());
}

fn append_raw(store: &EvolutionStore, name: &str, bytes: &[u8]) {
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(store.path().join(name))
        .unwrap();
    file.write_all(bytes).unwrap();
}

#[test]
fn torn_tail_future_and_invalid_lines_are_tolerated() {
    let (_temp, store) = temp_store();
    store
        .append_usage(&usage("u-1", "t", "skill:bundled:docx", Channel::Stable, 1))
        .unwrap();
    append_raw(&store, "usages.jsonl", b"not json\n");
    let mut future =
        serde_json::to_value(usage("u-9", "t", "skill:bundled:docx", Channel::Stable, 1)).unwrap();
    future["version"] = 99.into();
    future["newField"] = true.into();
    append_raw(&store, "usages.jsonl", format!("{future}\n").as_bytes());
    // Simulate a crash in the middle of an append.
    append_raw(&store, "usages.jsonl", b"{\"version\":1,\"usageId\":\"u-");

    let read = store.read_usages().unwrap();
    assert_eq!(read.records.len(), 1);
    assert_eq!(read.stats.invalid, 1);
    assert_eq!(read.stats.future, 1);
    assert!(read.stats.torn_tail);

    // The next append terminates the torn line and stays readable.
    store
        .append_usage(&usage("u-2", "t", "skill:bundled:docx", Channel::Stable, 2))
        .unwrap();
    let read = store.read_usages().unwrap();
    assert_eq!(
        read.records
            .iter()
            .map(|r| r.usage_id.as_str())
            .collect::<Vec<_>>(),
        ["u-1", "u-2"]
    );
    assert!(!read.stats.torn_tail);
    assert_eq!(
        read.stats.invalid, 2,
        "the repaired torn line now counts as invalid"
    );
}

#[test]
fn stats_rebuild_after_a_crash_between_append_and_cache_write() {
    let (_temp, store) = temp_store();
    let weights = SignalWeights::DEFAULT;
    store
        .append_usage(&usage("u-1", "t", "skill:bundled:docx", Channel::Stable, 1))
        .unwrap();
    store.append_outcome(&success("o-1", "u-1", true)).unwrap();
    let first = store.stats(&weights).unwrap();
    let bucket = first.buckets.values().next().unwrap();
    assert_eq!(bucket.observations, 1);
    assert!(store.path().join("stats.json").exists());

    // The cache is now stale: new journal data without a cache update.
    store
        .append_usage(&usage("u-2", "t", "skill:bundled:docx", Channel::Stable, 2))
        .unwrap();
    store.append_outcome(&success("o-2", "u-2", false)).unwrap();
    let second = store.stats(&weights).unwrap();
    let bucket = second.buckets.values().next().unwrap();
    assert_eq!(bucket.observations, 2);
    assert!((bucket.alpha - 1.0).abs() < 1e-12 && (bucket.beta - 1.0).abs() < 1e-12);

    // A deleted or corrupt cache is rebuilt from the journals.
    std::fs::write(store.path().join("stats.json"), b"{broken").unwrap();
    assert_eq!(store.stats(&weights).unwrap(), second);
    std::fs::remove_file(store.path().join("stats.json")).unwrap();
    assert_eq!(store.rebuild_stats(&weights).unwrap(), second);

    // Changed weights invalidate the cache.
    let mut no_procedure = weights;
    no_procedure.procedure = 0.0;
    let third = store.stats(&no_procedure).unwrap();
    assert_eq!(third.buckets.values().next().unwrap().observations, 0);
}

#[test]
fn environment_failures_do_not_score() {
    let (_temp, store) = temp_store();
    store
        .append_usage(&usage("u-1", "t", "skill:bundled:docx", Channel::Stable, 1))
        .unwrap();
    let mut failure = success("o-1", "u-1", false);
    failure.cause = Some(OutcomeCause::Environment);
    store.append_outcome(&failure).unwrap();
    let stats = store.stats(&SignalWeights::DEFAULT).unwrap();
    let bucket = stats.buckets.values().next().unwrap();
    assert_eq!((bucket.usages, bucket.observations), (1, 0));
    assert_eq!((bucket.alpha, bucket.beta), (0.0, 0.0));
}

#[test]
fn evidence_is_bounded_deduplicated_and_purged_by_ttl() {
    let (_temp, store) = temp_store();
    let day = 24 * 60 * 60 * 1000;
    let id = store.put_evidence("redacted snippet", 0, 1).unwrap();
    assert!(id.starts_with("ev-"));
    assert_eq!(store.put_evidence("redacted snippet", 0, 1).unwrap(), id);
    let other = store.put_evidence("another snippet", 0, 10).unwrap();
    assert!(matches!(
        store.put_evidence(&"x".repeat(crate::EVIDENCE_SNIPPET_MAX_BYTES + 1), 0, 1),
        Err(EvolutionError::EvidenceTooLarge { .. })
    ));
    assert_eq!(
        crate::truncate_snippet("é".repeat(10).as_str(), 5).len(),
        4,
        "truncation keeps a character boundary"
    );
    assert_eq!(
        store.read_evidence(&id, 1).unwrap().unwrap().text,
        "redacted snippet"
    );
    assert!(
        store.read_evidence(&id, 2 * day).unwrap().is_none(),
        "expired reads as absent"
    );

    assert_eq!(store.purge_expired_evidence(2 * day).unwrap(), 1);
    assert!(store.read_evidence(&other, 2 * day).unwrap().is_some());
    // Re-putting extends the expiry instead of duplicating.
    store.put_evidence("another snippet", 5 * day, 30).unwrap();
    assert_eq!(store.purge_expired_evidence(20 * day).unwrap(), 0);
    assert_eq!(store.purge_expired_evidence(40 * day).unwrap(), 1);
}

#[test]
fn scope_lock_blocks_a_second_handle_until_released() {
    let temp = tempfile::tempdir().unwrap();
    let first = EvolutionStore::open(temp.path()).unwrap();
    let second = EvolutionStore::open(temp.path())
        .unwrap()
        .with_lock_wait(Duration::from_millis(50));
    let guard = first.lock().unwrap();
    let record = usage("u-1", "t", "skill:bundled:docx", Channel::Stable, 1);
    assert!(matches!(
        second.append_usage(&record),
        Err(EvolutionError::LockBusy)
    ));
    assert_eq!(EvolutionError::LockBusy.code(), "evolution_busy");
    drop(guard);
    second.append_usage(&record).unwrap();
    assert_eq!(first.read_usages().unwrap().records.len(), 1);
}

#[test]
fn job_leases_are_exclusive_per_job_and_target() {
    let temp = tempfile::tempdir().unwrap();
    let first = EvolutionStore::open(temp.path()).unwrap();
    let second = EvolutionStore::open(temp.path()).unwrap();
    let docx = key("skill:bundled:docx");
    let pptx = key("skill:bundled:pptx");
    let lease = first
        .try_job_lease("distill", Some(&docx))
        .unwrap()
        .unwrap();
    assert!(
        second
            .try_job_lease("distill", Some(&docx))
            .unwrap()
            .is_none()
    );
    assert!(
        second
            .try_job_lease("distill", Some(&pptx))
            .unwrap()
            .is_some()
    );
    drop(lease);
    assert!(
        second
            .try_job_lease("distill", Some(&docx))
            .unwrap()
            .is_some()
    );
    assert!(first.try_job_lease("../bad", None).is_err());
}

#[test]
fn newer_format_markers_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    drop(EvolutionStore::open(temp.path()).unwrap());
    let marker = temp.path().join("evolution/format.json");
    std::fs::write(&marker, br#"{"format":"kcoder.evolution","version":2}"#).unwrap();
    assert!(matches!(
        EvolutionStore::open(temp.path()),
        Err(EvolutionError::UnsupportedFormat(2))
    ));
    assert_eq!(
        std::fs::read_to_string(&marker).unwrap(),
        r#"{"format":"kcoder.evolution","version":2}"#,
        "the newer marker is not rewritten"
    );
}

#[test]
fn state_persists_jobs_and_monthly_usage() {
    let temp = tempfile::tempdir().unwrap();
    let store = EvolutionStore::open(temp.path()).unwrap();
    // 2026-11-24T00:00:00Z and 2026-12-01T00:00:00Z.
    let november = 1_795_478_400_000;
    let december = 1_796_083_200_000;
    assert_eq!(month_key(november), "2026-11");
    assert_eq!(month_key(december), "2026-12");
    assert_eq!(month_key(0), "1970-01");
    assert_eq!(
        crate::rfc3339_from_unix_ms(november + 3_723_004),
        "2026-11-24T01:02:03.004Z"
    );
    assert_eq!(
        crate::rfc3339_from_unix_ms(951_782_400_000),
        "2000-02-29T00:00:00.000Z"
    );
    store
        .record_job_run("curator", Some("cursor-1".into()), november)
        .unwrap();
    store.record_model_usage(november, 100, 20).unwrap();
    let usage = store.record_model_usage(november, 1, 2).unwrap();
    assert_eq!((usage.input_tokens, usage.output_tokens), (101, 22));
    store
        .update_state(|state| {
            state.distill.insert(
                key("skill:bundled:docx"),
                crate::DistillCursor {
                    observed_usages: 5,
                    conflicts: 1,
                    last_run_at_ms: Some(november),
                    ..Default::default()
                },
            );
        })
        .unwrap();

    let reopened = EvolutionStore::open(temp.path()).unwrap();
    let state = reopened.read_state().unwrap();
    assert_eq!(state.jobs["curator"].last_run_at_ms, Some(november));
    assert_eq!(state.distill[&key("skill:bundled:docx")].observed_usages, 5);
    assert!(state.usage_limit_reached(november, Some(123)));
    assert!(!state.usage_limit_reached(november, None));
    assert_eq!(state.month_usage_at(december).total_tokens(), 0);
    let next = reopened.record_model_usage(december, 7, 0).unwrap();
    assert_eq!((next.month.as_str(), next.input_tokens), ("2026-12", 7));
}

#[test]
fn clear_all_removes_data_but_keeps_the_format() {
    let (_temp, store) = temp_store();
    store
        .append_usage(&usage("u-1", "t", "skill:bundled:docx", Channel::Stable, 1))
        .unwrap();
    store.put_evidence("snippet", 0, 1).unwrap();
    store.record_job_run("curator", None, 1).unwrap();
    store.clear_all().unwrap();
    assert!(store.read_usages().unwrap().records.is_empty());
    assert_eq!(store.read_state().unwrap().revision, 0);
    assert!(store.path().join("format.json").exists());
    store
        .append_usage(&usage("u-2", "t", "skill:bundled:docx", Channel::Stable, 1))
        .unwrap();
}

#[test]
fn project_scope_roots_reuse_the_memory_key_and_stay_outside_the_project() {
    use crate::{EvolutionScope, resolve_scope_root};
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("home");
    let project = temp.path().join("work space");
    std::fs::create_dir_all(&project).unwrap();
    assert_eq!(
        resolve_scope_root(&data, &EvolutionScope::User).unwrap(),
        data
    );
    let root = resolve_scope_root(
        &data,
        &EvolutionScope::Project {
            cwd: project.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        root,
        data.join("evolution-projects").join(
            kcoder_config::memory_project_key::project_key_for_path(&project)
        )
    );
    let inside = project.join(".home");
    assert!(matches!(
        resolve_scope_root(&inside, &EvolutionScope::Project { cwd: project }),
        Err(EvolutionError::ScopeInsideProject(_))
    ));
}

#[test]
fn target_storage_components_are_safe_and_case_distinct() {
    let upper = crate::target_storage_component(&key("skill:bundled:Docx"));
    let lower = crate::target_storage_component(&key("skill:bundled:docx"));
    assert_ne!(upper.to_lowercase(), lower.to_lowercase());
    let odd = crate::target_storage_component(&key("tool_usage:mcp:git hub/../x:y"));
    assert!(!odd.contains('/') && !odd.contains(':') && !odd.contains(' '));
    assert!(odd.starts_with("tool_usage.mcp."));
}
