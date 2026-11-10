use super::*;

async fn response(
    pump: &mut NativeRuntimePump,
    manager: &ThreadManager,
    caller: tokio::task::JoinHandle<Result<IntegrationReply>>,
) -> IntegrationReply {
    let (outbound, _receiver) = mpsc::channel(64);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !caller.is_finished() {
            let event = pump.receive().await;
            pump.observe(event, &outbound, manager).await.unwrap();
        }
        caller.await.unwrap().unwrap()
    })
    .await
    .unwrap()
}
fn read_request(fixture: &Fixture, payload: Value) -> IntegrationRequest {
    let mut request = fixture.request("read-control");
    request.operation_id = None;
    request.payload = payload.as_object().unwrap().clone();
    request
}

#[tokio::test]
async fn canonical_queries_never_initialize_or_activate_missing_runtime_storage() {
    let fixture = Fixture::new();
    let (manager, _) = resident(&fixture).await;
    let (mut pump, client) = NativeRuntimePump::new();
    let context = Arc::new(fixture.context.recapture_for_owned_service().unwrap());
    let before = std::fs::read_dir(&fixture.profile).unwrap().count();
    let request = read_request(&fixture, json!({"operationId":"not-created"}));
    let caller = tokio::spawn({
        let client = client.clone();
        let context = context.clone();
        async move { client.read_operation(context, request).await }
    });
    let reply = response(&mut pump, &manager, caller).await;
    assert_eq!(reply.status, IntegrationStatus::Unavailable);
    assert!(pump.driver.is_none() && pump.active.is_empty());
    assert!(NativeRuntimeDriver::load(&context).unwrap().is_none());
    assert_eq!(std::fs::read_dir(&fixture.profile).unwrap().count(), before);
    let mut forged = read_request(&fixture, json!({"operationId":"not-created"}));
    forged.scope.account_id = "different-native-owner".into();
    assert!(client.read_operation(context, forged).await.is_err());
    assert!(pump.controls.try_recv().is_err());
    pump.close().await;
    shutdown(manager).await;
}

#[tokio::test]
async fn canonical_controls_cancel_only_original_owned_workflow_after_source_revocation_and_notify_real_terminal()
 {
    let fixture = Fixture::new();
    let (mut manager, prepared) = workflow_fixture_node(
        &fixture,
        json!({"id":"wait","title":"Wait for owned cancellation","kind":"wait","config":{"wait":{"delayMs":30000}}}),
    )
    .await;
    let (mut pump, client) = NativeRuntimePump::new();
    let context = Arc::new(fixture.context.recapture_for_owned_service().unwrap());
    let authority = authority();
    let original = fixture.request("owned-controls-workflow");
    let caller = tokio::spawn({
        let (client, context, authority) = (client.clone(), context.clone(), authority.clone());
        async move { client.accept(context, original, prepared, authority).await }
    });
    let (outbound, _receiver) = mpsc::channel(64);
    wait_for_admission(&mut pump, &outbound, &manager, "owned-controls-workflow").await;
    assert!(pump.next_request(&mut manager).unwrap().is_none());
    let accepted = response(&mut pump, &manager, caller).await;
    assert_eq!(accepted.status, IntegrationStatus::Accepted);
    let accepted: IntegrationRuntimeAcceptance =
        serde_json::from_value(Value::Object(accepted.result.as_ref().unwrap().clone())).unwrap();
    let reference = json!({"threadId":accepted.thread_id,"taskId":accepted.task_id});
    let request = read_request(&fixture, json!({"operationId":"owned-controls-workflow"}));
    let caller = tokio::spawn({
        let (client, context) = (client.clone(), context.clone());
        async move { client.read_operation(context, request).await }
    });
    let receipt = response(&mut pump, &manager, caller).await;
    assert_eq!(receipt.status, IntegrationStatus::Completed);
    let receipt: IntegrationOperationReadResult =
        serde_json::from_value(Value::Object(receipt.result.as_ref().unwrap().clone())).unwrap();
    assert_eq!(
        receipt
            .receipt
            .as_ref()
            .unwrap()
            .runtime_acceptance
            .as_ref(),
        Some(&accepted)
    );
    authority.enabled.store(false, Ordering::SeqCst);
    let mut cancel = fixture.request("cancel-owned-controls-workflow");
    cancel.payload = reference.as_object().unwrap().clone();
    let caller = tokio::spawn({
        let (client, context) = (client.clone(), context.clone());
        async move { client.cancel_task(context, cancel).await }
    });
    let queued = response(&mut pump, &manager, caller).await;
    assert_eq!(queued.status, IntegrationStatus::Accepted);
    assert_ne!(
        pump.driver
            .as_ref()
            .unwrap()
            .read_task(&context, "owned-controls-workflow")
            .unwrap()
            .state,
        IntegrationTaskState::Cancelled
    );
    assert!(pump.next_request(&mut manager).unwrap().is_none());
    let observed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let request = read_request(&fixture, reference.clone());
            let caller = tokio::spawn({
                let (client, context) = (client.clone(), context.clone());
                async move { client.read_task(context, request).await }
            });
            let reply = response(&mut pump, &manager, caller).await;
            assert_eq!(reply.status, IntegrationStatus::Completed);
            let task: IntegrationRuntimeTask =
                serde_json::from_value(Value::Object(reply.result.as_ref().unwrap().clone()))
                    .unwrap();
            if task.state == IntegrationTaskState::Cancelled {
                break task;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(observed.task_id, accepted.task_id);
    assert!(
        authority
            .observed
            .lock()
            .unwrap()
            .iter()
            .any(|(operation, state)| operation == "owned-controls-workflow"
                && *state == IntegrationTaskState::Cancelled)
    );
    assert!(!pump.active.contains_key("owned-controls-workflow"));
    pump.close().await;
    let (mut cold, cold_client) = NativeRuntimePump::new();
    let request = read_request(&fixture, reference);
    let caller = tokio::spawn({
        let context = context.clone();
        async move { cold_client.read_task(context, request).await }
    });
    let reply = response(&mut cold, &manager, caller).await;
    assert_eq!(reply.status, IntegrationStatus::Completed);
    assert!(cold.active.is_empty() && !cold.driver.as_ref().unwrap().has_commands());
    assert_eq!(
        reply.result.as_ref().unwrap().get("state"),
        Some(&json!("cancelled"))
    );
    cold.close().await;
    shutdown(manager).await;
}
