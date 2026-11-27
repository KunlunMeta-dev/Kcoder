use super::*;

#[test]
fn idle_handoff_read_lease_orders_a_real_enqueue_without_replaying_it() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-idle-order")?;
    let store = create(root.path())?;
    let observation = store.observe_idle_wake_handoff(None)?;
    assert!(observation.pending().is_empty());
    let error = store
        .enqueue(&source(), intent("same-original-request"), 1)
        .unwrap_err();
    assert_eq!(error.to_string(), "AGENT_MESSAGE_BUSY");
    drop(observation);
    let receipt = store.enqueue(&source(), intent("same-original-request"), 1)?;
    assert_eq!(receipt.status, AgentMessageStatus::Queued);
    assert_eq!(store.revision()?, 2);
    Ok(())
}

#[test]
fn idle_handoff_hint_reuses_only_work_facts_without_body_reads_or_writes() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-idle-hint")?;
    let store = create(root.path())?;
    let mut request = intent("original-wake");
    request.mode = AgentMessageMode::WakeIfIdle;
    let receipt = store.enqueue(&source(), request, 1)?;
    let observation = store.observe_idle_wake_handoff(None)?;
    assert_eq!(observation.pending().len(), 1);
    assert_eq!(observation.pending()[0].message_id(), receipt.message_id);
    assert!(observation.pending()[0].unexpired_at(crate::now_millis()));
    assert!(!observation.pending()[0].unexpired_at(u64::MAX));
    let hint = observation.hint();
    drop(observation);
    let before = store.queue_body_io_counts();
    for _ in 0..8 {
        let observed = store.observe_idle_wake_handoff(Some(&hint))?;
        assert_eq!(observed.pending().len(), 1);
    }
    assert_eq!(store.queue_body_io_counts(), before);
    store.note_cold_wake_deferred(&receipt.message_id, "cold_target_restore_unavailable")?;
    let after_write = store.queue_body_io_counts();
    drop(store.observe_idle_wake_handoff(Some(&hint))?);
    assert!(store.queue_body_io_counts().0 > after_write.0);
    assert_eq!(store.queue_body_io_counts().1, after_write.1);
    Ok(())
}

#[test]
fn actual_failed_cold_restore_reason_preserves_original_payload_and_is_idempotent() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-idle-reason")?;
    let store = create(root.path())?;
    let mut request = intent("original-wake-reason");
    request.mode = AgentMessageMode::WakeIfIdle;
    let receipt = store.enqueue(&source(), request.clone(), 1)?;
    store.note_cold_wake_deferred(&receipt.message_id, "cold_target_original_turn_unsettled")?;
    let record = store
        .get_record_by_message_id(&receipt.message_id)?
        .unwrap();
    assert_eq!(record.intent, request);
    assert_eq!(record.receipt.message_id, receipt.message_id);
    assert_eq!(record.receipt.client_message_id, receipt.client_message_id);
    assert_eq!(record.receipt.status, AgentMessageStatus::Queued);
    assert_eq!(
        record.receipt.reason_code.as_deref(),
        Some("cold_target_original_turn_unsettled")
    );
    let before = store.io_counts().1;
    store.note_cold_wake_deferred(&receipt.message_id, "cold_target_original_turn_unsettled")?;
    assert_eq!(store.io_counts().1, before);
    assert!(
        store
            .note_cold_wake_deferred(&receipt.message_id, "private/secret")
            .is_err()
    );
    Ok(())
}

#[test]
fn every_closed_cold_wake_reason_keeps_the_message_queued_until_actual_delivery() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-idle-reason-set")?;
    let store = create(root.path())?;
    let mut request = intent("original-wake-reason-set");
    request.mode = AgentMessageMode::WakeIfIdle;
    let receipt = store.enqueue(&source(), request, 1)?;
    for reason in crate::cross_session_messages::COLD_WAKE_DEFERRED_REASONS {
        store.note_cold_wake_deferred(&receipt.message_id, reason)?;
        let current = store
            .get_by_client_id(&source(), &receipt.client_message_id)?
            .unwrap();
        assert_eq!(current.status, AgentMessageStatus::Queued, "{reason}");
        assert_eq!(current.reason_code.as_deref(), Some(*reason));
        assert_eq!(current.message_id, receipt.message_id);
    }
    // Still a cold wake candidate: a failed attempt never strands the message.
    assert_eq!(store.cold_wake_targets(8)?, vec!["target-thread"]);
    // Once the target is resident, the ordinary FIFO reservation delivers the
    // same message and clears the deferred explanation.
    let now = crate::now_millis();
    let lease = store
        .reserve_next("target-thread", store.revision()?, now, now + 10_000)?
        .expect("the queued message remains deliverable");
    assert_eq!(lease.record().receipt.message_id, receipt.message_id);
    let delivering = store
        .get_by_client_id(&source(), &receipt.client_message_id)?
        .unwrap();
    assert_eq!(delivering.status, AgentMessageStatus::Delivering);
    assert!(delivering.reason_code.is_none());
    Ok(())
}

#[test]
fn cold_wake_generation_moves_only_for_the_same_target() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-cold-generation")?;
    let store = create(root.path())?;
    let mut wake = intent("generation-wake");
    wake.mode = AgentMessageMode::WakeIfIdle;
    let receipt = store.enqueue(&source(), wake, store.revision()?)?;
    let first = store.cold_wake_target_generations_after(8, None)?;
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].0, "target-thread");
    // Unrelated writes change the namespace stamp but not this target's generation.
    let mut other = intent("other-target");
    other.target_thread_id = "other-thread".into();
    store.enqueue(&source(), other, store.revision()?)?;
    store.note_cold_wake_deferred(&receipt.message_id, "cold_target_lease_busy")?;
    let unrelated = store
        .cold_wake_target_generations_after(8, None)?
        .into_iter()
        .find(|(target, _)| target == "target-thread")
        .unwrap();
    assert_eq!(unrelated, first[0]);
    // A newly queued follow-up (even enqueue_only) for the same target moves it.
    store.enqueue(&source(), intent("generation-follow-up"), store.revision()?)?;
    let moved = store
        .cold_wake_target_generations_after(8, None)?
        .into_iter()
        .find(|(target, _)| target == "target-thread")
        .unwrap();
    assert!(moved.1 > first[0].1);
    assert_eq!(
        store.cold_wake_targets_after(8, None)?,
        store
            .cold_wake_target_generations_after(8, None)?
            .into_iter()
            .map(|(target, _)| target)
            .collect::<Vec<_>>()
    );
    Ok(())
}
