use super::*;
use anyhow::Result;
use kcoder_config::PrivateDirectory;
use kcoder_types::cross_session_messages::*;
use std::{ffi::OsStr, path::Path};

mod admission;
mod cold_targets;
mod idle_handoff;
mod maintenance;
mod receipt_summary;

fn scope() -> CrossSessionMessageScope {
    CrossSessionMessageScope {
        account_id: "account-a".into(),
        target_id: "target-a".into(),
        workspace_id: "workspace-a".into(),
    }
}
fn source() -> CrossSessionMessageSource {
    CrossSessionMessageSource {
        thread_id: "source-thread".into(),
        principal_id: "principal-a".into(),
        address: None,
    }
}
fn intent(id: &str) -> AgentMessageIntent {
    AgentMessageIntent {
        reply_to_message_id: None,
        target_thread_id: "target-thread".into(),
        target_address: None,
        client_message_id: id.into(),
        mode: AgentMessageMode::EnqueueOnly,
        expected_turn_id: None,
        text: "private message body".into(),
    }
}
fn create(root: &Path) -> Result<CrossSessionMessageStore> {
    CrossSessionMessageStore::create_in(
        &PrivateDirectory::open_existing(root)?,
        OsStr::new("messages"),
        &scope(),
    )
}
fn open(root: &Path) -> Result<CrossSessionMessageStore> {
    Ok(CrossSessionMessageStore::open_in(
        &PrivateDirectory::open_existing(root)?,
        OsStr::new("messages"),
        &scope(),
    )?
    .unwrap())
}

#[test]
fn pure_reads_do_not_initialize_or_write_and_owner_mismatch_fails_closed() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("cross-message-reads")?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    assert!(
        CrossSessionMessageStore::open_in(&parent, OsStr::new("messages"), &scope())?.is_none()
    );
    assert!(!root.path().join("messages").exists());
    let store = create(root.path())?;
    let receipt = store.enqueue(&source(), intent("request"), 1)?;
    let before = store.io_counts();
    let bytes = std::fs::read(root.path().join("messages/messages.json"))?;
    for _ in 0..10 {
        assert_eq!(
            store.get_by_client_id(&source(), "request")?,
            Some(receipt.clone())
        );
    }
    let after = store.io_counts();
    assert_eq!(after.1, before.1);
    assert_eq!(
        after.0 - before.0,
        40,
        "one bounded data read and three bounded identity reads per query"
    );
    assert_eq!(
        std::fs::read(root.path().join("messages/messages.json"))?,
        bytes
    );
    for changed in [
        CrossSessionMessageScope {
            account_id: "other".into(),
            ..scope()
        },
        CrossSessionMessageScope {
            target_id: "other".into(),
            ..scope()
        },
        CrossSessionMessageScope {
            workspace_id: "other".into(),
            ..scope()
        },
    ] {
        assert!(
            CrossSessionMessageStore::open_in(&parent, OsStr::new("messages"), &changed).is_err()
        );
    }
    Ok(())
}

#[test]
fn exact_request_reopens_and_reconciles_without_replay_or_source_confusion() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("cross-message-dedupe")?;
    let store = create(root.path())?;
    let first = store.enqueue(&source(), intent("request"), 1)?;
    assert_eq!(store.enqueue(&source(), intent("request"), 1)?, first);
    assert_eq!(store.revision()?, 2);
    let mut changed = intent("request");
    changed.text = "different action".into();
    assert!(
        store
            .enqueue(&source(), changed, 2)
            .unwrap_err()
            .to_string()
            .contains("AGENT_MESSAGE_REQUEST_CONFLICT")
    );
    let other = CrossSessionMessageSource {
        principal_id: "principal-b".into(),
        ..source()
    };
    assert!(store.get_by_client_id(&other, "request")?.is_none());
    let second = store.enqueue(&other, intent("request"), 2)?;
    assert_ne!(first.message_id, second.message_id);
    assert!(
        store
            .enqueue(&source(), intent("new-stale-request"), 1)
            .is_err()
    );
    drop(store);
    assert_eq!(
        open(root.path())?.get_by_client_id(&source(), "request")?,
        Some(first)
    );
    Ok(())
}

#[test]
fn fifo_reservation_expiry_is_unknown_and_never_creates_another_dispatch() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("cross-message-fence")?;
    let store = create(root.path())?;
    let first = store.enqueue(&source(), intent("first"), 1)?;
    store.enqueue(&source(), intent("second"), 2)?;
    let lease = store.reserve_next("target-thread", 3, 100, 200)?.unwrap();
    assert_eq!(lease.record().receipt.message_id, first.message_id);
    assert_eq!(lease.record().sequence, 1);
    assert_eq!(
        lease.record().receipt.status,
        AgentMessageStatus::Delivering
    );
    assert!(store.reserve_next("target-thread", 4, 101, 201).is_err());
    assert_eq!(store.reconcile_expired(4, 199)?, 0);
    assert_eq!(store.reconcile_expired(4, 200)?, 1);
    assert_eq!(
        store.get_by_client_id(&source(), "first")?.unwrap().status,
        AgentMessageStatus::Unknown
    );
    assert!(store.mark_unknown(&lease, 5).is_err());
    assert!(
        open(root.path())?
            .reserve_next("target-thread", 5, 300, 400)
            .is_err()
    );
    assert_eq!(
        store.get_by_client_id(&source(), "second")?.unwrap().status,
        AgentMessageStatus::Queued
    );
    Ok(())
}

#[test]
fn reservations_cannot_cross_namespaces_and_unknown_requires_the_original_fence() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("cross-message-lease")?;
    let other = kcoder_config::create_private_temp_dir("cross-message-peer")?;
    let store = create(root.path())?;
    let peer = create(other.path())?;
    store.enqueue(&source(), intent("first"), 1)?;
    let lease = store.reserve_next("target-thread", 2, 100, 200)?.unwrap();
    assert!(peer.mark_unknown(&lease, 1).is_err());
    assert!(store.mark_unknown(&lease, 2).is_err());
    assert_eq!(
        store.mark_unknown(&lease, 3)?.status,
        AgentMessageStatus::Unknown
    );
    assert_eq!(
        store.enqueue(&source(), intent("first"), 1)?.status,
        AgentMessageStatus::Unknown
    );
    Ok(())
}

#[test]
fn corruption_future_format_and_directory_replacement_are_not_empty_queues() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("cross-message-damage")?;
    let store = create(root.path())?;
    store.enqueue(&source(), intent("original"), 1)?;
    let path = root.path().join("messages/messages.json");
    let original = std::fs::read(&path)?;
    let mut future: serde_json::Value = serde_json::from_slice(&original)?;
    future["version"] = serde_json::json!(2);
    let future = serde_json::to_vec(&future)?;
    std::fs::write(&path, &future)?;
    assert!(store.get_by_client_id(&source(), "original").is_err());
    assert_eq!(std::fs::read(&path)?, future);
    std::fs::write(&path, b"{broken")?;
    assert!(open(root.path()).is_err());
    std::fs::write(&path, &original)?;
    std::fs::rename(
        root.path().join("messages"),
        root.path().join("old-messages"),
    )?;
    let _replacement = create(root.path())?;
    assert!(store.get_by_client_id(&source(), "original").is_err());
    assert!(
        open(root.path())?
            .get_by_client_id(&source(), "original")?
            .is_none()
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn hard_linked_data_and_replaced_lock_are_rejected() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("cross-message-links")?;
    let store = create(root.path())?;
    let data = root.path().join("messages/messages.json");
    std::fs::hard_link(&data, root.path().join("linked-data"))?;
    assert!(store.revision().is_err());
    std::fs::remove_file(root.path().join("linked-data"))?;
    let lock = root.path().join("messages/messages.lock");
    std::fs::rename(&lock, root.path().join("old-lock"))?;
    std::fs::write(&lock, b"")?;
    assert!(store.revision().is_err());
    Ok(())
}

struct OwnedChild(std::process::Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

#[test]
#[ignore = "owned subprocess fixture explicitly executed by the concurrency test"]
fn owned_cross_process_enqueue_fixture() -> Result<()> {
    let root =
        std::path::PathBuf::from(std::env::var_os("KCODER_CROSS_MESSAGE_TEST_ROOT").unwrap());
    let nonce = std::env::var("KCODER_CROSS_MESSAGE_TEST_NONCE").unwrap();
    assert_eq!(std::fs::read_to_string(root.join("owner"))?, nonce);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let store = loop {
        match open(&root) {
            Ok(store) => break store,
            Err(error) if error.to_string().contains("AGENT_MESSAGE_BUSY") => {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            Err(error) => return Err(error),
        }
    };
    let slot = std::env::var("KCODER_CROSS_MESSAGE_TEST_SLOT").unwrap();
    assert!(matches!(slot.as_str(), "0" | "1"));
    std::fs::write(root.join(format!("ready-{slot}")), &nonce)?;
    while !root.join("start").exists() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    // Lock contention is a retryable local admission failure, never a new ID.
    loop {
        match store.enqueue(&source(), intent("same-request"), 1) {
            Ok(_) => break,
            Err(error) if error.to_string().contains("AGENT_MESSAGE_BUSY") => {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[test]
fn two_owned_processes_racing_the_same_request_commit_one_message() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("cross-message-processes")?;
    let store = create(root.path())?;
    let nonce = uuid::Uuid::new_v4().to_string();
    std::fs::write(root.path().join("owner"), &nonce)?;
    let mut children = Vec::new();
    for slot in 0..2 {
        children.push(OwnedChild(
            std::process::Command::new(std::env::current_exe()?)
                .args([
                    "--ignored",
                    "--exact",
                    "cross_session_messages::tests::owned_cross_process_enqueue_fixture",
                    "--test-threads=1",
                ])
                .env("KCODER_CROSS_MESSAGE_TEST_ROOT", root.path())
                .env("KCODER_CROSS_MESSAGE_TEST_NONCE", &nonce)
                .env("KCODER_CROSS_MESSAGE_TEST_SLOT", slot.to_string())
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()?,
        ));
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !(root.path().join("ready-0").exists() && root.path().join("ready-1").exists()) {
        assert!(
            std::time::Instant::now() < deadline,
            "owned children did not reach the barrier"
        );
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    std::fs::write(root.path().join("start"), b"start")?;
    for child in &mut children {
        loop {
            if let Some(status) = child.0.try_wait()? {
                assert!(status.success());
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "owned child exceeded deadline"
            );
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }
    let receipt = store.get_by_client_id(&source(), "same-request")?.unwrap();
    assert_eq!(store.revision()?, 2);
    assert_eq!(
        store.enqueue(&source(), intent("same-request"), 1)?,
        receipt
    );
    Ok(())
}

#[test]
fn same_thread_id_on_distinct_full_targets_is_valid_and_half_addresses_are_not() -> Result<()> {
    use kcoder_types::session_address::SessionAddressV1;
    let root = kcoder_config::create_private_temp_dir("cross-message-addresses")?;
    let store = create(root.path())?;
    let source = CrossSessionMessageSource {
        thread_id: "target-thread".into(),
        principal_id: "source-principal".into(),
        address: Some(SessionAddressV1 {
            target_id: "remote-source".into(),
            workspace_id: "remote-workspace".into(),
            thread_id: "target-thread".into(),
        }),
    };
    let mut request = intent("addressed");
    request.target_address = Some(SessionAddressV1 {
        target_id: scope().target_id,
        workspace_id: scope().workspace_id,
        thread_id: "target-thread".into(),
    });
    let receipt = store.enqueue(&source, request.clone(), 1)?;
    assert_eq!(receipt.source_address, source.address);
    assert_eq!(receipt.target_address, request.target_address);
    let mut self_source = source.clone();
    self_source.address = request.target_address.clone();
    request.client_message_id = "self".into();
    assert!(store.enqueue(&self_source, request.clone(), 2).is_err());
    let mut half = source;
    half.address = None;
    assert!(store.enqueue(&half, request, 2).is_err());
    Ok(())
}

#[test]
fn observation_stamp_is_only_a_zero_body_read_wake_hint_and_never_a_queue_allow_verdict()
-> Result<()> {
    let root = kcoder_config::create_private_temp_dir("cross-message-stamp")?;
    let store = create(root.path())?;
    let before = store.io_counts();
    let stamp = store.observation_stamp()?;
    for _ in 0..10 {
        assert_eq!(store.observation_stamp()?, stamp);
    }
    assert_eq!(
        store.io_counts(),
        before,
        "idle wake polling performs no header/body reads or writes"
    );
    store.enqueue(&source(), intent("new-message"), 1)?;
    assert_ne!(store.observation_stamp()?, stamp);
    std::fs::write(root.path().join("messages/messages.json"), b"{damaged")?;
    assert!(
        store.observation_stamp().is_ok(),
        "a stat hint is deliberately not a validity proof"
    );
    assert!(
        store.get_by_client_id(&source(), "new-message").is_err(),
        "actual reads still fail closed on damage"
    );
    Ok(())
}
