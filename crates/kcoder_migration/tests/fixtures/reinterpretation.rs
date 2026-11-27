//! Artificial persisted /3 job, parsed through the real version-bound legacy capture strategy.
//! This fixture does not execute an old vendor program or introduce a production fault switch.
use kcoder_migration::{
    history_jobs::HistoryJobStore,
    history_normalization::{HistoryNormalizer, LEGACY_HISTORY_NORMALIZATION_REVISION},
    history_sources::HistorySourceBinding,
};
use kcoder_state::external_history::ExternalHistoryStore;
use kcoder_types::{external_history::*, migration::MigrationSourceKind};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn legacy(
    profile: &Path,
    source: &Path,
    kind: MigrationSourceKind,
    dense_failure: bool,
) -> (HistoryImportJobView, HistorySourceBinding, PathBuf) {
    fs::create_dir_all(source).unwrap();
    let session = uuid::Uuid::new_v4().to_string();
    let content = if dense_failure {
        let mut content = (0..10_000)
            .map(|index| json!({"type":"text","text":format!("Reinterpret dense result {index}")}))
            .collect::<Vec<_>>();
        content.push(match kind {
            MigrationSourceKind::ClaudeCode => json!({"type":"document","title":"retained-proof.txt","source":{"type":"text","media_type":"text/plain","data":"REINTERPRETED_ATTACHMENT_PROOF"}}),
            MigrationSourceKind::Codex => {
                use base64::Engine as _;
                json!({"type":"input_file","filename":"retained-proof.txt","file_data":format!("data:text/plain;base64,{}", base64::engine::general_purpose::STANDARD.encode(b"REINTERPRETED_ATTACHMENT_PROOF"))})
            }
        });
        json!(content)
    } else {
        json!("REINTERPRETED_SMALL_RESULT")
    };
    let values = match kind {
        MigrationSourceKind::ClaudeCode => vec![
            json!({"type":"user","uuid":"root","sessionId":session,"version":"2.1.301","message":{"role":"user","content":format!("REINTERPRETED_USER_ROOT {}", "x".repeat(80_000))}}),
            json!({"type":"assistant","uuid":"call","parentUuid":"root","sessionId":session,"version":"2.1.301","message":{"role":"assistant","content":[{"type":"tool_use","id":"old-call","name":"Bash","input":{"command":"touch NEVER_REPLAY_REINTERPRETATION"}}]}}),
            json!({"type":"user","uuid":"result","parentUuid":"call","sessionId":session,"version":"2.1.301","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"old-call","content":content}]}}),
            json!({"type":"assistant","uuid":"tail","parentUuid":"result","sessionId":session,"version":"2.1.301","message":{"role":"assistant","content":"REINTERPRETED_FINAL_ANSWER"}}),
        ],
        MigrationSourceKind::Codex => vec![
            json!({"type":"session_meta","payload":{"id":session,"cli_version":"0.163.0"}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"old-call","name":"Bash","arguments":"{\"command\":\"touch NEVER_REPLAY_REINTERPRETATION\"}"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"old-call","output":content}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"REINTERPRETED_FINAL_ANSWER"}]}}),
        ],
    };
    let records = values
        .iter()
        .map(|value| serde_json::to_vec(value).unwrap())
        .collect::<Vec<_>>();
    let path = source.join(format!("{session}.jsonl"));
    fs::write(
        &path,
        records
            .iter()
            .flat_map(|record| record.iter().copied().chain([b'\n']))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let binding = HistorySourceBinding::capture(
        source,
        Path::new(path.file_name().unwrap()),
        ExternalHistoryOrigin {
            source: kind,
            source_instance: "owned-reinterpretation-fixture".into(),
            source_session_id: session,
            source_artifact_id: None,
            source_format: "synthetic-jsonl".into(),
            adapter_revision: "raw/1".into(),
            title: Some("Owned reinterpretation history".into()),
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
    let key = uuid::Uuid::new_v4().to_string();
    let created = store.create(&key, &binding).unwrap();
    let archived = store.step(&key, created.sequence, 10, |_| true).unwrap();
    // Materialize the old job identity, then execute its exact legacy capture policy.
    let journal = profile
        .join("migrations/history")
        .join(format!("{key}.json"));
    let mut saved: serde_json::Value =
        serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
    saved["normalizationRevision"] = json!(LEGACY_HISTORY_NORMALIZATION_REVISION);
    fs::write(journal, serde_json::to_vec(&saved).unwrap()).unwrap();
    let archives = ExternalHistoryStore::open_existing(profile)
        .unwrap()
        .unwrap();
    let reader = archives
        .reader(archived.archive_id.as_deref().unwrap())
        .unwrap();
    let mut normalizer =
        HistoryNormalizer::open_with_revision(reader, LEGACY_HISTORY_NORMALIZATION_REVISION)
            .unwrap();
    let parsed = normalizer.step(10, |_| true).unwrap();
    assert!(parsed.normalization_complete);
    assert_eq!(parsed.records_with_diagnostics, u64::from(dense_failure));
    drop(normalizer);
    let done = store.step(&key, archived.sequence, 10, |_| true).unwrap();
    assert_eq!(done.stage, HistoryImportStage::Normalized);
    (done, binding, path)
}

pub fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    fn visit(root: &Path, path: &Path, files: &mut Vec<(PathBuf, Vec<u8>)>) {
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                visit(root, &entry.path(), files);
            } else {
                files.push((
                    entry.path().strip_prefix(root).unwrap().into(),
                    fs::read(entry.path()).unwrap(),
                ));
            }
        }
    }
    let mut files = Vec::new();
    visit(root, root, &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}
