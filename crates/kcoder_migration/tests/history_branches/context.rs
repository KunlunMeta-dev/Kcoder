use super::*;
use kcoder_migration::{
    history_attachment_jobs::HistoryAttachmentJobs,
    history_context::{HistoryContextCompiler, HistoryContextPhase},
};
use kcoder_types::{
    historical_attachment::*,
    historical_context::*,
    imported_transcript::{HistoricalRole, HistoricalToolOutcome},
};

fn selected(
    profile: &Path,
    root: &Path,
    source: MigrationSourceKind,
    records: Vec<Value>,
) -> (String, String) {
    let (job, _, _) = archive(profile, root, source, A, A, records);
    let branches = HistoryBranchStore::open(profile).unwrap();
    let view = branches.prepare(&job, &[]).unwrap().view_id;
    branches.build(&job, &view, || true).unwrap();
    (job, view)
}
fn compile(profile: &Path, job: &str, view: &str) -> HistoricalContextCompilation {
    HistoryContextCompiler::open(profile)
        .unwrap()
        .compile(job, view, HistoricalContextPolicy::default(), |_| true)
        .unwrap()
}
fn blocked(result: &HistoricalContextCompilation, code: &str) {
    assert!(!result.report.context_compiled);
    assert!(result.document.is_none() && result.binding.is_none());
    assert!(
        result.report.issues.iter().any(|issue| issue.code == code),
        "{:?}",
        result.report
    );
}
fn codex(payload: Value) -> Value {
    json!({"type":"response_item","payload":payload})
}
fn meta() -> Value {
    json!({"type":"session_meta","payload":{"id":A,"cli_version":"0.163.0"}})
}
fn claude(id: &str, parent: Option<&str>, role: &str, content: Value) -> Value {
    json!({"type":role,"uuid":id,"parentUuid":parent,"sessionId":A,"version":"2.1.301","message":{"role":role,"content":content}})
}
fn pair(output: Value) -> Vec<Value> {
    vec![
        claude(
            "call",
            None,
            "assistant",
            json!([{"type":"tool_use","id":"c1","name":"write","input":{"content":"historical write only"}}]),
        ),
        claude(
            "result",
            Some("call"),
            "user",
            json!([{"type":"tool_result","tool_use_id":"c1","content":output}]),
        ),
    ]
}
fn selection(
    job: &str,
    view: &str,
    position: u64,
    block: u32,
    item: Option<u32>,
) -> HistoricalAttachmentSelection {
    HistoricalAttachmentSelection {
        job_id: job.into(),
        view_id: Some(view.into()),
        position,
        block_index: block,
        tool_item_index: item,
    }
}

#[test]
fn claude_metadata_keeps_away_summary_and_excludes_only_verified_empty_records() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let (job, view) = selected(
        profile.path(),
        root.path(),
        MigrationSourceKind::ClaudeCode,
        vec![
            message("root", None),
            json!({"type":"system","subtype":"turn_duration","uuid":"duration","parentUuid":"root","sessionId":A,"durationMs":10,"messageCount":1}),
            json!({"type":"attachment","uuid":"reminder","parentUuid":"duration","sessionId":A,"attachment":{"type":"task_reminder","content":[],"itemCount":0}}),
            json!({"type":"system","subtype":"away_summary","uuid":"summary","parentUuid":"reminder","sessionId":A,"content":"Historical progress"}),
            message("next", Some("summary")),
        ],
    );
    let original = fs::read(root.path().join(format!("{A}.jsonl"))).unwrap();
    let compiled = compile(profile.path(), &job, &view);
    assert!(compiled.report.context_compiled, "{:?}", compiled.report);
    let entries = compiled.document.unwrap().entries;
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].text, "root");
    assert_eq!(
        entries[1].text,
        "[Historical away summary]\nHistorical progress"
    );
    assert_eq!(entries[1].source_role, HistoricalRole::System);
    assert_eq!(entries[2].text, "next");
    assert_eq!(compiled.report.excluded_provider_blocks, 2);
    assert_eq!(
        fs::read(root.path().join(format!("{A}.jsonl"))).unwrap(),
        original
    );
}

#[test]
fn claude_metadata_rejects_unverified_or_nonempty_reminders() {
    for metadata in [
        json!({"type":"system","subtype":"turn_duration","uuid":"meta","parentUuid":"root","sessionId":A,"durationMs":10,"messageCount":1,"unrecognized":"must not discard"}),
        json!({"type":"attachment","uuid":"meta","parentUuid":"root","sessionId":A,"attachment":{"type":"task_reminder","content":["do not discard"],"itemCount":1}}),
        json!({"type":"attachment","uuid":"meta","parentUuid":"root","sessionId":A,"attachment":{"type":"task_reminder","content":[],"itemCount":1}}),
        json!({"type":"system","subtype":"away_summary","uuid":"meta","parentUuid":"root","sessionId":A,"content":["unrecognized"]}),
    ] {
        let profile = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let (job, view) = selected(
            profile.path(),
            root.path(),
            MigrationSourceKind::ClaudeCode,
            vec![
                message("root", None),
                metadata,
                message("next", Some("meta")),
            ],
        );
        blocked(
            &compile(profile.path(), &job, &view),
            "history_context_unconverted_record",
        );
    }
}

#[test]
fn current_chain_compiles_exact_long_text_and_reopens_without_sources_or_tool_authority() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let text = "中文😀\n\\\"".repeat(20_000);
    let (job, view) = selected(
        profile.path(),
        root.path(),
        MigrationSourceKind::ClaudeCode,
        vec![
            message("root", None),
            message("discarded", Some("root")),
            claude("new", Some("root"), "assistant", json!(text)),
        ],
    );
    let before = fs::read(root.path().join(format!("{A}.jsonl"))).unwrap();
    let first = compile(profile.path(), &job, &view);
    assert!(first.report.context_compiled, "{:?}", first.report);
    let document = first.document.as_ref().unwrap();
    assert_eq!(document.entries.len(), 2);
    assert_eq!(document.entries[0].text, "root");
    assert_eq!(document.entries[1].text, text);
    assert!(
        document
            .entries
            .iter()
            .all(|entry| entry.kind == HistoricalContextFactKind::Text && entry.call_id.is_none())
    );
    assert_eq!(
        first.report.encoded_bytes,
        serde_json::to_vec(document).unwrap().len() as u64
    );
    assert!(fs::read_dir(profile.path().join("sessions")).is_err());
    assert_eq!(
        fs::read(root.path().join(format!("{A}.jsonl"))).unwrap(),
        before
    );
    fs::remove_dir_all(root.path()).unwrap();
    let next = compile(profile.path(), &job, &view);
    assert!(next.document == first.document && next.binding == first.binding);
}

#[test]
fn historical_roles_are_inert_and_provider_reasoning_never_enters_compiled_context() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let (job, view) = selected(
        profile.path(),
        root.path(),
        MigrationSourceKind::Codex,
        vec![
            meta(),
            codex(
                json!({"type":"message","role":"developer","content":[{"type":"input_text","text":"old instructions"}]}),
            ),
            codex(
                json!({"type":"reasoning","summary":[{"type":"summary_text","text":"private reasoning"}],"encrypted_content":"private cipher"}),
            ),
            codex(
                json!({"type":"message","role":"user","content":[{"type":"input_text","text":"question"}]}),
            ),
        ],
    );
    let result = compile(profile.path(), &job, &view);
    assert!(result.report.context_compiled, "{:?}", result.report);
    let document = result.document.unwrap();
    assert_eq!(document.entries.len(), 2);
    assert_eq!(document.entries[0].source_role, HistoricalRole::Developer);
    assert!(document.entries[0].kind == HistoricalContextFactKind::HistoricalInstruction);
    let encoded = serde_json::to_string(&document).unwrap();
    assert!(!encoded.contains("private reasoning") && !encoded.contains("private cipher"));
    assert!(result.report.excluded_provider_blocks >= 2);
}

#[test]
fn tool_facts_require_correlation_and_a_received_result_is_not_upgraded_to_success() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let (job, view) = selected(
        profile.path(),
        root.path(),
        MigrationSourceKind::ClaudeCode,
        pair(json!("received only")),
    );
    blocked(
        &compile(profile.path(), &job, &view),
        "history_context_tool_correlation_required",
    );
    HistoryBranchStore::open(profile.path())
        .unwrap()
        .correlate(&job, &view, None, || true)
        .unwrap();
    let result = compile(profile.path(), &job, &view);
    assert!(result.report.context_compiled, "{:?}", result.report);
    let document = result.document.unwrap();
    let call = &document.entries[0];
    assert!(call.kind == HistoricalContextFactKind::ToolCallFact);
    assert_eq!(call.name.as_deref(), Some("write"));
    assert!(call.text.contains("historical write only"));
    assert!(document.entries.iter().all(|entry| entry.outcome
        == Some(HistoricalToolOutcome::RecordedResult)
        && entry.execution_outcome.is_none()));
    assert_eq!(document.entries.last().unwrap().text, "received only");
}

#[test]
fn missing_tool_results_remain_unknown_and_broken_parent_chains_still_block() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let (job, view) = selected(
        profile.path(),
        root.path(),
        MigrationSourceKind::ClaudeCode,
        vec![pair(json!("unused")).remove(0)],
    );
    HistoryBranchStore::open(profile.path())
        .unwrap()
        .correlate(&job, &view, None, || true)
        .unwrap();
    let missing = compile(profile.path(), &job, &view);
    assert!(missing.report.context_compiled, "{:?}", missing.report);
    let document = missing.document.unwrap();
    let call = document
        .entries
        .iter()
        .find(|entry| entry.kind == HistoricalContextFactKind::ToolCallFact)
        .unwrap();
    assert_eq!(call.outcome, Some(HistoricalToolOutcome::OutcomeUnknown));
    assert_eq!(call.execution_outcome, None);
    assert!(
        call.text.contains("outcome is unknown") && call.text.contains("historical write only")
    );
    let (job, view) = selected(
        profile.path(),
        root.path(),
        MigrationSourceKind::ClaudeCode,
        vec![message("broken", Some("missing"))],
    );
    blocked(
        &compile(profile.path(), &job, &view),
        "history_context_incomplete_branch",
    );
}

#[test]
fn orphan_tool_result_is_preserved_without_fabricating_a_call() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let (job, view) = selected(
        profile.path(),
        root.path(),
        MigrationSourceKind::ClaudeCode,
        vec![claude(
            "result",
            None,
            "user",
            json!([{"type":"tool_result","tool_use_id":"missing-call","content":"source result"}]),
        )],
    );
    HistoryBranchStore::open(profile.path())
        .unwrap()
        .correlate(&job, &view, None, || true)
        .unwrap();
    let compiled = compile(profile.path(), &job, &view);
    assert!(compiled.report.context_compiled, "{:?}", compiled.report);
    let entries = compiled.document.unwrap().entries;
    assert!(
        entries
            .iter()
            .all(|entry| entry.kind != HistoricalContextFactKind::ToolCallFact)
    );
    assert!(
        entries
            .iter()
            .any(|entry| entry.text.contains("no matching recorded call"))
    );
    assert!(entries.iter().any(|entry| entry.text == "source result"));
    assert!(
        entries
            .iter()
            .all(|entry| entry.name.is_none() && entry.execution_outcome.is_none())
    );
}

#[test]
fn structured_tool_parts_preserve_order_but_not_encoded_attachment_or_encrypted_bodies() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let (job, view) = selected(
        profile.path(),
        root.path(),
        MigrationSourceKind::ClaudeCode,
        pair(json!([
            {"type":"text","text":"before"},
            {"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"AAECAw=="},"title":"report.pdf"},
            {"type":"encrypted_content","data":"hidden cipher"},
            {"type":"text","text":"after"}
        ])),
    );
    HistoryBranchStore::open(profile.path())
        .unwrap()
        .correlate(&job, &view, None, || true)
        .unwrap();
    blocked(
        &compile(profile.path(), &job, &view),
        "history_context_attachment_collection_required",
    );
    let jobs = HistoryAttachmentJobs::open(profile.path()).unwrap();
    jobs.run(&selection(&job, &view, 1, 0, None), None, || true)
        .unwrap();
    blocked(
        &compile(profile.path(), &job, &view),
        "history_context_attachment_required",
    );
    let child = selection(&job, &view, 1, 0, Some(0));
    jobs.run(&child, None, || true).unwrap();
    let result = compile(profile.path(), &job, &view);
    assert!(result.report.context_compiled, "{:?}", result.report);
    assert_eq!(result.report.attachment_bytes, 4);
    assert_eq!(result.report.excluded_provider_blocks, 1);
    let document = result.document.unwrap();
    let parts = &document.entries[2..];
    assert_eq!(
        parts
            .iter()
            .map(|part| part.source_array_index)
            .collect::<Vec<_>>(),
        [Some(0), Some(1), Some(3)]
    );
    assert_eq!(parts[0].text, "before");
    assert!(parts[1].kind == HistoricalContextFactKind::AttachmentReference);
    assert_eq!(parts[2].text, "after");
    assert_eq!(document.attachments[0].selection, child);
    assert_eq!(document.attachments[0].receipt.bytes, 4);
    let text = serde_json::to_string(&document).unwrap();
    assert!(!text.contains("AAECAw==") && !text.contains("hidden cipher"));
}

#[test]
fn ordinary_attachments_must_be_ready_and_are_verified_under_count_and_byte_budgets() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let (job, view) = selected(
        profile.path(),
        root.path(),
        MigrationSourceKind::ClaudeCode,
        vec![claude(
            "image",
            None,
            "user",
            json!([{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAECAw=="}}]),
        )],
    );
    blocked(
        &compile(profile.path(), &job, &view),
        "history_context_attachment_required",
    );
    let jobs = HistoryAttachmentJobs::open(profile.path()).unwrap();
    let sel = selection(&job, &view, 0, 0, None);
    jobs.run(&sel, None, || true).unwrap();
    assert!(compile(profile.path(), &job, &view).report.context_compiled);
    for policy in [
        HistoricalContextPolicy {
            max_attachments: 0,
            ..Default::default()
        },
        HistoricalContextPolicy {
            max_attachment_bytes: 3,
            ..Default::default()
        },
    ] {
        let result = HistoryContextCompiler::open(profile.path())
            .unwrap()
            .compile(&job, &view, policy, |_| true)
            .unwrap();
        blocked(&result, "history_context_attachment_budget_exceeded");
    }
    let compiler = HistoryContextCompiler::open(profile.path()).unwrap();
    assert!(
        compiler
            .compile(&job, &view, Default::default(), |progress| !matches!(
                progress.phase,
                HistoryContextPhase::VerifyingAttachment
            ))
            .is_err()
    );
}

#[test]
fn plaintext_that_looks_like_json_stays_plaintext_and_unknown_envelopes_are_blocked() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let plaintext = "[{\"type\":\"image\",\"data\":\"not a real attachment\"}]";
    for (output, valid) in [
        (json!(plaintext), true),
        (
            json!({"content":[{"type":"text","text":"unrecognized wrapper"}]}),
            false,
        ),
        (json!([{"type":"future","text":"not promoted"}]), false),
    ] {
        let (job, view) = selected(
            profile.path(),
            root.path(),
            MigrationSourceKind::ClaudeCode,
            pair(output),
        );
        HistoryBranchStore::open(profile.path())
            .unwrap()
            .correlate(&job, &view, None, || true)
            .unwrap();
        let result = compile(profile.path(), &job, &view);
        if valid {
            assert!(result.report.context_compiled, "{:?}", result.report);
            assert_eq!(
                result.document.unwrap().entries.last().unwrap().text,
                plaintext
            );
        } else {
            assert!(!result.report.context_compiled);
            assert!(result.document.is_none());
        }
    }
}

#[test]
fn context_size_and_entry_budgets_and_cancel_never_return_partial_artifacts() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let (job, view) = selected(
        profile.path(),
        root.path(),
        MigrationSourceKind::ClaudeCode,
        vec![
            message("root", None),
            claude(
                "next",
                Some("root"),
                "assistant",
                json!("😀\n".repeat(40_000)),
            ),
        ],
    );
    let compiler = HistoryContextCompiler::open(profile.path()).unwrap();
    for (policy, code) in [
        (
            HistoricalContextPolicy {
                max_entries: 1,
                ..Default::default()
            },
            "history_context_entry_budget_exceeded",
        ),
        (
            HistoricalContextPolicy {
                max_context_bytes: 1024,
                ..Default::default()
            },
            "history_context_byte_budget_exceeded",
        ),
    ] {
        blocked(
            &compiler.compile(&job, &view, policy, |_| true).unwrap(),
            code,
        );
    }
    assert!(
        compiler
            .compile(&job, &view, Default::default(), |progress| !matches!(
                progress.phase,
                HistoryContextPhase::Reading
            ))
            .is_err()
    );
    let wrong = uuid::Uuid::new_v4().to_string();
    assert!(
        compiler
            .compile(&wrong, &view, Default::default(), |_| true)
            .is_err()
    );
}

#[test]
fn rollback_uses_only_selected_replacement_context() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let message = |text| json!({"type":"message","role":"user","content":[{"type":"input_text","text":text}]});
    let (job, view) = selected(
        profile.path(),
        root.path(),
        MigrationSourceKind::Codex,
        vec![
            meta(),
            codex(message("old")),
            json!({"type":"compacted","payload":{"message":"summary","window_number":1,"resume_metadata":{},"replacement_history":[message("replacement")],"replacement_history_metadata":[{"client_authored":true,"user_input_order":1}]}}),
            codex(message("removed")),
            json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}),
        ],
    );
    let result = compile(profile.path(), &job, &view);
    assert!(result.report.context_compiled, "{:?}", result.report);
    let document = result.document.unwrap();
    assert_eq!(document.entries.len(), 1);
    assert_eq!(document.entries[0].text, "replacement");
}

#[test]
fn codex_cross_archive_tools_keep_namespace_and_structured_text_without_current_execution() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let (parent, _, ends) = archive(
        profile.path(),
        root.path(),
        MigrationSourceKind::Codex,
        A,
        A,
        vec![
            json!({"type":"session_meta","ordinal":0,"payload":{"id":A,"cli_version":"0.163.0","history_mode":"paginated"}}),
            json!({"type":"response_item","ordinal":1,"payload":{"type":"function_call","call_id":"cross","namespace":"functions","name":"exec_command","arguments":"{\"cmd\":\"historical only\"}"}}),
        ],
    );
    let (job, _, _) = archive(
        profile.path(),
        root.path(),
        MigrationSourceKind::Codex,
        B,
        B,
        vec![
            json!({"type":"session_meta","ordinal":2,"payload":{"id":B,"cli_version":"0.163.0","history_mode":"paginated","history_base":{"thread_id":A,"end_ordinal_exclusive":2,"end_byte_offset":ends[1]}}}),
            json!({"type":"response_item","ordinal":3,"payload":{"type":"function_call_output","call_id":"cross","output":[{"type":"input_text","text":"cross archive output"}]}}),
        ],
    );
    let branches = HistoryBranchStore::open(profile.path()).unwrap();
    let view = branches.prepare(&job, &[parent]).unwrap().view_id;
    branches.build(&job, &view, || true).unwrap();
    branches.correlate(&job, &view, None, || true).unwrap();
    let result = compile(profile.path(), &job, &view);
    assert!(result.report.context_compiled, "{:?}", result.report);
    let entries = result.document.unwrap().entries;
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].namespace.as_deref(), Some("functions"));
    assert_eq!(entries[2].text, "cross archive output");
    assert_eq!(entries[2].source_array_index, Some(0));
    assert!(
        entries
            .iter()
            .all(|entry| entry.outcome == Some(HistoricalToolOutcome::RecordedResult))
    );
}

#[test]
fn unavailable_references_do_not_fetch_and_an_altered_saved_payload_cannot_compile() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let (job, view) = selected(
        profile.path(),
        root.path(),
        MigrationSourceKind::ClaudeCode,
        vec![claude(
            "ref",
            None,
            "user",
            json!([{"type":"image","source":{"type":"url","url":"https://invalid.example/private.png"}}]),
        )],
    );
    let jobs = HistoryAttachmentJobs::open(profile.path()).unwrap();
    let reference = selection(&job, &view, 0, 0, None);
    assert_eq!(
        jobs.run(&reference, None, || true).unwrap().stage,
        HistoricalAttachmentJobStage::Unavailable
    );
    blocked(
        &compile(profile.path(), &job, &view),
        "history_context_attachment_not_ready",
    );
    let (job, view) = selected(
        profile.path(),
        root.path(),
        MigrationSourceKind::ClaudeCode,
        vec![claude(
            "binary",
            None,
            "user",
            json!([{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAECAw=="}}]),
        )],
    );
    jobs.run(&selection(&job, &view, 0, 0, None), None, || true)
        .unwrap();
    fn payloads(directory: &Path) -> Vec<PathBuf> {
        let mut paths = Vec::new();
        for entry in fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                paths.extend(payloads(&entry.path()));
            } else if entry.file_name() == "payload.bin" {
                paths.push(entry.path());
            }
        }
        paths
    }
    let paths = payloads(profile.path());
    assert_eq!(paths.len(), 1);
    fs::write(&paths[0], [0, 1, 2, 9]).unwrap();
    assert!(
        HistoryContextCompiler::open(profile.path())
            .unwrap()
            .compile(&job, &view, Default::default(), |_| true)
            .is_err()
    );
}

#[test]
fn compiled_history_and_verified_attachments_prepare_durably_without_creating_a_native_session() {
    use kcoder_migration::history_context_preparations::{HistoryPreparationOutcome, prepare};
    use kcoder_state::historical_contexts::HistoricalContextStore;
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let (job, view) = selected(
        profile.path(),
        source.path(),
        MigrationSourceKind::ClaudeCode,
        vec![claude(
            "ready",
            None,
            "user",
            json!([
                {"type":"text","text":"historical question"},
                {"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"AAECAw=="},"title":"report.pdf"}
            ]),
        )],
    );
    let id = uuid::Uuid::new_v4().to_string();
    let outcome = prepare(profile.path(), &id, &job, &view, Default::default(), |_| {
        true
    })
    .unwrap();
    assert!(matches!(outcome, HistoryPreparationOutcome::Blocked(_)));
    assert!(
        HistoricalContextStore::open_existing(profile.path())
            .unwrap()
            .is_none()
    );
    HistoryAttachmentJobs::open(profile.path())
        .unwrap()
        .run(&selection(&job, &view, 0, 1, None), None, || true)
        .unwrap();
    let outcome = prepare(profile.path(), &id, &job, &view, Default::default(), |_| {
        true
    })
    .unwrap();
    let HistoryPreparationOutcome::Prepared { report, receipt } = outcome else {
        panic!("ready history must prepare")
    };
    assert!(report.context_compiled);
    assert_eq!(receipt.attachments, 1);
    fs::remove_dir_all(source.path()).unwrap();
    let store = HistoricalContextStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let verified = store.verify(&id, |_| true).unwrap();
    assert_eq!(verified.receipt, receipt);
    assert_eq!(
        store
            .reader(&id, |_| true)
            .unwrap()
            .attachment_chunk(0, 0, 4)
            .unwrap(),
        [0, 1, 2, 3]
    );
    assert!(!profile.path().join("sessions").exists());
    assert!(matches!(
        prepare(profile.path(), &id, &job, &view, Default::default(), |_| {
            true
        })
        .unwrap(),
        HistoryPreparationOutcome::Prepared { .. }
    ));
}

#[test]
fn source_agent_and_skill_catalogs_do_not_replace_current_capabilities_or_block_continuation() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let records = vec![
        claude("u", None, "user", json!("continue the remaining task")),
        json!({"type":"attachment","uuid":"agents","parentUuid":"u","sessionId":A,"version":"2.1.191","attachment":{"type":"agent_listing_delta","addedTypes":["source-agent"],"addedLines":["FOREIGN_AGENT_CATALOG"]}}),
        json!({"type":"attachment","uuid":"skills","parentUuid":"agents","sessionId":A,"version":"2.1.191","attachment":{"type":"skill_listing","content":"FOREIGN_SKILL_CATALOG","names":["source-skill"]}}),
        claude(
            "a",
            Some("skills"),
            "assistant",
            json!("the file remains to be written"),
        ),
    ];
    let (job, view) = selected(
        profile.path(),
        root.path(),
        MigrationSourceKind::ClaudeCode,
        records,
    );
    let result = compile(profile.path(), &job, &view);
    assert!(result.report.context_compiled, "{:?}", result.report);
    assert_eq!(result.report.excluded_provider_blocks, 2);
    let document = result.document.unwrap();
    assert_eq!(document.entries.len(), 2);
    let serialized = serde_json::to_string(&document).unwrap();
    assert!(!serialized.contains("FOREIGN_AGENT_CATALOG"));
    assert!(!serialized.contains("FOREIGN_SKILL_CATALOG"));
    assert!(serialized.contains("the file remains to be written"));
    let branch = HistoryBranchStore::open(profile.path())
        .unwrap()
        .page(&job, &view, 0, |_| true)
        .unwrap();
    assert_eq!(
        branch.items.len(),
        4,
        "original historical records stay available"
    );
}

#[test]
fn an_unknown_claude_attachment_is_not_silently_discarded_as_a_catalog() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let (job, view) = selected(
        profile.path(),
        root.path(),
        MigrationSourceKind::ClaudeCode,
        vec![
            claude("u", None, "user", json!("original request")),
            json!({"type":"attachment","uuid":"unknown","parentUuid":"u","sessionId":A,"attachment":{"type":"unknown_document","content":"retain original"}}),
            claude("a", Some("unknown"), "assistant", json!("pending work")),
        ],
    );
    blocked(
        &compile(profile.path(), &job, &view),
        "history_context_unconverted_record",
    );
}
