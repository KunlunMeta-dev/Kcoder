use kcoder_config::PrivateDirectory;
use kcoder_state::{AppState, historical_undo::*};
use kcoder_types::{Message, historical_context::*, historical_undo::HistoricalUndoSealReceipt};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
struct Fixture {
    _root: tempfile::TempDir,
    artifacts: PathBuf,
    state: AppState,
    binding: HistoricalSessionSeedBinding,
    seal: HistoricalUndoSealReceipt,
}
fn binding(state: &AppState, message: &Message) -> HistoricalSessionSeedBinding {
    HistoricalSessionSeedBinding {
        operation_id: uuid::Uuid::new_v4().to_string(),
        session_id: state.session_id(),
        source_job_id: uuid::Uuid::new_v4().to_string(),
        view_id: "v".repeat(64),
        model_snapshot_sha256: "a".repeat(64),
        projection_sha256: format!("{:x}", Sha256::digest(serde_json::to_vec(message).unwrap())),
        preparation: PreparedContextReceipt {
            preparation_id: uuid::Uuid::new_v4().to_string(),
            document_sha256: "b".repeat(64),
            binding_sha256: "c".repeat(64),
            attachments: 0,
            attachment_bytes: 0,
        },
    }
}
fn artifact(root: &Path, session: &str) -> PathBuf {
    let directory = root.join(session).join("attachments");
    PrivateDirectory::open_or_create(&directory).unwrap();
    let path = directory.join("fixture.txt");
    fs::write(&path, b"initial owned attachment").unwrap();
    path
}
fn make_fixture() -> Fixture {
    make_fixture_with_attachments(0)
}
fn make_fixture_with_attachments(additional: usize) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let history = root.path().join("history");
    let artifacts = root.path().join("client");
    PrivateDirectory::open_or_create(&history).unwrap();
    PrivateDirectory::open_or_create(&artifacts).unwrap();
    let state = AppState::new(root.path());
    state.set_short_id_registry(&root.path().join("ids"));
    state.start_new_session().unwrap();
    state.with_history_path(history.join(format!("{}.jsonl", state.session_id())));
    artifact(&artifacts, &state.session_id());
    for index in 0..additional {
        fs::write(
            artifacts
                .join(state.session_id())
                .join("attachments")
                .join(format!("{index:04}-{}.txt", "a".repeat(220))),
            b"owned",
        )
        .unwrap();
    }
    let message = Message::runtime_text("imported facts, no user request");
    let binding = binding(&state, &message);
    let lease = HistoricalUndoLease::try_acquire(
        &state.history_path().unwrap(),
        &artifacts,
        &state.session_id(),
    )
    .unwrap();
    state
        .publish_historical_seed(binding.clone(), message)
        .unwrap();
    let seal = seal_historical_session(&lease, &binding, |_| true).unwrap();
    drop(lease);
    Fixture {
        _root: root,
        artifacts,
        state,
        binding,
        seal,
    }
}

#[test]
fn a_full_supported_attachment_batch_fits_the_metadata_budget() {
    let fixture = make_fixture_with_attachments(255);
    preview_historical_session_undo(&acquire(&fixture), &fixture.binding, &fixture.seal, |_| {
        true
    })
    .unwrap();
    let seal = fs::metadata(control(&fixture).join("historical-undo.seal.json")).unwrap();
    assert!(seal.len() < 1024 * 1024);
}
fn acquire(fixture: &Fixture) -> HistoricalUndoLease {
    HistoricalUndoLease::try_acquire(
        &fixture.state.history_path().unwrap(),
        &fixture.artifacts,
        &fixture.state.session_id(),
    )
    .unwrap()
}
fn control(fixture: &Fixture) -> PathBuf {
    fixture.state.history_path().unwrap().with_extension("hctl")
}

#[test]
fn unchanged_owned_session_is_retired_once_and_all_attachments_audit_and_sources_stay() {
    let fixture = make_fixture();
    let path = fixture.state.history_path().unwrap();
    let original2 = fs::read(&path).unwrap();
    let payload = fixture
        .artifacts
        .join(fixture.state.session_id())
        .join("attachments/fixture.txt");
    let lease = acquire(&fixture);
    let operation = uuid::Uuid::new_v4().to_string();
    preview_historical_session_undo(&lease, &fixture.binding, &fixture.seal, |_| true).unwrap();
    let receipt =
        undo_historical_session(&lease, &fixture.binding, &fixture.seal, &operation, |_| {
            true
        })
        .unwrap();
    assert!(!path.exists());
    assert!(payload.exists());
    assert_eq!(fs::read(&payload).unwrap(), b"initial owned attachment");
    assert!(control(&fixture).join("historical-undo.seal.json").exists());
    assert!(
        path.parent()
            .unwrap()
            .join(format!(
                ".{}.history-undo-{operation}.bin",
                fixture.state.session_id()
            ))
            .exists()
    );
    assert_eq!(
        fs::read(path.parent().unwrap().join(format!(
            ".{}.history-undo-{operation}.bin",
            fixture.state.session_id()
        )))
        .unwrap(),
        original2
    );
    assert!(
        read_historical_session_undo(&lease, &fixture.seal, &operation).unwrap()
            == Some(receipt.clone())
    );
    assert!(
        undo_historical_session(&lease, &fixture.binding, &fixture.seal, &operation, |_| {
            false
        })
        .unwrap()
            == receipt
    );
    assert!(fixture.state.save_history().is_err());
    assert!(!path.exists());
}

#[tokio::test]
async fn a_real_later_user_message_and_even_equal_byte_history_replacement_block_undo() {
    let fixture = make_fixture();
    let path = fixture.state.history_path().unwrap();
    fixture
        .state
        .add_message(Message::user_text("new native work"));
    fixture.state.flush_history().await.unwrap();
    let before = fs::read(&path).unwrap();
    assert!(
        undo_historical_session(
            &acquire(&fixture),
            &fixture.binding,
            &fixture.seal,
            &uuid::Uuid::new_v4().to_string(),
            |_| true
        )
        .is_err()
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    drop(fixture);
    let fixture = make_fixture();
    let path = fixture.state.history_path().unwrap();
    let initial = fs::read(&path).unwrap();
    fixture.state.save_history().unwrap();
    fs::write(&path, &initial).unwrap();
    let error = preview_historical_session_undo(
        &acquire(&fixture),
        &fixture.binding,
        &fixture.seal,
        |_| true,
    )
    .err()
    .unwrap();
    assert!(error.to_string().contains("generation_changed"));
    assert_eq!(fs::read(&path).unwrap(), initial);
}

#[test]
fn metadata_goals_added_artifacts_and_identical_replaced_files_are_user_owned() {
    for change in 0..4 {
        let fixture = make_fixture();
        let path = fixture.state.history_path().unwrap();
        let before = fs::read(&path).unwrap();
        let attachment = fixture
            .artifacts
            .join(fixture.state.session_id())
            .join("attachments/fixture.txt");
        match change {
            0 => {
                fixture.state.set_goal("later user goal", None);
            }
            1 => {
                fs::write(
                    attachment.parent().unwrap().join("new-note.txt"),
                    b"user data",
                )
                .unwrap();
            }
            2 => {
                let old = fixture.artifacts.join("saved-original.txt");
                fs::rename(&attachment, &old).unwrap();
                fs::write(&attachment, b"initial owned attachment").unwrap();
            }
            _ => {
                fs::write(&attachment, b"user edited attachment").unwrap();
            }
        }
        assert!(
            undo_historical_session(
                &acquire(&fixture),
                &fixture.binding,
                &fixture.seal,
                &uuid::Uuid::new_v4().to_string(),
                |_| true
            )
            .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(attachment.exists());
    }
}

#[test]
fn publication_lease_and_metadata_lock_cannot_be_bypassed_or_replaced() {
    use fs2::FileExt;
    let fixture = make_fixture();
    let path = fixture.state.history_path().unwrap();
    let lease = acquire(&fixture);
    assert!(
        HistoricalUndoLease::try_acquire(&path, &fixture.artifacts, &fixture.state.session_id())
            .is_err()
    );
    drop(lease);
    let metadata = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(
            fixture
                .artifacts
                .join(LIFECYCLE_LOCK_DIRECTORY)
                .join(format!("{}.lock", fixture.state.session_id())),
        )
        .unwrap();
    metadata.try_lock_exclusive().unwrap();
    assert!(
        HistoricalUndoLease::try_acquire(&path, &fixture.artifacts, &fixture.state.session_id())
            .is_err()
    );
    drop(metadata);
    let lease = acquire(&fixture);
    let lock = path.with_extension("lease");
    fs::rename(&lock, lock.with_extension("previous-lock")).unwrap();
    fs::write(&lock, b"").unwrap();
    assert!(
        lease
            .verify(&path, &fixture.artifacts, &fixture.state.session_id())
            .is_err()
    );
    assert!(path.exists());
    drop(lease);
    let replacement = HistoricalUndoLease::try_acquire_existing(
        &path,
        &fixture.artifacts,
        &fixture.state.session_id(),
    )
    .unwrap();
    assert!(
        preview_historical_session_undo(&replacement, &fixture.binding, &fixture.seal, |_| true)
            .is_err()
    );
}

#[test]
fn an_old_unsealed_session_is_never_adopted_and_cancelled_checks_leave_it_active() {
    let fixture = make_fixture();
    let path = fixture.state.history_path().unwrap();
    let lease = acquire(&fixture);
    assert!(
        preview_historical_session_undo(&lease, &fixture.binding, &fixture.seal, |_| false)
            .is_err()
    );
    assert!(path.exists());
    fs::remove_file(control(&fixture).join("historical-undo.seal.json")).unwrap();
    assert!(seal_historical_session(&lease, &fixture.binding, |_| true).is_err());
    assert!(path.exists());
}

#[test]
fn a_lost_undo_receipt_and_pre_rename_crash_reconcile_only_this_owned_intent() {
    let fixture = make_fixture();
    let lease = acquire(&fixture);
    let path = fixture.state.history_path().unwrap();
    let operation = uuid::Uuid::new_v4().to_string();
    let receipt =
        undo_historical_session(&lease, &fixture.binding, &fixture.seal, &operation, |_| {
            true
        })
        .unwrap();
    let retained = path.parent().unwrap().join(format!(
        ".{}.history-undo-{operation}.bin",
        fixture.state.session_id()
    ));
    fs::remove_file(control(&fixture).join(format!("historical-undo-{operation}.receipt.json")))
        .unwrap();
    fs::rename(&retained, &path).unwrap();
    assert!(
        read_historical_session_undo(&lease, &fixture.seal, &operation)
            .unwrap()
            .is_none()
    );
    assert!(path.exists());
    let different = uuid::Uuid::new_v4().to_string();
    assert!(
        undo_historical_session(&lease, &fixture.binding, &fixture.seal, &different, |_| {
            true
        })
        .is_err()
    );
    assert!(path.exists());
    let recovered =
        undo_historical_session(&lease, &fixture.binding, &fixture.seal, &operation, |_| {
            true
        })
        .unwrap();
    assert!(recovered == receipt);
    assert!(!path.exists());
    assert!(retained.exists());
}
