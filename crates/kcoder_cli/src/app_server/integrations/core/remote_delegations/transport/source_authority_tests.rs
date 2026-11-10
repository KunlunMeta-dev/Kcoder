//! Real Source journal inputs with an explicit test parent; no target authentication claim.
use super::super::{NativeRemoteAuthority, authority_ssh::AcceptedSshRemoteAuthority, registry};
use super::host_client::tests::fixture;
use kcoder_acp::outbound::{OutboundEffect, OwnedNativeFrameTransport};
use kcoder_native_journal::NativeOperations;
use kcoder_tools::{ToolContext, integrations::remotes::RemoteDelegateInput};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Mutex;

#[tokio::test]
async fn ssh_source_requires_the_original_bind_before_session_and_checks_every_reply_identity() {
    let (fixture, client, _parent, mut outgoing) = fixture();
    fixture.engine.state.history_attempt_scope(fixture.attempt.clone()).unwrap().run(async {
        let config = json!({"integrations":{"remotes":{"enabled":true,"outbound":{"enabled":true,
            "maximumTotalTokens":80,"maximumModelCalls":2,"maximumDurationSeconds":1800},
            "nativeSshPeers":[{"id":"owned-ssh-peer","enabled":true,"target":{"targetId":"actual-target",
                "targetRevision":"actual-target-revision","targetPlatform":"windows","expectedNativeSha256":"a".repeat(64)},
                "maximumDurationSeconds":120}]}}});
        fixture.native.profile().unwrap().atomic_replace(std::ffi::OsStr::new("settings.json"), &serde_json::to_vec(&config).unwrap()).unwrap();
        let registry = registry::observe(&fixture.native, &fixture.engine).unwrap().unwrap();
        assert_eq!(registry.peers().unwrap()[0]["kind"], "native_ssh_acp");
        let selector = registry.configured_ssh_peer("owned-ssh-peer", registry.revision()).unwrap().unwrap();
        let input = RemoteDelegateInput { peer_id:"owned-ssh-peer".into(), peer_revision:registry.revision().into(),
            prompt:"Original bounded prompt".into(), maximum_seconds:30, materials:vec![] };
        let caller = ToolContext::new(fixture.engine.state.clone()).with_tool_call_id("original-current-native-call");
        let owners=Mutex::default();
        let authority=AcceptedSshRemoteAuthority::capture(&fixture.native,&fixture.engine,&fixture.attempt,&caller,
            (registry,selector,input,client.clone(),&owners)).unwrap();
        let captured=authority.frames();
        let erased:std::sync::Arc<dyn OwnedNativeFrameTransport>=captured.clone();
        authority.verify_owned_frame_transport(erased.as_ref()).unwrap();
        let (budget,_,_,_)=captured.source_control_binding().unwrap();
        let foreign=super::NativeRemoteSourceFrames::bind_original(client.clone(),budget,
            serde_json::from_value(config["integrations"]["remotes"]["nativeSshPeers"][0]["target"].clone()).unwrap(),
            authority.operation(),tokio::time::Instant::now()+std::time::Duration::from_secs(30),tokio_util::sync::CancellationToken::new()).unwrap();
        assert!(authority.verify_owned_frame_transport(foreign.as_ref()).is_err());
        assert!(authority.check_frozen_intent(OutboundEffect::Session, &json!({"cwd":"D:/owned"})).is_err());
        assert!(authority.check_frozen_intent(OutboundEffect::Prompt, &json!({"sessionId":"invented","prompt":[]})).is_err());
        let frame=authority.original_bind();
        let NativeRemoteControlDataV1::BindOriginal(binding)=&frame.message else { panic!("Original bind required") };
        assert_eq!(binding.frozen_input_sha256,format!("{:x}",Sha256::digest(binding.prompt.as_bytes())));
        assert!(outgoing.try_recv().is_err(), "Constructing a captured source does not open SSH");
        let received=json!({"version":1,"operationId":frame.operation_id,"requestId":frame.request_id,
            "endpointRevision":frame.endpoint_revision,"endpointInstanceId":frame.endpoint_instance_id,"state":"received",
            "data":{"kind":"original_bound","frozenInputSha256":binding.frozen_input_sha256,"receiverSettingsSha256":"c".repeat(64)}});
        for field in ["operationId","requestId","endpointRevision","endpointInstanceId"] {
            let mut wrong=received.clone();wrong[field]=json!("another-original");
            assert!(authority.verify_owned_native_bind_receipt(&wrong).is_err());
        }
        let mut grant=received.clone();grant["authority"]=json!(true);
        assert!(authority.verify_owned_native_bind_receipt(&grant).is_err());
        authority.verify_owned_native_bind_receipt(&received).unwrap();
        authority.observe_owned_native_bind(&received).unwrap();
        assert!(authority.verify_owned_native_bind(&serde_json::to_value(frame).unwrap()).is_err(), "No repeat binding write");
        use kcoder_acp::outbound::OutboundHost;
        use super::super::NativeRemoteJournal;
        use kcoder_types::integrations::core::*;
        let original=IntegrationRequest {contract_version:IntegrationContractVersion::ParallelV1,
            request_id:"original-owned-callback".into(),scope:fixture.native.scope().clone(),operation_id:Some(authority.operation().into()),
            expected_revision:None,timeout_ms:1000,cancellation_ref:None,payload:json!({"prompt":"Original bounded prompt"}).as_object().unwrap().clone()};
        let journal=std::sync::Arc::new(NativeRemoteJournal::begin(&fixture.native,&original,authority.clone()).unwrap());
        journal.before_effect(OutboundEffect::Spawn,&json!({"expectedName":"kcoder","expectedVersion":kcoder_cli_commands::build_identity::version()})).unwrap();
        journal.record_receipt(OutboundEffect::Spawn,&json!({"ownedEndpointInstanceId":frame.endpoint_instance_id})).unwrap();
        journal.before_effect(OutboundEffect::Initialize,&json!({"protocolVersion":1})).unwrap();
        journal.record_receipt(OutboundEffect::Initialize,&json!({"protocolVersion":1})).unwrap();
        // The authority was already bound above; the State observation is a
        // fixture receipt, not permission from this JSON.
        let bind_permit=journal.store().before_dispatch(authority.operation(),fixture.native.scope(),
            kcoder_state::integrations::core::remote_delegations::NativeRemoteStage::BindOriginal,&json!({"original":true})).unwrap();
        journal.store().receive(&bind_permit,&received).unwrap();
        let prompt_permit=journal.store().before_dispatch(authority.operation(),fixture.native.scope(),
            kcoder_state::integrations::core::remote_delegations::NativeRemoteStage::Session,&json!({"original":true})).unwrap();
        journal.store().receive(&prompt_permit,&json!({"sessionId":"original-receiver-session"})).unwrap();
        let _prompt=journal.store().before_dispatch(authority.operation(),fixture.native.scope(),
            kcoder_state::integrations::core::remote_delegations::NativeRemoteStage::Prompt,&json!({"original":true})).unwrap();
        let opening=authority.frames();let opened=opening.clone();let opening=tokio::spawn(async move {opened.open().await});
        let request=outgoing.recv().await.unwrap();
        client.route_response(&json!({"jsonrpc":"2.0","id":request["id"],"result":{"operationId":authority.operation(),
            "endpointInstanceId":frame.endpoint_instance_id,"state":"opened","receiverWorkspace":"D:/owned/receiver","targetPlatform":"windows","nativeSha256":"a".repeat(64)}}));
        opening.await.unwrap().unwrap();
        let accepted=NativeRemoteAcceptedFactsV1 {identity:NativeRemoteTurnIdentityV1{thread_id:"actual-receiver-thread".into(),turn_id:"actual-receiver-turn".into(),attempt_id:"actual-receiver-attempt".into()},
            accepted_input_sha256:"a".repeat(64),accepted_receipt_sha256:"b".repeat(64),receiver_settings_sha256:"c".repeat(64),receiver_scope:Some(fixture.native.scope().clone())};
        let control=|id:&str,message:NativeRemoteControlDataV1|json!({"jsonrpc":"2.0","id":id,"method":NATIVE_REMOTE_CONTROL_METHOD,
            "params":NativeRemoteControlFrameV1{version:1,operation_id:authority.operation().into(),request_id:id.into(),endpoint_revision:frame.endpoint_revision.clone(),
                endpoint_instance_id:frame.endpoint_instance_id.clone(),source_accepted_sha256:frame.source_accepted_sha256.clone(),message}});
        let receiver=control("actual-receiver",NativeRemoteControlDataV1::ReceiverAccepted(accepted.clone()));
        journal.handle_owned_native_control(&receiver).await.unwrap();
        let reserve=control("actual-reserve",NativeRemoteControlDataV1::ReserveModel(NativeRemoteReserveModelV1{receiver_accepted:accepted.clone(),native_call_id:"original-model-call".into(),
            provider_id:"own-provider".into(),model_id:"own-model".into(),model_configuration_revision:"original-model-revision".into(),conservative_bound:NativeRemoteChargeDataV1{tokens:10,model_calls:1,run_millis:1000,cost_micros:None}}));
        let dispatch=control("actual-dispatch",NativeRemoteControlDataV1::DispatchModel(NativeRemoteCallRefV1{receiver_accepted:accepted,native_call_id:"original-model-call".into()}));
        let pump=journal.clone();
        tokio::spawn(async move {pump.handle_owned_native_control(&reserve).await?;pump.handle_owned_native_control(&dispatch).await?;Ok::<_,anyhow::Error>(())})
            .await.unwrap().expect("Original journal callback must use only its captured native owner, not the pump task local");
        let operations=NativeOperations::load(&fixture.native).unwrap().unwrap();
        let actual_operation=operations.read(&fixture.native,authority.operation()).unwrap().unwrap();
        operations.transition(&fixture.native,&actual_operation,IntegrationOperationPhase::CancelRequested,None).unwrap();
        let settlement=control("original-observe-dispatched",NativeRemoteControlDataV1::ObserveModel(NativeRemoteCallRefV1 {
            receiver_accepted:authority.observed_receiver().unwrap(),native_call_id:"original-model-call".into()}));
        assert!(journal.handle_owned_native_settlement(&settlement).await.unwrap().is_some());
        let forbidden=control("cannot-reserve-after-cancel",NativeRemoteControlDataV1::DispatchModel(NativeRemoteCallRefV1 {
            receiver_accepted:authority.observed_receiver().unwrap(),native_call_id:"original-model-call".into()}));
        assert!(journal.handle_owned_native_settlement(&forbidden).await.is_err());
        authority.observe_receipt(OutboundEffect::Session,&json!({"sessionId":"original-receiver-session"})).unwrap();
        journal.begin_owned_cancel(&json!("original-receiver-session")).unwrap();
        journal.store().unknown(&_prompt).unwrap();
        let close=authority.original_close().unwrap();
        let close_value=serde_json::to_value(&close).unwrap();
        assert!(authority.verify_owned_native_read(&close_value).is_err(), "Close is never read-only");
        let mut foreign_close=close_value.clone();foreign_close["requestId"]=json!("another-close");
        assert!(journal.before_owned_native_close(&foreign_close).is_err());
        assert!(outgoing.try_recv().is_err(), "Rejected admission sends no close");
        journal.before_owned_native_close(&close_value).unwrap();
        assert!(journal.before_owned_native_close(&close_value).is_err(), "No repeat close dispatch");
        assert!(journal.check_current().is_err(), "No new execution after close dispatch");
        assert!(authority.check_owned_native_control(&fixture.native).is_err(), "No model callback after close");
        let cancellation=json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"original-receiver-session"}});
        let retained=authority.frames();let bytes=cancellation.clone();
        let send=tokio::spawn(async move {retained.send(bytes).await});
        let write=outgoing.recv().await.unwrap();
        assert_eq!(write["params"]["frame"],cancellation);
        client.route_response(&json!({"jsonrpc":"2.0","id":write["id"],"result":{
            "operationId":authority.operation(),"endpointInstanceId":frame.endpoint_instance_id,
            "sequence":write["params"]["sequence"],"state":"transport_written"}}));
        send.await.unwrap().unwrap();
        assert!(authority.frames().send(cancellation).await.is_err(), "Original cancellation cannot be replayed");
        let late=control("late-original-settlement",NativeRemoteControlDataV1::ObserveModel(NativeRemoteCallRefV1 {
            receiver_accepted:authority.observed_receiver().unwrap(),native_call_id:"original-model-call".into()}));
        let response=journal.handle_owned_native_settlement(&late).await.unwrap().unwrap();
        let reply=json!({"jsonrpc":"2.0","id":late["id"],"result":response});
        let retained=authority.frames();let bytes=reply.clone();
        let send=tokio::spawn(async move {retained.send(bytes).await});
        let write=outgoing.recv().await.unwrap();
        assert_eq!(write["params"]["direction"],"frame_write");
        assert_eq!(write["params"]["frame"],reply);
        client.route_response(&json!({"jsonrpc":"2.0","id":write["id"],"result":{
            "operationId":authority.operation(),"endpointInstanceId":frame.endpoint_instance_id,
            "sequence":write["params"]["sequence"],"state":"transport_written"}}));
        send.await.unwrap().unwrap();
        assert!(authority.frames().send(reply).await.is_err(), "A retained reply is one-use, not arbitrary execution admission");

        let receipt=json!({"version":1,"operationId":close.operation_id,"requestId":close.request_id,
            "endpointRevision":close.endpoint_revision,"endpointInstanceId":close.endpoint_instance_id,"state":"received",
            "data":{"kind":"owner_closed","accepted":authority.observed_receiver().unwrap(),"outcome":"completed",
                "backendExited":true,"ownerTreeCleanupConfirmed":true}});
        for outcome in [serde_json::Value::Null, json!("failed"), json!("interrupted"), json!("outcome_unknown")] {
            let mut actual=receipt.clone();actual["data"]["outcome"]=outcome;
            authority.verify_owned_native_close_receipt(&actual).unwrap();
        }
        for field in ["backendExited", "ownerTreeCleanupConfirmed"] {
            let mut wrong=receipt.clone();wrong["data"][field]=json!(false);
            assert!(journal.record_owned_native_close(&wrong).is_err(), "Both actual cleanup facts are required");
        }
        let mut wrong=receipt.clone();wrong["data"]["accepted"]["identity"]["attemptId"]=json!("another-attempt");
        assert!(journal.record_owned_native_close(&wrong).is_err());
        journal.unknown_owned_native_close().unwrap();
        assert!(journal.before_owned_native_close(&close_value).is_err(), "Unknown close cannot be replayed");
        assert!(!journal.store().read(authority.operation()).unwrap().unwrap().endpoint_receiver.unwrap().cleanup_confirmed);
        // Retained authoritative receipt reconciliation sends no replacement close.
        journal.record_owned_native_close(&receipt).unwrap();
        assert!(journal.store().read(authority.operation()).unwrap().unwrap().endpoint_receiver.unwrap().cleanup_confirmed);
        authority.frames().begin_close();
        authority.frames().verify_retained_source().unwrap();
        assert!(authority.frames().verify_owner().is_err(),"A retained owner cannot revive closed bytes");
        client.close();
    }).await;
    fixture.close().await;
}
