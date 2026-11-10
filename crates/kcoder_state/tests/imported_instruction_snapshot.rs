//! Actual child-process restoration of the private v2 instruction envelope; no provider or source access.
use kcoder_state::AppState;
use kcoder_types::{
    Message,
    imported_context_snapshot::{ImportedContextSnapshot, ImportedContextSnapshotSource},
    imported_instructions::ImportedInstructionSession,
};
use std::{path::PathBuf, process::Command};
fn expected() -> ImportedContextSnapshot {
    ImportedContextSnapshot {
        version: 2,
        profile_identity: "a".repeat(64),
        source: ImportedContextSnapshotSource::Captured,
        content: Some("OLD_AFTER_NATIVE".into()),
        instructions: Some(Box::new(ImportedInstructionSession {
            version: 1,
            before_native: Some("FIXED_SOURCE_ANCESTOR".into()),
            native_context: Some("FIXED_NATIVE_BOUNDARY".into()),
            deferred: Vec::new(),
        })),
    }
}
#[test]
fn scoped_instruction_snapshot_survives_real_process_reopen_and_fork_export() {
    let root = tempfile::tempdir().unwrap();
    let parent = AppState::new(root.path());
    let history = root.path().join(format!("{}.jsonl", parent.session_id()));
    parent.with_history_path(&history);
    parent.add_message(Message::user_text("owned task"));
    parent.save_history().unwrap();
    parent.freeze_imported_context_snapshot(expected()).unwrap();
    let fork = AppState::new(root.path());
    fork.inherit_imported_context_snapshot(&parent).unwrap();
    assert_eq!(fork.imported_context_snapshot(), Some(expected()));
    let export = root.path().join("fork.json");
    fork.export_snapshot(&export).unwrap();
    drop(parent);
    drop(fork);
    let result = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "instruction_snapshot_child_process",
            "--nocapture",
        ])
        .env("KCODER_INSTRUCTION_TEST_ROOT", root.path())
        .env("KCODER_INSTRUCTION_TEST_HISTORY", &history)
        .env("KCODER_INSTRUCTION_TEST_EXPORT", &export)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "owned snapshot probe failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("INSTRUCTION_PAYLOAD_REOPENED"));
}
#[test]
#[ignore = "helper invoked only by the owned parent test"]
fn instruction_snapshot_child_process() {
    let root = PathBuf::from(std::env::var_os("KCODER_INSTRUCTION_TEST_ROOT").unwrap());
    let history = PathBuf::from(std::env::var_os("KCODER_INSTRUCTION_TEST_HISTORY").unwrap());
    let export = PathBuf::from(std::env::var_os("KCODER_INSTRUCTION_TEST_EXPORT").unwrap());
    assert!(history.starts_with(&root) && export.starts_with(&root));
    let state = AppState::new(&root);
    state.resume_from_history(&history).unwrap();
    assert_eq!(state.imported_context_snapshot(), Some(expected()));
    let fork = AppState::new(&root);
    fork.import_snapshot(&export).unwrap();
    assert_eq!(fork.imported_context_snapshot(), Some(expected()));
    println!("INSTRUCTION_PAYLOAD_REOPENED");
}
