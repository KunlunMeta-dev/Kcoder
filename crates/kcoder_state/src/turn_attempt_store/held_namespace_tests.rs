use super::*;
use std::sync::Arc;

fn accepted(name: &str) -> TurnAttemptRecord {
    TurnAttemptRecord {
        version: 1,
        client_presentation: None,
        identity: TurnAttemptIdentity {
            thread_id: "session".into(),
            turn_id: name.into(),
            attempt_id: name.into(),
        },
        parent_attempt_id: None,
        retry_operation_id: None,
        accepted_at_ms: 100,
        input_context_hash: "a".repeat(64),
        request_fingerprint: None,
        retained_input: None,
        status: TurnAttemptStatus::Accepted,
        completion: None,
    }
}
fn terminal() -> TurnAttemptCompletion {
    TurnAttemptCompletion {
        status: TurnAttemptStatus::Completed,
        finished_at_ms: 101,
        error: None,
        provider_failure: None,
        partial_output: String::new(),
        partial_output_truncated: false,
        committed_history_uuid: None,
    }
}

#[test]
fn held_attempt_session_child_does_not_follow_a_completed_decoy_during_aba() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let session = temp.path().join("session");
    let writer = TurnAttemptStore::open(&session, "session")?;
    writer.begin(accepted("actual-unsettled"))?;
    let child = Arc::new(PrivateDirectory::open_existing(&session)?);
    let original = child.directory_identity()?;
    let held = TurnAttemptStore::open_existing_in(child.clone(), "session")?.unwrap();
    let decoy_path = temp.path().join("decoy/session");
    let decoy = TurnAttemptStore::open(&decoy_path, "session")?;
    let old = accepted("old-completed");
    decoy.begin(old.clone())?;
    decoy.finish(&old.identity, terminal())?;
    let saved = temp.path().join("original-held");
    std::fs::rename(&session, &saved)?;
    std::fs::rename(&decoy_path, &session)?;
    let observed = held.list_with_budget(8, 64 * 1024)?;
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0].status, TurnAttemptStatus::Accepted);
    assert_ne!(
        PrivateDirectory::open_existing(&session)?.directory_identity()?,
        original
    );
    std::fs::rename(&session, &decoy_path)?;
    std::fs::rename(&saved, &session)?;
    assert_eq!(
        PrivateDirectory::open_existing(&session)?.directory_identity()?,
        original
    );
    assert_eq!(
        held.list_with_budget(8, 64 * 1024)?[0].status,
        TurnAttemptStatus::Accepted
    );
    Ok(())
}

#[test]
fn held_attempt_directory_rejects_a_nested_completed_decoy() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let session = temp.path().join("session");
    let writer = TurnAttemptStore::open(&session, "session")?;
    writer.begin(accepted("actual-unsettled"))?;
    let child = Arc::new(PrivateDirectory::open_existing(&session)?);
    let held = TurnAttemptStore::open_existing_in(child, "session")?.unwrap();
    let decoy_path = temp.path().join("decoy/session");
    let decoy = TurnAttemptStore::open(&decoy_path, "session")?;
    let old = accepted("old-completed");
    decoy.begin(old.clone())?;
    decoy.finish(&old.identity, terminal())?;
    let attempts = session.join("turn-attempts");
    let saved = session.join("original-attempts");
    std::fs::rename(&attempts, &saved)?;
    std::fs::rename(decoy_path.join("turn-attempts"), &attempts)?;
    assert!(held.list_with_budget(8, 64 * 1024).is_err());
    std::fs::rename(&attempts, decoy_path.join("turn-attempts"))?;
    std::fs::rename(&saved, &attempts)?;
    assert_eq!(
        held.list_with_budget(8, 64 * 1024)?[0].status,
        TurnAttemptStatus::Accepted
    );
    Ok(())
}

#[test]
fn observation_budget_is_typed_and_does_not_hide_corruption() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let session = temp.path().join("session");
    let store = TurnAttemptStore::open(&session, "session")?;
    store.begin(accepted("first"))?;
    store.begin(accepted("second"))?;
    let exhausted = store.list_with_budget(1, 64 * 1024).unwrap_err();
    assert!(TurnAttemptStore::is_observation_budget_exhausted(
        &exhausted
    ));
    assert!(exhausted.to_string().contains("record budget"));
    let bytes_exhausted = store.list_with_budget(8, 1).unwrap_err();
    assert!(TurnAttemptStore::is_observation_budget_exhausted(
        &bytes_exhausted
    ));
    assert!(bytes_exhausted.to_string().contains("byte budget"));
    let file = session
        .join("turn-attempts")
        .join(leaf(&accepted("first").identity, "attempt"));
    std::fs::write(file, b"{broken")?;
    let corrupted = store.list_with_budget(8, 64 * 1024).unwrap_err();
    assert!(!TurnAttemptStore::is_observation_budget_exhausted(
        &corrupted
    ));
    Ok(())
}
