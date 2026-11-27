use super::*;
use crate::cross_session_messages::OriginalReceiptQuery;
use sha2::{Digest, Sha256};

#[test]
fn authoritative_receipt_summary_keeps_exact_bindings_and_original_times_after_body_retirement()
-> Result<()> {
    let root = kcoder_config::create_private_temp_dir("original-receipt-summary")?;
    let store = create(root.path())?;
    let address = kcoder_types::session_address::SessionAddressV1 {
        target_id: "target-a".into(),
        workspace_id: "workspace-a".into(),
        thread_id: "target-thread".into(),
    };
    let source = CrossSessionMessageSource {
        address: Some(kcoder_types::session_address::SessionAddressV1 {
            thread_id: "source-thread".into(),
            ..address.clone()
        }),
        ..source()
    };
    let mut intent = intent("summary");
    intent.target_address = Some(address.clone());
    intent.reply_to_message_id = Some("original-reply".into());
    let sha = format!("{:x}", Sha256::digest(intent.text.as_bytes()));
    let receipt =
        store.enqueue_with_ttl_seconds(&source, intent.clone(), store.revision()?, 123)?;
    let mut query = OriginalReceiptQuery {
        source: &source,
        client_message_id: "summary",
        message_id: Some(&receipt.message_id),
        destination: &address,
        mode: AgentMessageMode::EnqueueOnly,
        expected_turn_id: None,
        reply_to_message_id: Some("original-reply"),
        body_sha256: &sha,
    };
    let original = store.original_receipt_summary(&query)?.unwrap();
    assert_eq!(original.receipt, receipt);
    assert_eq!(
        original.expires_at_ms.unwrap() - original.created_at_ms.unwrap(),
        123_000
    );
    query.body_sha256 = "changed";
    assert!(store.original_receipt_summary(&query).is_err());
    query.body_sha256 = &sha;
    query.reply_to_message_id = None;
    assert!(store.original_receipt_summary(&query).is_err());
    query.reply_to_message_id = Some("original-reply");
    query.message_id = Some("wrong-mid");
    assert!(store.original_receipt_summary(&query).is_err());
    query.message_id = Some(&receipt.message_id);
    query.mode = AgentMessageMode::WakeIfIdle;
    assert!(store.original_receipt_summary(&query).is_err());
    query.mode = AgentMessageMode::EnqueueOnly;
    let different = CrossSessionMessageSource {
        principal_id: "other".into(),
        ..source.clone()
    };
    query.source = &different;
    assert!(store.original_receipt_summary(&query)?.is_none());
    query.source = &source;
    let rejected =
        store.reject_queued(&receipt.message_id, "owned-rejection", store.revision()?)?;
    store.maintain(crate::now_millis() + 2 * 86_400_000)?;
    assert!(store.get_record_by_message_id(&receipt.message_id).is_err());
    let before = store.queue_body_io_counts();
    for _ in 0..5 {
        let archived = store.original_receipt_summary(&query)?.unwrap();
        assert_eq!(archived.receipt, rejected);
        assert_eq!(archived.created_at_ms, original.created_at_ms);
        assert_eq!(archived.expires_at_ms, original.expires_at_ms);
        assert_eq!(archived.body_sha256, sha);
    }
    assert_eq!(
        store.queue_body_io_counts().1,
        before.1,
        "summary reads do not write or resurrect payloads"
    );
    Ok(())
}

#[test]
fn legacy_summary_without_original_time_does_not_substitute_the_query_clock() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("legacy-receipt-summary")?;
    let store = create(root.path())?;
    let address = kcoder_types::session_address::SessionAddressV1 {
        target_id: "target-a".into(),
        workspace_id: "workspace-a".into(),
        thread_id: "target-thread".into(),
    };
    let source = CrossSessionMessageSource {
        address: Some(kcoder_types::session_address::SessionAddressV1 {
            thread_id: "source-thread".into(),
            ..address.clone()
        }),
        ..source()
    };
    let mut intent = intent("legacy-summary");
    intent.target_address = Some(address.clone());
    let sha = format!("{:x}", Sha256::digest(intent.text.as_bytes()));
    store.enqueue(&source, intent, store.revision()?)?;
    // Reproduce the old serialized shape in this private fixture only. The
    // production API must not expose a way to rewrite an original timestamp.
    let directory = PrivateDirectory::open_existing(&root.path().join("messages"))?;
    let mut data: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.path().join("messages/messages.json"))?)?;
    let row = data["messages"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap()
        .as_object_mut()
        .unwrap();
    row.remove("createdAtMs");
    row.remove("expiresAtMs");
    directory.atomic_replace(OsStr::new("messages.json"), &serde_json::to_vec(&data)?)?;
    let query = OriginalReceiptQuery {
        source: &source,
        client_message_id: "legacy-summary",
        message_id: None,
        destination: &address,
        mode: AgentMessageMode::EnqueueOnly,
        expected_turn_id: None,
        reply_to_message_id: None,
        body_sha256: &sha,
    };
    let summary = store.original_receipt_summary(&query)?.unwrap();
    assert_eq!(summary.created_at_ms, None);
    assert_eq!(summary.expires_at_ms, None);
    Ok(())
}
