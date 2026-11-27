use kcoder_migration::{
    history_branches::HistoryBranchStore, history_jobs::HistoryJobStore,
    history_sources::HistorySourceBinding,
};
use kcoder_state::external_history::ExternalHistoryStore;
use kcoder_types::{
    external_history::*, historical_branch::HistoricalBranchStage, migration::MigrationSourceKind,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};
const A: &str = "11111111-1111-4111-8111-111111111111";
const B: &str = "22222222-2222-4222-8222-222222222222";
#[path = "history_branches/attachments.rs"]
mod attachments;
#[path = "history_branches/context.rs"]
mod context;
#[path = "history_branches/continuation.rs"]
mod continuation;
#[path = "history_branches/search.rs"]
mod search;
#[path = "history_branches/tools.rs"]
mod tools;
fn message(id: &str, parent: Option<&str>) -> Value {
    json!({"type":"user","uuid":id,"parentUuid":parent,"sessionId":A,"version":"2.1.301","message":{"role":"user","content":id}})
}
fn archive(
    profile: &Path,
    root: &Path,
    source: MigrationSourceKind,
    session: &str,
    physical: &str,
    records: Vec<Value>,
) -> (String, PathBuf, Vec<u64>) {
    let name = if source == MigrationSourceKind::Codex {
        if session == physical {
            format!("rollout-2026-10-16T00-00-00-{session}.jsonl")
        } else {
            format!("rollout-2026-10-16T00-00-00-{session}_{physical}.jsonl")
        }
    } else {
        format!("{session}.jsonl")
    };
    let mut bytes = Vec::new();
    let mut ends = Vec::new();
    for value in records {
        serde_json::to_writer(&mut bytes, &value).unwrap();
        bytes.push(b'\n');
        ends.push(bytes.len() as u64);
    }
    let path = root.join(&name);
    fs::write(&path, &bytes).unwrap();
    let binding = HistorySourceBinding::capture(
        root,
        Path::new(&name),
        ExternalHistoryOrigin {
            source,
            source_instance: "fixture".into(),
            source_session_id: session.into(),
            source_artifact_id: None,
            source_format: "jsonl".into(),
            adapter_revision: "raw/1".into(),
            title: None,
            created_at: None,
            updated_at: None,
            project: None,
            archived: false,
            parent_session_id: None,
        },
        &mut |_, _| true,
    )
    .unwrap();
    let store = HistoryJobStore::open(profile).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let mut job = store.create(&id, &binding).unwrap();
    while job.stage != HistoryImportStage::Normalized {
        job = store.step(&id, job.sequence, 10, |_| true).unwrap();
        assert!(!matches!(
            job.stage,
            HistoryImportStage::Failed | HistoryImportStage::Cancelled
        ));
    }
    (id, path, ends)
}
fn row(profile: &Path, id: &str, cursor: u64) -> Vec<u64> {
    ExternalHistoryStore::open_existing(profile)
        .unwrap()
        .unwrap()
        .branch(id, false)
        .unwrap()
        .page(cursor)
        .unwrap()
        .items
        .into_iter()
        .map(|item| item.record)
        .collect()
}

fn prepare_waits_for_shared_lease(path: &[&str], lock_name: &str) {
    use kcoder_config::PrivateDirectory;
    use std::{ffi::OsStr, sync::mpsc, time::Duration};

    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let (first, _, _) = archive(
        profile.path(),
        source.path(),
        MigrationSourceKind::ClaudeCode,
        A,
        A,
        vec![message("first", None)],
    );
    let mut second_message = message("second", None);
    second_message["sessionId"] = B.into();
    let (second, _, _) = archive(
        profile.path(),
        source.path(),
        MigrationSourceKind::ClaudeCode,
        B,
        B,
        vec![second_message],
    );
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    store.prepare(&first, &[]).unwrap();
    let directory = path
        .iter()
        .fold(profile.path().to_owned(), |path, part| path.join(part));
    let directory = PrivateDirectory::open_existing(&directory).unwrap();
    let lease = directory
        .try_exclusive_lock(OsStr::new(lock_name))
        .unwrap()
        .unwrap();
    let (started, starting) = mpsc::channel();
    let (finished, result) = mpsc::channel();
    let worker_profile = profile.path().to_owned();
    let worker_job = second.clone();
    let worker = std::thread::spawn(move || {
        let store = HistoryBranchStore::open(&worker_profile).unwrap();
        started.send(()).unwrap();
        finished.send(store.prepare(&worker_job, &[])).unwrap();
    });
    starting.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(
        result.recv_timeout(Duration::from_millis(300)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    drop(lease);
    let prepared = result
        .recv_timeout(Duration::from_secs(15))
        .unwrap()
        .unwrap();
    worker.join().unwrap();
    assert_eq!(
        store.last_choice(&second).unwrap().unwrap().view_id,
        prepared.view_id
    );
}

#[test]
fn preparing_independent_branches_waits_for_the_shared_choice_lease() {
    prepare_waits_for_shared_lease(&["migrations", "branch-selections"], "choices.lock");
}

#[test]
fn preparing_independent_branches_waits_for_the_shared_catalog_lease() {
    prepare_waits_for_shared_lease(&["external-history", "branches"], "catalog.lock");
}

#[test]
fn sixty_four_independent_branches_preserve_each_choice_under_contention() {
    use std::sync::{Arc, Barrier};

    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let mut jobs = Vec::new();
    for index in 0..kcoder_migration::history_jobs::HISTORY_IMPORT_CONCURRENCY {
        let session = uuid::Uuid::new_v4().to_string();
        let mut record = message(&format!("message-{index}"), None);
        record["sessionId"] = session.clone().into();
        let (job, _, _) = archive(
            profile.path(),
            source.path(),
            MigrationSourceKind::ClaudeCode,
            &session,
            &session,
            vec![record],
        );
        jobs.push(job);
    }
    let barrier = Arc::new(Barrier::new(jobs.len()));
    let workers = jobs
        .iter()
        .map(|job| {
            let profile = profile.path().to_owned();
            let job = job.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let store = HistoryBranchStore::open(&profile);
                barrier.wait();
                store.and_then(|store| store.prepare(&job, &[]).map(|view| (job, view.view_id)))
            })
        })
        .collect::<Vec<_>>();
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    for worker in workers {
        let (job, view_id) = worker.join().unwrap().unwrap();
        assert_eq!(store.last_choice(&job).unwrap().unwrap().view_id, view_id);
    }
}

#[test]
fn claude_current_chain_is_persisted_and_reused_after_restart_without_original_sources() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let mut side = message("side", Some("root"));
    side["isSidechain"] = true.into();
    let (job, path, _) = archive(
        profile.path(),
        source.path(),
        MigrationSourceKind::ClaudeCode,
        A,
        A,
        vec![
            message("root", None),
            message("old", Some("root")),
            message("current", Some("root")),
            side,
        ],
    );
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    let prepared = store.prepare(&job, &[]).unwrap();
    assert_eq!(prepared.stage, HistoricalBranchStage::Planned);
    assert_eq!(store.prepare(&job, &[]).unwrap().view_id, prepared.view_id);
    let ready = store.build(&job, &prepared.view_id, || true).unwrap();
    assert_eq!(ready.stage, HistoricalBranchStage::Ready);
    assert_eq!(ready.total_items, Some(2));
    assert_eq!(row(profile.path(), &prepared.view_id, 0), [0, 2]);
    fs::remove_file(path).unwrap();
    drop(store);
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    assert_eq!(
        store.last_choice(&job).unwrap().unwrap().view_id,
        prepared.view_id
    );
    assert_eq!(
        store
            .build(&job, &prepared.view_id, || panic!(
                "ready view must not replay reconstruction"
            ))
            .unwrap()
            .stage,
        HistoricalBranchStage::Ready
    );
}

#[test]
fn missing_claude_parents_are_readable_but_never_reported_as_a_complete_branch() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let (job, _, _) = archive(
        profile.path(),
        source.path(),
        MigrationSourceKind::ClaudeCode,
        A,
        A,
        vec![message("old", None), message("new", Some("missing"))],
    );
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    let prepared = store.prepare(&job, &[]).unwrap();
    let ready = store.build(&job, &prepared.view_id, || true).unwrap();
    assert_eq!(ready.structural_complete, Some(false));
    assert!(
        ready
            .issues
            .iter()
            .any(|code| code == "claude_parent_chain_incomplete")
    );
    assert_eq!(row(profile.path(), &prepared.view_id, 0), [1]);
}

#[test]
fn cancellation_preserves_the_view_and_requires_an_explicit_sequence_checked_resume() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let records = (0..30)
        .map(|index| {
            message(
                &format!("message-{index}"),
                (index > 0)
                    .then(|| format!("message-{}", index - 1))
                    .as_deref(),
            )
        })
        .collect();
    let (job, _, _) = archive(
        profile.path(),
        source.path(),
        MigrationSourceKind::ClaudeCode,
        A,
        A,
        records,
    );
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    let prepared = store.prepare(&job, &[]).unwrap();
    let mut checks = 0;
    let cancelled = store
        .build(&job, &prepared.view_id, || {
            checks += 1;
            checks < 7
        })
        .unwrap();
    assert_eq!(cancelled.stage, HistoricalBranchStage::Cancelled);
    assert!(store.build(&job, &prepared.view_id, || true).is_err());
    assert!(
        store
            .resume(&job, &prepared.view_id, cancelled.sequence - 1)
            .is_err()
    );
    store
        .resume(&job, &prepared.view_id, cancelled.sequence)
        .unwrap();
    let ready = store.build(&job, &prepared.view_id, || true).unwrap();
    assert_eq!(ready.total_items, Some(30));
}

#[test]
fn codex_compaction_and_rollback_keep_replacement_references_separate_from_physical_records() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let msg = |text: &str| json!({"type":"message","role":"user","content":[{"type":"input_text","text":text}]});
    let (job, _, _) = archive(
        profile.path(),
        source.path(),
        MigrationSourceKind::Codex,
        A,
        A,
        vec![
            json!({"type":"session_meta","payload":{"id":A,"cli_version":"0.163.0"}}),
            json!({"type":"response_item","payload":msg("old input")}),
            json!({"type":"compacted","payload":{"message":"summary","window_number":1,"resume_metadata":{},
            "replacement_history":[msg("replacement input")],"replacement_history_metadata":[{"client_authored":true,"user_input_order":1}]}}),
            json!({"type":"response_item","payload":msg("removed input")}),
            json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}),
        ],
    );
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    let prepared = store.prepare(&job, &[]).unwrap();
    let ready = store.build(&job, &prepared.view_id, || true).unwrap();
    assert_eq!(ready.stage, HistoricalBranchStage::Ready);
    let archives = ExternalHistoryStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let view = archives.branch(&prepared.view_id, false).unwrap();
    let items = view.page(0).unwrap().items;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].record, 2);
    assert_eq!(items[0].replacement_index, Some(0));
    let page = store.page(&job, &prepared.view_id, 0, |_| true).unwrap();
    assert_eq!(page.items[0].position, 0);
    assert_eq!(page.items[0].record.record, 2);
    assert_eq!(
        page.items[0].record.blocks[0].preview.as_deref(),
        Some("replacement input")
    );
    assert_eq!(
        store
            .text(&job, &prepared.view_id, 0, 0, 0, |_| true)
            .unwrap()
            .text,
        "replacement input"
    );
}

#[test]
fn explicit_paginated_parent_archives_are_owned_bound_and_have_stable_source_indexes() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let msg = |ordinal: u64, text: &str| json!({"type":"response_item","ordinal":ordinal,"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}});
    let (parent, _, ends) = archive(
        profile.path(),
        source.path(),
        MigrationSourceKind::Codex,
        A,
        A,
        vec![
            json!({"type":"session_meta","ordinal":0,"payload":{"id":A,"cli_version":"0.163.0","history_mode":"paginated"}}),
            msg(1, "inherited input"),
        ],
    );
    let (child, _, _) = archive(
        profile.path(),
        source.path(),
        MigrationSourceKind::Codex,
        B,
        B,
        vec![
            json!({"type":"session_meta","ordinal":2,"payload":{"id":B,"cli_version":"0.163.0","history_mode":"paginated","history_base":{"thread_id":A,"end_ordinal_exclusive":2,"end_byte_offset":ends[1]}}}),
            msg(3, "child input"),
        ],
    );
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    let missing = store.prepare(&child, &[]).unwrap();
    assert!(
        !store
            .build(&child, &missing.view_id, || true)
            .unwrap()
            .issues
            .is_empty()
    );
    let prepared = store.prepare(&child, &[parent]).unwrap();
    let ready = store.build(&child, &prepared.view_id, || true).unwrap();
    assert_eq!(ready.structural_complete, Some(true));
    let archives = ExternalHistoryStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let view = archives.branch(&prepared.view_id, false).unwrap();
    let selected = view.page(0).unwrap();
    assert_eq!(selected.items.len(), 2);
    assert_eq!(selected.items[0].source_index, 1);
    assert_eq!(selected.items[1].source_index, 0);
    let page = store.page(&child, &prepared.view_id, 0, |_| true).unwrap();
    assert_eq!(page.items[0].source_session_id, A);
    assert_eq!(page.items[1].source_session_id, B);
    assert_eq!(
        store
            .text(&child, &prepared.view_id, 0, 0, 0, |_| true)
            .unwrap()
            .text,
        "inherited input"
    );
    assert_eq!(
        store
            .text(&child, &prepared.view_id, 1, 0, 0, |_| true)
            .unwrap()
            .text,
        "child input"
    );
    assert!(
        store
            .progress(&uuid::Uuid::new_v4().to_string(), &prepared.view_id)
            .is_err()
    );
}

#[test]
fn readable_reconstruction_is_persisted_and_admitted_with_distinct_provenance() {
    use kcoder_migration::history_context::HistoryContextCompiler;
    use kcoder_types::historical_context::HistoricalContextPolicy;
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let mut records = vec![
        json!({"type":"session_meta","payload":{"id":A,"session_id":A,"history_mode":"paginated"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"original task"}]}}),
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"call-1","name":"write","arguments":"{}"}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":[{"type":"input_text","text":"记录内容😀".repeat(3000)},{"type":"input_image","image_url":"data:image/png;base64,AA=="}]}}),
        json!({"type":"compacted","payload":{"message":"","window_number":1,"replacement_history":[{"type":"compaction","encrypted_content":"opaque"}]}}),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"next step"}]}}),
    ];
    for (ordinal, record) in records.iter_mut().enumerate() {
        record["ordinal"] = json!(ordinal);
    }
    let (job, source_path, _) = archive(
        profile.path(),
        source.path(),
        MigrationSourceKind::Codex,
        A,
        A,
        records,
    );
    let original_bytes = fs::read(&source_path).unwrap();
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    let exact = store.prepare(&job, &[]).unwrap();
    let reconstructed = store.prepare_readable_reconstruction(&job).unwrap();
    assert_ne!(exact.view_id, reconstructed.view_id);
    let archives = ExternalHistoryStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    assert_eq!(
        archives
            .branch(&reconstructed.view_id, false)
            .unwrap()
            .recipe()
            .revision,
        kcoder_migration::history_branches::HISTORY_RECONSTRUCTION_BRANCH_REVISION
    );
    let ready = store.build(&job, &reconstructed.view_id, || true).unwrap();
    assert_eq!(ready.stage, HistoricalBranchStage::Ready);
    assert_eq!(ready.structural_complete, Some(false));
    assert!(
        ready
            .issues
            .iter()
            .any(|issue| issue == "codex_readable_reconstruction_requires_admission")
    );
    assert_eq!(row(profile.path(), &reconstructed.view_id, 0), [1, 2, 3, 5]);
    assert_eq!(
        store.prepare_readable_reconstruction(&job).unwrap().view_id,
        reconstructed.view_id
    );
    let tool_state = store
        .correlate(&job, &reconstructed.view_id, None, || true)
        .unwrap();
    assert_eq!(
        tool_state.run.unwrap().stage,
        kcoder_types::historical_tool_links::HistoricalToolLinkStage::Ready
    );
    let tool_links = store
        .tools_page(&job, &reconstructed.view_id, None)
        .unwrap();
    assert_eq!(tool_links.links.len(), 1);
    assert_eq!(
        tool_links.links[0].status,
        kcoder_types::historical_tool_links::HistoricalToolLinkStatus::Linked
    );
    assert_eq!(tool_links.links[0].call_id, "call-1");
    let compilation = HistoryContextCompiler::open(profile.path())
        .unwrap()
        .compile(
            &job,
            &reconstructed.view_id,
            HistoricalContextPolicy::default(),
            |_| true,
        )
        .unwrap();
    assert!(
        compilation.report.context_compiled,
        "{:?}",
        compilation.report
    );
    let document = compilation.document.unwrap();
    assert_eq!(
        document.revision,
        kcoder_types::historical_context::HISTORICAL_CONTEXT_RECONSTRUCTED_REVISION
    );
    let excerpt = document
        .entries
        .iter()
        .find(|entry| entry.text.contains("Historical tool output excerpt only"))
        .expect("long tool output must have a transparent excerpt");
    assert!(excerpt.text.contains("complete original is retained"));
    assert!(document.entries.iter().any(|entry| {
        entry
            .text
            .contains("attachment omitted from reconstructed model context")
    }));
    assert!(document.attachments.is_empty());
    assert!(
        !serde_json::to_string(&document)
            .unwrap()
            .contains("data:image/png;base64")
    );
    assert!(excerpt.text.len() < 9000);
    assert!(std::str::from_utf8(excerpt.text.as_bytes()).is_ok());
    assert_eq!(
        compilation.binding.unwrap().compiler_revision,
        kcoder_types::historical_context::HISTORICAL_CONTEXT_RECONSTRUCTED_REVISION
    );
    assert_eq!(fs::read(source_path).unwrap(), original_bytes);
    drop(store);
    let reopened = HistoryBranchStore::open(profile.path()).unwrap();
    assert_eq!(
        reopened
            .progress(&job, &reconstructed.view_id)
            .unwrap()
            .view_id,
        reconstructed.view_id
    );
    assert_eq!(row(profile.path(), &reconstructed.view_id, 0), [1, 2, 3, 5]);
    assert_eq!(
        reopened
            .build(&job, &reconstructed.view_id, || panic!(
                "ready reconstruction must not replay"
            ))
            .unwrap()
            .view_id,
        reconstructed.view_id
    );
}

#[test]
fn additional_tool_declarations_use_a_distinct_stable_readable_branch() {
    use kcoder_migration::history_context::HistoryContextCompiler;
    use kcoder_types::historical_context::HistoricalContextPolicy;
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let mut records = vec![
        json!({"type":"session_meta","payload":{"id":A,"session_id":A,"history_mode":"paginated"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"original task"}]}}),
        json!({"type":"compacted","payload":{"message":"","window_number":1,"replacement_history":[{"type":"additional_tools","role":"developer","id":"tools-1","tools":[{"name":"OLD_TOOL_SECRET","command":"NEVER_EXECUTE"}]},{"type":"compaction","encrypted_content":"opaque"}]}}),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"next step"}]}}),
    ];
    for (ordinal, record) in records.iter_mut().enumerate() {
        record["ordinal"] = json!(ordinal);
    }
    let (job, source_path, _) = archive(
        profile.path(),
        source.path(),
        MigrationSourceKind::Codex,
        A,
        A,
        records,
    );
    let original = fs::read(&source_path).unwrap();
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    let legacy = store.prepare_readable_reconstruction(&job).unwrap();
    let failed = store.build(&job, &legacy.view_id, || true).unwrap();
    assert_eq!(failed.stage, HistoricalBranchStage::Failed);
    assert_eq!(
        failed.failure_code.as_deref(),
        Some("history_reconstruction_checkpoint_unsupported")
    );
    let prepared = store.prepare_readable_reconstruction(&job).unwrap();
    assert_ne!(prepared.view_id, legacy.view_id);
    let archives = ExternalHistoryStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    assert_eq!(
        archives
            .branch(&prepared.view_id, false)
            .unwrap()
            .recipe()
            .revision,
        kcoder_migration::history_branches::HISTORY_RECONSTRUCTION_TOOLS_BRANCH_REVISION
    );
    let ready = store.build(&job, &prepared.view_id, || true).unwrap();
    assert_eq!(ready.stage, HistoricalBranchStage::Ready);
    assert_eq!(ready.structural_complete, Some(false));
    assert_eq!(
        store.prepare_readable_reconstruction(&job).unwrap().view_id,
        prepared.view_id
    );
    store
        .correlate(&job, &prepared.view_id, None, || true)
        .unwrap();
    let compilation = HistoryContextCompiler::open(profile.path())
        .unwrap()
        .compile(
            &job,
            &prepared.view_id,
            HistoricalContextPolicy::default(),
            |_| true,
        )
        .unwrap();
    assert!(
        compilation.report.context_compiled,
        "{:?}",
        compilation.report
    );
    let document = serde_json::to_string(&compilation.document.unwrap()).unwrap();
    assert!(document.contains("original task") && document.contains("next step"));
    assert!(!document.contains("OLD_TOOL_SECRET") && !document.contains("NEVER_EXECUTE"));
    assert_eq!(fs::read(source_path).unwrap(), original);
}

#[test]
fn reconstructed_context_omits_whole_old_tool_groups_before_user_messages() {
    use kcoder_migration::history_context::HistoryContextCompiler;
    use kcoder_types::historical_context::{HistoricalContextFactKind, HistoricalContextPolicy};
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let mut records = vec![
        json!({"type":"session_meta","payload":{"id":A,"session_id":A,"history_mode":"paginated"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"original request"}]}}),
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"old","name":"write","arguments":"{}"}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"old","output":"old result ".repeat(120)}}),
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"recent","name":"read","arguments":"{}"}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"recent","output":"recent result"}}),
        json!({"type":"compacted","payload":{"message":"","window_number":1,"replacement_history":[{"type":"compaction","encrypted_content":"opaque"}]}}),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"final answer"}]}}),
    ];
    for (ordinal, record) in records.iter_mut().enumerate() {
        record["ordinal"] = json!(ordinal);
    }
    let (job, source_path, _) = archive(
        profile.path(),
        source.path(),
        MigrationSourceKind::Codex,
        A,
        A,
        records,
    );
    let original = fs::read(&source_path).unwrap();
    let store = HistoryBranchStore::open(profile.path()).unwrap();
    let view = store.prepare_readable_reconstruction(&job).unwrap().view_id;
    assert_eq!(
        store.build(&job, &view, || true).unwrap().stage,
        HistoricalBranchStage::Ready
    );
    store.correlate(&job, &view, None, || true).unwrap();
    let compiler = HistoryContextCompiler::open(profile.path()).unwrap();
    let policy = HistoricalContextPolicy {
        max_entries: 5,
        ..HistoricalContextPolicy::default()
    };
    let compiled = compiler
        .compile(&job, &view, policy.clone(), |_| true)
        .unwrap();
    assert!(compiled.report.context_compiled, "{:?}", compiled.report);
    assert!(compiled.report.excluded_provider_blocks >= 3);
    let entries = compiled.document.unwrap().entries;
    assert!(entries.iter().any(|entry| entry.text == "original request"));
    assert!(entries.iter().any(|entry| entry.text == "final answer"));
    assert!(
        entries
            .iter()
            .all(|entry| entry.call_id.as_deref() != Some("old"))
    );
    assert!(
        entries
            .iter()
            .any(|entry| entry.call_id.as_deref() == Some("recent")
                && entry.kind == HistoricalContextFactKind::ToolCallFact)
    );
    assert!(
        entries
            .iter()
            .any(|entry| entry.call_id.as_deref() == Some("recent")
                && entry.kind == HistoricalContextFactKind::ToolResultFact)
    );
    let byte_policy = HistoricalContextPolicy {
        max_context_bytes: 2200,
        ..HistoricalContextPolicy::default()
    };
    let byte_compiled = compiler
        .compile(&job, &view, byte_policy, |_| true)
        .unwrap();
    assert!(
        byte_compiled.report.context_compiled,
        "{:?}",
        byte_compiled.report
    );
    let bytes = byte_compiled.document.unwrap().entries;
    assert!(bytes.iter().any(|entry| entry.text == "original request"));
    assert!(bytes.iter().any(|entry| entry.text == "final answer"));
    assert!(
        bytes
            .iter()
            .all(|entry| entry.call_id.as_deref() != Some("old"))
    );
    let policy = HistoricalContextPolicy {
        max_entries: 1,
        ..policy
    };
    let blocked = compiler.compile(&job, &view, policy, |_| true).unwrap();
    assert!(!blocked.report.context_compiled && blocked.document.is_none());
    assert_eq!(fs::read(source_path).unwrap(), original);
}

#[test]
fn top_level_tool_declarations_and_verified_guardians_recover_after_legacy_failure() {
    use kcoder_migration::history_context::HistoryContextCompiler;
    use kcoder_types::historical_context::HistoricalContextPolicy;
    for scenario in [
        "top_level_tools",
        "guardian",
        "guardian_opaque",
        "historical_search",
    ] {
        let profile = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let user = json!({"type":"message","role":"user","content":[{"type":"input_text","text":"original task"}]});
        let assistant = json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"next step"}]});
        let mut records = vec![
            json!({"type":"session_meta","payload":{"id":A,"session_id":A,"history_mode":"paginated"}}),
            json!({"type":"response_item","payload":user}),
            json!({"type":"response_item","payload":assistant}),
        ];
        if scenario == "top_level_tools" {
            records.push(json!({"type":"response_item","payload":{"type":"additional_tools","role":"developer","id":"tools-1","tools":[{"name":"OLD_TOOL_SECRET"}]}}));
        } else if scenario.starts_with("guardian") {
            let snapshot = if scenario == "guardian_opaque" {
                let mut original_assistant = assistant.clone();
                original_assistant["id"] = json!("changed-id");
                json!([user, {"type":"reasoning","content":null,"encrypted_content":"opaque","summary":[{"type":"summary_text","text":"PRIVATE_REASONING"}]}, original_assistant])
            } else {
                json!([user, assistant])
            };
            records.push(json!({"type":"compacted","payload":{"message":"","window_number":1,"replacement_history":[{"type":"compaction","encrypted_content":"opaque"}],"guardian_history":snapshot}}));
        } else {
            records.push(json!({"type":"response_item","payload":{"type":"web_search_call","id":"ws","status":"completed","action":{"type":"search","query":"PRIVATE_QUERY"}}}));
            records.push(json!({"type":"response_item","payload":{"type":"tool_search_call","call_id":"c","status":"completed","execution":"client","arguments":{"query":"PRIVATE_SEARCH"}}}));
            records.push(json!({"type":"response_item","payload":{"type":"tool_search_output","call_id":"c","status":"completed","execution":"client","tools":[{"name":"OLD_TOOL_SECRET"}]}}));
        }
        for (ordinal, record) in records.iter_mut().enumerate() {
            record["ordinal"] = json!(ordinal);
        }
        let (job, source_path, _) = archive(
            profile.path(),
            source.path(),
            MigrationSourceKind::Codex,
            A,
            A,
            records,
        );
        let original = fs::read(&source_path).unwrap();
        let store = HistoryBranchStore::open(profile.path()).unwrap();
        let legacy = store.prepare_readable_reconstruction(&job).unwrap();
        let failed = store.build(&job, &legacy.view_id, || true).unwrap();
        assert_eq!(failed.stage, HistoricalBranchStage::Failed);
        assert_eq!(
            failed.failure_code.as_deref(),
            Some(if scenario.starts_with("guardian") {
                "history_reconstruction_source_requires_review"
            } else {
                "history_reconstruction_checkpoint_not_found"
            })
        );
        let prepared = store.prepare_readable_reconstruction(&job).unwrap();
        assert_ne!(prepared.view_id, legacy.view_id);
        assert_eq!(
            store.build(&job, &prepared.view_id, || true).unwrap().stage,
            HistoricalBranchStage::Ready
        );
        store
            .correlate(&job, &prepared.view_id, None, || true)
            .unwrap();
        let compilation = HistoryContextCompiler::open(profile.path())
            .unwrap()
            .compile(
                &job,
                &prepared.view_id,
                HistoricalContextPolicy::default(),
                |_| true,
            )
            .unwrap();
        assert!(
            compilation.report.context_compiled,
            "{scenario}: {:?}",
            compilation.report
        );
        let document = serde_json::to_string(&compilation.document.unwrap()).unwrap();
        assert!(document.contains("original task") && document.contains("next step"));
        assert!(!document.contains("OLD_TOOL_SECRET"));
        assert!(!document.contains("PRIVATE_REASONING"));
        if scenario == "historical_search" {
            assert!(document.contains("Historical web search"));
            assert!(document.contains("Historical tool discovery"));
            assert!(!document.contains("PRIVATE_QUERY") && !document.contains("PRIVATE_SEARCH"));
        }
        assert_eq!(
            store.prepare_readable_reconstruction(&job).unwrap().view_id,
            prepared.view_id
        );
        assert_eq!(fs::read(source_path).unwrap(), original);
    }
}
