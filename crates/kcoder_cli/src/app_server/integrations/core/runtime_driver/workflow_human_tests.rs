//! Original persisted Human decisions, native task state and timeout evidence.
use super::*;
use kcoder_types::workflow::WorkflowAwaitRequest;

struct NarrowLifetime;
impl NativeRuntimeAuthority for NarrowLifetime {
    fn verify_admission(
        &self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
    ) -> Result<()> {
        FixtureInstaller.verify_admission(context, request, prepared)
    }
    fn installer(&self) -> &dyn NativeRuntimePolicyInstaller {
        &FixtureInstaller
    }
    fn workflow_timeout_seconds(&self) -> Option<u64> {
        Some(1)
    }
}

async fn human_case(respond: bool, owner_timeout: bool) {
    let fixture = Fixture::new();
    let timeout = if respond || owner_timeout {
        60_000
    } else {
        500
    };
    let authority: Arc<dyn NativeRuntimeAuthority> = if owner_timeout {
        Arc::new(NarrowLifetime)
    } else {
        Arc::new(FixtureInstaller)
    };
    let (mut driver, manager, _, ticket, job) = prepare_launch(&fixture,
        json!({"id":"decision","kind":"human","config":{"human":{"prompt":"Approve the fixed result?","responseSchema":{"type":"boolean"},"timeoutMs":timeout}}}), authority).await;
    job.run().await.unwrap();
    driver
        .observe_workflow_launch(&fixture.context, &ticket, Ok(()))
        .unwrap();
    let root = fixture.profile.join("workflow-runs");
    let pending = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            driver
                .refresh_workflow(&fixture.context, "real-workflow")
                .unwrap();
            let task = driver.read_task(&fixture.context, "real-workflow").unwrap();
            if task.state == IntegrationTaskState::WaitingForUser {
                assert!(task.turn_id.is_none());
                assert!(
                    task.pending_interactions.is_empty(),
                    "Human must not fabricate a turn Approval or Question"
                );
                let run = task.task_id.unwrap();
                let requests = kcoder_tools::workflow_interactions::list(&root, &run).unwrap();
                assert_eq!(requests.len(), 1);
                assert_eq!(requests[0].node_id, "decision");
                assert!(matches!(
                    requests[0].request,
                    WorkflowAwaitRequest::Human { .. }
                ));
                break (run, requests[0].request_id.clone());
            }
            assert!(!matches!(
                task.state,
                IntegrationTaskState::Completed
                    | IntegrationTaskState::Failed
                    | IntegrationTaskState::Cancelled
            ));
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    if respond {
        kcoder_tools::workflow_interactions::respond(&root, &pending.0, &pending.1, json!(true))
            .unwrap();
    }
    let task = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            driver
                .refresh_workflow(&fixture.context, "real-workflow")
                .unwrap();
            let task = driver.read_task(&fixture.context, "real-workflow").unwrap();
            if matches!(
                task.state,
                IntegrationTaskState::Completed
                    | IntegrationTaskState::Failed
                    | IntegrationTaskState::Cancelled
            ) {
                break task;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        task.state,
        if respond {
            IntegrationTaskState::Completed
        } else {
            IntegrationTaskState::Failed
        }
    );
    assert_eq!(task.task_id.as_deref(), Some(pending.0.as_str()));
    if !respond {
        assert!(
            kcoder_tools::workflow_interactions::respond(
                &root,
                &pending.0,
                &pending.1,
                json!(true)
            )
            .is_err(),
            "Expired decision must reject late assent"
        );
    }
    assert_eq!(kcoder_tools::workflow_runs::list(root).unwrap().len(), 1);
    shutdown(manager).await;
}

#[tokio::test]
async fn actual_original_human_request_waits_then_only_explicit_response_completes() {
    human_case(true, false).await;
}
#[tokio::test]
async fn actual_original_human_deadline_fails_without_implicit_consent() {
    human_case(false, false).await;
}
#[tokio::test]
async fn native_source_lifetime_bounds_human_wait_before_its_longer_deadline() {
    human_case(false, true).await;
}
