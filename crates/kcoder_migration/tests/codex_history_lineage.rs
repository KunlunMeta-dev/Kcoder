use kcoder_migration::history_codex::select_codex_history_from_lineage;
use kcoder_migration::{
    history_codex::resolve_codex_history_lineage, history_normalization::HistoryNormalizer,
    history_records::CODEX_ROLLOUT_BASELINE, history_sources::HistorySourceBinding,
};
use kcoder_state::external_history::ExternalHistoryStore;
use kcoder_types::{
    external_history::*, imported_transcript::HistoricalCodexBase, migration::MigrationSourceKind,
};
use serde_json::{Value, json};
use std::path::Path;

const A: &str = "11111111-1111-4111-8111-111111111111";
const B: &str = "22222222-2222-4222-8222-222222222222";
const C: &str = "33333333-3333-4333-8333-333333333333";
const D: &str = "44444444-4444-4444-8444-444444444444";

struct Imported {
    id: String,
    physical: String,
    first: u64,
    ends: Vec<u64>,
}
impl Imported {
    fn cutoff(&self, records: usize) -> HistoricalCodexBase {
        HistoricalCodexBase {
            rollout_id: self.physical.clone(),
            end_ordinal_exclusive: self.first + records as u64,
            end_byte_offset: self.ends[records - 1],
        }
    }
}
fn source(
    from: &Path,
    store: &ExternalHistoryStore,
    thread: &str,
    physical: &str,
    base: Option<HistoricalCodexBase>,
    items: Vec<Value>,
    operation: &str,
) -> Imported {
    let mut meta = json!({"id":thread,"session_id":thread,"cli_version":CODEX_ROLLOUT_BASELINE,"history_mode":"paginated"});
    if let Some(base) = base {
        meta["history_base"] = json!({"thread_id":base.rollout_id,"end_ordinal_exclusive":base.end_ordinal_exclusive,"end_byte_offset":base.end_byte_offset});
    }
    let mut records = vec![json!({"type":"session_meta","payload":meta})];
    records.extend(items);
    capture(from, store, thread, physical, records, operation)
}
fn capture(
    from: &Path,
    store: &ExternalHistoryStore,
    thread: &str,
    physical: &str,
    records: Vec<Value>,
    operation: &str,
) -> Imported {
    let first = records[0]
        .get("ordinal")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| {
            records[0]["payload"]["history_base"]["end_ordinal_exclusive"]
                .as_u64()
                .unwrap_or(0)
        });
    let mut bytes = Vec::new();
    let mut ends = Vec::new();
    for (at, mut record) in records.into_iter().enumerate() {
        if record.get("ordinal").is_none() {
            record["ordinal"] = (first + at as u64).into();
        }
        record["timestamp"] = "2026-10-16T00:00:00Z".into();
        serde_json::to_writer(&mut bytes, &record).unwrap();
        bytes.push(b'\n');
        ends.push(bytes.len() as u64);
    }
    let filename = if physical == thread {
        format!("rollout-2026-10-16T00-00-00-{thread}.jsonl")
    } else {
        format!("rollout-2026-10-16T00-00-00-{thread}_{physical}.jsonl")
    };
    std::fs::write(from.join(&filename), &bytes).unwrap();
    let origin = ExternalHistoryOrigin {
        source: MigrationSourceKind::Codex,
        source_instance: "owned-source-family".into(),
        source_session_id: thread.into(),
        source_artifact_id: None,
        source_format: "synthetic-codex-jsonl".into(),
        adapter_revision: "raw/1".into(),
        title: None,
        created_at: None,
        updated_at: None,
        project: None,
        archived: false,
        parent_session_id: None,
    };
    let binding =
        HistorySourceBinding::capture(from, Path::new(&filename), origin, &mut |_, _| true)
            .unwrap();
    assert_eq!(
        binding.snapshot().origin.source_artifact_id.as_deref(),
        Some(physical)
    );
    let receipt = binding
        .archive(store, operation, &mut |_| true)
        .unwrap()
        .receipt;
    let mut normalizer =
        HistoryNormalizer::open(store.reader(&receipt.archive_id).unwrap()).unwrap();
    while !normalizer.progress().unwrap().normalization_complete {
        normalizer.step(10, |_| true).unwrap();
    }
    Imported {
        id: receipt.archive_id,
        physical: physical.into(),
        first,
        ends,
    }
}
fn message(text: &str) -> Value {
    json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}})
}
fn error(
    result: Result<kcoder_migration::history_codex::CodexHistoryLineage, anyhow::Error>,
    code: &str,
) {
    assert!(
        result
            .err()
            .expect("expected incomplete lineage")
            .to_string()
            .contains(code)
    );
}

#[test]
fn current_structural_lineage_accepts_newer_versions_but_legacy_projection_remains_pinned() {
    use kcoder_migration::{
        history_codex::resolve_codex_history_lineage_with_revision,
        history_normalization::HISTORY_NORMALIZATION_REVISION_V5,
    };
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let parent = capture(
        from.path(),
        &store,
        A,
        B,
        vec![
            json!({"type":"session_meta","payload":{"id":A,"session_id":A,"cli_version":"99.0.0","history_mode":"paginated"}}),
            message("retained"),
        ],
        "new-parent",
    );
    let base = parent.cutoff(2);
    let child = capture(
        from.path(),
        &store,
        A,
        C,
        vec![
            json!({"type":"session_meta","payload":{"id":A,"session_id":A,"cli_version":"99.0.0","history_mode":"paginated","history_base":{"thread_id":base.rollout_id,"end_ordinal_exclusive":base.end_ordinal_exclusive,"end_byte_offset":base.end_byte_offset}}}),
            message("continued"),
        ],
        "new-child",
    );
    let lineage =
        resolve_codex_history_lineage(&store, &child.id, std::slice::from_ref(&parent.id), |_| {
            true
        })
        .unwrap();
    assert_eq!(lineage.segments().len(), 2);
    for archive in [&parent.id, &child.id] {
        let mut normalizer = HistoryNormalizer::open_with_revision(
            store.reader(archive).unwrap(),
            HISTORY_NORMALIZATION_REVISION_V5,
        )
        .unwrap();
        while !normalizer.progress().unwrap().normalization_complete {
            normalizer.step(10, |_| true).unwrap();
        }
    }
    error(
        resolve_codex_history_lineage_with_revision(
            &store,
            &child.id,
            &[parent.id],
            HISTORY_NORMALIZATION_REVISION_V5,
            |_| true,
        ),
        "history_lineage_source_version_unsupported",
    );
}

#[test]
fn nested_prefixes_use_physical_files_and_exclude_newer_parent_tails() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let grand = source(
        from.path(),
        &store,
        A,
        A,
        None,
        vec![
            message("shared grandparent"),
            message("excluded grandparent tail"),
        ],
        "grand",
    );
    let parent = source(
        from.path(),
        &store,
        B,
        B,
        Some(grand.cutoff(2)),
        vec![message("shared parent"), message("excluded parent tail")],
        "parent",
    );
    let child = source(
        from.path(),
        &store,
        C,
        C,
        Some(parent.cutoff(2)),
        vec![message("local child")],
        "child",
    );
    let selected =
        resolve_codex_history_lineage(&store, &child.id, &[parent.id, grand.id], |_| true).unwrap();
    assert_eq!(selected.segments().len(), 3);
    assert_eq!(
        selected
            .segments()
            .iter()
            .map(|segment| segment.first_ordinal())
            .collect::<Vec<_>>(),
        [1, 3, 5]
    );
    for segment in selected.segments() {
        assert_eq!(segment.end_record_exclusive(), 2);
        let record = selected.record(&store, segment.source_index(), 1).unwrap();
        assert_eq!(record.persisted_ordinal, Some(segment.first_ordinal()));
        assert!(selected.record(&store, segment.source_index(), 2).is_err());
        assert!(selected.record(&store, segment.source_index(), 0).is_err());
    }
}

#[test]
fn revert_can_keep_the_same_thread_id_while_using_a_distinct_physical_parent() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let previous = source(
        from.path(),
        &store,
        A,
        B,
        None,
        vec![message("old retained input")],
        "previous",
    );
    let reverted = source(
        from.path(),
        &store,
        A,
        C,
        Some(previous.cutoff(2)),
        vec![message("new input")],
        "reverted",
    );
    let selected =
        resolve_codex_history_lineage(&store, &reverted.id, &[previous.id], |_| true).unwrap();
    assert_eq!(selected.segments().len(), 2);
}

#[test]
fn omitted_sources_wrong_offsets_and_wrong_ordinals_cannot_satisfy_a_base() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let parent = source(
        from.path(),
        &store,
        A,
        A,
        None,
        vec![message("first"), message("tail")],
        "parent",
    );
    let child = source(
        from.path(),
        &store,
        B,
        B,
        Some(parent.cutoff(2)),
        vec![],
        "child",
    );
    error(
        resolve_codex_history_lineage(&store, &child.id, &[], |_| true),
        "history_lineage_missing_selected_base",
    );
    let mut cutoff = parent.cutoff(2);
    cutoff.end_byte_offset += 1;
    let bad = source(from.path(), &store, C, C, Some(cutoff), vec![], "offset");
    error(
        resolve_codex_history_lineage(&store, &bad.id, std::slice::from_ref(&parent.id), |_| true),
        "history_lineage_cutoff_not_record_boundary",
    );
    let mut cutoff = parent.cutoff(2);
    cutoff.end_ordinal_exclusive += 1;
    let bad = source(from.path(), &store, D, D, Some(cutoff), vec![], "ordinal");
    error(
        resolve_codex_history_lineage(&store, &bad.id, &[parent.id], |_| true),
        "history_lineage_cutoff_ordinal_mismatch",
    );
}

#[test]
fn duplicate_snapshots_with_equal_prefixes_are_stable_but_conflicting_prefixes_are_rejected() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let old = source(
        from.path(),
        &store,
        A,
        A,
        None,
        vec![message("shared")],
        "old",
    );
    let new = source(
        from.path(),
        &store,
        A,
        A,
        None,
        vec![message("shared"), message("newer tail")],
        "new",
    );
    let child = source(
        from.path(),
        &store,
        B,
        B,
        Some(old.cutoff(2)),
        vec![message("child")],
        "child",
    );
    let first =
        resolve_codex_history_lineage(&store, &child.id, &[old.id.clone(), new.id.clone()], |_| {
            true
        })
        .unwrap();
    let second =
        resolve_codex_history_lineage(&store, &child.id, &[new.id.clone(), old.id.clone()], |_| {
            true
        })
        .unwrap();
    assert_eq!(first.lineage_sha256(), second.lineage_sha256());
    assert_eq!(
        first
            .segments()
            .iter()
            .map(|segment| segment.source_index())
            .collect::<Vec<_>>(),
        second
            .segments()
            .iter()
            .map(|segment| segment.source_index())
            .collect::<Vec<_>>()
    );
    let conflict = source(
        from.path(),
        &store,
        A,
        A,
        None,
        vec![message("edited")],
        "conflict",
    );
    error(
        resolve_codex_history_lineage(&store, &child.id, &[old.id, conflict.id], |_| true),
        "history_lineage_ambiguous_prefix",
    );
}

#[test]
fn cyclic_physical_lineage_is_rejected_without_infinite_recursion() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let parent = source(
        from.path(),
        &store,
        B,
        B,
        Some(HistoricalCodexBase {
            rollout_id: A.into(),
            end_ordinal_exclusive: 50,
            end_byte_offset: 1,
        }),
        (0..49).map(|_| message("prefix")).collect(),
        "parent",
    );
    let child = source(
        from.path(),
        &store,
        A,
        A,
        Some(parent.cutoff(50)),
        vec![],
        "child",
    );
    error(
        resolve_codex_history_lineage(&store, &child.id, &[parent.id], |_| true),
        "history_lineage_cycle",
    );
}

#[test]
fn reordered_or_missing_persisted_ordinals_are_rejected_even_at_valid_byte_boundaries() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let mut wrong = message("wrong ordinal");
    wrong["ordinal"] = 77.into();
    let parent = source(from.path(), &store, A, A, None, vec![wrong], "parent");
    let child = source(
        from.path(),
        &store,
        B,
        B,
        Some(parent.cutoff(2)),
        vec![],
        "child",
    );
    error(
        resolve_codex_history_lineage(&store, &child.id, &[parent.id], |_| true),
        "history_lineage_ordinal_mismatch",
    );
}

#[test]
fn parent_tail_diagnostics_do_not_pollute_an_earlier_valid_prefix() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let parent = source(
        from.path(),
        &store,
        A,
        A,
        None,
        vec![
            message("shared"),
            json!({"type":"unknown_future_payload","payload":{}}),
        ],
        "parent",
    );
    let child = source(
        from.path(),
        &store,
        B,
        B,
        Some(parent.cutoff(2)),
        vec![message("child")],
        "child",
    );
    let selected =
        resolve_codex_history_lineage(&store, &child.id, &[parent.id], |_| true).unwrap();
    assert_eq!(selected.segments()[0].end_record_exclusive(), 2);
}

#[test]
fn archive_only_recovery_survives_source_removal_and_rejects_other_profiles() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let parent = source(
        from.path(),
        &store,
        A,
        A,
        None,
        vec![message("shared")],
        "parent",
    );
    let child = source(
        from.path(),
        &store,
        B,
        B,
        Some(parent.cutoff(2)),
        vec![message("child")],
        "child",
    );
    let original =
        resolve_codex_history_lineage(&store, &child.id, std::slice::from_ref(&parent.id), |_| {
            true
        })
        .unwrap();
    from.close().unwrap();
    drop(store);
    let store = ExternalHistoryStore::open_existing(to.path())
        .unwrap()
        .unwrap();
    let restored =
        resolve_codex_history_lineage(&store, &child.id, &[parent.id], |_| true).unwrap();
    assert_eq!(original.lineage_sha256(), restored.lineage_sha256());
    let segment = &restored.segments()[0];
    assert!(restored.record(&store, segment.source_index(), 1).is_ok());
    let other = tempfile::tempdir().unwrap();
    let other_store = ExternalHistoryStore::open(other.path()).unwrap();
    assert!(
        restored
            .record(&other_store, segment.source_index(), 1)
            .err()
            .unwrap()
            .to_string()
            .contains("history_lineage_owner_mismatch")
    );
    error(
        resolve_codex_history_lineage(&store, &child.id, &[], |_| false),
        "history_selection_cancelled",
    );
}

#[test]
fn selected_files_from_another_source_root_cannot_be_joined_by_a_matching_id() {
    let from = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let parent = source(
        other.path(),
        &store,
        A,
        A,
        None,
        vec![message("foreign root")],
        "parent",
    );
    let child = source(
        from.path(),
        &store,
        B,
        B,
        Some(parent.cutoff(2)),
        vec![],
        "child",
    );
    error(
        resolve_codex_history_lineage(&store, &child.id, &[parent.id], |_| true),
        "history_lineage_source_scope_mismatch",
    );
}

#[test]
fn a_parent_compaction_and_child_rollback_share_one_window_without_replaying_tools() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let parent = source(
        from.path(),
        &store,
        A,
        A,
        None,
        vec![
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"parent-turn"}}),
            message("parent input"),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"old-write","name":"write","arguments":"{\"path\":\"NEVER_EXECUTE\"}"}}),
            json!({"type":"compacted","payload":{"message":"summary","window_number":1,"replacement_history":[
            {"type":"message","role":"user","content":[{"type":"input_text","text":"parent input"}]},
            {"type":"message","role":"assistant","content":[{"type":"output_text","text":"retained summary"}]}]}}),
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"parent-turn"}}),
        ],
        "parent",
    );
    let child = source(
        from.path(),
        &store,
        B,
        B,
        Some(parent.cutoff(6)),
        vec![
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"child-turn"}}),
            message("remove child input"),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"remove child answer"}]}}),
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"child-turn"}}),
            json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}),
        ],
        "child",
    );
    let closure = resolve_codex_history_lineage(&store, &child.id, &[parent.id], |_| true).unwrap();
    let selected = select_codex_history_from_lineage(&store, closure, |_| true).unwrap();
    assert!(selected.complete_window());
    assert_eq!(selected.checkpoint(), Some(4));
    assert_eq!(selected.checkpoint_source(), Some(1));
    assert_eq!(selected.items().len(), 2);
    assert!(
        selected
            .items()
            .iter()
            .all(|item| item.source_index == 1 && item.record == 4)
    );
    let kcoder_types::imported_transcript::HistoricalRecordData::Message { blocks, .. } =
        selected.item_from_store(&store, 1).unwrap()
    else {
        panic!("message expected")
    };
    assert!(
        matches!(&blocks[0],kcoder_types::imported_transcript::HistoricalBlock::Text {value} if value.preview.as_deref()==Some("retained summary"))
    );
    assert!(!to.path().join("NEVER_EXECUTE").exists());
}

#[test]
fn child_rollback_can_remove_a_parent_turn_while_keep_original_archives_unchanged() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let parent = source(
        from.path(),
        &store,
        A,
        A,
        None,
        vec![message("keep parent"), message("remove parent")],
        "parent",
    );
    let child = source(
        from.path(),
        &store,
        B,
        B,
        Some(parent.cutoff(3)),
        vec![
            json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}),
            message("child input"),
        ],
        "child",
    );
    let closure =
        resolve_codex_history_lineage(&store, &child.id, std::slice::from_ref(&parent.id), |_| {
            true
        })
        .unwrap();
    let selected = select_codex_history_from_lineage(&store, closure, |_| true).unwrap();
    assert!(selected.complete_window());
    assert_eq!(
        selected
            .items()
            .iter()
            .map(|item| (item.source_index, item.record))
            .collect::<Vec<_>>(),
        [(1, 1), (0, 2)]
    );
    assert_eq!(
        store
            .reader(&parent.id)
            .unwrap()
            .records(0, 10)
            .unwrap()
            .total_records,
        3
    );
    let other = tempfile::tempdir().unwrap();
    let other_store = ExternalHistoryStore::open(other.path()).unwrap();
    assert!(selected.item_from_store(&other_store, 0).is_err());
}

#[test]
fn complete_window_ignores_unselected_parent_tail_diagnostics_but_preserves_source_facts() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let parent = source(
        from.path(),
        &store,
        A,
        A,
        None,
        vec![
            message("included"),
            json!({"type":"unknown_future_record","payload":{}}),
        ],
        "parent",
    );
    let child = source(
        from.path(),
        &store,
        B,
        B,
        Some(parent.cutoff(2)),
        vec![message("local")],
        "child",
    );
    let closure =
        resolve_codex_history_lineage(&store, &child.id, std::slice::from_ref(&parent.id), |_| {
            true
        })
        .unwrap();
    let selected = select_codex_history_from_lineage(&store, closure, |_| true).unwrap();
    assert!(selected.complete_window());
    assert_eq!(selected.items().len(), 2);
    let reader = store.reader(&parent.id).unwrap();
    let index = reader
        .projection(
            kcoder_migration::history_normalization::HISTORY_NORMALIZATION_REVISION,
            false,
        )
        .unwrap()
        .unwrap();
    assert_eq!(index.progress().unwrap().records_with_diagnostics, 1);
}

#[test]
fn incomplete_subagent_initialization_cannot_be_used_as_a_ready_root() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let root = capture(
        from.path(),
        &store,
        A,
        A,
        vec![
            json!({"type":"session_meta","ordinal":0,"payload":{"id":A,"session_id":A,"cli_version":CODEX_ROLLOUT_BASELINE,"history_mode":"paginated","subagent_history_start_ordinal":10}}),
            message("unfinished copied prefix"),
        ],
        "partial",
    );
    error(
        resolve_codex_history_lineage(&store, &root.id, &[], |_| true),
        "history_lineage_child_prefix_incomplete",
    );
}

#[test]
fn ordinal_overflow_is_reported_without_wrapping_or_guessing_a_missing_ordinal() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let store = ExternalHistoryStore::open(to.path()).unwrap();
    let root = source(
        from.path(),
        &store,
        A,
        A,
        Some(HistoricalCodexBase {
            rollout_id: B.into(),
            end_ordinal_exclusive: u64::MAX,
            end_byte_offset: 1,
        }),
        vec![],
        "overflow",
    );
    error(
        resolve_codex_history_lineage(&store, &root.id, &[], |_| true),
        "history_lineage_ordinal_overflow",
    );
}
