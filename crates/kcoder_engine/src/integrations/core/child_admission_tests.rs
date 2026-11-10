//! Cancellation must settle the same Accepted receipt even before first poll.
use super::*;

fn fixture() -> (
    tempfile::TempDir,
    NativeChildAcceptedScope,
    Arc<TurnAttemptStore>,
    TurnAttemptIdentity,
) {
    let directory = tempfile::tempdir().unwrap();
    let state = kcoder_state::AppState::new(directory.path());
    state.with_history_path(directory.path().join("history.jsonl"));
    let identity = TurnAttemptIdentity {
        thread_id: state.session_id(),
        turn_id: "original-turn".into(),
        attempt_id: "original-attempt".into(),
    };
    let session_directory = directory.path().join(&identity.thread_id);
    std::fs::create_dir(&session_directory).unwrap();
    let store = Arc::new(TurnAttemptStore::open(&session_directory, &identity.thread_id).unwrap());
    store
        .begin(TurnAttemptRecord {
            version: 1,
            identity: identity.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: now_ms(),
            input_context_hash: "a".repeat(64),
            request_fingerprint: Some("b".repeat(64)),
            retained_input: None,
            client_presentation: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        })
        .unwrap();
    let scope = NativeChildAcceptedScope {
        scope: state.history_attempt_scope(identity.clone()).unwrap(),
        terminal: ChildCompletion {
            store: store.clone(),
            identity: identity.clone(),
            observer: None,
            finished: false,
        },
    };
    (directory, scope, store, identity)
}
#[test]
fn unpolled_owned_child_future_preserves_original_interrupted_receipt() {
    let (_directory, scope, store, identity) = fixture();
    let future = scope.run(std::future::pending::<Result<()>>());
    drop(future);
    let record = store.load(&identity).unwrap().unwrap();
    assert_eq!(record.status, TurnAttemptStatus::Interrupted);
    assert_eq!(
        record.completion.unwrap().error.as_deref(),
        Some("NATIVE_CHILD_EXECUTION_DROPPED")
    );
}
#[tokio::test]
async fn started_owned_child_cancellation_and_success_have_distinct_receipts() {
    let (_directory, scope, store, identity) = fixture();
    let future = scope.run(std::future::pending::<Result<()>>());
    let mut future = Box::pin(future);
    assert!(futures::poll!(&mut future).is_pending());
    drop(future);
    assert_eq!(
        store.load(&identity).unwrap().unwrap().status,
        TurnAttemptStatus::Interrupted
    );
    let (_directory, scope, store, identity) = fixture();
    scope.run(async { Ok(()) }).await.unwrap();
    assert_eq!(
        store.load(&identity).unwrap().unwrap().status,
        TurnAttemptStatus::Completed
    );
}
