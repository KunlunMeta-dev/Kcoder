use super::*;

fn snapshot(text: Option<String>) -> ImportedContextSnapshot {
    ImportedContextSnapshot {
        version: 1,
        profile_identity: "a".repeat(64),
        source: ImportedContextSnapshotSource::Captured,
        content: text,
        instructions: None,
    }
}
fn state(root: &Path) -> AppState {
    let state = AppState::new(root);
    let history = root.join(format!("{}.jsonl", state.session_id()));
    state.with_history_path(history);
    state.add_message(Message::user_text("Owned snapshot test"));
    state.save_history().unwrap();
    state
}
fn path(state: &AppState) -> PathBuf {
    state.read_inner().session_state_path.clone().unwrap()
}

#[test]
fn private_large_context_reopens_without_inflating_bounded_metadata_and_inherits_on_export() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    let original = snapshot(Some("Unverified note\n".repeat(140_000)));
    // Drop the successful return value to model a caller that lost its receipt.
    state
        .freeze_imported_context_snapshot(original.clone())
        .unwrap();
    let history = state.history_path().unwrap();
    let metadata = path(&state);
    assert!(fs::metadata(&metadata).unwrap().len() < 16 * 1024);
    let prepared = crate::capture_session_metadata_bounded(&history, 1024 * 1024).unwrap();
    assert!(prepared.bytes_read() < 16 * 1024);
    let export = root.path().join("export.json");
    state.export_snapshot(&export).unwrap();
    drop(state);
    let restored = AppState::new(root.path());
    restored.resume_from_history(&history).unwrap();
    assert_eq!(restored.imported_context_snapshot(), Some(original.clone()));
    assert_eq!(
        restored
            .freeze_imported_context_snapshot(snapshot(Some(
                "NEW PROFILE CONTENT MUST NOT REPLACE IT".into()
            )))
            .unwrap(),
        original
    );
    let child = AppState::new(root.path());
    child.import_snapshot(&export).unwrap();
    let child_history = root.path().join(format!("{}.jsonl", child.session_id()));
    child.with_history_path(&child_history);
    child.save_history().unwrap();
    let child_reopened = AppState::new(root.path());
    child_reopened.resume_from_history(&child_history).unwrap();
    assert_eq!(child_reopened.imported_context_snapshot(), Some(original));
}

#[test]
fn absent_context_is_immutable_and_a_new_session_can_capture_a_new_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    let empty = snapshot(None);
    state
        .freeze_imported_context_snapshot(empty.clone())
        .unwrap();
    let history = state.history_path().unwrap();
    let restored = AppState::new(root.path());
    restored.resume_from_history(&history).unwrap();
    assert!(!restored.imported_context_is_legacy_unobserved());
    assert_eq!(
        restored
            .freeze_imported_context_snapshot(snapshot(Some("LATER ENABLED NOTE".into())))
            .unwrap(),
        empty
    );
    restored.start_new_session().unwrap();
    assert!(restored.imported_context_snapshot().is_none());
    assert_eq!(
        restored
            .freeze_imported_context_snapshot(snapshot(Some("NEW SESSION NOTE".into())))
            .unwrap()
            .content
            .as_deref(),
        Some("NEW SESSION NOTE")
    );
}

#[test]
fn pending_intent_keeps_original_bytes_while_corruption_and_missing_payload_stay_blocked() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    let original = snapshot(Some("Private original frozen bytes".into()));
    let metadata = path(&state);
    let session = session_for(&state.read_inner());
    publish(&metadata, &session, &original).unwrap();
    assert!(
        state
            .reconcile_imported_context_snapshot(&"b".repeat(64))
            .is_err()
    );
    assert!(
        load_session_state(&metadata)
            .unwrap()
            .imported_context_snapshot
            .is_none()
    );
    assert_eq!(
        state
            .reconcile_imported_context_snapshot(&"a".repeat(64))
            .unwrap(),
        Some(original.clone())
    );
    assert_eq!(
        state
            .freeze_imported_context_snapshot(snapshot(Some(
                "CHANGED BEFORE METADATA COMMIT".into()
            )))
            .unwrap(),
        original
    );
    let history = state.history_path().unwrap();
    let directory = metadata.parent().unwrap();
    let payload = directory.join(FILE);
    let mut bytes = fs::read(&payload).unwrap();
    let original = bytes.clone();
    *bytes.last_mut().unwrap() ^= 1;
    fs::write(&payload, &bytes).unwrap();
    let broken = AppState::new(root.path());
    assert!(broken.resume_from_history(&history).is_err());
    assert!(broken.imported_context_snapshot().is_none());
    fs::write(&payload, &original).unwrap();
    fs::rename(&payload, directory.join("withheld-imported-context")).unwrap();
    assert!(
        AppState::new(root.path())
            .resume_from_history(&history)
            .is_err()
    );
}

#[test]
fn legacy_metadata_keeps_unknown_context_distinct_from_a_captured_empty_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    let history = state.history_path().unwrap();
    assert!(
        load_session_state(&path(&state))
            .unwrap()
            .imported_context_snapshot
            .is_none()
    );
    let restored = AppState::new(root.path());
    restored.resume_from_history(&history).unwrap();
    assert!(restored.imported_context_is_legacy_unobserved());
    assert!(restored.imported_context_snapshot().is_none());
    let legacy = ImportedContextSnapshot {
        source: ImportedContextSnapshotSource::LegacyUnobserved,
        ..snapshot(None)
    };
    restored
        .freeze_imported_context_snapshot(legacy.clone())
        .unwrap();
    let again = AppState::new(root.path());
    again.resume_from_history(&history).unwrap();
    assert_eq!(again.imported_context_snapshot(), Some(legacy));
    assert!(again.imported_context_is_legacy_unobserved());
    let mut invalid = snapshot(Some("MUST NOT BECOME LEGACY PROOF".into()));
    invalid.source = ImportedContextSnapshotSource::LegacyUnobserved;
    assert!(validate(&invalid).is_err());
}

#[test]
fn ordinary_metadata_writes_do_not_repair_or_reread_an_already_published_context_payload() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    state
        .freeze_imported_context_snapshot(snapshot(Some(
            "Large immutable reference data\n".repeat(80_000),
        )))
        .unwrap();
    let metadata = path(&state);
    let before = load_session_state(&metadata)
        .unwrap()
        .imported_context_snapshot
        .unwrap();
    let payload = metadata.parent().unwrap().join(FILE);
    fs::remove_file(&payload).unwrap();
    // A metadata-only writer keeps the original small reference. It must not
    // recreate a deleted payload or copy/hash its large cached body on each write.
    state.commit_session_state();
    assert!(!payload.exists());
    assert_eq!(
        load_session_state(&metadata)
            .unwrap()
            .imported_context_snapshot,
        Some(before)
    );
    assert!(
        AppState::new(root.path())
            .resume_from_history(&state.history_path().unwrap())
            .is_err()
    );
}

#[test]
fn scoped_instruction_envelope_roundtrips_private_payload_and_snapshot_export_without_touching_v1()
{
    use kcoder_types::imported_instructions::ImportedInstructionSession;
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    let mut expected = snapshot(Some("LEGACY_AFTER_NATIVE".into()));
    expected.version = 2;
    expected.instructions = Some(Box::new(ImportedInstructionSession {
        version: 1,
        before_native: Some("SOURCE_ANCESTOR_BEFORE_NATIVE".into()),
        native_context: Some("NATIVE_GUIDE_CAPTURED_ONCE".into()),
        deferred: Vec::new(),
    }));
    state
        .freeze_imported_context_snapshot(expected.clone())
        .unwrap();
    let history = state.history_path().unwrap();
    let restored = AppState::new(root.path());
    restored.resume_from_history(&history).unwrap();
    assert_eq!(restored.imported_context_snapshot(), Some(expected.clone()));
    let exported = root.path().join("owned-export.json");
    state.export_snapshot(&exported).unwrap();
    let fork = AppState::new(root.path());
    fork.import_snapshot(&exported).unwrap();
    assert_eq!(fork.imported_context_snapshot(), Some(expected));
    let original = snapshot(Some("OLD_PRIVATE_BYTES".into()));
    let reference = SnapshotReference::new(&original, "legacy");
    assert_eq!(reference.version, 1);
    assert_eq!(payload(&original), b"OLD_PRIVATE_BYTES");
    assert!(
        !serde_json::to_string(&original)
            .unwrap()
            .contains("instructions")
    );
}

#[test]
fn instruction_envelope_encoding_stops_at_the_real_escaped_byte_budget() {
    use kcoder_types::imported_instructions::ImportedInstructionSession;
    let mut value = snapshot(None);
    value.version = 2;
    value.instructions = Some(Box::new(ImportedInstructionSession {
        version: 1,
        before_native: Some("\u{0001}".repeat(1024)),
        native_context: None,
        deferred: Vec::new(),
    }));
    assert!(
        try_payload(&value, 2048).is_err(),
        "a short raw string can exceed the complete escaped private envelope limit"
    );
    assert!(try_payload(&value, 8192).is_ok());
    assert_eq!(
        try_payload(&snapshot(Some("old raw bytes".into())), 13).unwrap(),
        b"old raw bytes"
    );
}
