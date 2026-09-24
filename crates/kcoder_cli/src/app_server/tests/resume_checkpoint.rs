#[test]
fn persisted_resume_typed_checkpoint_is_used_by_the_real_cli_preflight() {
    use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let path = workspace
        .path()
        .join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&path);
    engine
        .state
        .add_message(kcoder_types::Message::user_text("real user"));
    engine.state.add_message(kcoder_types::Message::runtime_text(
        "[system] internal context",
    ));
    engine.state.save_history().unwrap();
    JournalFence::try_acquire(workspace.path(), JournalDomain::History)
        .unwrap()
        .activate()
        .unwrap();
    let (first, lease, count) =
        prepare_persisted_thread_resume(&engine, &engine.session_id()).unwrap();
    assert_eq!(count, 1);
    let visible = first.load_transcript_messages().unwrap();
    drop(lease);
    assert!(workspace.path().join(".kcoder-resume-checkpoints").is_dir());
    let original = std::fs::read(&path).unwrap();
    // External same-size edits are outside an explicitly activated journal epoch. Withhold
    // readable prefix bytes to prove this call is the typed checkpoint path, not full replay.
    std::fs::write(&path, vec![0xff; original.len()]).unwrap();
    let second = prepare_persisted_thread_resume(&engine, &engine.session_id());
    std::fs::write(&path, &original).unwrap();
    let (second, lease, count) = second.unwrap();
    assert_eq!(count, 1);
    assert_eq!(second.load_transcript_messages().unwrap(), visible);
    let resumed = kcoder_state::AppState::new(workspace.path());
    resumed.apply_prepared_session_resume(second).unwrap();
    assert_eq!(resumed.messages(), visible);
    assert_eq!(resumed.session_id(), engine.session_id());
    drop(lease);
}

#[test]
fn persisted_resume_without_tracking_still_reads_authority_and_never_creates_checkpoint() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let path = workspace
        .path()
        .join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&path);
    engine
        .state
        .add_message(kcoder_types::Message::user_text("ordinary resume"));
    engine.state.save_history().unwrap();
    let (_, lease, count) = prepare_persisted_thread_resume(&engine, &engine.session_id()).unwrap();
    assert_eq!(count, 1);
    drop(lease);
    assert!(!workspace.path().join(".kcoder-resume-checkpoints").exists());
    let original = std::fs::read(&path).unwrap();
    std::fs::write(&path, vec![0xff; original.len()]).unwrap();
    let result = prepare_persisted_thread_resume(&engine, &engine.session_id());
    std::fs::write(&path, original).unwrap();
    assert!(result.is_err());
}
