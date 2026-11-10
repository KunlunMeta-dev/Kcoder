use super::*;
use kcoder_permissions::{PermissionPrompt, PermissionRequestContext};

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

#[tokio::test]
async fn explicit_local_origin_permission_uses_a_real_tui_response_channel() {
    let (tx, mut rx) = mpsc::channel(1);
    let prompt = crate::events::TuiPermissionPrompt::new(AppEventSender::new(tx));
    let request = PermissionRequestContext {
        tool_name: "WebFetch".into(),
        description: "Read one approved local origin".into(),
        input: serde_json::json!({"url":"http://127.0.0.1:1234","prompt":"read"}),
        risk: PermissionRisk::High,
        detail_lines: vec!["Origin: http://127.0.0.1:1234".into()],
    };
    let task = tokio::spawn(async move { prompt.ask_explicit_context_with_edit(&request).await });
    let AppEvent::PermissionRequest {
        response_tx,
        tool_name,
        ..
    } = rx.recv().await.unwrap()
    else {
        panic!("explicit permission must reach the TUI event loop");
    };
    assert_eq!(tool_name, "WebFetch");
    assert!(!task.is_finished());
    response_tx
        .send(PermissionDialogResult {
            response: PermissionResponse::DenyOnce,
            modified_input: None,
        })
        .unwrap();
    assert_eq!(task.await.unwrap().response, PermissionResponse::DenyOnce);
}
