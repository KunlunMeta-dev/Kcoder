use super::*;
use crate::session_persistence::{parse_session_state, prepare_session_state_write};

#[test]
fn historical_fixture_upgrades_once_without_changing_delivery_ids_on_reopen() {
    let path = Path::new("fixture.state.json");
    let source = include_str!("fixtures/v0001.json");
    let mut state = parse_session_state(path, source).unwrap();
    assert_eq!(state.schema_version, 1);
    upgrade_for_resume(&mut state, path).unwrap();
    let task = &state.tasks["legacy-agent"];
    assert_eq!(task.output.as_deref(), Some("saved result"));
    assert!(task.pending_messages.is_empty());
    assert_eq!(task.message_queue.len(), 2);
    let once = serde_json::to_value(&state).unwrap();
    let mut reopened = parse_session_state(path, &once.to_string()).unwrap();
    upgrade_for_resume(&mut reopened, path).unwrap();
    assert_eq!(serde_json::to_value(reopened).unwrap(), once);
}

#[test]
fn newer_or_corrupt_stored_state_cannot_be_overwritten_as_a_migration() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("session.state.json");
    for bytes in [
        r#"{"schema_version":3}"#,
        r#"{"schema_version":0}"#,
        r#"{"schema_version":2,"delivery_format":"future"}"#,
        "{corrupt",
    ] {
        std::fs::write(&path, bytes).unwrap();
        assert!(prepare_session_state_write(&path, &PersistedSessionState::default()).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), bytes);
        assert!(!path.with_extension("pre-reliable-delivery.bak").exists());
    }
}
