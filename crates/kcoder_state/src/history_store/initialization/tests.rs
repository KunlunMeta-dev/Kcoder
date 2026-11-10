use super::*;
use crate::AppState;
use kcoder_types::{Message, historical_context::*};
use sha2::{Digest, Sha256};
fn sample() -> (
    tempfile::TempDir,
    AppState,
    HistoricalSessionSeedBinding,
    Message,
) {
    let root = tempfile::tempdir().unwrap();
    let state = AppState::new(root.path());
    state.with_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    let message = Message::runtime_text("historical inert facts");
    let binding = HistoricalSessionSeedBinding {
        operation_id: uuid::Uuid::new_v4().to_string(),
        session_id: state.session_id(),
        source_job_id: uuid::Uuid::new_v4().to_string(),
        view_id: "view".into(),
        model_snapshot_sha256: "a".repeat(64),
        projection_sha256: format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&message).unwrap())
        ),
        preparation: PreparedContextReceipt {
            preparation_id: uuid::Uuid::new_v4().to_string(),
            document_sha256: "b".repeat(64),
            binding_sha256: "c".repeat(64),
            attachments: 0,
            attachment_bytes: 0,
        },
    };
    (root, state, binding, message)
}
#[test]
fn authority_without_a_commit_receipt_is_reconciled_without_rewriting_or_replaying() {
    let (root, state, binding, message) = sample();
    let path = state.history_path().unwrap();
    let cut = commit::install_cut(&path, commit::CommitStage::AfterAuthority, false);
    assert!(
        state
            .publish_historical_seed(binding.clone(), message.clone())
            .is_err()
    );
    assert!(path.exists());
    assert_eq!(state.message_count(), 0);
    let before = fs::read(&path).unwrap();
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    drop(cut);
    state
        .publish_historical_seed(binding, message.clone())
        .unwrap();
    assert_eq!(state.messages(), [message]);
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
    assert!(
        root.path()
            .join(state.session_id())
            .join("historical-seed.receipt.json")
            .exists()
    );
}
#[test]
fn a_pending_intent_without_authority_is_not_blindly_replayed() {
    let (root, state, binding, message) = sample();
    let path = state.history_path().unwrap();
    let cut = commit::install_cut(&path, commit::CommitStage::AfterPending, false);
    assert!(
        state
            .publish_historical_seed(binding.clone(), message.clone())
            .is_err()
    );
    assert!(!path.exists());
    drop(cut);
    assert!(state.publish_historical_seed(binding, message).is_err());
    assert!(!path.exists());
    assert_eq!(state.message_count(), 0);
    assert!(
        !root
            .path()
            .join(state.session_id())
            .join("historical-seed.receipt.json")
            .exists()
    );
}
#[test]
fn identical_bytes_in_a_replaced_generation_do_not_confer_seed_authority() {
    let (_root, state, binding, message) = sample();
    state
        .publish_historical_seed(binding.clone(), message.clone())
        .unwrap();
    let path = state.history_path().unwrap();
    let before = fs::read(&path).unwrap();
    let source = crate::require_history_source(&state.read_inner())
        .unwrap()
        .clone();
    source.replace(&before).unwrap();
    assert!(state.publish_historical_seed(binding, message).is_err());
    assert_eq!(fs::read(path).unwrap(), before);
}
#[test]
fn initialization_refuses_existing_authority_even_when_requested_bytes_are_identical() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("fresh.jsonl");
    fs::write(&path, b"existing\n").unwrap();
    let source = HistorySource::bind(&path).unwrap();
    assert!(
        source
            .initialize(b"existing\n", uuid::Uuid::new_v4())
            .is_err()
    );
    assert_eq!(fs::read(path).unwrap(), b"existing\n");
}
