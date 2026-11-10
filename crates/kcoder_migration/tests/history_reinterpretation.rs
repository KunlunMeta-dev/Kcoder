#[path = "fixtures/reinterpretation.rs"]
mod fixture;
use kcoder_migration::{
    history_branches::HistoryBranchStore,
    history_context::HistoryContextCompiler,
    history_jobs::HistoryJobStore,
    history_normalization::{
        HISTORY_NORMALIZATION_REVISION, LEGACY_HISTORY_NORMALIZATION_REVISION,
    },
};
use kcoder_types::{
    external_history::*, historical_context::HistoricalContextPolicy,
    migration::MigrationSourceKind,
};
use std::fs;

fn finish(store: &HistoryJobStore, mut job: HistoryImportJobView) -> HistoryImportJobView {
    while job.stage != HistoryImportStage::Normalized {
        assert!(!matches!(
            job.stage,
            HistoryImportStage::Cancelled | HistoryImportStage::Failed
        ));
        job = store.step(&job.job_id, job.sequence, 10, |_| true).unwrap();
    }
    job
}

#[test]
fn sealed_old_failure_requires_an_explicit_new_job_and_remains_readable_after_reinterpretation() {
    for kind in [MigrationSourceKind::ClaudeCode, MigrationSourceKind::Codex] {
        let profile = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let (old, _, path) = fixture::legacy(profile.path(), source.path(), kind, true);
        let store = HistoryJobStore::open(profile.path()).unwrap();
        let before = store
            .archive_view(&old.job_id)
            .unwrap()
            .page(0, |_| true)
            .unwrap();
        assert_eq!(
            before.adapter_revision,
            LEGACY_HISTORY_NORMALIZATION_REVISION
        );
        assert_eq!(
            old.normalization.as_ref().unwrap().records_with_diagnostics,
            1
        );
        let old_projection = profile
            .path()
            .join("external-history")
            .join(old.archive_id.as_ref().unwrap())
            .join(format!(
                "normalized-{:x}",
                sha2::Sha256::digest(LEGACY_HISTORY_NORMALIZATION_REVISION.as_bytes())
            ));
        let old_bytes = fixture::snapshot(&old_projection);
        let old_journal = profile
            .path()
            .join("migrations/history")
            .join(format!("{}.json", old.job_id));
        let old_job_bytes = fs::read(&old_journal).unwrap();
        fs::remove_file(&path).unwrap();
        let preview = store.reinterpretation_preview(&old.job_id).unwrap();
        assert!(preview.can_create);
        assert_ne!(preview.source_revision, preview.parser_revision);
        assert_eq!(fixture::snapshot(&old_projection), old_bytes);
        let key = uuid::Uuid::new_v4().to_string();
        let new = store.reinterpret(&key, &old.job_id, old.sequence).unwrap();
        assert_eq!(new.archive_id, old.archive_id);
        assert_eq!(new.sequence, 0);
        assert!(new.normalization.is_none());
        assert_eq!(
            store.reinterpret(&key, &old.job_id, old.sequence).unwrap(),
            new
        );
        let complete = finish(&store, new);
        assert_eq!(
            complete
                .normalization
                .as_ref()
                .unwrap()
                .records_with_diagnostics,
            0
        );
        let page = store.archive_view(&key).unwrap().page(0, |_| true).unwrap();
        assert_eq!(page.adapter_revision, HISTORY_NORMALIZATION_REVISION);
        assert_ne!(
            store.archive_view(&key).unwrap().content_identity(),
            store.archive_view(&old.job_id).unwrap().content_identity()
        );
        let branches = HistoryBranchStore::open(profile.path()).unwrap();
        let view = branches.prepare(&key, &[]).unwrap().view_id;
        let ready = branches.build(&key, &view, || true).unwrap();
        assert_eq!(ready.structural_complete, Some(true));
        let tools = branches.correlate(&key, &view, None, || true).unwrap();
        assert!(tools.progress.unwrap().sealed);
        if kind == MigrationSourceKind::ClaudeCode {
            let collection = branches.tool_attachments(&key, &view, 2, 0).unwrap();
            let catalog = collection.build(|_, _| true).unwrap();
            assert_eq!(catalog.attachments, 1);
            assert!(
                collection
                    .extract_item(0, 1024, |_, _| true)
                    .unwrap()
                    .receipt
                    .is_some()
            );
            let compiled = HistoryContextCompiler::open(profile.path())
                .unwrap()
                .compile(&key, &view, HistoricalContextPolicy::default(), |_| true)
                .unwrap();
            assert!(!compiled.report.context_compiled);
            assert!(
                compiled
                    .report
                    .issues
                    .iter()
                    .any(|issue| issue.code == "history_context_part_budget_exceeded")
            );
        }
        // Old job metadata, sealed rows, and their original interpretation are never redirected.
        assert_eq!(fs::read(old_journal).unwrap(), old_job_bytes);
        assert_eq!(fixture::snapshot(&old_projection), old_bytes);
        assert_eq!(
            serde_json::to_value(
                store
                    .archive_view(&old.job_id)
                    .unwrap()
                    .page(0, |_| true)
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(before).unwrap()
        );
    }
}

#[test]
fn a_new_ordinary_job_uses_current_interpretation_instead_of_the_same_archives_old_failure() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let (old, binding, path) = fixture::legacy(
        profile.path(),
        source.path(),
        MigrationSourceKind::ClaudeCode,
        true,
    );
    fs::remove_file(path).unwrap();
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let current = finish(
        &store,
        store
            .create(&uuid::Uuid::new_v4().to_string(), &binding)
            .unwrap(),
    );
    assert_eq!(current.archive_id, old.archive_id);
    assert_eq!(
        store.normalization_revision(&current.job_id).unwrap(),
        HISTORY_NORMALIZATION_REVISION
    );
    assert_eq!(current.normalization.unwrap().records_with_diagnostics, 0);
    assert_eq!(
        store
            .read(&old.job_id)
            .unwrap()
            .normalization
            .unwrap()
            .records_with_diagnostics,
        1
    );
    assert!(
        !store
            .reinterpretation_preview(&current.job_id)
            .unwrap()
            .can_create
    );
}

#[test]
fn reinterpretation_has_owned_cancellation_reopen_and_revision_fences_without_requiring_the_source()
{
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let (old, _, path) = fixture::legacy(
        profile.path(),
        source.path(),
        MigrationSourceKind::ClaudeCode,
        false,
    );
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let old_branch = HistoryBranchStore::open(profile.path()).unwrap();
    let view = old_branch.prepare(&old.job_id, &[]).unwrap().view_id;
    old_branch.build(&old.job_id, &view, || true).unwrap();
    old_branch
        .correlate(&old.job_id, &view, None, || true)
        .unwrap();
    let old_report = HistoryContextCompiler::open(profile.path())
        .unwrap()
        .compile(
            &old.job_id,
            &view,
            HistoricalContextPolicy::default(),
            |_| true,
        )
        .unwrap()
        .report;
    assert!(old_report.context_compiled);
    fs::remove_file(path).unwrap();
    let key = uuid::Uuid::new_v4().to_string();
    assert!(
        store
            .reinterpret(&key, &old.job_id, old.sequence + 1)
            .is_err()
    );
    let new = store.reinterpret(&key, &old.job_id, old.sequence).unwrap();
    let cancelled = store.request_cancel(&key).unwrap();
    let cancelled = store.step(&key, cancelled.sequence, 1, |_| true).unwrap();
    assert_eq!(cancelled.stage, HistoryImportStage::Cancelled);
    assert!(store.resume(&key, new.sequence).is_err());
    let reopened = HistoryJobStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    assert_eq!(
        reopened
            .reinterpret(&key, &old.job_id, old.sequence)
            .unwrap(),
        cancelled
    );
    let complete = finish(
        &reopened,
        reopened.resume(&key, cancelled.sequence).unwrap(),
    );
    assert_eq!(complete.stage, HistoryImportStage::Normalized);
    assert_eq!(
        serde_json::to_value(
            HistoryContextCompiler::open(profile.path())
                .unwrap()
                .compile(
                    &old.job_id,
                    &view,
                    HistoricalContextPolicy::default(),
                    |_| true
                )
                .unwrap()
                .report
        )
        .unwrap(),
        serde_json::to_value(old_report).unwrap()
    );
    assert!(
        !profile
            .path()
            .join("NEVER_REPLAY_REINTERPRETATION")
            .exists()
    );
}

use sha2::Digest;

#[test]
fn ambiguous_unsealed_v3_never_appends_a_guessed_parser_after_an_acknowledged_prefix() {
    use kcoder_migration::{history_records::parse_record, history_sources::HistorySourceBinding};
    use kcoder_state::external_history::ExternalHistoryStore;
    use serde_json::json;
    use std::path::Path;

    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let session = uuid::Uuid::new_v4().to_string();
    let dense = (0..10_000)
        .map(|index| json!({"type":"text","text":format!("Ambiguous dense result {index}")}))
        .collect::<Vec<_>>();
    let record = json!({"type":"user","uuid":"dense","sessionId":session,"version":"2.1.301","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"old-call","content":dense}]}});
    let bytes = format!("{record}\n{record}\n");
    let path = source.path().join("ambiguous.jsonl");
    fs::write(&path, bytes).unwrap();
    let binding = HistorySourceBinding::capture(
        source.path(),
        Path::new("ambiguous.jsonl"),
        ExternalHistoryOrigin {
            source: MigrationSourceKind::ClaudeCode,
            source_instance: "owned-ambiguous-v3-fixture".into(),
            source_session_id: session,
            source_artifact_id: None,
            source_format: "synthetic-jsonl".into(),
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
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let created = store.create(&id, &binding).unwrap();
    let archived = store.step(&id, created.sequence, 10, |_| true).unwrap();
    let archives = ExternalHistoryStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let reader = archives
        .reader(archived.archive_id.as_deref().unwrap())
        .unwrap();
    // cfd/12cb shipped this exact-path parser under /3. Its acknowledged prefix is real.
    let first = parse_record(&reader, 0, |_| true).unwrap();
    assert!(first.diagnostics.is_empty());
    let mut projection = reader
        .projection(LEGACY_HISTORY_NORMALIZATION_REVISION, true)
        .unwrap()
        .unwrap();
    let prefix = projection.append(0, &[first]).unwrap();
    assert_eq!(prefix.normalized_records, 1);
    assert!(!prefix.normalization_complete);
    drop(projection);
    let journal = profile
        .path()
        .join("migrations/history")
        .join(format!("{id}.json"));
    let mut saved: serde_json::Value =
        serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
    saved["normalizationRevision"] = json!(LEGACY_HISTORY_NORMALIZATION_REVISION);
    saved["view"]["normalization"] = serde_json::to_value(&prefix).unwrap();
    fs::write(&journal, serde_json::to_vec(&saved).unwrap()).unwrap();
    let before_job = fs::read(&journal).unwrap();
    let before = store.read(&id).unwrap();
    let projection_dir = profile
        .path()
        .join("external-history")
        .join(archived.archive_id.as_ref().unwrap())
        .join(format!(
            "normalized-{:x}",
            sha2::Sha256::digest(LEGACY_HISTORY_NORMALIZATION_REVISION.as_bytes())
        ));
    let before_rows = fixture::snapshot(&projection_dir);
    let attempt = store.step(&id, before.sequence, 10, |_| true);
    if let Ok(mixed) = &attempt {
        let progress = mixed.normalization.as_ref().unwrap();
        assert_eq!(progress.normalized_records, 2);
        assert_eq!(progress.records_with_diagnostics, 1);
        eprintln!(
            "Unsafe /3 replay mixed a successful exact-path prefix with one legacy budget error: {progress:?}"
        );
    }
    let error =
        attempt.expect_err("an unsealed /3 has no implementation fingerprint and must not guess");
    assert_eq!(error.to_string(), "history_reinterpretation_required");
    assert_eq!(store.read(&id).unwrap(), before);
    assert_eq!(fs::read(&journal).unwrap(), before_job);
    assert_eq!(fixture::snapshot(&projection_dir), before_rows);
    fs::remove_file(path).unwrap();
    let new_id = uuid::Uuid::new_v4().to_string();
    let new = finish(
        &store,
        store.reinterpret(&new_id, &id, before.sequence).unwrap(),
    );
    assert_eq!(new.normalization.as_ref().unwrap().normalized_records, 2);
    assert_eq!(new.normalization.unwrap().records_with_diagnostics, 0);
    assert_eq!(store.read(&id).unwrap(), before);
    assert_eq!(fixture::snapshot(&projection_dir), before_rows);
    // An explicit cancellation may still settle the old job, but resume must not erase
    // that accepted control record before reporting the same interpretation boundary.
    let requested = store.request_cancel(&id).unwrap();
    let cancelled = store.step(&id, requested.sequence, 10, |_| true).unwrap();
    assert_eq!(cancelled.stage, HistoryImportStage::Cancelled);
    let cancelled_bytes = fs::read(&journal).unwrap();
    let control = profile
        .path()
        .join("migrations/history")
        .join(format!("{id}.cancel.json"));
    let control_bytes = fs::read(&control).unwrap();
    assert_eq!(
        store
            .resume(&id, cancelled.sequence)
            .unwrap_err()
            .to_string(),
        "history_reinterpretation_required"
    );
    assert_eq!(fs::read(journal).unwrap(), cancelled_bytes);
    assert_eq!(fs::read(control).unwrap(), control_bytes);
    assert_eq!(fixture::snapshot(&projection_dir), before_rows);
}
