use super::*;

#[tokio::test]
async fn stale_peer_maintenance_completion_cannot_finish_a_new_foreground_turn() {
    let (raw_tx, mut rx) = mpsc::channel(16);
    let tx = AppEventSender::new(raw_tx);
    let mut app = ReplApp {
        peer_idle_generation: Some(7),
        ..ReplApp::default()
    };
    let task = tokio::spawn(std::future::pending());
    app.begin_turn(task, CancellationToken::new());
    assert_eq!(app.peer_idle_generation, None);
    crate::peer_messages::finish_idle_delivery(&mut app, &tx, 7);
    assert!(
        app.turn_state.is_active(),
        "the old peer completion cannot close the new task"
    );
    assert!(rx.try_recv().is_err());
    if let Some(task) = app.abort_turn_for_shutdown() {
        task.abort();
        let _ = task.await;
    }
}

#[tokio::test]
async fn enqueue_only_maintenance_finish_does_not_manufacture_a_goal_or_model_wake() {
    let (raw_tx, mut rx) = mpsc::channel(16);
    let tx = AppEventSender::new(raw_tx);
    let mut app = ReplApp::default();
    let task = tokio::spawn(async {});
    app.begin_turn(task, CancellationToken::new());
    app.peer_idle_generation = Some(8);
    crate::peer_messages::finish_idle_delivery(&mut app, &tx, 8);
    assert!(!app.turn_state.is_active());
    assert!(
        rx.try_recv().is_err(),
        "peer maintenance alone does not enter the automatic turn scheduler"
    );
}
