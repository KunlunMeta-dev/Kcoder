use kcoder_state::AppState;
use kcoder_types::{ContentBlock, Message, historical_context::*};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn binding(state: &AppState, message: &Message) -> HistoricalSessionSeedBinding {
    HistoricalSessionSeedBinding {
        operation_id: uuid::Uuid::new_v4().to_string(),
        session_id: state.session_id(),
        source_job_id: uuid::Uuid::new_v4().to_string(),
        view_id: "v".repeat(64),
        model_snapshot_sha256: "a".repeat(64),
        projection_sha256: digest(&serde_json::to_vec(message).unwrap()),
        preparation: PreparedContextReceipt {
            preparation_id: uuid::Uuid::new_v4().to_string(),
            document_sha256: "b".repeat(64),
            binding_sha256: "c".repeat(64),
            attachments: 0,
            attachment_bytes: 0,
        },
    }
}
fn new_state(root: &Path) -> AppState {
    let state = AppState::new(root);
    state.with_history_path(root.join(format!("{}.jsonl", state.session_id())));
    state
}
#[test]
fn presentation_provenance_survives_context_replacement_without_claiming_the_old_seed_is_current() {
    let root = tempfile::tempdir().unwrap();
    let state = new_state(root.path());
    let message = Message::runtime_text("historical evidence");
    let binding = binding(&state, &message);
    state
        .publish_historical_seed(binding.clone(), message)
        .unwrap();
    let path = state.history_path().unwrap();
    state.set_messages(vec![Message::user_text("current compacted history")]);
    state.save_history().unwrap();
    let before = fs::read(&path).unwrap();
    assert!(state.historical_seed_receipt().is_err());
    let origin = AppState::historical_source_for_path(&path, &state.session_id())
        .unwrap()
        .unwrap();
    assert_eq!(origin.operation_id, binding.operation_id);
    assert_eq!(origin.source_job_id, binding.source_job_id);
    assert_eq!(origin.view_id, binding.view_id);
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn presentation_provenance_is_read_only_and_cannot_be_copied_to_another_session() {
    let root = tempfile::tempdir().unwrap();
    let ordinary = new_state(root.path());
    ordinary.add_message(Message::user_text("ordinary thread"));
    let files = fs::read_dir(root.path()).unwrap().count();
    assert!(
        AppState::historical_source_for_path(
            &ordinary.history_path().unwrap(),
            &ordinary.session_id()
        )
        .unwrap()
        .is_none()
    );
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), files);
    let imported = new_state(root.path());
    let message = Message::runtime_text("historical facts");
    imported
        .publish_historical_seed(binding(&imported, &message), message)
        .unwrap();
    let from = root.path().join(imported.session_id());
    let to = root.path().join(ordinary.session_id());
    kcoder_config::PrivateDirectory::open_existing(root.path())
        .unwrap()
        .open_child(std::ffi::OsStr::new(&ordinary.session_id()), true)
        .unwrap();
    for file in [
        "historical-seed.intent.json",
        "historical-seed.receipt.json",
    ] {
        fs::copy(from.join(file), to.join(file)).unwrap();
    }
    assert_eq!(
        AppState::historical_source_for_path(
            &ordinary.history_path().unwrap(),
            &ordinary.session_id()
        )
        .unwrap_err()
        .to_string(),
        "historical_seed_receipt_changed"
    );
}

#[test]
fn an_initial_runtime_seed_restores_without_a_user_request_task_or_executable_tool() {
    let root = tempfile::tempdir().unwrap();
    let state = new_state(root.path());
    let message = Message::runtime_text(
        r#"Historical evidence only: {"kind":"tool_call_fact","name":"write","text":"old output"}"#,
    );
    let choice = binding(&state, &message);
    assert!(state.historical_seed_receipt().unwrap().is_none());
    let receipt = state
        .publish_historical_seed(choice.clone(), message.clone())
        .unwrap();
    assert_eq!(receipt.binding, choice);
    assert_eq!(
        state.historical_seed_receipt().unwrap(),
        Some(receipt.clone())
    );
    assert_eq!(state.messages(), std::slice::from_ref(&message));
    assert!(state.tasks().is_empty() && state.goal().is_none());
    assert!(!kcoder_types::is_real_user_message(&state.messages()[0]));
    assert!(kcoder_types::public_conversation_message(&state.messages()[0]).is_none());
    let history = state.history_path().unwrap();
    assert_eq!(digest(&fs::read(&history).unwrap()), receipt.history_sha256);
    let restored = AppState::new(root.path());
    assert_eq!(restored.resume_from_history(&history).unwrap(), 1);
    assert_eq!(restored.messages(), [message]);
    assert!(restored.tasks().is_empty() && restored.goal().is_none());
    assert_eq!(restored.historical_seed_receipt().unwrap(), Some(receipt));
}
#[test]
fn a_lost_receipt_can_be_reconciled_without_rewriting_or_replacing_newer_user_work() {
    let root = tempfile::tempdir().unwrap();
    let state = new_state(root.path());
    let message = Message::runtime_text("historical context");
    let choice = binding(&state, &message);
    let receipt = state
        .publish_historical_seed(choice.clone(), message.clone())
        .unwrap();
    let path = state.history_path().unwrap();
    fs::remove_file(
        root.path()
            .join(state.session_id())
            .join("historical-seed.receipt.json"),
    )
    .unwrap();
    assert!(state.historical_seed_receipt().unwrap().is_none());
    assert_eq!(
        AppState::historical_source_for_path(&path, &state.session_id())
            .unwrap_err()
            .to_string(),
        "historical_seed_publication_unconfirmed"
    );
    state.add_message(Message::user_text("new explicit request"));
    let goal = state.set_goal("current work", None);
    let before = fs::read(&path).unwrap();
    assert_eq!(
        state.publish_historical_seed(choice, message).unwrap(),
        receipt
    );
    assert_eq!(fs::read(path).unwrap(), before);
    assert_eq!(state.message_count(), 2);
    assert_eq!(state.goal().unwrap().goal_id, goal.goal_id);
}

#[test]
fn receipt_observation_does_not_create_files_and_rejects_altered_provenance_or_body() {
    let root = tempfile::tempdir().unwrap();
    let state = new_state(root.path());
    let before = fs::read_dir(root.path()).unwrap().count();
    assert!(state.historical_seed_receipt().unwrap().is_none());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), before);
    let message = Message::runtime_text("inert context");
    state
        .publish_historical_seed(binding(&state, &message), message)
        .unwrap();
    let file = state.history_path().unwrap();
    let mut bytes = fs::read(&file).unwrap();
    let at = bytes.iter().position(|byte| *byte == b'i').unwrap();
    bytes[at] = b'j';
    fs::write(&file, &bytes).unwrap();
    assert!(state.historical_seed_receipt().is_err());
}
#[test]
fn existing_histories_and_nonempty_memory_are_never_overwritten() {
    let root = tempfile::tempdir().unwrap();
    let state = new_state(root.path());
    let message = Message::runtime_text("old imported evidence");
    let choice = binding(&state, &message);
    let history = state.history_path().unwrap();
    fs::write(&history, b"user owned history\n").unwrap();
    assert!(state.publish_historical_seed(choice, message).is_err());
    assert_eq!(fs::read(history).unwrap(), b"user owned history\n");
    let other = tempfile::tempdir().unwrap();
    let live = new_state(other.path());
    live.add_message(Message::user_text("already started"));
    let context = Message::runtime_text("old evidence");
    assert!(
        live.publish_historical_seed(binding(&live, &context), context)
            .is_err()
    );
    assert_eq!(live.messages()[0], Message::user_text("already started"));
}
#[test]
fn live_or_source_execution_blocks_and_projection_identity_changes_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let state = new_state(root.path());
    for message in [
        Message::user_text("not a new user request"),
        Message::assistant_text("source output"),
        Message::user_content(vec![ContentBlock::ToolUse {
            id: "old".into(),
            name: "write".into(),
            input: serde_json::json!({}),
        }])
        .with_origin(kcoder_types::MessageOrigin::Runtime),
        Message::user_content(vec![ContentBlock::Thinking {
            thinking: "private".into(),
            signature: "old".into(),
        }])
        .with_origin(kcoder_types::MessageOrigin::Runtime),
    ] {
        assert!(
            state
                .publish_historical_seed(binding(&state, &message), message)
                .is_err()
        );
    }
    assert!(!state.history_path().unwrap().exists());
    let message = Message::runtime_text("historical context");
    let choice = binding(&state, &message);
    state
        .publish_historical_seed(choice.clone(), message.clone())
        .unwrap();
    let before = fs::read(state.history_path().unwrap()).unwrap();
    let mut changed = choice.clone();
    changed.model_snapshot_sha256 = "d".repeat(64);
    assert!(
        state
            .publish_historical_seed(changed, message.clone())
            .is_err()
    );
    assert!(
        state
            .publish_historical_seed(choice, Message::runtime_text("different content"))
            .is_err()
    );
    assert_eq!(fs::read(state.history_path().unwrap()).unwrap(), before);
}

#[test]
fn a_workflow_draft_is_not_repurposed_as_an_imported_conversation() {
    let root = tempfile::tempdir().unwrap();
    let state = new_state(root.path());
    state.enter_workflow_draft_before_first_message().unwrap();
    let message = Message::runtime_text("historical context");
    assert!(
        state
            .publish_historical_seed(binding(&state, &message), message)
            .is_err()
    );
    assert_eq!(state.message_count(), 0);
    assert!(!state.history_path().unwrap().exists());
}
