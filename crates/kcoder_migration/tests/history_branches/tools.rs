use super::*;
use kcoder_types::historical_tool_links::{HistoricalToolLinkStage, HistoricalToolLinkStatus};
use kcoder_types::imported_transcript::HistoricalToolOutcome;

fn selected(
    profile: &Path,
    root: &Path,
    records: Vec<Value>,
    kind: MigrationSourceKind,
) -> (String, String) {
    let (job, _, _) = archive(profile, root, kind, A, A, records);
    let store = HistoryBranchStore::open(profile).unwrap();
    let prepared = store.prepare(&job, &[]).unwrap();
    store.build(&job, &prepared.view_id, || true).unwrap();
    (job, prepared.view_id)
}
fn claude(id: &str, parent: Option<&str>, kind: &str, content: Value) -> Value {
    json!({"type":kind,"uuid":id,"parentUuid":parent,"sessionId":A,"version":"2.1.301","message":{"role":kind,"content":content}})
}

#[test]
fn codex_patch_execution_is_selected_and_enriched_without_fabricating_a_missing_result() {
    use kcoder_migration::history_context::HistoryContextCompiler;
    use kcoder_types::historical_context::{HistoricalContextFactKind, HistoricalContextPolicy};
    for include_result in [true, false] {
        let profile = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let mut records = include_str!("../../fixtures/codex-patch-execution-0.163.0.jsonl")
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        records[0]["payload"]["id"] = json!(A);
        if !include_result {
            records.pop();
        }
        let (job, view) = selected(
            profile.path(),
            source.path(),
            records,
            MigrationSourceKind::Codex,
        );
        let store = HistoryBranchStore::open(profile.path()).unwrap();
        store.correlate(&job, &view, None, || true).unwrap();
        let links = store.tools_page(&job, &view, None).unwrap();
        assert_eq!(links.links.len(), 1);
        let link = &links.links[0];
        assert_eq!(
            link.execution_outcome,
            Some(HistoricalToolOutcome::RecordedSuccess)
        );
        assert_eq!(link.execution_event.as_ref().unwrap().record, 2);
        let compiled = HistoryContextCompiler::open(profile.path())
            .unwrap()
            .compile(&job, &view, HistoricalContextPolicy::default(), |_| true)
            .unwrap();
        if include_result {
            assert_eq!(link.status, HistoricalToolLinkStatus::Linked);
            assert_eq!(link.outcome, HistoricalToolOutcome::RecordedSuccess);
            assert!(compiled.report.context_compiled, "{:?}", compiled.report);
            let results = compiled
                .document
                .unwrap()
                .entries
                .into_iter()
                .filter(|entry| entry.kind == HistoricalContextFactKind::ToolResultFact)
                .collect::<Vec<_>>();
            // The compiler retains one outcome header and one body part, never a second result.
            assert_eq!(results.len(), 2);
            assert_eq!(
                results.iter().filter(|entry| entry.text.is_empty()).count(),
                1
            );
            assert_eq!(
                results
                    .iter()
                    .filter(|entry| entry.text == "A response was received")
                    .count(),
                1
            );
            assert!(results.iter().all(
                |entry| entry.execution_outcome == Some(HistoricalToolOutcome::RecordedSuccess)
            ));
        } else {
            assert_eq!(link.status, HistoricalToolLinkStatus::MissingResult);
            assert_eq!(link.outcome, HistoricalToolOutcome::OutcomeUnknown);
            assert!(link.result.is_none());
            assert!(!compiled.report.context_compiled);
            assert!(compiled.document.is_none());
        }
    }
}

#[test]
fn a_late_patch_receipt_for_a_rolled_back_turn_never_attaches_to_the_retained_call_id() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let user = |turn: &str| json!({"type":"response_item","payload":{"type":"message","role":"user","turn_id":turn,"content":[{"type":"input_text","text":turn}]}});
    let call = |turn: &str| json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":"reused","name":"apply_patch","input":"inert patch","turn_id":turn}});
    let result = |turn: &str| json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"reused","output":"received only","turn_id":turn}});
    let (job, view) = selected(
        profile.path(),
        source.path(),
        vec![
            json!({"type":"session_meta","payload":{"id":A,"cli_version":"0.163.0"}}),
            user("retained"),
            call("retained"),
            result("retained"),
            user("discarded"),
            call("discarded"),
            result("discarded"),
            json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}),
            json!({"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"reused","turn_id":"discarded","success":false,"status":"failed"}}),
        ],
        MigrationSourceKind::Codex,
    );
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    assert_eq!(
        store.progress(&job, &view).unwrap().structural_complete,
        Some(true)
    );
    assert_eq!(row(profile.path(), &view, 0), vec![1, 2, 3]);
    store.correlate(&job, &view, None, || true).unwrap();
    let links = store.tools_page(&job, &view, None).unwrap();
    assert_eq!(links.links.len(), 1);
    assert_eq!(
        links.links[0].outcome,
        HistoricalToolOutcome::RecordedResult
    );
    assert!(links.links[0].execution_event.is_none());
    assert!(links.links[0].execution_outcome.is_none());
}

#[test]
fn patch_receipts_without_unique_turn_ownership_leave_the_branch_read_only() {
    for omit_turn in [true, false] {
        let profile = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let mut records = include_str!("../../fixtures/codex-patch-execution-0.163.0.jsonl")
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        records[0]["payload"]["id"] = json!(A);
        if omit_turn {
            records[2]["payload"]
                .as_object_mut()
                .unwrap()
                .remove("turn_id");
        } else {
            records.insert(2, records[1].clone());
        }
        let (job, view) = selected(
            profile.path(),
            source.path(),
            records,
            MigrationSourceKind::Codex,
        );
        let store = HistoryBranchStore::open(profile.path()).unwrap();
        let progress = store.progress(&job, &view).unwrap();
        assert_eq!(progress.structural_complete, Some(false));
        assert!(progress.issues.iter().any(|issue| issue
            == if omit_turn {
                "codex_execution_turn_identity_required"
            } else {
                "codex_execution_call_ambiguous"
            }));
        let compiled =
            kcoder_migration::history_context::HistoryContextCompiler::open(profile.path())
                .unwrap()
                .compile(
                    &job,
                    &view,
                    kcoder_types::historical_context::HistoricalContextPolicy::default(),
                    |_| true,
                )
                .unwrap();
        assert!(!compiled.report.context_compiled);
        assert!(compiled.document.is_none());
    }
}

#[test]
fn conflicting_patch_receipts_cannot_be_washed_into_success_by_a_later_duplicate() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let mut records = include_str!("../../fixtures/codex-patch-execution-0.163.0.jsonl")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    records[0]["payload"]["id"] = json!(A);
    let mut failed = records[2].clone();
    failed["payload"]["success"] = json!(false);
    failed["payload"]["status"] = json!("failed");
    records.push(failed);
    records.push(records[2].clone());
    let (job, view) = selected(
        profile.path(),
        source.path(),
        records,
        MigrationSourceKind::Codex,
    );
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    store.correlate(&job, &view, None, || true).unwrap();
    let links = store.tools_page(&job, &view, None).unwrap();
    assert_eq!(
        links.links[0].status,
        HistoricalToolLinkStatus::ConflictingOutcome
    );
    assert_eq!(
        links.links[0].outcome,
        HistoricalToolOutcome::OutcomeUnknown
    );
    let compiled = kcoder_migration::history_context::HistoryContextCompiler::open(profile.path())
        .unwrap()
        .compile(
            &job,
            &view,
            kcoder_types::historical_context::HistoricalContextPolicy::default(),
            |_| true,
        )
        .unwrap();
    assert!(!compiled.report.context_compiled);
}

#[test]
fn claude_only_pairs_the_selected_chain_and_keeps_a_received_unknown_result_distinct() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let call = |value: &str| json!([{"type":"tool_use","id":"same","name":"write","input":{"content":value}}]);
    let (job, view) = selected(
        profile.path(),
        source.path(),
        vec![
            message("root", None),
            claude("old", Some("root"), "assistant", call("old")),
            claude(
                "old-result",
                Some("old"),
                "user",
                json!([{"type":"tool_result","tool_use_id":"same","content":"old failed","is_error":true}]),
            ),
            claude("new", Some("root"), "assistant", call("new")),
            claude(
                "new-result",
                Some("new"),
                "user",
                json!([{"type":"tool_result","tool_use_id":"same","content":"result received"}]),
            ),
        ],
        MigrationSourceKind::ClaudeCode,
    );
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    let completed = store.correlate(&job, &view, None, || true).unwrap();
    assert_eq!(completed.run.unwrap().stage, HistoricalToolLinkStage::Ready);
    let page = store.tools_page(&job, &view, None).unwrap();
    assert!(page.progress.sealed);
    assert_eq!(page.links.len(), 1);
    assert_eq!(page.links[0].status, HistoricalToolLinkStatus::Linked);
    assert_eq!(page.links[0].outcome, HistoricalToolOutcome::RecordedResult);
    assert_eq!(page.links[0].call.as_ref().unwrap().record, 3);
    assert_eq!(page.links[0].result.as_ref().unwrap().record, 4);
    assert_eq!(page.links[0].call.as_ref().unwrap().source_index, 0);
    assert!(
        store
            .correlate(&job, &view, None, || panic!(
                "sealed correlation must not replay"
            ))
            .unwrap()
            .progress
            .unwrap()
            .sealed
    );
}

#[test]
fn calls_in_a_parent_prefix_link_to_child_results_with_physical_origins_preserved() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let (parent, _, ends) = archive(
        profile.path(),
        source.path(),
        MigrationSourceKind::Codex,
        A,
        A,
        vec![
            json!({"type":"session_meta","ordinal":0,"payload":{"id":A,"cli_version":"0.163.0","history_mode":"paginated"}}),
            json!({"type":"response_item","ordinal":1,"payload":{"type":"function_call","call_id":"call","name":"write","namespace":"tools","arguments":"{}"}}),
        ],
    );
    let (job, _, _) = archive(
        profile.path(),
        source.path(),
        MigrationSourceKind::Codex,
        B,
        B,
        vec![
            json!({"type":"session_meta","ordinal":2,"payload":{"id":B,"cli_version":"0.163.0","history_mode":"paginated","history_base":{"thread_id":A,"end_ordinal_exclusive":2,"end_byte_offset":ends[1]}}}),
            json!({"type":"response_item","ordinal":3,"payload":{"type":"function_call_output","call_id":"call","output":"received"}}),
        ],
    );
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    let prepared = store.prepare(&job, &[parent]).unwrap();
    store.build(&job, &prepared.view_id, || true).unwrap();
    store
        .correlate(&job, &prepared.view_id, None, || true)
        .unwrap();
    let link = store
        .tools_page(&job, &prepared.view_id, None)
        .unwrap()
        .links
        .remove(0);
    assert_eq!(link.status, HistoricalToolLinkStatus::Linked);
    assert_eq!(link.namespace.as_deref(), Some("tools"));
    assert_eq!(link.call.as_ref().unwrap().source_index, 1);
    assert_eq!(link.result.as_ref().unwrap().source_index, 0);
    assert_eq!(link.call.as_ref().unwrap().record, 1);
    assert_eq!(link.result.as_ref().unwrap().record, 1);
    assert_eq!(link.outcome, HistoricalToolOutcome::RecordedResult);
}

#[test]
fn compacted_replacement_locations_do_not_alias_the_checkpoint_record_or_each_other() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let (job, view) = selected(
        profile.path(),
        source.path(),
        vec![
            json!({"type":"session_meta","payload":{"id":A,"cli_version":"0.163.0"}}),
            json!({"type":"compacted","payload":{"message":"summary","window_number":1,"resume_metadata":{},"replacement_history":[
            {"type":"function_call","call_id":"c","name":"edit","arguments":"{}"},
            {"type":"function_call_output","call_id":"c","output":"done"}],"replacement_history_metadata":[{},{}]}}),
        ],
        MigrationSourceKind::Codex,
    );
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    store.correlate(&job, &view, None, || true).unwrap();
    let links = store.tools_page(&job, &view, None).unwrap();
    let link = &links.links[0];
    assert_eq!(link.call.as_ref().unwrap().replacement_index, Some(0));
    assert_eq!(link.result.as_ref().unwrap().replacement_index, Some(1));
    assert_eq!(link.call.as_ref().unwrap().record, 1);
    assert_eq!(link.result.as_ref().unwrap().record, 1);
    assert_ne!(
        link.call.as_ref().unwrap().sequence,
        link.result.as_ref().unwrap().sequence
    );
}

#[test]
fn missing_and_ambiguous_results_are_preserved_and_cancelled_correlation_resumes_explicitly() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let (job, view) = selected(
        profile.path(),
        source.path(),
        vec![
            claude(
                "a",
                None,
                "assistant",
                json!([{"type":"tool_use","id":"c","name":"write","input":{}}]),
            ),
            claude(
                "b",
                Some("a"),
                "assistant",
                json!([{"type":"tool_use","id":"c","name":"write","input":{}}]),
            ),
            claude(
                "r",
                Some("b"),
                "user",
                json!([{"type":"tool_result","tool_use_id":"c","content":"received"}]),
            ),
        ],
        MigrationSourceKind::ClaudeCode,
    );
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    let mut checks = 0;
    let cancelled = store
        .correlate(&job, &view, None, || {
            checks += 1;
            checks < 3
        })
        .unwrap();
    assert_eq!(
        cancelled.run.as_ref().unwrap().stage,
        HistoricalToolLinkStage::Cancelled
    );
    assert!(store.correlate(&job, &view, None, || true).is_err());
    let sequence = cancelled.run.unwrap().sequence;
    let completed = store
        .correlate(&job, &view, Some(sequence), || true)
        .unwrap();
    assert!(completed.progress.unwrap().unresolved_links > 0);
    let links = store.tools_page(&job, &view, None).unwrap();
    assert!(
        links
            .links
            .iter()
            .all(|link| link.status == HistoricalToolLinkStatus::Ambiguous)
    );
    assert!(
        links
            .links
            .iter()
            .all(|link| link.outcome != HistoricalToolOutcome::RecordedSuccess)
    );
}
