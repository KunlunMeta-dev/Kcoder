use super::*;

#[test]
fn classifies_must_deliver_coalescible_and_droppable_events() {
    assert_eq!(
        app_event_backpressure(&AppEvent::Terminal(CEvent::FocusGained)),
        AppEventBackpressure::MustDeliver
    );
    assert_eq!(
        app_event_backpressure(&AppEvent::PermissionRequest {
            tool_name: "bash".to_string(),
            description: "Run command".to_string(),
            input: serde_json::json!({ "command": "pwd" }),
            risk: PermissionRisk::Low,
            detail_lines: Vec::new(),
            response_tx: tokio::sync::oneshot::channel().0,
        }),
        AppEventBackpressure::MustDeliver
    );
    assert_eq!(
        app_event_backpressure(&AppEvent::AssistantDelta("chunk".to_string())),
        AppEventBackpressure::Coalescible
    );
    assert_eq!(
        app_event_backpressure(&AppEvent::FrameTick),
        AppEventBackpressure::Coalescible
    );
    assert_eq!(
        app_event_backpressure(&AppEvent::ToolInputProgress {
            name: "write".to_string(),
            chars: 0,
        }),
        AppEventBackpressure::MustDeliver
    );
    assert_eq!(
        app_event_backpressure(&AppEvent::ToolInputProgress {
            name: "write".to_string(),
            chars: 128,
        }),
        AppEventBackpressure::Droppable
    );
    assert_eq!(
        app_event_backpressure(&AppEvent::SubagentSteerApplied {
            id: "agent-1".to_string(),
            message_id: "msg-1".to_string(),
            queue_depth: 0,
        }),
        AppEventBackpressure::MustDeliver
    );
}

#[test]
fn drops_droppable_event_when_bounded_channel_is_full() {
    let (tx, mut rx) = mpsc::channel(1);
    let tx = AppEventSender::new(tx);

    assert!(tx.send(AppEvent::SystemNotice("first".to_string())));
    assert!(tx.send(AppEvent::ToolInputProgress {
        name: "write".to_string(),
        chars: 128,
    }));

    assert!(matches!(
        rx.try_recv(),
        Ok(AppEvent::SystemNotice(text)) if text == "first"
    ));
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn ordered_send_waits_for_capacity_when_channel_is_full() {
    let (tx, mut rx) = mpsc::channel(1);
    let tx = AppEventSender::new(tx);

    assert!(tx.send(AppEvent::SystemNotice("first".to_string())));
    let send_task = tokio::spawn({
        let tx = tx.clone();
        async move {
            tx.send_ordered(AppEvent::Terminal(CEvent::FocusGained))
                .await
        }
    });

    assert!(matches!(
        rx.recv().await,
        Some(AppEvent::SystemNotice(text)) if text == "first"
    ));
    let delivered = tokio::time::timeout(Duration::from_secs(1), send_task)
        .await
        .expect("send task timed out")
        .expect("send task panicked");
    assert!(delivered);
    assert!(matches!(
        rx.recv().await,
        Some(AppEvent::Terminal(CEvent::FocusGained))
    ));
}
