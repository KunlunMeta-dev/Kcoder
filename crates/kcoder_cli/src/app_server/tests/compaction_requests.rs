#[tokio::test]
async fn compact_rechecks_running_after_waiting_for_the_activity_gate() {
    let tmp = tempfile::tempdir().unwrap();
    let runtime =
        thread_runtime::test_support::test_runtime("compact", &tmp.path().join("history.jsonl"));
    let engine = runtime.engine();
    engine
        .state
        .with_history_path(tmp.path().join("history.jsonl"));
    engine
        .state
        .add_message(kcoder_types::Message::user_text("request"));
    engine
        .state
        .add_message(kcoder_types::Message::assistant_text("response"));
    let before = engine.state.messages();
    let thread_id = engine.session_id();
    let mut manager = ThreadManager::with_resident_limit(1);
    assert!(manager.insert(runtime).is_ok());
    let turn_state = manager.turn_state(&thread_id).unwrap();
    let gate = turn_state.activity_gate.lock().await;
    let (tx, mut rx) = mpsc::channel(4);
    let compact = thread_rewind_requests::dispatch(
        method::THREAD_COMPACT,
        json!(1),
        json!({"threadId": thread_id}),
        &tx,
        &mut manager,
    );
    tokio::pin!(compact);
    assert!(
        futures::poll!(&mut compact).is_pending(),
        "compact must wait for the owner gate"
    );
    turn_state.running.store(true, Ordering::SeqCst);
    drop(gate);
    compact.await.unwrap();
    let response = rx.recv().await.unwrap();
    assert_eq!(response["error"]["code"], -32030, "{response}");
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("turn is running")
    );
    assert_eq!(engine.state.messages(), before);
}
