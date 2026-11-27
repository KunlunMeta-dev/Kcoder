//! Reader-specific regressions are registered only with the complete attachment observer.
use super::super::*;
use super::attachment_view::ResourceAttachmentPhase;

#[test]
fn a_new_budget_has_no_fabricated_legacy_upgrade_intent() {
    let root = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let selected = crate::history_sources::HistorySourceBinding::capture(
        root.path(),
        Path::new("source.jsonl"),
        kcoder_types::external_history::ExternalHistoryOrigin {
            source: kcoder_types::migration::MigrationSourceKind::ClaudeCode,
            source_instance: "owned-metadata".into(),
            source_session_id: "owned".into(),
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
    );
    // Missing input must not be replaced by any ambient source.
    assert!(selected.is_err());
    std::fs::write(root.path().join("source.jsonl"), b"{\"type\":\"user\",\"uuid\":\"owned\",\"message\":{\"role\":\"user\",\"content\":\"owned metadata\"}}\n").unwrap();
    let selected = crate::history_sources::HistorySourceBinding::capture(
        root.path(),
        Path::new("source.jsonl"),
        kcoder_types::external_history::ExternalHistoryOrigin {
            source: kcoder_types::migration::MigrationSourceKind::ClaudeCode,
            source_instance: "owned-metadata".into(),
            source_session_id: "owned".into(),
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
    let before = store.create(&id, &selected).unwrap();
    let files = std::fs::read_dir(profile.path().join("migrations/history"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<std::collections::BTreeSet<_>>();
    std::fs::remove_file(root.path().join("source.jsonl")).unwrap();
    let observed = store.resource_attachment(&id).unwrap();
    assert_eq!(observed.phase, ResourceAttachmentPhase::Tracked);
    assert!(observed.original_intent.is_none());
    assert_eq!(observed.current_sequence, before.sequence);
    assert_eq!(store.read(&id).unwrap(), before);
    assert_eq!(
        std::fs::read_dir(profile.path().join("migrations/history"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>(),
        files
    );
}
