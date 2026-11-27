use super::*;
use kcoder_types::cross_session_messages::*;
use std::{ffi::OsStr, fs::OpenOptions};

#[test]
fn actual_original_queue_lock_is_busy_and_corruption_never_becomes_message_changed() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("claimed-original-read")?;
    let queue = CrossSessionMessageStore::create_in(
        &kcoder_config::PrivateDirectory::open_existing(root.path())?,
        OsStr::new("mailbox"),
        &CrossSessionMessageScope {
            account_id: "owned".into(),
            target_id: "target".into(),
            workspace_id: "workspace".into(),
        },
    )?;
    let source = CrossSessionMessageSource {
        thread_id: "source".into(),
        principal_id: "owned".into(),
        address: None,
    };
    let original = queue.enqueue(
        &source,
        AgentMessageIntent {
            target_thread_id: "target".into(),
            target_address: None,
            client_message_id: "original-read".into(),
            mode: AgentMessageMode::WakeIfIdle,
            expected_turn_id: None,
            reply_to_message_id: None,
            text: "Owned immutable original".into(),
        },
        queue.revision()?,
    )?;
    let held = OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join("mailbox/messages.lock"))?;
    fs2::FileExt::lock_exclusive(&held)?;
    let busy = queue
        .get_record_by_message_id(&original.message_id)
        .err()
        .context("actual shared queue read must contend")?;
    assert!(is_temporary_read_contention(&busy));
    assert_eq!(
        public_read_error(&busy, "peer_provider_start_original_record_unavailable"),
        "peer_provider_start_original_read_busy"
    );
    drop(held);
    let record = queue
        .get_record_by_message_id(&original.message_id)?
        .unwrap();
    assert_eq!(record.receipt, original);
    assert_eq!(record.intent.text, "Owned immutable original");
    let data = root.path().join("mailbox/messages.json");
    let before = std::fs::read(&data)?;
    std::fs::write(&data, b"{owned-corruption")?;
    let corrupt = queue
        .get_record_by_message_id(&original.message_id)
        .err()
        .context("corrupt queue must reject")?;
    assert!(!is_temporary_read_contention(&corrupt));
    assert_eq!(
        public_read_error(&corrupt, "peer_provider_start_original_record_unavailable"),
        "peer_provider_start_original_record_unavailable"
    );
    std::fs::write(data, before)?;
    assert_eq!(
        queue.get_by_client_id(&source, "original-read")?,
        Some(original)
    );
    Ok(())
}

#[test]
fn closed_target_loss_keeps_the_fail_closed_code_but_names_its_diagnostic_reason() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("claimed-target-loss")?;
    let history = root.path().join("target.jsonl");
    let lease = kcoder_cli_storage::session_lease::SessionLease::acquire(&history)?;
    let witness = lease.native_witness()?;
    witness.verify_target(&history)?;
    // A retired original lease is target loss, never a stale native permit.
    drop(lease);
    let closed = witness
        .verify_target(&history)
        .err()
        .context("a dropped original lease must not verify")?;
    assert!(!is_temporary_read_contention(&closed));
    assert_eq!(claimed_read_reason(&closed), "SESSION_NATIVE_OWNER_CLOSED");
    assert_eq!(
        public_read_error(&closed, "peer_provider_start_original_permit_not_current"),
        "peer_provider_start_original_permit_not_current"
    );
    let changed = anyhow::anyhow!("peer_delivery_target_changed");
    assert_eq!(
        claimed_read_reason(&changed),
        "peer_delivery_target_changed"
    );
    assert_eq!(
        public_read_error(&changed, "peer_provider_start_original_permit_not_current"),
        "peer_provider_start_original_permit_not_current"
    );
    let unknown = anyhow::anyhow!("owned unclassified failure");
    assert_eq!(claimed_read_reason(&unknown), "peer_wake_start_unconfirmed");
    Ok(())
}
