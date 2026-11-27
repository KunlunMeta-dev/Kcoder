use super::*;
use crate::app_server::session_messages::service::PeerRouterLaunch;
use kcoder_app_protocol::RetentionParentLaunchV1;
use kcoder_config::{ConfigPaths, PrivateDirectory};
use std::ffi::OsStr;
#[path = "receipt_list_tests.rs"]
mod receipt_list_tests;
#[path = "session_read_tests.rs"]
mod session_read_tests;

fn fixture(enabled: bool, private_parent: bool) -> (tempfile::TempDir, RouterRpc) {
    let root = tempfile::tempdir().unwrap();
    let profile_path = root.path().join("profile");
    let profile = PrivateDirectory::open_or_create(&profile_path).unwrap();
    let workspace = root.path().join("workspace");
    PrivateDirectory::open_or_create(&workspace).unwrap();
    let storage = workspace.join("client-sessions");
    PrivateDirectory::open_or_create(&storage).unwrap();
    if enabled {
        profile
            .atomic_replace(
                OsStr::new("settings.json"),
                br#"{"cross_session_messages":{"enabled":true,"wake_idle":false}}"#,
            )
            .unwrap();
    }
    let paths =
        ConfigPaths::with_config_dir_and_executable_dir(&workspace, profile_path.clone(), None);
    let launch = private_parent.then_some(PeerRouterLaunch {
        parent: RetentionParentLaunchV1::LocalOs,
        account_root: profile_path,
    });
    let service = PeerMessageService::capture(paths, workspace.clone(), launch).unwrap();
    let rpc = RouterRpc::capture(service, workspace, storage, None).unwrap();
    (root, rpc)
}
fn call(rpc: &RouterRpc, name: &str, params: Value) -> Result<Value> {
    let mut envelope = json!({"jsonrpc":"2.0","id":1,"method":name,"params":params});
    if !matches!(
        name,
        router::method::IDENTITY | router::method::CAPABILITIES
    ) {
        let identity = rpc.service.identity()?;
        envelope[PRIVATE_AGENT_MESSAGE_ROUTE_FIELD] =
            serde_json::to_value(PrivatePeerRouteProofV1 {
                version: 1,
                purpose: AGENT_MESSAGE_ROUTE_PURPOSE.into(),
                authorization_id: "owned-private-route".into(),
                source: identity.clone(),
                destination: identity,
            })?;
    }
    let request = PrivatePeerRouterRequest::decode(&serde_json::to_string(&envelope)?)
        .map_err(anyhow::Error::msg)?;
    rpc.prepare(request, &ThreadManager::default())?.execute()
}

#[test]
fn disabled_capture_is_pure_and_an_unbranded_parent_cannot_open_private_rpc() {
    let (root, disabled) = fixture(false, true);
    assert!(!disabled.service.policy().unwrap().enabled);
    assert!(!root.path().join("profile/peer-router-v1").exists());
    assert!(call(&disabled, router::method::IDENTITY, json!({})).is_err());
    assert!(!root.path().join("profile/peer-router-v1").exists());
    let (_root, ordinary) = fixture(true, false);
    assert!(call(&ordinary, router::method::IDENTITY, json!({})).is_err());
}

#[test]
fn original_receipt_query_survives_retired_payload_without_reconstructing_a_body() {
    let (_root, rpc) = fixture(true, true);
    let source = rpc.service.address("source").unwrap();
    let intent = AgentMessageIntent {
        reply_to_message_id: None,
        target_thread_id: "receiver".into(),
        target_address: Some(rpc.service.address("receiver").unwrap()),
        client_message_id: "retired-body".into(),
        mode: AgentMessageMode::EnqueueOnly,
        expected_turn_id: None,
        text: "Private terminal payload".into(),
    };
    let id = PeerMessageService::operation_id(&source, &intent.client_message_id).unwrap();
    let authority = rpc.service.authority().unwrap();
    let store = authority.store().unwrap();
    let operation = store.prepare(&id, source, &intent).unwrap();
    store.mark_dispatching(&id).unwrap();
    let queue = rpc.service.mailbox().unwrap();
    let native_source = rpc.service.message_source("source").unwrap();
    let receipt = queue
        .enqueue(&native_source, intent, queue.revision().unwrap())
        .unwrap();
    let receipt = queue
        .reject_queued(
            &receipt.message_id,
            "fixture_rejected",
            queue.revision().unwrap(),
        )
        .unwrap();
    store.record_receipt(&id, receipt.clone()).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    queue.maintain(now).unwrap();
    queue.maintain(now + 86_400_001).unwrap();
    assert!(queue.get_record_by_message_id(&receipt.message_id).is_err());
    let binding = queue
        .get_receipt_binding_by_message_id(&receipt.message_id)
        .unwrap()
        .unwrap();
    rpc.service.verify_local_receipt_binding(&binding).unwrap();
    let mut wrong = binding;
    wrong.body_sha256 = "0".repeat(64);
    assert!(rpc.service.verify_local_receipt_binding(&wrong).is_err());
    let result = call(
        &rpc,
        router::method::QUERY_ORIGINAL,
        json!({
            "attestation":operation.attestation,"query":{"messageId":receipt.message_id}
        }),
    )
    .unwrap();
    assert_eq!(result["receipt"], serde_json::to_value(&receipt).unwrap());
    let result_by_client = call(
        &rpc,
        router::method::QUERY_ORIGINAL,
        json!({
            "attestation":operation.attestation,"query":{"clientMessageId":"retired-body"}
        }),
    )
    .unwrap();
    assert_eq!(
        result_by_client["receipt"],
        serde_json::to_value(receipt).unwrap()
    );
}

#[test]
fn selectors_and_saved_source_facts_never_bootstrap_a_new_source_admission() {
    let (_root, rpc) = fixture(true, true);
    let identity: PeerRouterIdentityV1 =
        serde_json::from_value(call(&rpc, router::method::IDENTITY, json!({})).unwrap()).unwrap();
    assert_eq!(identity, rpc.service.identity().unwrap());
    let source = rpc.service.address("unowned-source").unwrap();
    let destination = rpc.service.address("unowned-destination").unwrap();
    let intent = AgentMessageIntent {
        reply_to_message_id: None,
        target_thread_id: destination.thread_id.clone(),
        target_address: Some(destination.clone()),
        client_message_id: "owned-logical-request".into(),
        mode: AgentMessageMode::EnqueueOnly,
        expected_turn_id: None,
        text: "Fixture private contribution".into(),
    };
    let operation_id =
        PeerMessageService::operation_id(&source, &intent.client_message_id).unwrap();
    assert!(
        call(
            &rpc,
            router::method::SOURCE_READ,
            json!({"operationId":operation_id})
        )
        .unwrap()
        .is_null()
    );
    let request = json!({"operationId":operation_id,"sourceThreadId":source.thread_id,"destination":destination,
        "message":{"clientMessageId":intent.client_message_id,"mode":"enqueue_only","text":intent.text}});
    assert!(call(&rpc, router::method::SOURCE_PREPARE, request.clone()).is_err());
    let authority = rpc.service.authority().unwrap();
    let store = authority.store().unwrap();
    assert!(store.read_operation(&operation_id).unwrap().is_none());
    // Signing the immutable facts is still not evidence that a live runtime
    // admitted the original send or currently permits dispatching it.
    let operation = store
        .prepare(&operation_id, source.clone(), &intent)
        .unwrap();
    assert!(
        call(
            &rpc,
            router::method::SOURCE_CHECK_ORIGINAL,
            json!({"attestation":operation.attestation,"access":"observe"})
        )
        .is_err(),
        "prepared provenance is not current dispatch authority"
    );
    assert_eq!(
        call(
            &rpc,
            router::method::SOURCE_READ,
            json!({"operationId":operation_id})
        )
        .unwrap(),
        serde_json::to_value(&operation).unwrap()
    );
    assert_eq!(call(&rpc, router::method::SOURCE_FIND, json!({"sourceThreadId":source.thread_id,"query":{"clientMessageId":intent.client_message_id}})).unwrap(), serde_json::to_value(&operation).unwrap());
    assert!(call(&rpc, router::method::SOURCE_PREPARE, request).is_err());
    assert!(
        call(
            &rpc,
            router::method::SOURCE_MARK_DISPATCH,
            json!({"operationId":operation_id})
        )
        .is_err()
    );
    assert_eq!(
        store.read_operation(&operation_id).unwrap().unwrap().stage,
        PeerRouterStageV1::Prepared
    );
    assert_eq!(rpc.service.mailbox().unwrap().revision().unwrap(), 1);
}

#[cfg(windows)]
#[path = "../../../peer_sessions/registry/windows_consumers_tests.rs"]
mod windows_consumers;
