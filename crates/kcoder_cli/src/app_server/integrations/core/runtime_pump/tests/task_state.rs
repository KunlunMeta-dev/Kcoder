use super::*;

fn observations(receiver: &mut mpsc::Receiver<Value>) -> Vec<IntegrationTaskStateObservation> {
    let mut values = vec![];
    while let Ok(frame) = receiver.try_recv() {
        if frame["method"]
            == kcoder_app_protocol::integrations::host::INTEGRATION_TASK_STATE_CHANGED
        {
            values.push(serde_json::from_value(frame["params"].clone()).unwrap());
        }
    }
    values
}

struct ObservationAuthority {
    allowed: AtomicBool,
    installer: FixtureInstaller,
}
impl NativeRuntimeAuthority for ObservationAuthority {
    fn verify_admission(
        &self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
    ) -> Result<()> {
        context.validate_scope(&request.scope)?;
        prepared.validate()
    }
    fn installer(&self) -> &dyn NativeRuntimePolicyInstaller {
        &self.installer
    }
    fn observe_task(
        &self,
        context: &NativeIntegrationContext,
        _request: &IntegrationRequest,
        _task: &IntegrationRuntimeTask,
    ) -> Result<()> {
        context.verify()?;
        ensure!(
            self.allowed.load(Ordering::SeqCst),
            "fixture observation denied"
        );
        Ok(())
    }
}

#[tokio::test]
async fn task_state_live_and_public_snapshot_share_original_versions_and_owner() {
    let fixture = Fixture::new();
    let (mut manager, prepared) = workflow_fixture_node(
        &fixture,
        json!({"id":"wait","title":"Wait","kind":"wait","config":{"wait":{"delayMs":30000}}}),
    )
    .await;
    let (mut pump, client) = NativeRuntimePump::new();
    let context = Arc::new(fixture.context.recapture_for_owned_service().unwrap());
    let source = Arc::new(ObservationAuthority {
        allowed: AtomicBool::new(false),
        installer: FixtureInstaller,
    });
    let caller = tokio::spawn({
        let (client, context, source) = (client.clone(), context.clone(), source.clone());
        let request = fixture.request("state-original");
        async move { client.accept(context, request, prepared, source).await }
    });
    let (outbound, mut receiver) = mpsc::channel(128);
    wait_for_admission(&mut pump, &outbound, &manager, "state-original").await;
    assert!(pump.next_request(&mut manager).unwrap().is_none());
    tokio::time::timeout(Duration::from_secs(5), async {
        while !caller.is_finished() {
            let event = pump.receive().await;
            pump.observe(event, &outbound, &manager).await.unwrap();
        }
    })
    .await
    .unwrap();
    let reply = caller.await.unwrap().unwrap();
    assert_eq!(reply.status, IntegrationStatus::Accepted);
    let accepted: IntegrationRuntimeAcceptance =
        serde_json::from_value(Value::Object(reply.result.as_ref().unwrap().clone())).unwrap();
    source.allowed.store(true, Ordering::SeqCst);
    pump.observe(RuntimePumpEvent::Tick, &outbound, &manager)
        .await
        .unwrap();
    assert!(
        observations(&mut receiver).is_empty(),
        "legacy clients receive no new event"
    );
    pump.set_task_state_notifications(true);
    source.allowed.store(false, Ordering::SeqCst);
    pump.observe(RuntimePumpEvent::Tick, &outbound, &manager)
        .await
        .unwrap();
    assert!(
        observations(&mut receiver).is_empty(),
        "source observation must authorize publishing"
    );
    source.allowed.store(true, Ordering::SeqCst);
    pump.observe(RuntimePumpEvent::Tick, &outbound, &manager)
        .await
        .unwrap();
    let live = observations(&mut receiver);
    assert_eq!(live.len(), 1);
    let live = &live[0];
    live.validate().unwrap();
    assert!(!live.snapshot);
    assert_eq!(live.operation_id, "state-original");
    assert_eq!(live.reference.task_id, accepted.task_id);

    let state = crate::app_server::ConnectionState {
        integration_context: Some(context.recapture_for_owned_service().unwrap()),
        integration_task_state_v1: true,
        ..Default::default()
    };
    let params = json!({"requestId":"original-state-read","scope":context.scope(),"reference":live.reference});
    let (responses, mut replies) = mpsc::channel(8);
    assert!(
        crate::app_server::integration_requests::dispatch_task_state(
            kcoder_app_protocol::integrations::host::INTEGRATION_TASK_STATE_READ,
            &json!(1),
            &params,
            &responses,
            &state,
        )
        .await
        .unwrap()
    );
    let snapshot: IntegrationTaskStateObservation =
        serde_json::from_value(replies.recv().await.unwrap()["result"].clone()).unwrap();
    assert!(snapshot.snapshot);
    assert_eq!(snapshot.revision, live.revision);
    assert_eq!(snapshot.state, live.state);
    assert_eq!(snapshot.reference, live.reference);
    let revision = pump.active["state-original"].published_revision;
    // Publishing the already observed binding itself is idempotent. The normal
    // workflow poll may commit a newer revision even when the state is unchanged.
    assert_eq!(revision, live.revision);

    let mut forbidden = state;
    for variant in ["capability", "scope", "reference", "source", "closed"] {
        let mut request = params.clone();
        forbidden.integration_task_state_v1 = variant != "capability";
        forbidden.native_source_dispatch = variant == "source";
        if variant == "scope" {
            request["scope"]["accountId"] = json!("other-account");
        }
        if variant == "reference" {
            request["reference"]["taskId"] = json!("other-task");
        }
        if variant == "closed" {
            forbidden.input_ended.cancel();
        }
        crate::app_server::integration_requests::dispatch_task_state(
            kcoder_app_protocol::integrations::host::INTEGRATION_TASK_STATE_READ,
            &json!(2),
            &request,
            &responses,
            &forbidden,
        )
        .await
        .unwrap();
        let denied = replies.recv().await.unwrap();
        assert_eq!(
            denied["error"]["message"],
            "INTEGRATION_TASK_STATE_UNAVAILABLE"
        );
    }
    pump.close().await;
    shutdown(manager).await;
}
