use super::*;
use futures::StreamExt;

async fn original_native_frame(f: &Fixture) -> Result<NativeEngineEventFrame> {
    f.facts
        .engine
        .state
        .add_message(kcoder_types::Message::user_text(
            "owned native event fixture",
        ));
    let scope = f
        .facts
        .engine
        .state
        .history_attempt_scope(f.facts.initial.clone())?;
    scope
        .run(async {
            f.facts
                .engine
                .run_native_turn_stream_with_max_turns(&kcoder_permissions::AutoDenyPrompt, 1)
                .next()
                .await
                .context("actual producer frame")
        })
        .await
}
#[tokio::test]
async fn native_event_uses_producer_ti_and_current_private_source_refs_after_collector_scope_ends()
-> Result<()> {
    let f = Fixture::new().await?;
    let guard = f.guard()?;
    guard
        .bind(f.bind(selected(f.choices().await?)).await?)
        .await?;
    let frame = original_native_frame(&f).await?;
    assert_eq!(frame.execution().attempt(), Some(&f.facts.initial));
    assert!(
        f.facts
            .engine
            .state
            .current_history_attempt_identity()
            .is_none()
    );
    guard.authorize_event(&frame).await?;
    f.facts
        .settings
        .lock()
        .unwrap()
        .mcp_disabled_servers
        .push("source-A".into());
    assert!(
        guard.authorize_event(&frame).await.is_err(),
        "a delayed frame cannot publish after actual source disable"
    );
    f.shutdown().await;
    Ok(())
}
#[tokio::test]
async fn none_event_keeps_local_work_without_source_discovery_but_requires_real_accepted_owner()
-> Result<()> {
    let f = Fixture::new().await?;
    let guard = f.guard()?;
    let frame = original_native_frame(&f).await?;
    assert!(guard.authorize_event(&frame).await.is_err());
    guard.bind(f.bind(none()).await?).await?;
    f.facts.source_unavailable.store(true, Ordering::SeqCst);
    guard.authorize_event(&frame).await?;
    f.facts.wrong_epoch.store(true, Ordering::SeqCst);
    assert!(guard.authorize_event(&frame).await.is_err());
    f.shutdown().await;
    Ok(())
}
