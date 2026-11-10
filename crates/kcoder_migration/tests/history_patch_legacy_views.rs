//! Persisted /4 remains exact while an explicit /5 interpretation owns its new view.
use kcoder_migration::{
    history_branches::HistoryBranchStore,
    history_context::HistoryContextCompiler,
    history_jobs::HistoryJobStore,
    history_normalization::{
        HISTORY_NORMALIZATION_REVISION, HISTORY_NORMALIZATION_REVISION_V4, HistoryNormalizer,
    },
    history_sources::HistorySourceBinding,
};
use kcoder_state::external_history::ExternalHistoryStore;
use kcoder_types::{
    external_history::*, historical_context::HistoricalContextPolicy,
    imported_transcript::HistoricalToolOutcome, migration::MigrationSourceKind,
};
use serde_json::{Value, json};
use std::{fs, path::Path};

#[test]
fn sealed_v4_branch_and_compiled_facts_stay_byte_identical_after_explicit_v5_reinterpretation() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let session = "48484848-4848-4484-8484-484848484848";
    let leaf = format!("rollout-2026-10-17T00-00-00-{session}.jsonl");
    let bytes = include_bytes!("../fixtures/codex-patch-execution-0.163.0.jsonl");
    fs::write(source.path().join(&leaf), bytes).unwrap();
    let binding = HistorySourceBinding::capture(
        source.path(),
        Path::new(&leaf),
        ExternalHistoryOrigin {
            source: MigrationSourceKind::Codex,
            source_instance: "synthetic-patch-fixture".into(),
            source_session_id: session.into(),
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
    let jobs = HistoryJobStore::open(profile.path()).unwrap();
    let key = uuid::Uuid::new_v4().to_string();
    let created = jobs.create(&key, &binding).unwrap();
    let archived = jobs.step(&key, created.sequence, 10, |_| true).unwrap();
    // Materialize an artificial old journal, then use the actual frozen /4 parser.
    let journal = profile
        .path()
        .join("migrations/history")
        .join(format!("{key}.json"));
    let mut saved: Value = serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
    saved["normalizationRevision"] = json!(HISTORY_NORMALIZATION_REVISION_V4);
    fs::write(&journal, serde_json::to_vec(&saved).unwrap()).unwrap();
    let archives = ExternalHistoryStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let reader = archives
        .reader(archived.archive_id.as_deref().unwrap())
        .unwrap();
    let mut old_parser =
        HistoryNormalizer::open_with_revision(reader, HISTORY_NORMALIZATION_REVISION_V4).unwrap();
    assert!(
        old_parser
            .step(10, |_| true)
            .unwrap()
            .normalization_complete
    );
    drop(old_parser);
    let old = jobs.step(&key, archived.sequence, 10, |_| true).unwrap();
    assert_eq!(old.stage, HistoryImportStage::Normalized);
    let branches = HistoryBranchStore::open(profile.path()).unwrap();
    let old_view = branches.prepare(&key, &[]).unwrap().view_id;
    branches.build(&key, &old_view, || true).unwrap();
    branches.correlate(&key, &old_view, None, || true).unwrap();
    let old_page = branches.page(&key, &old_view, 0, |_| true).unwrap();
    assert_eq!(
        old_page
            .items
            .iter()
            .map(|item| item.record.record)
            .collect::<Vec<_>>(),
        vec![1, 3]
    );
    let old_links = branches.tools_page(&key, &old_view, None).unwrap();
    assert_eq!(
        old_links.links[0].outcome,
        HistoricalToolOutcome::RecordedResult
    );
    assert!(old_links.links[0].execution_outcome.is_none());
    let compiler = HistoryContextCompiler::open(profile.path()).unwrap();
    let old_context = compiler
        .compile(&key, &old_view, HistoricalContextPolicy::default(), |_| {
            true
        })
        .unwrap();
    assert!(old_context.report.context_compiled);
    let old_document = serde_json::to_vec(&old_context.document).unwrap();
    let old_page_bytes = serde_json::to_vec(&old_page).unwrap();
    let old_link_bytes = serde_json::to_vec(&old_links).unwrap();
    let old_journal = fs::read(&journal).unwrap();
    fs::remove_file(source.path().join(leaf)).unwrap();
    let new_key = uuid::Uuid::new_v4().to_string();
    let mut current = jobs.reinterpret(&new_key, &key, old.sequence).unwrap();
    while current.stage != HistoryImportStage::Normalized {
        current = jobs.step(&new_key, current.sequence, 10, |_| true).unwrap();
        assert!(!matches!(
            current.stage,
            HistoryImportStage::Failed | HistoryImportStage::Cancelled
        ));
    }
    assert_eq!(
        jobs.normalization_revision(&new_key).unwrap(),
        HISTORY_NORMALIZATION_REVISION
    );
    let new_view = branches.prepare(&new_key, &[]).unwrap().view_id;
    assert_ne!(new_view, old_view);
    branches.build(&new_key, &new_view, || true).unwrap();
    branches
        .correlate(&new_key, &new_view, None, || true)
        .unwrap();
    let new_links = branches.tools_page(&new_key, &new_view, None).unwrap();
    assert_eq!(
        new_links.links[0].execution_outcome,
        Some(HistoricalToolOutcome::RecordedSuccess)
    );
    assert!(
        compiler
            .compile(
                &new_key,
                &new_view,
                HistoricalContextPolicy::default(),
                |_| true
            )
            .unwrap()
            .report
            .context_compiled
    );
    assert_eq!(fs::read(journal).unwrap(), old_journal);
    assert_eq!(
        serde_json::to_vec(&branches.page(&key, &old_view, 0, |_| true).unwrap()).unwrap(),
        old_page_bytes
    );
    assert_eq!(
        serde_json::to_vec(&branches.tools_page(&key, &old_view, None).unwrap()).unwrap(),
        old_link_bytes
    );
    let reread = compiler
        .compile(&key, &old_view, HistoricalContextPolicy::default(), |_| {
            true
        })
        .unwrap();
    assert!(reread.report.context_compiled);
    assert_eq!(serde_json::to_vec(&reread.document).unwrap(), old_document);
}
