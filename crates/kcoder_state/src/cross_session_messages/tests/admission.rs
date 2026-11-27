use super::*;

#[test]
fn reply_reference_is_frozen_in_receipt_and_same_cid_cannot_change_or_remove_it() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-reply-admission")?;
    let store = create(root.path())?;
    let mut request = intent("reply-association");
    request.reply_to_message_id = Some("received-original".into());
    let receipt = store.enqueue(&source(), request.clone(), store.revision()?)?;
    assert_eq!(receipt.reply_to_message_id, request.reply_to_message_id);
    let revision = store.revision()?;
    assert_eq!(store.enqueue(&source(), request.clone(), 0)?, receipt);
    for link in [None, Some("another-original".into())] {
        let mut changed = request.clone();
        changed.reply_to_message_id = link;
        assert!(store.enqueue(&source(), changed, revision).is_err());
    }
    assert_eq!(store.revision()?, revision);
    drop(store);
    let store = open(root.path())?;
    assert_eq!(
        store.get_by_client_id(&source(), &request.client_message_id)?,
        Some(receipt)
    );
    Ok(())
}

#[test]
fn new_stale_turn_is_rejected_atomically_and_duplicates_never_recheck_the_new_turn() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-turn-admission")?;
    let store = create(root.path())?;
    let mut original = intent("original-turn-message");
    original.expected_turn_id = Some("actual-ended-turn".into());
    let rejected =
        store.enqueue_with_admission(&source(), original.clone(), store.revision()?, 60, || {
            Ok(Some("target_turn_changed"))
        })?;
    assert_eq!(rejected.status, AgentMessageStatus::Rejected);
    assert_eq!(rejected.reason_code.as_deref(), Some("target_turn_changed"));
    assert!(
        store
            .pending_for_target(&original.target_thread_id)?
            .is_empty()
    );
    let revision = store.revision()?;
    let duplicate = store.enqueue_with_admission(&source(), original.clone(), 0, 60, || {
        panic!("original CID cannot re-enter current-turn admission")
    })?;
    assert_eq!(duplicate, rejected);
    assert_eq!(store.revision()?, revision);
    let mut conflict = original;
    conflict.text.push_str(" changed");
    assert!(
        store
            .enqueue_with_admission(&source(), conflict, revision, 60, || panic!(
                "conflicting CID cannot enter admission"
            ))
            .is_err()
    );
    assert_eq!(
        store.get_by_client_id(&source(), "original-turn-message")?,
        Some(rejected)
    );
    Ok(())
}

#[test]
fn unavailable_current_owner_leaves_no_queue_write_and_existing_receipts_still_reconcile()
-> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-turn-unavailable")?;
    let store = create(root.path())?;
    let before = store.revision()?;
    let request = intent("owner-busy");
    assert!(
        store
            .enqueue_with_admission(&source(), request.clone(), before, 60, || anyhow::bail!(
                "target_turn_owner_busy"
            ))
            .is_err()
    );
    assert_eq!(store.revision()?, before);
    assert!(
        store
            .get_by_client_id(&source(), &request.client_message_id)?
            .is_none()
    );
    let queued =
        store.enqueue_with_admission(&source(), request.clone(), before, 60, || Ok(None))?;
    assert_eq!(queued.status, AgentMessageStatus::Queued);
    assert_eq!(
        store.enqueue_with_admission(&source(), request, 0, 60, || anyhow::bail!(
            "target_turn_changed"
        ))?,
        queued
    );
    Ok(())
}
