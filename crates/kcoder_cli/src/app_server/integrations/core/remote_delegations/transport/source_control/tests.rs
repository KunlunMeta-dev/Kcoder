//! Original Native ledger fixtures; selected-target/Receiver authentication is not simulated as proof.
use super::super::host_client::tests::fixture;
use super::*;
use kcoder_types::TurnAttemptIdentity;
use serde_json::json;
use tokio_util::sync::CancellationToken;
fn original_operation(source: &super::super::super::launch::NativeRemoteSourceFacts) -> String {
    format!(
        "remote-{}",
        super::super::super::launch::digest(&(
            IntegrationOwner::from(&source.scope),
            &source.attempt,
            &source.tool_call_id
        ))
        .unwrap()
    )
}
#[tokio::test]
async fn private_controls_use_the_same_original_source_slot_and_unknown_never_refunds() {
    let (f, client, _parent, mut outgoing) = fixture();
    f.engine.state.history_attempt_scope(f.attempt.clone()).unwrap().run(async {
        f.native.profile().unwrap().atomic_replace(std::ffi::OsStr::new("settings.json"),&serde_json::to_vec(&json!({"integrations":{"remotes":{"enabled":true,"outbound":{"enabled":true,"maximumTotalTokens":80,"maximumModelCalls":2,"maximumDurationSeconds":1800}}}})).unwrap()).unwrap();
        let caller=kcoder_tools::ToolContext::new(f.engine.state.clone()).with_tool_call_id("original-approved-native-fixture-call");
        let budget=NativeRemoteSourceBudget::capture(&f.native,&f.engine,&f.attempt,&caller).unwrap();
        let source=budget.frozen_native_facts().unwrap();let operation=original_operation(&source);
        let frames=NativeRemoteSourceFrames::bind_original(client.clone(),budget,NativeRemoteTargetRefV1{target_id:"actual-selected-target-fixture".into(),target_revision:"target-revision".into(),target_platform:NativeRemoteTargetPlatformV1::Windows,expected_native_sha256:"a".repeat(64)},&operation,tokio::time::Instant::now()+std::time::Duration::from_secs(30),CancellationToken::new()).unwrap();
        let control=NativeRemoteSourceControl::bind_original(frames.clone()).unwrap();
        let receiver=NativeRemoteAcceptedFactsV1{identity:NativeRemoteTurnIdentityV1::from(&TurnAttemptIdentity{thread_id:"receiver-thread".into(),turn_id:"receiver-turn".into(),attempt_id:"receiver-attempt".into()}),accepted_input_sha256:"a".repeat(64),accepted_receipt_sha256:"b".repeat(64),receiver_scope:None,receiver_settings_sha256:"c".repeat(64)};
        let frame=|id:&str,message:NativeRemoteControlDataV1|json!({"jsonrpc":"2.0","id":id,"method":NATIVE_REMOTE_CONTROL_METHOD,"params":NativeRemoteControlFrameV1{version:1,operation_id:operation.clone(),request_id:id.into(),endpoint_revision:"target-revision".into(),endpoint_instance_id:frames.endpoint_instance_id().into(),source_accepted_sha256:source.accepted_receipt_sha256.clone(),message}});
        assert!(control.handle_owned_frame(&frame("before-open",NativeRemoteControlDataV1::ReceiverAccepted(receiver.clone()))).is_err());
        let opening=frames.clone();let opening=tokio::spawn(async move {opening.open().await});
        let open=outgoing.recv().await.unwrap();
        assert_eq!(open["params"]["sourceAttempt"],serde_json::to_value(NativeRemoteTurnIdentityV1::from(&f.attempt)).unwrap());
        client.route_response(&json!({"jsonrpc":"2.0","id":open["id"],"result":{"operationId":operation,"endpointInstanceId":frames.endpoint_instance_id(),"state":"opened","receiverWorkspace":"D:/owned/receiver","targetPlatform":"windows","nativeSha256":"a".repeat(64)}}));
        opening.await.unwrap().unwrap();
        control.bind_receiver_settings(&"c".repeat(64)).unwrap();
        control.handle_owned_frame(&frame("accepted",NativeRemoteControlDataV1::ReceiverAccepted(receiver.clone()))).unwrap();
        let reserve=frame("reserve",NativeRemoteControlDataV1::ReserveModel(NativeRemoteReserveModelV1{receiver_accepted:receiver.clone(),native_call_id:"actual-provider-call".into(),provider_id:"own-provider".into(),model_id:"own-model".into(),model_configuration_revision:"own-model-revision".into(),conservative_bound:NativeRemoteChargeDataV1{tokens:40,model_calls:1,run_millis:1000,cost_micros:None}}));
        let reserved=control.handle_owned_frame(&reserve).unwrap();assert_eq!(reserved["data"]["charged"]["tokens"],40);
        assert_eq!(reserved,control.handle_owned_frame(&reserve).unwrap());
        let call=NativeRemoteCallRefV1{receiver_accepted:receiver.clone(),native_call_id:"actual-provider-call".into()};
        control.handle_owned_frame(&frame("dispatch",NativeRemoteControlDataV1::DispatchModel(call.clone()))).unwrap();
        let unknown=control.handle_owned_frame(&frame("unknown",NativeRemoteControlDataV1::FinishModel(NativeRemoteFinishModelV1{call:call.clone(),outcome:NativeRemoteCallOutcomeV1::OutcomeUnknown,actual_usage:None}))).unwrap();
        assert_eq!(unknown["data"]["charged"]["tokens"],40);assert_eq!(unknown["data"]["finished"],false);assert!(unknown["data"]["charged"]["costMicros"].is_null());
        let finished=control.handle_owned_frame(&frame("completed",NativeRemoteControlDataV1::FinishModel(NativeRemoteFinishModelV1{call,outcome:NativeRemoteCallOutcomeV1::Completed,actual_usage:Some(NativeRemoteChargeDataV1{tokens:9,model_calls:1,run_millis:20,cost_micros:None})}))).unwrap();
        assert_eq!(finished["data"]["charged"]["tokens"],9);assert_eq!(finished["data"]["finished"],true);
        let mut conflict=reserve.clone();conflict["params"]["message"]["params"]["nativeCallId"]=json!("different-call");
        assert!(control.handle_owned_frame(&conflict).is_err());
        let mut changed=reserve;changed["params"]["endpointInstanceId"]=json!("replacement-endpoint");
        assert!(control.handle_owned_frame(&changed).is_err());
    }).await;
    client.close();
    f.close().await;
}
