use super::*;

#[test]
fn cold_wake_inventory_is_bounded_read_only_and_never_activates_enqueue_only() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("cross-message-cold-target")?;
    let store = create(root.path())?;
    store.enqueue(&source(), intent("enqueue-only"), store.revision()?)?;
    assert!(store.cold_wake_targets(8)?.is_empty());
    for (id, target) in [("wake-one", "first-target"), ("wake-two", "second-target")] {
        let mut wake = intent(id);
        wake.target_thread_id = target.into();
        wake.mode = AgentMessageMode::WakeIfIdle;
        store.enqueue(&source(), wake, store.revision()?)?;
    }
    let before = store.io_counts();
    let bytes = std::fs::read(root.path().join("messages/messages.json"))?;
    assert_eq!(store.cold_wake_targets(1)?, vec!["first-target"]);
    assert_eq!(
        store.cold_wake_targets(2)?,
        vec!["first-target", "second-target"]
    );
    assert!(store.cold_wake_targets(0).is_err());
    assert!(store.cold_wake_targets(33).is_err());
    assert_eq!(store.io_counts().1, before.1);
    assert_eq!(
        std::fs::read(root.path().join("messages/messages.json"))?,
        bytes
    );
    Ok(())
}

#[test]
fn cold_wake_inventory_does_not_skip_a_delivering_or_unknown_predecessor() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("cross-message-cold-fifo")?;
    let store = create(root.path())?;
    store.enqueue(&source(), intent("original-enqueue"), store.revision()?)?;
    let mut wake = intent("later-wake");
    wake.mode = AgentMessageMode::WakeIfIdle;
    store.enqueue(&source(), wake, store.revision()?)?;
    assert_eq!(store.cold_wake_targets(8)?, vec!["target-thread"]);
    let lease = store
        .reserve_next("target-thread", store.revision()?, 100, 200)?
        .unwrap();
    assert!(store.cold_wake_targets(8)?.is_empty());
    store.mark_unknown(&lease, store.revision()?)?;
    assert!(open(root.path())?.cold_wake_targets(8)?.is_empty());
    Ok(())
}
