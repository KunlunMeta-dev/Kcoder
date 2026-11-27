use super::*;

#[test]
fn receipt_details_observe_destination_not_stale_source_cache_and_keep_legacy_get_shape() {
    let (_root, rpc) = fixture(true, true);
    let source = rpc.service.address("source").unwrap();
    let intent = AgentMessageIntent {
        target_thread_id: "receiver".into(),
        target_address: Some(rpc.service.address("receiver").unwrap()),
        client_message_id: "outgoing-summary".into(),
        mode: AgentMessageMode::EnqueueOnly,
        expected_turn_id: None,
        reply_to_message_id: Some("reply-original".into()),
        text: "private original body".into(),
    };
    let id = PeerMessageService::operation_id(&source, &intent.client_message_id).unwrap();
    let authority = rpc.service.authority().unwrap();
    let store = authority.store().unwrap();
    store.prepare(&id, source, &intent).unwrap();
    store.mark_dispatching(&id).unwrap();
    let queue = rpc.service.mailbox().unwrap();
    let receipt = queue
        .enqueue(
            &rpc.service.message_source("source").unwrap(),
            intent,
            queue.revision().unwrap(),
        )
        .unwrap();
    let operation = store.record_receipt(&id, receipt.clone()).unwrap();
    let final_receipt = queue
        .reject_queued(
            &receipt.message_id,
            "owned_rejection",
            queue.revision().unwrap(),
        )
        .unwrap();
    let page = call(
        &rpc,
        router::method::SOURCE_LIST,
        json!({"sourceThreadId":"source","query":{"limit":10,"status":"rejected"}}),
    )
    .unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        page["items"][0]["operation"]["receipt"]["status"], "queued",
        "source cache is a frozen prior observation"
    );
    let params =
        json!({"attestation":operation.attestation,"query":{"clientMessageId":"outgoing-summary"}});
    let details = call(&rpc, router::method::QUERY_ORIGINAL_DETAILS, params.clone()).unwrap();
    assert_eq!(
        details["receipt"],
        serde_json::to_value(&final_receipt).unwrap()
    );
    assert!(details["createdAtMs"].as_u64().is_some_and(|time| time > 0));
    assert!(details["expiresAtMs"].as_u64().is_some());
    assert!(
        !serde_json::to_string(&details)
            .unwrap()
            .contains("private original body")
    );
    assert_eq!(
        serde_json::to_value(
            rpc.service
                .local_outgoing_receipt_details(&operation)
                .unwrap()
        )
        .unwrap(),
        details
    );
    assert_eq!(
        call(&rpc, router::method::QUERY_ORIGINAL, params).unwrap(),
        json!({"receipt":final_receipt})
    );
    // Revoking acceptance of new messages does not hide an already executed result.
    let policy = rpc.service.policy().unwrap();
    rpc.service
        .save_policy(&policy.revision, false, false)
        .unwrap();
    assert!(
        rpc.service
            .local_outgoing_receipt_details(&operation)
            .unwrap()
            .receipt
            .is_some()
    );
    authority.close();
    assert!(
        rpc.service
            .local_outgoing_receipt_details(&operation)
            .is_err()
    );
}

#[test]
fn receipt_details_missing_and_forged_bindings_never_invent_times_or_current_status() {
    let (_root, rpc) = fixture(true, true);
    let source = rpc.service.address("source").unwrap();
    let destination = rpc.service.address("receiver").unwrap();
    let intent = AgentMessageIntent {
        target_thread_id: destination.thread_id.clone(),
        target_address: Some(destination),
        client_message_id: "not-dispatched".into(),
        mode: AgentMessageMode::EnqueueOnly,
        expected_turn_id: None,
        reply_to_message_id: None,
        text: "private never admitted".into(),
    };
    let id = PeerMessageService::operation_id(&source, &intent.client_message_id).unwrap();
    let authority = rpc.service.authority().unwrap();
    let operation = authority
        .store()
        .unwrap()
        .prepare(&id, source, &intent)
        .unwrap();
    let empty = rpc
        .service
        .local_outgoing_receipt_details(&operation)
        .unwrap();
    assert_eq!(
        serde_json::to_value(empty).unwrap(),
        json!({"receipt":null})
    );
    let mut forged = operation.clone();
    forged.attestation.claims.destination.thread_id = "different".into();
    assert!(rpc.service.local_outgoing_receipt_details(&forged).is_err());
    assert!(PrivatePeerRouterRequest::decode(&json!({"jsonrpc":"2.0","id":1,"method":router::method::SOURCE_LIST,"params":{"sourceThreadId":"source","query":{}}}).to_string()).is_err());
    assert!(
        call(
            &rpc,
            router::method::SOURCE_LIST,
            json!({"sourceThreadId":"source","query":{},"scope":{"targetId":"forged"}})
        )
        .is_err()
    );
}

/// Regression for the read blackout: while the recipient processes an inbound
/// same-host message (its delivery reservation is held, i.e. the window during
/// which a peer-driven turn runs without a parent-router client owner), the
/// sender's receipt and outbox reads are answered from this host's own durable
/// facts. Only an operation addressed to another runtime target needs the route.
#[test]
fn same_host_receipts_stay_readable_while_the_recipient_processes_the_inbound_message() {
    use crate::app_server::session_messages::{
        receipt_list::local_page_observed, service::OutgoingReceiptRead,
    };
    use kcoder_types::cross_session_messages::CrossSessionMessageReceiptListParams;
    let (_root, rpc) = fixture(true, true);
    assert!(rpc.service.has_private_parent());
    let source = rpc.service.address("source").unwrap();
    let destination = rpc.service.address("receiver").unwrap();
    let intent = AgentMessageIntent {
        target_thread_id: "receiver".into(),
        target_address: Some(destination.clone()),
        client_message_id: "inbound-window".into(),
        mode: AgentMessageMode::EnqueueOnly,
        expected_turn_id: None,
        reply_to_message_id: None,
        text: "private processing-window body".into(),
    };
    let by_client = AgentMessageGetParams {
        client_message_id: Some("inbound-window".into()),
        message_id: None,
    };
    let id = PeerMessageService::operation_id(&source, &intent.client_message_id).unwrap();
    let authority = rpc.service.authority().unwrap();
    let store = authority.store().unwrap();
    store.prepare(&id, source.clone(), &intent).unwrap();
    assert_eq!(
        rpc.service
            .local_outgoing_receipt(&source, &by_client)
            .unwrap(),
        OutgoingReceiptRead::Local(None),
        "an undispatched operation has no receipt, the same answer as the route"
    );
    store.mark_dispatching(&id).unwrap();
    assert!(
        rpc.service
            .local_outgoing_receipt(&source, &by_client)
            .is_err(),
        "absence after dispatch is never reported as a missing message"
    );
    let queue = rpc.service.mailbox().unwrap();
    let receipt = queue
        .enqueue(
            &rpc.service.message_source("source").unwrap(),
            intent,
            queue.revision().unwrap(),
        )
        .unwrap();
    store.record_receipt(&id, receipt.clone()).unwrap();

    // Controllable hook: the recipient starts processing and holds its FIFO
    // delivery reservation for the whole window.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let held = queue
        .reserve_next("receiver", queue.revision().unwrap(), now, now + 60_000)
        .unwrap()
        .expect("the recipient reserves the inbound message");
    let by_message = AgentMessageGetParams {
        client_message_id: None,
        message_id: Some(receipt.message_id.clone()),
    };
    // Readers on other threads observe the live receipt during the window.
    let readers = (0..4)
        .map(|index| {
            let service = rpc.service.clone();
            let source = source.clone();
            let query = if index % 2 == 0 {
                by_client.clone()
            } else {
                by_message.clone()
            };
            std::thread::spawn(move || service.local_outgoing_receipt(&source, &query))
        })
        .collect::<Vec<_>>();
    for reader in readers {
        match reader.join().unwrap().unwrap() {
            OutgoingReceiptRead::Local(Some(observed)) => {
                assert_eq!(observed.message_id, receipt.message_id);
                assert_eq!(observed.status, AgentMessageStatus::Delivering);
            }
            other => panic!("same-host receipt required the route: {other:?}"),
        }
    }
    let page = local_page_observed(
        &rpc.service,
        &source,
        &CrossSessionMessageReceiptListParams::default(),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(
        page.remote_candidates, 0,
        "a local-only page needs no route"
    );
    assert_eq!(page.result.items.len(), 1);
    assert_eq!(
        page.result.items[0]
            .receipt
            .as_ref()
            .map(|receipt| receipt.status),
        Some(AgentMessageStatus::Delivering)
    );
    assert_eq!(page.result.unconfirmed_count, 0);
    drop(held);

    // An operation to another runtime target still requires the route; the
    // local page reports it as unconfirmed instead of inventing a receipt.
    let remote = SessionAddressV1 {
        target_id: format!("{}-other", destination.target_id),
        workspace_id: destination.workspace_id.clone(),
        thread_id: "remote-receiver".into(),
    };
    let remote_intent = AgentMessageIntent {
        target_thread_id: remote.thread_id.clone(),
        target_address: Some(remote),
        client_message_id: "remote-window".into(),
        mode: AgentMessageMode::EnqueueOnly,
        expected_turn_id: None,
        reply_to_message_id: None,
        text: "private remote body".into(),
    };
    let remote_id =
        PeerMessageService::operation_id(&source, &remote_intent.client_message_id).unwrap();
    store
        .prepare(&remote_id, source.clone(), &remote_intent)
        .unwrap();
    store.mark_dispatching(&remote_id).unwrap();
    assert_eq!(
        rpc.service
            .local_outgoing_receipt(
                &source,
                &AgentMessageGetParams {
                    client_message_id: Some("remote-window".into()),
                    message_id: None,
                },
            )
            .unwrap(),
        OutgoingReceiptRead::RequiresRoute
    );
    let mixed = local_page_observed(
        &rpc.service,
        &source,
        &CrossSessionMessageReceiptListParams::default(),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(mixed.remote_candidates, 1);
    assert_eq!(mixed.result.unconfirmed_count, 1);
}
