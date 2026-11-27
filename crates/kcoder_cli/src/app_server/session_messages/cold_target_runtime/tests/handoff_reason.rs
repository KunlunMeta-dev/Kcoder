use super::*;

pub(super) async fn run() -> Result<()> {
    assert_eq!(owned::owned_case(), "cold-handoff-reason");
    let fixture = Fixture::new().await?;
    let (mut cold, mut idle, mut manager, _events) = fixture.driver(true)?;
    let original = fixture
        .send("original-explained-wake", AgentMessageMode::WakeIfIdle)
        .await?;
    let history_before = std::fs::read(&fixture.target_history)?;
    fixture
        .source
        .settings
        .write()
        .unwrap()
        .tools
        .disabled
        .push("SendSessionMessage".into());
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            cold.tick(&mut manager).await;
            let receipt = fixture
                .service
                .mailbox()?
                .get_record_by_message_id(&original.message_id)?
                .context("the same original queued record")?
                .receipt;
            if receipt.reason_code.as_deref() == Some("cold_target_source_unavailable") {
                assert_eq!(receipt.status, AgentMessageStatus::Queued);
                assert_eq!(receipt.message_id, original.message_id);
                assert_eq!(receipt.client_message_id, original.client_message_id);
                break Ok::<_, anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .with_context(|| {
        format!(
            "no cold wake explanation recorded: {:?}",
            cold.restore_errors
        )
    })??;
    assert!(manager.engine(&fixture.target).is_none());
    assert_eq!(
        fixture.calls.lock().unwrap().len(),
        1,
        "only the original terminal seed ran"
    );
    assert_eq!(std::fs::read(&fixture.target_history)?, history_before);
    cold.shutdown(&mut manager).await;
    idle.shutdown().await;
    fixture.close().await
}
