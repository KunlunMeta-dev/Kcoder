use super::*;

#[test]
fn destination_deadline_survives_reopen_and_same_id_does_not_extend_it() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-ttl-durable")?;
    let store = create(root.path())?;
    let receipt = store.enqueue_with_ttl_seconds(&source(), intent("ttl"), 1, 1)?;
    let created = store
        .get_record_by_message_id(&receipt.message_id)?
        .unwrap()
        .created_at_ms;
    let initial = store.maintain(created)?;
    assert_eq!(initial.next_deadline_ms, Some(created + 1000));
    let before = store.queue_body_io_counts();
    let metadata_before = store.io_counts();
    for _ in 0..10 {
        store.maintain(created + 500)?;
    }
    assert_eq!(
        store.queue_body_io_counts(),
        before,
        "warm ticks do not read queue bodies or write"
    );
    assert!(
        store.io_counts().0 - metadata_before.0 <= 20,
        "warm namespace verification stays bounded"
    );
    drop(store);
    let store = open(root.path())?;
    assert_eq!(
        store.enqueue_with_ttl_seconds(&source(), intent("ttl"), 1, 604_800)?,
        receipt
    );
    let expired = store.maintain(created + 1000)?;
    assert_eq!(expired.expired_queued, 1);
    assert_eq!(expired.uncertain_leases, 0);
    assert_eq!(
        store.get_by_client_id(&source(), "ttl")?.unwrap().status,
        AgentMessageStatus::Expired
    );
    let before = store.queue_body_io_counts();
    store.maintain(created + 20_000)?;
    assert_eq!(store.queue_body_io_counts(), before);
    Ok(())
}

#[test]
fn expired_delivery_lease_stays_unknown_after_message_deadline() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-ttl-unknown")?;
    let store = create(root.path())?;
    let receipt = store.enqueue_with_ttl_seconds(&source(), intent("unknown"), 1, 1)?;
    let created = store
        .get_record_by_message_id(&receipt.message_id)?
        .unwrap()
        .created_at_ms;
    let _lease = store
        .reserve_next(
            "target-thread",
            store.revision()?,
            created + 1,
            created + 10,
        )?
        .unwrap();
    let done = store.maintain(created + 10)?;
    assert_eq!(done.uncertain_leases, 1);
    assert_eq!(done.expired_queued, 0);
    store.maintain(created + 86_400_000)?;
    let after = store.get_by_client_id(&source(), "unknown")?.unwrap();
    assert_eq!(after.status, AgentMessageStatus::Unknown);
    assert!(
        store
            .reserve_next(
                "target-thread",
                store.revision()?,
                created + 20,
                created + 30
            )
            .is_err()
    );
    Ok(())
}

#[test]
fn reservation_checks_deadline_in_the_same_queue_transaction() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-ttl-reserve")?;
    let store = create(root.path())?;
    let receipt = store.enqueue_with_ttl_seconds(&source(), intent("expired"), 1, 1)?;
    let created = store
        .get_record_by_message_id(&receipt.message_id)?
        .unwrap()
        .created_at_ms;
    assert!(
        store
            .reserve_next(
                "target-thread",
                store.revision()?,
                created + 1000,
                created + 1100
            )?
            .is_none()
    );
    assert_eq!(
        store
            .get_by_client_id(&source(), "expired")?
            .unwrap()
            .status,
        AgentMessageStatus::Expired
    );
    Ok(())
}

#[test]
fn changed_queue_invalidates_hint_and_corruption_is_not_repaired() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-ttl-hint")?;
    let store = create(root.path())?;
    store.enqueue(&source(), intent("later"), 1)?;
    store.maintain(1)?;
    let other = open(root.path())?;
    let receipt =
        other.enqueue_with_ttl_seconds(&source(), intent("earlier"), other.revision()?, 1)?;
    let created = other
        .get_record_by_message_id(&receipt.message_id)?
        .unwrap()
        .created_at_ms;
    assert_eq!(store.maintain(created + 1000)?.expired_queued, 1);
    let namespace = PrivateDirectory::open_existing(&root.path().join("messages"))?;
    namespace.atomic_replace(OsStr::new("messages.json"), b"{")?;
    assert!(store.maintain(created + 1001).is_err());
    assert_eq!(
        std::fs::read(root.path().join("messages/messages.json"))?,
        b"{"
    );
    Ok(())
}
