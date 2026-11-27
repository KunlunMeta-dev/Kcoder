use kcoder_state::{AppState, OrchestrateRuntimeEvent};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use tempfile::tempdir;

fn event_hash(event: &OrchestrateRuntimeEvent) -> String {
    let mut unsigned = event.clone();
    unsigned.event_sha256.clear();
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&unsigned).unwrap())
    )
}

fn write_events(path: &std::path::Path, events: &[OrchestrateRuntimeEvent]) {
    let mut bytes = Vec::new();
    for event in events {
        serde_json::to_writer(&mut bytes, event).unwrap();
        bytes.push(b'\n');
    }
    fs::write(path, bytes).unwrap();
}

#[test]
fn owned_runtime_journal_recomputes_each_digest_and_rejects_tampering() {
    let temp = tempdir().unwrap();
    let state = AppState::new(temp.path());
    state.with_history_path(temp.path().join("session.jsonl"));
    state.enter_orchestrate_before_first_message().unwrap();

    for sequence in 1..=2 {
        let message_id = format!("synthetic-message-{sequence}");
        state
            .record_orchestrate_runtime_event(
                "message_queued",
                Some("synthetic-work"),
                None,
                Some("synthetic-agent"),
                Some(&message_id),
                json!({ "sequence": sequence }),
            )
            .unwrap();
    }

    let event_path = state
        .session_state_path()
        .unwrap()
        .parent()
        .unwrap()
        .join("runtime-events.jsonl");
    let events = state.read_orchestrate_runtime_events().unwrap();
    assert_eq!(events.len(), 2);

    let mut previous = "genesis".to_string();
    for (index, event) in events.iter().enumerate() {
        assert_eq!(
            event.previous_event_sha256,
            previous,
            "record {} link",
            index + 1
        );
        assert_eq!(
            event_hash(event),
            event.event_sha256,
            "record {} digest",
            index + 1
        );
        previous.clone_from(&event.event_sha256);
    }

    let mut tampered_payload = events.clone();
    tampered_payload[1].metadata["sequence"] = json!(99);
    write_events(&event_path, &tampered_payload);
    let error = state.read_orchestrate_runtime_events().unwrap_err();
    assert!(
        error
            .to_string()
            .contains("runtime event hash mismatch at record 2"),
        "{error:#}"
    );

    let mut tampered_link = events;
    tampered_link[1].previous_event_sha256 = "synthetic-wrong-predecessor".into();
    tampered_link[1].event_sha256 = event_hash(&tampered_link[1]);
    write_events(&event_path, &tampered_link);
    let error = state.read_orchestrate_runtime_events().unwrap_err();
    assert!(
        error
            .to_string()
            .contains("runtime event chain mismatch at record 2"),
        "{error:#}"
    );
}
